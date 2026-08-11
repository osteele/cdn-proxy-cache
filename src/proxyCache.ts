import express = require('express');
import stream, { Readable } from 'node:stream';
import zlib from 'node:zlib';
import * as cacache from 'cacache';
import * as csstree from 'css-tree';
import { parse as parseCss } from 'css-tree';
import fetch from 'node-fetch';
import { parse as parseHtml } from 'node-html-parser';
import { WritableCounter, fromReadable, multiplexStreamWriter } from './helpers/stream-helpers';
import { isDefined } from './ts-extras';
import path = require('node:path');
import assert = require('node:assert');

const debug = require('debug')('cdn-proxy-cache');
const MAX_REDIRECTS = 20;

//#region exported types
export type ProxyCacheOptions = {
  cachePath: string;
  cacheSeeds: string[];
  proxyPrefix: string;
  shouldProxyPath: (url: string) => boolean;
};

export type ProxyCache = {
  // properties
  cachePath: string;
  proxyPrefix: string;

  // methods
  router: (req: RequestI, res: ResponseI) => Promise<void>;
  replaceUrlsInHtml: (html: string) => string;

  // cache management methods
  clear: () => Promise<void>;
  warm: (options: WarmCacheOptions, callback?: (message: CacheWarmMessage) => void) => Promise<CacheWarmStats>;
  ls: typeof cacacheLsBind;

  isProxyPath: (url: string) => boolean;

  // private methods; exported for unit testing
  decodeProxyPath: (url: string, query?: RequestI['query']) => string;
  encodeProxyPath: (url: string) => string;
  _testing: {
    decodeContent: typeof decodeContent;
    makeProxyReplacementStream: (
      stream: NodeJS.ReadableStream,
      contentType: string,
      contentEncoding: string,
      base: string
    ) => NodeJS.ReadableStream;
  };
};

type WarmCacheOptions = {
  /** If true, re-fetch cache seeds and recursively-referenced items,
   * regardless of whether they're already cached and expiration status. */
  force?: boolean;

  /** If true, re-fetch all items that are currently in the cache, rather
   * than starting from the cache seeds. This flag only makes sense if
   * `force` is also true. */
  reload?: boolean;
};

export type CacheWarmStats = {
  total: number;
  failures: number;
  hits: number;
  misses: number;
};

export type CacheWarmMessage =
  | { type: 'initial'; total: number }
  | { type: 'prefetch'; url: string }
  | { type: 'error'; url: string; status: number }
  | { type: 'progress'; stats: CacheWarmStats };
//#endregion

export const HTTP_RESPONSE_HEADER_CACHE_STATUS = 'x-cdn-proxy-cache-hit';

// Response headers that should not be stored in the cache.
const uncacheableResponseHeaders = [
  'accept-ranges', // the proxy does not implement ranges, even if the origin does

  // Connection and hop-by-hop request headers depend on the server engine, not
  // the proxy middleware or the cached value
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'trailer',
  'upgrade', // TODO: should this disable the proxy?

  'alt-svc',

  'strict-transport-security',
  'transfer-encoding',

  // 'content-accept-ranges',
  'content-length', // this can change from cached value when the server rewrites the urls
];

// Request headers that are passed through to the proxied request. Other headers
// are ignored, in order to assure that the cached response can be shared
// between different requests.
const headerAcceptList = ['accept', 'accept-language', 'accept-encoding', 'user-agent'];

// A dummy function used with typeof to derive the type of the bound method.
const cacacheLsBind = () => cacache.ls('cachePath');

// The RequestI and ReponseI interfaces specify the part of express.Request and
// express.Response that cdnProxyRouter uses. It is done this way so that
// prefetch, which is used to warm the cache, can call cdnProxyRouter instead of
// using separate logic to test and populate the cache.

/** The express.Request properties that cdnProxyRouter depends on. */
export interface RequestI {
  headers: typeof express.request.headers;
  path: typeof express.request.path;
  query: typeof express.request.query;
}

/** The express.Response properties that cdnProxyRouter depends on. */
export interface ResponseI extends NodeJS.WritableStream {
  destroy(error?: Error): void;
  setHeader(key: string, value: string | number | readonly string[]): void;
  send(chunk: string | Buffer): void;
  status(code: number): void;
}

/** A null ResponseI */
class NullWritable extends stream.Writable {
  setHeader() {}
  send() {}
  status() {}
  _write() {}
}

export function createProxyCache({
  proxyPrefix,
  cachePath,
  cacheSeeds,
  shouldProxyPath,
}: ProxyCacheOptions): ProxyCache {
  return {
    cachePath,
    proxyPrefix,
    clear: () => cacache.rm.all(cachePath),
    router: cdnProxyRouter,
    replaceUrlsInHtml,
    warm: warmCache,
    ls: cacache.ls.bind(cacache, cachePath),
    isProxyPath: (url) => url.startsWith(proxyPrefix),
    // exported for unit testing:
    decodeProxyPath,
    encodeProxyPath,
    _testing: { decodeContent, makeProxyReplacementStream },
  };

  // Note that express.Request implements RequestI, and express.Response
  // implements ResponseI.
  //
  // This function uses the more general type to allow prefetch to call
  // cdnProxyRouter.
  async function cdnProxyRouter(req: RequestI, res: ResponseI): Promise<void> {
    let targetResponse = res;
    const originUrl = decodeProxyPath(req.path, req.query);
    if (!shouldProxyPath(originUrl)) {
      targetResponse.status(403);
      targetResponse.send(`Refusing to proxy URL: ${originUrl}`);
      return;
    }
    // Normalize the encoding and remove 'br', for caching purposes. Safari
    // sends 'gzip, deflate'. Chrome sends 'gzip, deflate, br'. This prevents
    // them from sharing a cache. The simplest solution is to simply not request
    // br.
    const acceptEncoding = req.headers['accept-encoding']
      ? (req.headers['accept-encoding'] as string)
          .split(/,\s*|\s+/)
          .filter((x) => x !== 'br')
          .join(', ')
      : null;
    // An earlier version used a cryptographic digest of the stringified JSON;
    // however, the 'crypto' module is not present in VSCode.
    const cacheKey = JSON.stringify({
      url: originUrl,
      // Formally, the cache key should include the headers in the Vary response
      // header. In practice, this header only has at most the following keys;
      // and, it is harmless to vary on them even when they aren't specified.
      //
      // Do NOT cache on User-Agent. It is not necessary for the supported CDNs,
      // and it would bust the cache between different browsers, which is
      // undesireable for offline development.
      accept: req.headers.accept,
      acceptEncoding,
    });
    const cacheObject = await cacache.get.info(cachePath, cacheKey);

    targetResponse.setHeader('x-cdn-proxy-origin-url', originUrl);

    // Cache hit. This can fall through to the cache miss case if the cached
    // value is present (in which case this value is send to the original
    // response) but expired (in which case the request is also sent to the
    // origin server and, if succesful, asynchronously used to replace the
    // cached value).
    if (cacheObject && !req.query.reload) {
      debug('cache hit', originUrl);
      targetResponse.setHeader(HTTP_RESPONSE_HEADER_CACHE_STATUS, 'HIT');

      // Copy the cached headers to the response.
      const { headers } = cacheObject.metadata;
      for (const key of Object.keys(headers)) {
        let value = headers[key];
        switch (key) {
          case 'location':
            if (shouldProxyPath(value)) {
              value = encodeProxyPath(value);
            }
            break;
          case 'cache-control':
            continue;
        }
        const headerMap: Record<string, string> = { server: 'origin-server' };
        targetResponse.setHeader(headerMap[key] ?? key, value);
      }
      // Add the Age and Cache-Control headers.
      {
        const age = Math.max(0, +new Date() - cacheObject.time);
        targetResponse.setHeader('age', Math.floor(age / 1000));
      }
      {
        let cacheControl = headers['cache-control']?.match(/(?:^|\b)(public|private)\b/)?.[1] ?? 'public';
        const maxAge = headers['cache-control']?.match(/(?:^|\b)max-age=(\d+)/)?.[1];
        if (maxAge) {
          cacheControl += `, max-age=${maxAge}`;
        }
        cacheControl += `, stale-while-revalidate=${maxAge || 86400}`;
        targetResponse.setHeader('cache-control', cacheControl);
      }

      targetResponse.status(cacheObject.metadata.status);
      let rstream = cacache.get.stream(cachePath, cacheKey) as unknown as NodeJS.ReadableStream;
      rstream = makeProxyReplacementStream(rstream, headers['content-type'], headers['content-encoding'], originUrl);
      rstream.pipe(targetResponse);

      // Check for cache expiration.
      //
      // The maxAge value used here differs from the one above, that is used in
      // the HTTP response header, in that this one prefers the origin server's
      // s-maxage over max-age if the former exists.
      const maxAge =
        (headers['cache-control']?.match(/(?:%|\b)s-maxage=(\d+)/) ||
          headers['cache-control']?.match(/(?:%|\b)max-age=(\d+)/))?.[1] ?? 'Infinity';
      const expires = new Date(cacheObject.time + Number(maxAge) * 1000);
      const expired = expires < new Date();
      if (expired) {
        debug('cache expired', originUrl);
        // The response is complete. Replace the original response instance with one that simply ignores writes.
        // Using a null Writable reduces the number of code paths, below.
        targetResponse = new NullWritable();
      } else {
        await new Promise((resolve) => targetResponse.on('finish', resolve));
        return;
      }
    }

    // Cache miss; or expired cache entry
    debug('cache miss', originUrl);

    // filter the headers, and combine string[] values back into strings
    const reqHeaders: Record<string, string> = Object.fromEntries(
      (
        Object.entries(req.headers)
          .filter(([key]) => headerAcceptList.includes(key))
          .filter(([_key, value]) => isDefined(value)) as [string, string | string[]][]
      ).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value])
    );
    if (acceptEncoding) reqHeaders['accept-encoding'] = acceptEncoding;
    const originResponse = await fetch(originUrl, {
      compress: false, // don't uncompress gzips — for efficiency, and so that the content matches the content-type
      headers: reqHeaders,
      redirect: 'manual', // don't follow redirects; cache the redirect directive instead
    }).catch((err) => {
      // This can happen if:
      // - the URL is invalid
      // - the origin server is down (unlikely)
      // - this server is offline from the internet
      // - this server is behind a firewall (e.g. cdn.jsdelivr.net is blocked in China)
      console.error(`Error during request for ${originUrl}:\n${err}`);
      targetResponse.status(500);
      targetResponse.send(`Error during request for ${originUrl}:\n${err}`);
      return null;
    });
    if (!originResponse) {
      return;
    }

    // Relay the origin status, and add a cache header
    targetResponse.status(originResponse.status);
    targetResponse.setHeader(HTTP_RESPONSE_HEADER_CACHE_STATUS, 'MISS');

    // Copy headers from the origin response to the output response.
    // Modify Location headers to proxy them, in the case of a redirect.
    originResponse.headers.forEach((value, key) => {
      const outputValue = key === 'location' && shouldProxyPath(value) ? encodeProxyPath(value) : value;
      targetResponse.setHeader(key, outputValue);
    });

    // This test excludes 300 Multiple Choice, since that status code is rarely
    // used in practice, and would require rewriting the links in the HTML
    // response.
    const redirected =
      300 < originResponse.status && originResponse.status < 400 && originResponse.headers.has('location');
    if (!originResponse.ok && !redirected) {
      // don't cache responses other than 200's and redirects
      debug(`Failed ${originResponse.ok} | ${originResponse.status} | ${originResponse.statusText}`);
      targetResponse.send(originResponse.statusText);
      return;
    }

    // expressjs.Response.headers serializes to {}. Copy it to an Object that can
    // be serialized to JSON.
    const responseHeaders = Object.fromEntries(
      Array.from(originResponse.headers.entries()).filter(([key]) => !uncacheableResponseHeaders.includes(key))
    );
    const cacheWriteStream = cacache.put.stream(cachePath, cacheKey, {
      metadata: {
        originUrl,
        headers: responseHeaders,
        status: originResponse.status,
      },
    }) as unknown as NodeJS.WritableStream;

    // pipe the origin response body to both the client response and the cache
    // write stream. Collect the length of the response for logging.
    const streamLengthCounter = new WritableCounter();
    const responseInput = new stream.PassThrough();
    const originSink = multiplexStreamWriter([cacheWriteStream, streamLengthCounter, responseInput]);
    const responseStream = makeProxyReplacementStream(
      responseInput,
      responseHeaders['content-type'],
      responseHeaders['content-encoding'],
      originUrl
    );
    responseStream.on('error', (error) => targetResponse.destroy(error));
    originResponse.body.pipe(originSink);
    responseStream.pipe(targetResponse);
    await Promise.all([waitForReadable(responseStream), waitForWritable(originSink), waitForWritable(targetResponse)]);
    debug('wrote', streamLengthCounter.length, 'bytes to cache for', originUrl);
  }

  //#region proxy paths

  // exported for unit testing
  function encodeProxyPath(originUrl: string, { includePrefix = true } = {}): string {
    if (!/^https?:/i.test(originUrl)) return originUrl;
    let proxyPath = originUrl;
    if (/\?/.test(originUrl)) {
      // package the entire query string into a single query parameter, so that other query parameters can be added to the
      // URL without breaking the cache
      const u = new URL(originUrl);
      u.search = `?search=${encodeURIComponent(u.search.substr(1))}`;
      proxyPath = u.toString();
    }
    // The following transformation improves the readability of the developer console's source list.
    proxyPath = proxyPath.replace(/^https:\/\//i, '').replace(/^http:\/\//i, 'http/');
    return includePrefix ? `${proxyPrefix}/${proxyPath}` : proxyPath;
  }

  // exported for unit testing
  function decodeProxyPath(proxyPath: string, query: RequestI['query'] = {}): string {
    let originUrl = proxyPath
      .replace(proxyPrefix, '')
      .replace(/^\//, '')
      .replace(/^http\//, 'http://');
    if (!/^https?:/i.test(originUrl)) originUrl = `https://${originUrl}`;
    if (originUrl.includes('?')) {
      const [pʹ, queryString, hash] = originUrl.match(/(.+)\?(.+)(#.*)?/)!.slice(1);
      originUrl = pʹ + (hash || '');
      new URLSearchParams(queryString).forEach((value, key) => {
        query[key] = value;
      });
    }
    if (query.search) {
      originUrl += `?${decodeURIComponent(query.search as string)}`;
    }
    return originUrl;
  }

  function isProxyPath(url: string): boolean {
    return url.startsWith(proxyPrefix);
  }

  //#endregion

  //#region cache warmup

  /** Verify that url is in the cache. Request it if it is not.
   *
   * Uses cdnProxyRouter to minimize different code paths that need to be
   * tested.
   *
   * Returns a Response-like structure, that warmCache can use to follow
   * referenced URLs.
   *
   * Follows redirections, caches intermediate results, and rejects redirect
   * cycles or chains longer than MAX_REDIRECTS.
   *
   */
  async function prefetch(
    url: string,
    { accept = '*/*', force = false },
    redirectChain: readonly string[] = []
  ): Promise<{ status: number; ok: boolean; headers: Record<string, string>; data: Buffer }> {
    if (redirectChain.includes(url) || redirectChain.length >= MAX_REDIRECTS) {
      return { status: 508, ok: false, headers: {}, data: Buffer.alloc(0) };
    }
    const reqHeaders = {
      accept,
      'accept-language': 'en-US,en;q=0.9',
      'accept-encoding': 'gzip, deflate',
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Safari/605.1.15',
    };
    const req = {
      headers: reqHeaders,
      path: encodeProxyPath(url, { includePrefix: false }),
      query: force ? { reload: 'true' } : {},
    };

    const res = new (class extends stream.Writable {
      chunks = new Array<Buffer>();
      headers: Record<string, string> = {};
      statusCode?: number;

      setHeader(key: string, value: string) {
        this.headers[key] = value;
      }
      status(code: number) {
        this.statusCode = code;
      }
      send(chunk: string | Buffer) {
        this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
        assert.ok(chunk instanceof Buffer);
        this.chunks.push(chunk as Buffer);
        callback();
      }
    })();

    debug(`warm cache for ${url}`);
    await cdnProxyRouter(req, res);
    const status = res.statusCode!;
    const redirected = 300 < status && status < 400 && res.headers.location?.startsWith(`${proxyPrefix}/`);
    if (redirected) {
      const location = decodeProxyPath(res.headers.location);
      debug(`following redirect from ${url} -> ${location}`);
      return prefetch(location, { accept, force }, [...redirectChain, url]);
    }
    return {
      data: Buffer.concat(res.chunks),
      headers: res.headers,
      ok: status < 400,
      status,
    };
  }

  async function getCachedUrls(): Promise<string[]> {
    const cache = await cacache.ls(cachePath);
    return Object.values(cache).map((value) => value.metadata.originUrl);
  }

  /** Warm the cache, by requesting all the urls in the manifest, and the urls that they reference.
   *
   * (Currently, only references in CSS files are prefetched.)
   */
  async function warmCache(
    { force, reload }: { force?: boolean; reload?: boolean },
    callback?: (message: CacheWarmMessage) => void
  ): Promise<CacheWarmStats> {
    // Most of this function's complexity is due to requesting the URLs
    // concurrently.
    const concurrency = 20; // max number of requests to make at once
    const stats = { total: 0, failures: 0, hits: 0, misses: 0 };
    const urls = removeArrayDuplicates(reload ? await getCachedUrls() : cacheSeeds).sort();
    callback?.({ type: 'initial', total: urls.length });

    const seen = new Set<string>();
    const promises: Promise<void>[] = [];
    // `while` instead of `for`, because visit() can add to the array.
    while (urls.length > 0 || promises.length > 0) {
      const url = urls.shift();
      if (url) {
        if (seen.has(url)) continue;
        seen.add(url);
        callback?.({ type: 'prefetch', url });
        await visit(url);
      } else {
        // One of the pending promises could add more urls to the queue, so wait
        // for the next one inside the loop, instead of awaiting Promise.all()
        // at the end.
        await Promise.race(promises);
      }
    }

    return stats;

    // This function returns immediately once it adds a fetch promise to the
    // array. (It does not wait for the fetch to initiate.) If there are already
    // `concurrency` promises pending, it waits for one to resolve before adding
    // the new promise and returning.
    async function visit(url: string) {
      if (promises.length >= concurrency) {
        // debug('waiting for one of', promises.length, 'prefetches to settle');
        await Promise.race(promises);
      }
      const accept =
        {
          '.css': 'text/css,*/*;q=0.1',
          '.html': 'text/html',
        }[path.extname(url)] || '*/*';
      const p = prefetch(url, { accept, force })
        .then(({ status, ok, headers, data }) => {
          if (ok) {
            const hit = headers[HTTP_RESPONSE_HEADER_CACHE_STATUS] === 'HIT';
            if (hit) stats.hits++;
            else stats.misses++;
            // add this document's URLs to the list of URLs to prefetch
            if (headers['content-type']?.startsWith('text/css') && data.length > 0) {
              const encoding = headers['content-encoding'];
              const decoded = decodeContent(data, encoding);
              if (decoded) {
                data = decoded;
              } else {
                console.warn(`unsupported content-encoding: ${encoding}`);
                data = Buffer.alloc(0);
              }
              const base = url;
              cssForEachUrl(data.toString(), (value) => {
                if (value.startsWith('data:')) return undefined;
                // prefetch returns a document with the URLs replaced. CDN URLs
                // therefore appear as proxy paths or other relative URLs; not
                // as absolute URLs with CDN hostnames.
                const cleanedValue = removeHash(value);
                if (isProxyPath(cleanedValue)) {
                  const originUrl = decodeProxyPath(cleanedValue);
                  urls.push(originUrl);
                } else if (isRelativeUrl(cleanedValue)) {
                  const originUrl = urlResolve(base, cleanedValue);
                  urls.push(originUrl);
                }
                return undefined;
              });
            }
            callback?.({ type: 'progress', stats });
          } else {
            stats.failures++;
            callback?.({ type: 'error', url, status });
          }
        })
        .finally(() => {
          stats.total++;
          promises.splice(promises.indexOf(p), 1);
        });
      promises.push(p);
    }
  }
  //#endregion

  //#region rewrite documents

  /** Replace CDN URLs in script[src] and link[href] with proxy cache paths.
   *
   * @param html the HTML to process
   * @returns the processed HTML
   */
  function replaceUrlsInHtml(html: string): string {
    const htmlRoot = parseHtml(html);
    let modified = false;

    // rewrite script[src]
    for (const element of htmlRoot.querySelectorAll('script[src]')) {
      if (shouldProxyPath(element.attributes.src)) {
        modified = true;
        element.setAttribute('src', encodeProxyPath(element.attributes.src));
      }
    }

    // rewrite link[href]
    for (const element of htmlRoot.querySelectorAll('link[rel=stylesheet][href]')) {
      if (shouldProxyPath(element.attributes.href)) {
        modified = true;
        element.setAttribute('href', encodeProxyPath(element.attributes.href));
      }
    }

    return modified ? htmlRoot.outerHTML : html;
  }

  /** Replace CDN URLs with proxy cache paths.
   *
   * @param html the HTML to process
   * @returns the processed HTML
   */
  function replaceUrlsInCss(text: string) {
    const stylesheet = parseCss(text);
    let modified = false;

    cssForEachUrl(stylesheet, (value) => {
      if (value.startsWith('data:')) return;
      if (shouldProxyPath(value)) {
        const proxied = encodeProxyPath(value);
        modified = true;
        return proxied;
      }
    });
    return modified ? csstree.generate(stylesheet) : text;
  }

  function makeProxyReplacementStream(
    stream: NodeJS.ReadableStream,
    contentType: string,
    contentEncoding: string,
    base: string
  ): NodeJS.ReadableStream {
    if (contentType?.startsWith('text/css')) {
      return makeCssRewriterStream(stream, base, contentEncoding);
    }
    return stream;
  }

  function makeCssRewriterStream(
    istream: NodeJS.ReadableStream,
    base: string,
    encoding?: string
  ): NodeJS.ReadableStream {
    // Note that this doesn't handle nested encodings. This isn't conceptually
    // hard, but it adds complexity and these aren't used in the wild.
    switch (encoding) {
      case 'deflate': {
        // First decompress with inflate, then recompress with deflate
        const uz = zlib.createInflate();
        const z = zlib.createDeflate();
        const ws = makeCssRewriterStream(uz, base);
        forwardErrors(z, [istream, uz, ws]);
        istream.pipe(uz);
        ws.pipe(z);
        return z;
      }
      case 'gzip':
      case 'x-gzip': {
        // First decompress with gunzip, then recompress with gzip
        const uz = zlib.createGunzip();
        const z = zlib.createGzip();
        const ws = makeCssRewriterStream(uz, base);
        forwardErrors(z, [istream, uz, ws]);
        istream.pipe(uz);
        ws.pipe(z);
        return z;
      }
      default:
        if (encoding) {
          console.error(`unsupported content-encoding: ${encoding}`);
          return istream;
        }
    }
    async function* iter() {
      // css-tree requires the complete stylesheet before it can rewrite its AST.
      const text = await fromReadable(istream);
      yield replaceUrlsInCss(text.toString());
    }
    return Readable.from(iter());
  }
}

//#endregion

//#region helpers

function decodeContent(data: Buffer, encoding?: string): Buffer | null {
  switch (encoding) {
    case 'deflate':
      return zlib.inflateSync(data);
    case 'gzip':
    case 'x-gzip':
      return zlib.gunzipSync(data);
    default:
      return encoding ? null : data;
  }
}

function forwardErrors(destination: stream.Readable, sources: NodeJS.ReadableStream[]) {
  for (const source of sources) {
    source.on('error', (error) => destination.destroy(error));
  }
}

function waitForReadable(readable: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    readable.once('end', resolve);
    readable.once('error', reject);
  });
}

function waitForWritable(writable: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    writable.once('finish', resolve);
    writable.once('error', reject);
  });
}

/** Call `callback` for each URL in the CSS stylesheet. If `callback` returns a
 * value, replace the URL with that value. */
function cssForEachUrl(stylesheet: csstree.CssNode | string, callback: (url: string) => undefined | string) {
  csstree.walk(typeof stylesheet === 'string' ? parseCss(stylesheet) : stylesheet, {
    visit: 'Url',
    enter(node) {
      // csstree's node.value is a string, but the latest @types/css-tree (v1)
      // declares it as a node.
      //
      const urlNode = node as unknown as { value: string };
      const transformed = callback(urlNode.value);
      if (transformed) {
        urlNode.value = transformed;
      }
    },
  });
}

function removeArrayDuplicates<T>(array: T[]): T[] {
  return Array.from(new Set(array));
}

function isRelativeUrl(url: string) {
  return !/^[a-z]+:/i.test(url);
}

function removeHash(url: string): string {
  return url.replace(/#.*/, '');
}

// Source: nodejs documentation for Url.resolve
function urlResolve(from: string, to: string): string {
  const resolvedUrl = new URL(to, new URL(from, 'resolve://'));
  if (resolvedUrl.protocol === 'resolve:') {
    const { pathname, search, hash } = resolvedUrl;
    return pathname + search + hash;
  }
  return resolvedUrl.toString();
}

//#endregion

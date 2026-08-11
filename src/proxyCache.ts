import type { IncomingHttpHeaders } from 'node:http';
import stream from 'node:stream';
import * as cacache from 'cacache';
import fetch from 'node-fetch';
import { parse as parseHtml } from 'node-html-parser';
import { multiplexStreamWriter, WritableCounter } from './helpers/stream-helpers';
import { cacheLifetimeSeconds, canStoreSharedResponse, parseCacheControl } from './internal/cache-control';
import {
  cssForEachUrl,
  decodeContent,
  makeProxyReplacementStream,
  replaceUrlsInCss as rewriteCss,
} from './internal/content';
import { isDefined } from './ts-extras';

import path = require('node:path');
import assert = require('node:assert');

const debug = require('debug')('cdn-proxy-cache');
const MAX_REDIRECTS = 20;
const DEFAULT_MAX_CSS_TRANSFORM_BYTES = 5 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_WARM_CONCURRENCY = 20;

//#region exported types
export type ProxyCacheOptions = {
  cachePath: string;
  cacheSeeds: string[];
  /** Maximum decompressed CSS size that may be buffered for rewriting. */
  maxCssTransformBytes?: number;
  /** Receives structured cache lifecycle events. */
  onEvent?: (event: ProxyCacheEvent) => void;
  proxyPrefix: string;
  /** Maximum time for an origin request, including streaming its body. */
  requestTimeoutMs?: number;
  shouldProxyPath: (url: string) => boolean;
  /** Default maximum number of concurrent cache-warming requests. */
  warmConcurrency?: number;
};

export type ProxyCacheEvent =
  | { type: 'request'; url: string }
  | { type: 'cache-hit'; url: string; stale: boolean }
  | { type: 'cache-miss'; url: string }
  | { type: 'cache-write'; url: string; bytes: number }
  | { type: 'cache-skip'; url: string; reason: 'no-store' | 'private' }
  | { type: 'error'; url: string; phase: 'fetch' | 'stream'; error: Error };

export type ProxyCache = {
  // properties
  cachePath: string;
  proxyPrefix: string;

  // methods
  router: (req: RequestI, res: ResponseI) => Promise<void>;
  replaceUrlsInHtml: (html: string) => string;
  replaceUrlsInCss: (css: string) => string;

  // cache management methods
  clear: () => Promise<void>;
  warm: (options: WarmCacheOptions, callback?: (message: CacheWarmMessage) => void) => Promise<CacheWarmStats>;
  ls: typeof cacacheLsBind;

  isProxyPath: (url: string) => boolean;

  decodeProxyPath: (url: string, query?: RequestI['query']) => string;
  encodeProxyPath: (url: string) => string;
};

export type WarmCacheOptions = {
  /** Override the instance's cache-warming concurrency. */
  concurrency?: number;

  /** If true, re-fetch cache seeds and recursively-referenced items,
   * regardless of whether they're already cached and expiration status. */
  force?: boolean;

  /** If true, re-fetch all items that are currently in the cache, rather
   * than starting from the cache seeds. This flag only makes sense if
   * `force` is also true. */
  reload?: boolean;

  /** Cancel cache warming and all in-flight origin requests. */
  signal?: AbortSignal;
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
  headers: IncomingHttpHeaders;
  path: string;
  query: Record<string, unknown>;
  signal?: AbortSignal;
  once?(event: 'aborted', listener: () => void): unknown;
  off?(event: 'aborted', listener: () => void): unknown;
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
  maxCssTransformBytes = DEFAULT_MAX_CSS_TRANSFORM_BYTES,
  onEvent,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  shouldProxyPath,
  warmConcurrency = DEFAULT_WARM_CONCURRENCY,
}: ProxyCacheOptions): ProxyCache {
  requirePositiveInteger('maxCssTransformBytes', maxCssTransformBytes);
  requirePositiveInteger('requestTimeoutMs', requestTimeoutMs);
  requirePositiveInteger('warmConcurrency', warmConcurrency);

  return {
    cachePath,
    proxyPrefix,
    clear: () => cacache.rm.all(cachePath),
    router: cdnProxyRouter,
    replaceUrlsInHtml,
    replaceUrlsInCss,
    warm: warmCache,
    ls: cacache.ls.bind(cacache, cachePath),
    isProxyPath: (url) => url.startsWith(proxyPrefix),
    decodeProxyPath,
    encodeProxyPath,
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
    onEvent?.({ type: 'request', url: originUrl });
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

    let servingStale = false;
    if (cacheObject && !req.query.reload) {
      const { headers } = cacheObject.metadata;
      const policy = parseCacheControl(headers['cache-control']);
      const age = Math.max(0, Date.now() - cacheObject.time);
      const lifetime = cacheLifetimeSeconds(policy);
      const expired = lifetime !== undefined && age >= lifetime * 1000;
      const cannotReuse = policy.noStore || policy.isPrivate;
      const requiresRevalidation = cannotReuse || policy.noCache || (expired && policy.mustRevalidate);
      if (cannotReuse) await cacache.rm.entry(cachePath, cacheKey);

      if (!requiresRevalidation) {
        servingStale = expired;
        debug(servingStale ? 'cache stale' : 'cache hit', originUrl);
        onEvent?.({ type: 'cache-hit', url: originUrl, stale: servingStale });
        targetResponse.setHeader(HTTP_RESPONSE_HEADER_CACHE_STATUS, 'HIT');

        for (const key of Object.keys(headers)) {
          let value = headers[key];
          if (key === 'location' && shouldProxyPath(value)) value = encodeProxyPath(value);
          const headerMap: Record<string, string> = { server: 'origin-server' };
          targetResponse.setHeader(headerMap[key] ?? key, value);
        }
        targetResponse.setHeader('age', Math.floor(age / 1000));

        targetResponse.status(cacheObject.metadata.status);
        let cachedStream = cacache.get.stream(cachePath, cacheKey) as unknown as NodeJS.ReadableStream;
        cachedStream = makeProxyReplacementStream(
          cachedStream,
          headers['content-type'],
          headers['content-encoding'],
          transformCssUrl,
          maxCssTransformBytes
        );
        cachedStream.on('error', (error) => res.destroy(error));
        cachedStream.pipe(targetResponse);

        if (servingStale) {
          targetResponse = new NullWritable();
        } else {
          await waitForWritable(targetResponse);
          return;
        }
      }
    }

    debug('cache miss', originUrl);
    onEvent?.({ type: 'cache-miss', url: originUrl });

    // filter the headers, and combine string[] values back into strings
    const reqHeaders: Record<string, string> = Object.fromEntries(
      (
        Object.entries(req.headers)
          .filter(([key]) => headerAcceptList.includes(key))
          .filter(([_key, value]) => isDefined(value)) as [string, string | string[]][]
      ).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value])
    );
    if (acceptEncoding) reqHeaders['accept-encoding'] = acceptEncoding;
    const abortContext = createAbortContext(req, servingStale ? undefined : res, requestTimeoutMs);
    let responseStarted = false;
    try {
      const originResponse = await fetch(originUrl, {
        compress: false,
        headers: reqHeaders,
        redirect: 'manual',
        signal: abortContext.controller.signal,
      });

      responseStarted = true;
      targetResponse.status(originResponse.status);
      targetResponse.setHeader(HTTP_RESPONSE_HEADER_CACHE_STATUS, 'MISS');
      const contentType = originResponse.headers.get('content-type') ?? undefined;
      const contentEncoding = originResponse.headers.get('content-encoding') ?? undefined;
      originResponse.headers.forEach((value, key) => {
        if (key === 'content-length' && contentType?.startsWith('text/css')) return;
        const outputValue = key === 'location' && shouldProxyPath(value) ? encodeProxyPath(value) : value;
        targetResponse.setHeader(key, outputValue);
      });

      const redirected =
        300 < originResponse.status && originResponse.status < 400 && originResponse.headers.has('location');
      if (!originResponse.ok && !redirected) {
        debug(`Failed ${originResponse.ok} | ${originResponse.status} | ${originResponse.statusText}`);
        targetResponse.send(originResponse.statusText);
        return;
      }

      const responseHeaders = Object.fromEntries(
        Array.from(originResponse.headers.entries()).filter(([key]) => !uncacheableResponseHeaders.includes(key))
      );
      const cachePolicy = parseCacheControl(responseHeaders['cache-control']);
      if (!canStoreSharedResponse(cachePolicy)) {
        const reason = cachePolicy.noStore ? 'no-store' : 'private';
        onEvent?.({ type: 'cache-skip', url: originUrl, reason });
        const responseStream = makeProxyReplacementStream(
          originResponse.body,
          contentType,
          contentEncoding,
          transformCssUrl,
          maxCssTransformBytes
        );
        responseStream.on('error', (error) => targetResponse.destroy(error));
        responseStream.pipe(targetResponse);
        await Promise.all([waitForReadable(responseStream), waitForWritable(targetResponse)]);
        return;
      }

      const cacheWriteStream = cacache.put.stream(cachePath, cacheKey, {
        metadata: { originUrl, headers: responseHeaders, status: originResponse.status },
      }) as unknown as NodeJS.WritableStream;
      const cacheCommitted = waitForCacheCommit(cacheWriteStream);
      const streamLengthCounter = new WritableCounter();
      const responseInput = new stream.PassThrough();
      const originSink = multiplexStreamWriter([cacheWriteStream, streamLengthCounter, responseInput]);
      const responseStream = makeProxyReplacementStream(
        responseInput,
        contentType,
        contentEncoding,
        transformCssUrl,
        maxCssTransformBytes
      );
      responseStream.on('error', (error) => targetResponse.destroy(error));
      originResponse.body.pipe(originSink);
      responseStream.pipe(targetResponse);
      await Promise.all([
        waitForReadable(responseStream),
        waitForWritable(originSink),
        waitForWritable(targetResponse),
        cacheCommitted,
      ]);
      debug('wrote', streamLengthCounter.length, 'bytes to cache for', originUrl);
      onEvent?.({ type: 'cache-write', url: originUrl, bytes: streamLengthCounter.length });
    } catch (cause) {
      if (req.signal?.aborted) throw abortReason(req.signal);
      const error = toError(cause);
      onEvent?.({ type: 'error', url: originUrl, phase: responseStarted ? 'stream' : 'fetch', error });
      debug('origin request failed', originUrl, error);
      if (servingStale) return;
      if (responseStarted || abortContext.clientAborted) {
        targetResponse.destroy(error);
        return;
      }
      const status = abortContext.timedOut ? 504 : 502;
      targetResponse.status(status);
      targetResponse.send(`Error during request for ${originUrl}:\n${error.message}`);
    } finally {
      abortContext.dispose();
    }
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
    { accept = '*/*', force = false, signal }: { accept?: string; force?: boolean; signal?: AbortSignal },
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
      signal,
    };

    const res = new (class extends stream.Writable {
      chunks = [] as Buffer[];
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
      return prefetch(location, { accept, force, signal }, [...redirectChain, url]);
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
    { concurrency = warmConcurrency, force, reload, signal }: WarmCacheOptions,
    callback?: (message: CacheWarmMessage) => void
  ): Promise<CacheWarmStats> {
    requirePositiveInteger('concurrency', concurrency);
    if (signal?.aborted) throw abortReason(signal);
    const stats = { total: 0, failures: 0, hits: 0, misses: 0 };
    const urls = removeArrayDuplicates(reload ? await getCachedUrls() : cacheSeeds).sort();
    callback?.({ type: 'initial', total: urls.length });

    const seen = new Set<string>();
    const promises: Promise<void>[] = [];
    // `while` instead of `for`, because visit() can add to the array.
    try {
      while (urls.length > 0 || promises.length > 0) {
        if (signal?.aborted) throw abortReason(signal);
        const url = urls.shift();
        if (url) {
          if (seen.has(url)) continue;
          seen.add(url);
          callback?.({ type: 'prefetch', url });
          await visit(url);
        } else {
          await Promise.race(promises);
        }
      }
    } catch (error) {
      await Promise.allSettled(promises);
      throw error;
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
      const p = prefetch(url, { accept, force, signal })
        .then(({ status, ok, headers, data }) => {
          if (ok) {
            const hit = headers[HTTP_RESPONSE_HEADER_CACHE_STATUS] === 'HIT';
            if (hit) stats.hits++;
            else stats.misses++;
            // add this document's URLs to the list of URLs to prefetch
            if (headers['content-type']?.startsWith('text/css') && data.length > 0) {
              const encoding = headers['content-encoding'];
              const decoded = decodeContent(data, encoding, maxCssTransformBytes);
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
            callback?.({ type: 'progress', stats: { ...stats } });
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
  function replaceUrlsInCss(text: string): string {
    return rewriteCss(text, transformCssUrl);
  }

  function transformCssUrl(value: string): string | undefined {
    if (value.startsWith('data:') || !shouldProxyPath(value)) return undefined;
    return encodeProxyPath(value);
  }
}

//#endregion

//#region helpers

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

function waitForCacheCommit(writable: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    writable.once('integrity', resolve);
    writable.once('error', reject);
  });
}

function createAbortContext(req: RequestI, res: ResponseI | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let clientAborted = false;
  let timedOut = false;
  const abortFromSignal = () => controller.abort(abortReason(req.signal!));
  const abortFromClient = () => {
    clientAborted = true;
    controller.abort(new Error('Client disconnected'));
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Origin request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  req.signal?.addEventListener('abort', abortFromSignal, { once: true });
  req.once?.('aborted', abortFromClient);
  res?.once('close', abortFromClient);
  if (req.signal?.aborted) abortFromSignal();

  return {
    controller,
    get clientAborted() {
      return clientAborted;
    },
    get timedOut() {
      return timedOut;
    },
    dispose() {
      clearTimeout(timeout);
      req.signal?.removeEventListener('abort', abortFromSignal);
      req.off?.('aborted', abortFromClient);
      res?.off('close', abortFromClient);
    },
  };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Operation aborted');
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
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

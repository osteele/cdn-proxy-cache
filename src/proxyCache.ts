import type { IncomingHttpHeaders } from 'node:http';
import stream from 'node:stream';
import * as cacache from 'cacache';
import fetch from 'node-fetch';
import { parse as parseHtml } from 'node-html-parser';
import { multiplexStreamWriter } from './helpers/stream-helpers';
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
const TRANSFORMED_CSS_ENCODINGS = new Set([undefined, 'deflate', 'gzip', 'x-gzip']);

//#region exported types
export type ProxyCacheOptions = {
  cachePath: string;
  cacheSeeds: string[];
  /** Bump this value when closed-over shouldProxyPath configuration changes. */
  cssTransformVersion?: string;
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
  | { type: 'cache-skip'; url: string; reason: 'no-store' | 'private' | 'vary-star' }
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
const headerAcceptList = ['accept', 'accept-language', 'accept-encoding'];

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

type CacheMetadata = {
  /** Absent on cache entries written before transformed CSS was stored. */
  cssTransformed?: boolean;
  /** Identifies the configuration used to rewrite a stored CSS representation. */
  cssTransformFingerprint?: string;
  headers: Record<string, string>;
  /** Age reported by the origin when this representation was stored or revalidated. */
  initialAgeSeconds?: number;
  originUrl: string;
  status: number;
};

/** A null ResponseI */
class NullWritable extends stream.Writable {
  setHeader() {}
  send() {}
  status() {}
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    callback();
  }
}

export function createProxyCache({
  proxyPrefix,
  cachePath,
  cacheSeeds,
  cssTransformVersion = '',
  maxCssTransformBytes = DEFAULT_MAX_CSS_TRANSFORM_BYTES,
  onEvent,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  shouldProxyPath,
  warmConcurrency = DEFAULT_WARM_CONCURRENCY,
}: ProxyCacheOptions): ProxyCache {
  requirePositiveInteger('maxCssTransformBytes', maxCssTransformBytes);
  requirePositiveInteger('requestTimeoutMs', requestTimeoutMs);
  requirePositiveInteger('warmConcurrency', warmConcurrency);
  const inFlightRequests = new Map<string, Promise<void>>();
  const cssTransformFingerprint = JSON.stringify({
    schema: 1,
    proxyPrefix,
    shouldProxyPath: shouldProxyPath.toString(),
    version: cssTransformVersion,
  });

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
  async function cdnProxyRouter(req: RequestI, res: ResponseI, coalesce = true): Promise<void> {
    let targetResponse = res;
    const originUrl = decodeProxyPath(req.path, req.query);
    if (!shouldProxyPath(originUrl)) {
      targetResponse.status(403);
      targetResponse.send(`Refusing to proxy URL: ${originUrl}`);
      return;
    }
    onEvent?.({ type: 'request', url: originUrl });
    const accept = normalizeAccept(req.headers.accept);
    const acceptLanguage = normalizeAcceptLanguage(req.headers['accept-language']);
    const acceptEncoding = normalizeAcceptEncoding(req.headers['accept-encoding']);
    // An earlier version used a cryptographic digest of the stringified JSON;
    // however, the 'crypto' module is not present in VSCode.
    const cacheKey = JSON.stringify({
      url: originUrl,
      // Include every representation-selecting request header that the proxy
      // forwards. User-Agent is intentionally not forwarded so browser versions
      // do not fragment the shared cache.
      accept,
      acceptLanguage,
      acceptEncoding,
    });
    let cacheObject = await cacache.get.info(cachePath, cacheKey);

    targetResponse.setHeader('x-cdn-proxy-origin-url', originUrl);

    let servingStale = false;
    let staleResponseCompletion: Promise<void> | undefined;
    if (cacheObject && !req.query.reload) {
      const metadata = cacheObject.metadata as CacheMetadata;
      if (metadata.cssTransformed && metadata.cssTransformFingerprint !== cssTransformFingerprint) {
        await cacache.rm.entry(cachePath, cacheKey);
        cacheObject = null;
      } else {
        const { headers } = metadata;
        const policy = parseCacheControl(headers['cache-control']);
        const age = Math.max(0, Date.now() - cacheObject.time) + metadataInitialAgeSeconds(metadata) * 1000;
        const lifetime = cacheLifetimeSeconds(policy);
        const expired = lifetime !== undefined && age >= lifetime * 1000;
        const cannotReuse = policy.noStore || policy.isPrivate || variesOnWildcard(headers.vary);
        const requiresRevalidation = cannotReuse || policy.noCache || (expired && policy.mustRevalidate);
        if (cannotReuse) {
          await cacache.rm.entry(cachePath, cacheKey);
          cacheObject = null;
        }

        if (cacheObject && !requiresRevalidation) {
          servingStale = expired;
          debug(servingStale ? 'cache stale' : 'cache hit', originUrl);
          onEvent?.({ type: 'cache-hit', url: originUrl, stale: servingStale });
          const completion = serveCachedEntry(cacheObject, targetResponse, res, age);

          if (servingStale) {
            staleResponseCompletion = completion;
            targetResponse = new NullWritable();
          } else {
            await completion;
            return;
          }
        }
      }
    }

    debug('cache miss', originUrl);
    onEvent?.({ type: 'cache-miss', url: originUrl });

    if (coalesce) {
      const existingRequest = inFlightRequests.get(cacheKey);
      if (existingRequest) {
        if (servingStale) {
          await staleResponseCompletion;
          return;
        }
        await existingRequest.catch(() => undefined);
        return cdnProxyRouter(req, res, false);
      }

      const request = fetchOrigin();
      inFlightRequests.set(cacheKey, request);
      try {
        await request;
        await staleResponseCompletion;
      } finally {
        if (inFlightRequests.get(cacheKey) === request) inFlightRequests.delete(cacheKey);
      }
      return;
    }

    await fetchOrigin();
    await staleResponseCompletion;

    async function fetchOrigin(): Promise<void> {
      // Filter the headers, and combine string[] values back into strings.
      const reqHeaders: Record<string, string> = {};
      for (const key of headerAcceptList) {
        const value = req.headers[key];
        if (isDefined(value)) reqHeaders[key] = Array.isArray(value) ? value.join(',') : value;
      }
      reqHeaders.accept = accept;
      if (acceptLanguage) reqHeaders['accept-language'] = acceptLanguage;
      else delete reqHeaders['accept-language'];
      if (acceptEncoding) reqHeaders['accept-encoding'] = acceptEncoding;
      else delete reqHeaders['accept-encoding'];

      const cachedMetadata = cacheObject?.metadata as CacheMetadata | undefined;
      if (cacheObject && !req.query.reload) {
        const etag = cachedMetadata?.headers.etag;
        const lastModified = cachedMetadata?.headers['last-modified'];
        if (etag) reqHeaders['if-none-match'] = etag;
        if (lastModified) reqHeaders['if-modified-since'] = lastModified;
      }

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
        const contentType = originResponse.headers.get('content-type') ?? undefined;
        const contentEncoding = originResponse.headers.get('content-encoding') ?? undefined;
        const responseHeaders = Object.fromEntries(
          Array.from(originResponse.headers.entries())
            .filter(([key]) => !uncacheableResponseHeaders.includes(key))
            .map(([key, value]) => [key, key === 'location' ? resolveLocation(originUrl, value) : value])
        );

        if (originResponse.status === 304 && cacheObject && cachedMetadata) {
          const headers = { ...cachedMetadata.headers, ...responseHeaders };
          if (!('age' in responseHeaders)) delete headers.age;
          const refreshedMetadata = {
            ...cachedMetadata,
            headers,
            initialAgeSeconds: parseAgeSeconds(responseHeaders.age),
          } satisfies CacheMetadata;
          const refreshedEntry = await cacache.index.insert(cachePath, cacheKey, cacheObject.integrity, {
            metadata: refreshedMetadata,
            size: cacheObject.size,
          });
          debug('revalidated', originUrl);
          if (!servingStale) {
            onEvent?.({ type: 'cache-hit', url: originUrl, stale: false });
            await serveCachedEntry(
              refreshedEntry,
              targetResponse,
              res,
              metadataInitialAgeSeconds(refreshedMetadata) * 1000
            );
          }
          return;
        }

        targetResponse.status(originResponse.status);
        targetResponse.setHeader(HTTP_RESPONSE_HEADER_CACHE_STATUS, 'MISS');
        originResponse.headers.forEach((value, key) => {
          if (key === 'content-length' && contentType?.startsWith('text/css')) return;
          const outputValue = key === 'location' ? proxyLocation(value) : value;
          targetResponse.setHeader(key, outputValue);
        });

        const redirected = isRedirectStatus(originResponse.status) && originResponse.headers.has('location');
        if (!originResponse.ok && !redirected) {
          debug(`Failed ${originResponse.ok} | ${originResponse.status} | ${originResponse.statusText}`);
          targetResponse.send(originResponse.statusText);
          return;
        }

        const cachePolicy = parseCacheControl(responseHeaders['cache-control']);
        const varyStar = variesOnWildcard(responseHeaders.vary);
        if (!canStoreSharedResponse(cachePolicy) || varyStar) {
          if (cacheObject) await cacache.rm.entry(cachePath, cacheKey);
          const reason = cachePolicy.noStore ? 'no-store' : cachePolicy.isPrivate ? 'private' : 'vary-star';
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

        const cssTransformed =
          contentType?.startsWith('text/css') === true && TRANSFORMED_CSS_ENCODINGS.has(contentEncoding);
        const cacheWriteStream = cacache.put.stream(cachePath, cacheKey, {
          metadata: {
            cssTransformed,
            cssTransformFingerprint: cssTransformed ? cssTransformFingerprint : undefined,
            originUrl,
            headers: responseHeaders,
            initialAgeSeconds: parseAgeSeconds(responseHeaders.age),
            status: originResponse.status,
          } satisfies CacheMetadata,
        }) as unknown as NodeJS.WritableStream & { destroy(error?: Error): void };
        const cacheCommitted = waitForCacheCommit(cacheWriteStream);
        const responseStream = makeProxyReplacementStream(
          originResponse.body,
          contentType,
          contentEncoding,
          transformCssUrl,
          maxCssTransformBytes
        );
        const responseSink = multiplexStreamWriter([cacheWriteStream, targetResponse]);
        responseStream.on('error', (error) => responseSink.destroy(error));
        const responseComplete = waitForReadable(responseStream);
        const sinkComplete = waitForWritable(responseSink);
        const targetComplete = waitForWritable(targetResponse);
        responseStream.pipe(responseSink);
        const [bytes] = await Promise.all([cacheCommitted, responseComplete, sinkComplete, targetComplete]);
        debug('wrote', bytes, 'bytes to cache for', originUrl);
        onEvent?.({ type: 'cache-write', url: originUrl, bytes });
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

      function proxyLocation(value: string): string {
        const resolved = resolveLocation(originUrl, value);
        return shouldProxyPath(resolved) ? encodeProxyPath(resolved) : resolved;
      }
    }

    function serveCachedEntry(
      entry: cacache.CacheObject,
      response: ResponseI,
      errorResponse: ResponseI,
      ageMs: number
    ): Promise<void> {
      const metadata = entry.metadata as CacheMetadata;
      response.setHeader(HTTP_RESPONSE_HEADER_CACHE_STATUS, 'HIT');
      for (const [key, originalValue] of Object.entries(metadata.headers)) {
        const value =
          key === 'location' && shouldProxyPath(originalValue) ? encodeProxyPath(originalValue) : originalValue;
        response.setHeader(key === 'server' ? 'origin-server' : key, value);
      }
      response.setHeader('age', Math.floor(ageMs / 1000));
      response.status(metadata.status);

      const storedStream = cacache.get.stream.byDigest(cachePath, entry.integrity, {
        size: entry.size,
      }) as unknown as NodeJS.ReadableStream;
      const cachedStream = metadata.cssTransformed
        ? storedStream
        : makeProxyReplacementStream(
            storedStream,
            metadata.headers['content-type'],
            metadata.headers['content-encoding'],
            transformCssUrl,
            maxCssTransformBytes
          );
      cachedStream.on('error', (error) => errorResponse.destroy(error));
      const completion = waitForWritable(response);
      cachedStream.pipe(response);
      return completion;
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
    let originSearch = typeof query.search === 'string' ? query.search : undefined;
    const queryIndex = originUrl.indexOf('?');
    if (queryIndex >= 0) {
      const hashIndex = originUrl.indexOf('#', queryIndex);
      const queryEnd = hashIndex >= 0 ? hashIndex : originUrl.length;
      const proxyQuery = new URLSearchParams(originUrl.slice(queryIndex + 1, queryEnd));
      originSearch = proxyQuery.get('search') ?? originSearch;
      originUrl = originUrl.slice(0, queryIndex) + originUrl.slice(queryEnd);
    }
    if (originSearch !== undefined) {
      const hashIndex = originUrl.indexOf('#');
      const insertionPoint = hashIndex >= 0 ? hashIndex : originUrl.length;
      originUrl = `${originUrl.slice(0, insertionPoint)}?${originSearch}${originUrl.slice(insertionPoint)}`;
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
        if (this.collectsBody()) this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
        assert.ok(chunk instanceof Buffer);
        if (this.collectsBody()) this.chunks.push(chunk as Buffer);
        callback();
      }
      private collectsBody() {
        return this.headers['content-type']?.startsWith('text/css') === true;
      }
      streamError?: Error;
      _destroy(error: Error | null, callback: (error?: Error | null) => void) {
        this.streamError = error ?? undefined;
        callback();
      }
    })();

    debug(`warm cache for ${url}`);
    await cdnProxyRouter(req, res);
    if (res.streamError) {
      return { status: 502, ok: false, headers: res.headers, data: Buffer.alloc(0) };
    }
    const status = res.statusCode!;
    const redirected = isRedirectStatus(status) && res.headers.location?.startsWith(`${proxyPrefix}/`);
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
    return Object.values(cache).map((value) => (value.metadata as CacheMetadata).originUrl);
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

    const queued = new Set(urls);
    const promises = new Set<Promise<void>>();
    let nextUrlIndex = 0;
    // `while` instead of `for`, because visit() can add to the queue.
    try {
      while (nextUrlIndex < urls.length || promises.size > 0) {
        if (signal?.aborted) throw abortReason(signal);
        if (nextUrlIndex < urls.length) {
          const url = urls[nextUrlIndex++];
          callback?.({ type: 'prefetch', url });
          await visit(url);
        } else {
          await Promise.race(promises);
        }
      }
    } catch (error) {
      await Promise.allSettled([...promises]);
      throw error;
    }

    return stats;

    // This function returns immediately once it adds a fetch promise to the
    // array. (It does not wait for the fetch to initiate.) If there are already
    // `concurrency` promises pending, it waits for one to resolve before adding
    // the new promise and returning.
    async function visit(url: string) {
      if (promises.size >= concurrency) {
        // debug('waiting for one of', promises.size, 'prefetches to settle');
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
                  enqueue(originUrl);
                } else if (isRelativeUrl(cleanedValue)) {
                  const originUrl = urlResolve(base, cleanedValue);
                  enqueue(originUrl);
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
          promises.delete(p);
        });
      promises.add(p);
    }

    function enqueue(url: string) {
      if (queued.has(url)) return;
      queued.add(url);
      urls.push(url);
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

function waitForCacheCommit(writable: NodeJS.WritableStream): Promise<number> {
  return new Promise((resolve, reject) => {
    writable.once('size', resolve);
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

function normalizeAccept(value: string | string[] | undefined): string {
  const normalized = headerValue(value)
    ?.split(',')
    .map((part) =>
      part
        .trim()
        .replace(/\s*;\s*/g, ';')
        .replace(/\s*=\s*/g, '=')
    )
    .filter(Boolean)
    .sort()
    .join(', ');
  return normalized || '*/*';
}

function normalizeAcceptLanguage(value: string | string[] | undefined): string | null {
  const normalized = headerValue(value)
    ?.split(',')
    .map((part) =>
      part
        .trim()
        .replace(/^([^;]+)/, (languageRange) => languageRange.toLowerCase())
        .replace(/\s*;\s*/g, ';')
        .replace(/\s*=\s*/g, '=')
    )
    .filter(Boolean)
    .join(', ');
  return normalized || null;
}

function normalizeAcceptEncoding(value: string | string[] | undefined): string | null {
  const encodings = new Map<string, number>();
  for (const part of headerValue(value)?.split(',') ?? []) {
    const [rawName, ...parameters] = part.trim().split(';');
    const name = rawName.toLowerCase();
    if (!name || name === 'br') continue;
    const qValue = parameters
      .map((parameter) => parameter.trim().match(/^q\s*=\s*(0(?:\.\d+)?|1(?:\.0+)?)$/i)?.[1])
      .find(isDefined);
    const quality = qValue === undefined ? 1 : Number(qValue);
    if (quality <= 0) continue;
    const names = name === '*' ? ['deflate', 'gzip'] : [name];
    for (const encoding of names) {
      encodings.set(encoding, Math.max(quality, encodings.get(encoding) ?? 0));
    }
  }
  const normalized = [...encodings]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, quality]) => (quality === 1 ? name : `${name};q=${quality}`))
    .join(', ');
  return normalized || null;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(',') : value;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function resolveLocation(originUrl: string, location: string): string {
  try {
    return new URL(location, originUrl).toString();
  } catch (error) {
    if (error instanceof TypeError) return location;
    throw error;
  }
}

function variesOnWildcard(value: string | undefined): boolean {
  return value?.split(',').some((field) => field.trim() === '*') ?? false;
}

function parseAgeSeconds(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) return 0;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : 0;
}

function metadataInitialAgeSeconds(metadata: CacheMetadata): number {
  return metadata.initialAgeSeconds ?? parseAgeSeconds(metadata.headers.age);
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

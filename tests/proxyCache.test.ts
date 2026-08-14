import { describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import stream from 'node:stream';
import zlib from 'node:zlib';
import * as cacache from 'cacache';
import { warmCache as runWarmCache, showCacheInfo } from '../src/commands';
import { fromReadable } from '../src/helpers/stream-helpers';
import { decodeContent, makeProxyReplacementStream } from '../src/internal/content';
import { createProxyCache, type ProxyCacheEvent, type ProxyCacheOptions } from '../src/proxyCache';

function isCdnUrl(url: string): boolean {
  if (!/^https?:/.test(url)) return false;
  return ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com'].includes(new URL(url).hostname);
}

const testCache = createProxyCache({
  proxyPrefix: '/__proxy_cache',
  cachePath: path.join(os.tmpdir(), 'cdn-proxy-cache-test'),
  cacheSeeds: [],
  shouldProxyPath: isCdnUrl,
});

describe('CDN Proxy', () => {
  const { decodeProxyPath, encodeProxyPath } = testCache;

  describe('encodeProxyPath', () => {
    test('encodes CDN URL', () => {
      expect(encodeProxyPath('https://cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js')).toBe(
        '/__proxy_cache/cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js'
      );
    });

    test('ignores relative URLs', () => {
      expect(encodeProxyPath('/npm/p5@1.4.0/lib/p5.min.js')).toBe('/npm/p5@1.4.0/lib/p5.min.js');
    });

    test('ignores other schemas', () => {
      expect(encodeProxyPath('ftp://cdn.jsdelivr.net/npm/p5@1.4.0/lib/p5.min.js')).toBe(
        'ftp://cdn.jsdelivr.net/npm/p5@1.4.0/lib/p5.min.js'
      );
    });

    test('encodes query parameters', () => {
      expect(encodeProxyPath('https://cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js?a=1&b=2')).toBe(
        '/__proxy_cache/cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js?search=a%3D1%26b%3D2'
      );
    });

    test('preserves hashes', () => {
      expect(encodeProxyPath('https://cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js#hash')).toBe(
        '/__proxy_cache/cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js#hash'
      );
      expect(encodeProxyPath('https://cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js?a=1&b=2#hash')).toBe(
        '/__proxy_cache/cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js?search=a%3D1%26b%3D2#hash'
      );
    });
  });

  describe('decodeProxyPath', () => {
    function testRoundtripEquality(originUrl: string) {
      expect(decodeProxyPath(encodeProxyPath(originUrl), {})).toBe(originUrl);
    }

    test('decodes CDN URL', () => testRoundtripEquality('https://cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js'));

    test('decodes query parameters', () =>
      testRoundtripEquality('https://cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js?a=1&b=2'));

    test('preserves percent-encoded query values', () => {
      testRoundtripEquality('https://cdn.jsdelivr.net/file?next=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&literal=%252F');
      testRoundtripEquality('https://cdn.jsdelivr.net/file?invalid=%ZZ');
    });

    test('preserves hashes', () => {
      testRoundtripEquality('https://cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js#hash');
      testRoundtripEquality('https://cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js?a=1&b=2#hash');
    });

    test('preserves scheme', () => {
      testRoundtripEquality('https://cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js');
      testRoundtripEquality('http://cdn.jsdelivr.net/npm/p5@1.4.0/lib/p5.min.js');
    });
  });

  test('rewrites proxied scripts and stylesheets', () => {
    const html = [
      '<script src="https://cdn.jsdelivr.net/example.js"></script>',
      '<script src="/local.js"></script>',
      '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/example.css">',
    ].join('');

    expect(testCache.replaceUrlsInHtml(html)).toBe(
      [
        '<script src="/__proxy_cache/cdn.jsdelivr.net/example.js"></script>',
        '<script src="/local.js"></script>',
        '<link rel="stylesheet" href="/__proxy_cache/cdnjs.cloudflare.com/example.css">',
      ].join('')
    );
  });

  describe('cache commands', () => {
    test('accepts a relative proxy path when showing cache info', async () => {
      const consoleLog = spyOn(console, 'log').mockImplementation(() => {});
      try {
        await showCacheInfo(testCache, '/__proxy_cache/cdn.jsdelivr.net/example.js');
        expect(consoleLog).toHaveBeenCalledWith('No entry found for /__proxy_cache/cdn.jsdelivr.net/example.js');
      } finally {
        consoleLog.mockRestore();
      }
    });

    test('rejects instead of terminating the process when warming fails', async () => {
      const failingCache = {
        ...testCache,
        warm: async () => ({ total: 2, failures: 1, hits: 0, misses: 1 }),
      };

      await expect(runWarmCache(failingCache, { verbose: true })).rejects.toThrow(
        'Failed to fetch 1 of 2 cache entries'
      );
    });
  });

  test('refuses URLs rejected by shouldProxyPath', async () => {
    const response = new (class extends stream.Writable {
      body = '';
      statusCode = 200;

      setHeader() {}
      send(chunk: string | Buffer) {
        this.body += chunk.toString();
      }
      status(code: number) {
        this.statusCode = code;
      }
      _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
        callback();
      }
    })();

    await testCache.router({ headers: {}, path: 'internal.example/secret', query: {} }, response);

    expect(response.statusCode).toBe(403);
    expect(response.body).toBe('Refusing to proxy URL: https://internal.example/secret');
  });

  describe('content encoding', () => {
    for (const encoding of ['deflate', 'gzip', 'x-gzip'] as const) {
      test(`rewrites ${encoding}-encoded CSS through the production stream`, async () => {
        const css = Buffer.from('body { background: url("https://cdn.jsdelivr.net/asset.png"); }');
        const compressed = encoding === 'deflate' ? zlib.deflateSync(css) : zlib.gzipSync(css);
        const outputStream = makeProxyReplacementStream(
          stream.Readable.from(compressed),
          'text/css',
          encoding,
          (url) => (isCdnUrl(url) ? testCache.encodeProxyPath(url) : undefined)
        );
        const output = await fromReadable(outputStream);
        if (!Buffer.isBuffer(output)) throw new TypeError('Expected a Buffer');

        const decoded = decodeContent(output, encoding);
        expect(decoded?.toString()).toContain('/__proxy_cache/cdn.jsdelivr.net/asset.png');
        expect(decodeContent(compressed, encoding)?.toString()).toBe(css.toString());
      });
    }

    test('propagates compressed CSS stream errors', async () => {
      const outputStream = makeProxyReplacementStream(
        stream.Readable.from('not deflate data'),
        'text/css',
        'deflate',
        () => undefined
      );
      await expect(fromReadable(outputStream)).rejects.toThrow();
    });

    test('rejects stylesheets above the transformation limit', async () => {
      const outputStream = makeProxyReplacementStream(
        stream.Readable.from('body { color: red; }'),
        'text/css',
        undefined,
        () => undefined,
        8
      );
      await expect(fromReadable(outputStream)).rejects.toThrow('8-byte transformation limit');
    });

    test('passes non-CSS content through without transforming it', async () => {
      const transformUrl = spyOn({ transformUrl: () => undefined }, 'transformUrl');
      const input = stream.Readable.from('plain text');
      const outputStream = makeProxyReplacementStream(input, 'text/plain', undefined, transformUrl);

      expect(outputStream).toBe(input);
      expect(await fromReadable(outputStream)).toBe('plain text');
      expect(transformUrl).not.toHaveBeenCalled();
    });

    test('recognizes CSS content types with parameters', async () => {
      const outputStream = makeProxyReplacementStream(
        stream.Readable.from('body { background: url("https://cdn.jsdelivr.net/asset.png"); }'),
        'text/css; charset=utf-8',
        undefined,
        (url) => (isCdnUrl(url) ? testCache.encodeProxyPath(url) : undefined)
      );

      expect((await fromReadable(outputStream)).toString()).toContain('/__proxy_cache/cdn.jsdelivr.net/asset.png');
    });

    test('forwards gzip source errors to the output stream', async () => {
      const input = new stream.PassThrough();
      const outputStream = makeProxyReplacementStream(input, 'text/css', 'gzip', () => undefined);
      const completion = fromReadable(outputStream);

      input.destroy(new Error('origin body failed'));

      await expect(completion).rejects.toThrow('origin body failed');
    });
  });

  describe('cache warming integration', () => {
    test('discovers assets referenced by CSS', async () => {
      let origin = '';
      let assetRequests = 0;
      const server = http.createServer((req, res) => {
        if (req.url === '/style.css') {
          res.setHeader('content-type', 'text/css');
          res.end('body { background: url("./asset.png"); }');
        } else if (req.url === '/asset.png') {
          assetRequests++;
          res.setHeader('content-type', 'image/png');
          res.end('asset');
        } else {
          res.statusCode = 404;
          res.end();
        }
      });
      origin = await listen(server);
      const cache = createLocalCache(origin, [`${origin}/style.css`]);

      try {
        const stats = await cache.warm({});
        expect(stats).toEqual({ total: 2, failures: 0, hits: 0, misses: 2 });
        expect(assetRequests).toBe(1);
      } finally {
        await cache.clear();
        await close(server);
      }
    });

    test('treats proxy-prefix lookalikes in CSS as relative origin paths', async () => {
      let origin = '';
      let assetRequests = 0;
      const requests: string[] = [];
      const server = http.createServer((req, res) => {
        requests.push(req.url ?? '');
        if (req.url === '/style.css') {
          res.setHeader('content-type', 'text/css');
          res.end('body { background: url("/__proxy_cache-other/asset.png"); }');
        } else if (req.url === '/__proxy_cache-other/asset.png') {
          assetRequests++;
          res.setHeader('content-type', 'image/png');
          res.end('asset');
        } else {
          res.statusCode = 404;
          res.end();
        }
      });
      origin = await listen(server);
      const cache = createLocalCache(origin, [`${origin}/style.css`]);

      try {
        const stats = await cache.warm({});
        expect(requests).toEqual(['/style.css', '/__proxy_cache-other/asset.png']);
        expect(stats).toEqual({ total: 2, failures: 0, hits: 0, misses: 2 });
        expect(assetRequests).toBe(1);
      } finally {
        await cache.clear();
        await close(server);
      }
    });

    test('serves fresh responses from cache', async () => {
      let requests = 0;
      const server = http.createServer((_req, res) => {
        requests++;
        res.setHeader('cache-control', 'max-age=60');
        res.end('asset');
      });
      const origin = await listen(server);
      const events: ProxyCacheEvent[] = [];
      const cache = createLocalCache(origin, [`${origin}/asset`], { onEvent: (event) => events.push(event) });

      try {
        await cache.warm({});
        await cache.warm({});
        expect(requests).toBe(1);
        expect(events.some((event) => event.type === 'cache-hit' && !event.stale)).toBe(true);
      } finally {
        await cache.clear();
        await close(server);
      }
    });

    test('coalesces concurrent cache misses', async () => {
      let requests = 0;
      const server = http.createServer((_req, res) => {
        requests++;
        res.setHeader('cache-control', 'max-age=60');
        setTimeout(() => res.end('asset'), 25);
      });
      const origin = await listen(server);
      const cache = createLocalCache(origin, []);

      try {
        const responses = await Promise.all(Array.from({ length: 8 }, () => requestCache(cache, `${origin}/asset`)));
        expect(requests).toBe(1);
        expect(responses.map((response) => response.body)).toEqual(Array(8).fill('asset'));
      } finally {
        await cache.clear();
        await close(server);
      }
    });

    test('cancels a coalesced warming waiter without canceling the shared transfer', async () => {
      let requests = 0;
      const originRelease = deferred();
      const originStarted = deferred();
      const followerJoined = deferred();
      const server = http.createServer((_req, res) => {
        requests++;
        originStarted.resolve();
        res.setHeader('cache-control', 'max-age=60');
        void originRelease.promise.then(() => res.end('asset'));
      });
      const origin = await listen(server);
      let misses = 0;
      const cache = createLocalCache(origin, [`${origin}/asset`], {
        onEvent: (event) => {
          if (event.type === 'cache-miss' && ++misses === 2) followerJoined.resolve();
        },
      });
      const controller = new AbortController();
      let owner: ReturnType<typeof cache.warm> | undefined;
      let follower: ReturnType<typeof cache.warm> | undefined;

      try {
        owner = cache.warm({});
        await originStarted.promise;
        follower = cache.warm({ signal: controller.signal });
        await followerJoined.promise;
        controller.abort(new Error('stop follower'));

        await expect(withTimeout(follower, 100)).rejects.toThrow('stop follower');
        expect(requests).toBe(1);

        originRelease.resolve();
        await expect(owner).resolves.toMatchObject({ misses: 1, failures: 0 });
        expect(Object.keys(await cache.ls())).toHaveLength(1);
      } finally {
        originRelease.resolve();
        await Promise.allSettled([owner, follower].filter((promise) => promise !== undefined));
        await cache.clear();
        await close(server);
      }
    });

    test('recovers coalesced waiters after the generation owner is canceled', async () => {
      let requests = 0;
      let misses = 0;
      let countForcedMisses = false;
      let forcedMisses = 0;
      const firstOriginStarted = deferred();
      const followerJoined = deferred();
      const forcedFollowersJoined = deferred();
      const forcedOriginStarted = deferred();
      const forcedOriginRelease = deferred();
      const server = http.createServer((_req, res) => {
        requests++;
        res.setHeader('cache-control', 'max-age=60');
        if (requests === 1) {
          firstOriginStarted.resolve();
        } else if (requests === 2) {
          res.end('asset');
        } else {
          forcedOriginStarted.resolve();
          void forcedOriginRelease.promise.then(() => res.end('asset'));
        }
      });
      const origin = await listen(server);
      const assetUrl = `${origin}/asset?variant=one`;
      const cache = createLocalCache(origin, [assetUrl], {
        onEvent: (event) => {
          if (event.type !== 'cache-miss') return;
          if (++misses === 2) followerJoined.resolve();
          if (countForcedMisses && ++forcedMisses === 2) forcedFollowersJoined.resolve();
        },
      });
      const controller = new AbortController();
      let owner: ReturnType<typeof cache.warm> | undefined;
      let follower: ReturnType<typeof cache.warm> | undefined;

      try {
        owner = cache.warm({ signal: controller.signal });
        await firstOriginStarted.promise;
        follower = cache.warm({});
        await followerJoined.promise;
        controller.abort(new Error('stop owner'));

        await expect(withTimeout(owner, 500)).rejects.toThrow('stop owner');
        await expect(withTimeout(follower, 500)).resolves.toMatchObject({ misses: 1, failures: 0 });
        expect(requests).toBe(2);
        expect(Object.keys(await cache.ls())).toHaveLength(1);

        await expect(cache.warm({})).resolves.toMatchObject({ hits: 1, failures: 0 });
        expect(requests).toBe(2);

        countForcedMisses = true;
        const forced = [cache.warm({ force: true }), cache.warm({ force: true })];
        await forcedFollowersJoined.promise;
        await forcedOriginStarted.promise;
        await new Promise((resolve) => setImmediate(resolve));
        expect(requests).toBe(3);
        forcedOriginRelease.resolve();
        await Promise.all(forced);
        expect(forcedMisses).toBe(2);
      } finally {
        controller.abort();
        forcedOriginRelease.resolve();
        await Promise.allSettled([owner, follower].filter((promise) => promise !== undefined));
        await cache.clear();
        await close(server);
      }
    });

    test('retries a forced refresh when its shared generation is canceled', async () => {
      let requests = 0;
      let misses = 0;
      const canceledRefreshStarted = deferred();
      const followerJoined = deferred();
      const server = http.createServer((_req, res) => {
        requests++;
        res.setHeader('cache-control', 'max-age=60');
        if (requests === 1) {
          res.end('version one');
        } else if (requests === 2) {
          canceledRefreshStarted.resolve();
        } else {
          res.end('version two');
        }
      });
      const origin = await listen(server);
      const cache = createLocalCache(origin, [`${origin}/asset`], {
        onEvent: (event) => {
          if (event.type === 'cache-miss' && ++misses === 3) followerJoined.resolve();
        },
      });
      const controller = new AbortController();
      let owner: ReturnType<typeof cache.warm> | undefined;
      let follower: ReturnType<typeof cache.warm> | undefined;

      try {
        await cache.warm({});
        owner = cache.warm({ force: true, signal: controller.signal });
        await canceledRefreshStarted.promise;
        follower = cache.warm({ force: true });
        await followerJoined.promise;
        controller.abort(new Error('cancel forced owner'));

        await expect(withTimeout(owner, 500)).rejects.toThrow('cancel forced owner');
        await expect(withTimeout(follower, 500)).resolves.toMatchObject({ misses: 1, failures: 0 });
        expect(requests).toBe(3);
        await expect(requestCache(cache, `${origin}/asset`)).resolves.toMatchObject({ body: 'version two' });
      } finally {
        controller.abort();
        await Promise.allSettled([owner, follower].filter((promise) => promise !== undefined));
        await cache.clear();
        await close(server);
      }
    });

    test('retries a forced refresh when its shared generation fails', async () => {
      let requests = 0;
      let misses = 0;
      let failedRefreshResponse: http.ServerResponse | undefined;
      const failedRefreshStarted = deferred();
      const followerJoined = deferred();
      const server = http.createServer((_req, res) => {
        requests++;
        res.setHeader('cache-control', 'max-age=60');
        if (requests === 1) {
          res.end('version one');
        } else if (requests === 2) {
          failedRefreshResponse = res;
          failedRefreshStarted.resolve();
        } else {
          res.end('version two');
        }
      });
      const origin = await listen(server);
      const assetUrl = `${origin}/asset`;
      const cache = createLocalCache(origin, [], {
        onEvent: (event) => {
          if (event.type === 'cache-miss' && ++misses === 3) {
            failedRefreshResponse!.statusCode = 503;
            failedRefreshResponse!.end('failed refresh');
            followerJoined.resolve();
          }
        },
      });
      let owner: ReturnType<typeof requestCache> | undefined;
      let follower: ReturnType<typeof requestCache> | undefined;

      try {
        await requestCache(cache, assetUrl);
        owner = requestCache(cache, assetUrl, {}, undefined, true);
        await failedRefreshStarted.promise;
        follower = requestCache(cache, assetUrl, {}, undefined, true);
        await followerJoined.promise;

        await expect(withTimeout(owner, 500)).resolves.toMatchObject({ statusCode: 503 });
        await expect(withTimeout(follower, 500)).resolves.toMatchObject({ statusCode: 200, body: 'version two' });
        expect(requests).toBe(3);
      } finally {
        await Promise.allSettled([owner, follower].filter((promise) => promise !== undefined));
        await cache.clear();
        await close(server);
      }
    });

    test('preserves the origin query when joining a successful reload', async () => {
      let requests = 0;
      const requestTargets: string[] = [];
      const reloadStarted = deferred();
      const reloadRelease = deferred();
      const server = http.createServer((req, res) => {
        requests++;
        requestTargets.push(req.url ?? '');
        res.setHeader('cache-control', 'max-age=60');
        if (requests === 1) {
          res.end('version one');
        } else if (requests === 2) {
          reloadStarted.resolve();
          void reloadRelease.promise.then(() => res.end('version two'));
        } else {
          res.end('unexpected transfer');
        }
      });
      const origin = await listen(server);
      const cache = createLocalCache(origin, []);
      const assetUrl = `${origin}/asset?variant=one`;
      let reloads: ReturnType<typeof requestCache>[] = [];

      try {
        await requestCache(cache, assetUrl);
        reloads = [
          requestCache(cache, assetUrl, {}, undefined, true),
          requestCache(cache, assetUrl, {}, undefined, true),
        ];
        await reloadStarted.promise;
        reloadRelease.resolve();
        const responses = await Promise.all(reloads);

        expect(responses.map((response) => response.body)).toEqual(['version two', 'version two']);
        expect(requests).toBe(2);
        expect(requestTargets).toEqual(['/asset?variant=one', '/asset?variant=one']);
      } finally {
        reloadRelease.resolve();
        await Promise.allSettled(reloads);
        await cache.clear();
        await close(server);
      }
    });

    test('coalesces concurrent stale refreshes', async () => {
      let requests = 0;
      const server = http.createServer((_req, res) => {
        requests++;
        res.setHeader('cache-control', 'max-age=0');
        res.end(Buffer.alloc(64 * 1024, 'x'));
      });
      const origin = await listen(server);
      const cache = createLocalCache(origin, []);

      try {
        await requestCache(cache, `${origin}/asset`);
        await Promise.all(Array.from({ length: 8 }, () => requestCache(cache, `${origin}/asset`)));
        expect(requests).toBe(2);
      } finally {
        await cache.clear();
        await close(server);
      }
    });

    test('retries a forced follower after a stale refresh fails', async () => {
      let requests = 0;
      let misses = 0;
      let failedRefreshResponse: http.ServerResponse | undefined;
      const refreshStarted = deferred();
      const followerJoined = deferred();
      const server = http.createServer((_req, res) => {
        requests++;
        if (requests === 1) {
          res.setHeader('cache-control', 'max-age=0');
          res.end('version one');
        } else if (requests === 2) {
          failedRefreshResponse = res;
          refreshStarted.resolve();
        } else {
          res.setHeader('cache-control', 'max-age=60');
          res.end('version two');
        }
      });
      const origin = await listen(server);
      const assetUrl = `${origin}/asset`;
      const cache = createLocalCache(origin, [], {
        onEvent: (event) => {
          if (event.type === 'cache-miss' && ++misses === 3) {
            failedRefreshResponse!.statusCode = 503;
            failedRefreshResponse!.end('failed refresh');
            followerJoined.resolve();
          }
        },
      });
      let staleOwner: ReturnType<typeof requestCache> | undefined;
      let forcedFollower: ReturnType<typeof requestCache> | undefined;

      try {
        await requestCache(cache, assetUrl);
        staleOwner = requestCache(cache, assetUrl);
        await refreshStarted.promise;
        forcedFollower = requestCache(cache, assetUrl, {}, undefined, true);
        await followerJoined.promise;

        await expect(withTimeout(staleOwner, 500)).resolves.toMatchObject({ body: 'version one' });
        await expect(withTimeout(forcedFollower, 500)).resolves.toMatchObject({ body: 'version two' });
        expect(requests).toBe(3);
      } finally {
        failedRefreshResponse?.end();
        await Promise.allSettled([staleOwner, forcedFollower].filter((promise) => promise !== undefined));
        await cache.clear();
        await close(server);
      }
    });

    test('retains stale data and permits a new refresh after the owner is canceled', async () => {
      let requests = 0;
      const refreshStarted = deferred();
      const server = http.createServer((_req, res) => {
        requests++;
        if (requests === 1) {
          res.setHeader('cache-control', 'max-age=0');
          res.end('version one');
        } else if (requests === 2) {
          refreshStarted.resolve();
        } else {
          res.setHeader('cache-control', 'max-age=60');
          res.end('version two');
        }
      });
      const origin = await listen(server);
      const cache = createLocalCache(origin, []);
      const controller = new AbortController();
      let refreshOwner: ReturnType<typeof requestCache> | undefined;

      try {
        await expect(requestCache(cache, `${origin}/asset`)).resolves.toMatchObject({ body: 'version one' });

        refreshOwner = requestCache(cache, `${origin}/asset`, {}, controller.signal);
        await refreshStarted.promise;
        await expect(withTimeout(requestCache(cache, `${origin}/asset`), 100)).resolves.toMatchObject({
          body: 'version one',
        });
        expect(requests).toBe(2);

        controller.abort(new Error('stop refresh owner'));
        await expect(withTimeout(refreshOwner, 500)).rejects.toThrow('stop refresh owner');

        await expect(requestCache(cache, `${origin}/asset`)).resolves.toMatchObject({ body: 'version one' });
        await expect(requestCache(cache, `${origin}/asset`)).resolves.toMatchObject({ body: 'version two' });
        expect(requests).toBe(3);
      } finally {
        controller.abort();
        await Promise.allSettled([refreshOwner].filter((promise) => promise !== undefined));
        await cache.clear();
        await close(server);
      }
    });

    test('follows relative redirects while warming', async () => {
      let targetRequests = 0;
      const server = http.createServer((req, res) => {
        if (req.url === '/start') {
          res.statusCode = 302;
          res.setHeader('location', './asset');
          res.end('redirect');
        } else if (req.url === '/asset') {
          targetRequests++;
          res.end('asset');
        } else {
          res.statusCode = 404;
          res.end();
        }
      });
      const origin = await listen(server);
      const cache = createLocalCache(origin, [`${origin}/start`]);

      try {
        const stats = await cache.warm({});
        expect(stats.failures).toBe(0);
        expect(targetRequests).toBe(1);
        expect(Object.keys(await cache.ls())).toHaveLength(2);
      } finally {
        await cache.clear();
        await close(server);
      }
    });

    test('revalidates cached responses with origin validators', async () => {
      let requests = 0;
      let conditionalRequests = 0;
      const server = http.createServer((req, res) => {
        requests++;
        res.setHeader('cache-control', 'no-cache');
        res.setHeader('etag', '"asset-v1"');
        if (req.headers['if-none-match'] === '"asset-v1"') {
          conditionalRequests++;
          res.statusCode = 304;
          res.end();
        } else {
          res.end('asset');
        }
      });
      const origin = await listen(server);
      const cache = createLocalCache(origin, []);

      try {
        const first = await requestCache(cache, `${origin}/asset`);
        const second = await requestCache(cache, `${origin}/asset`);
        expect(requests).toBe(2);
        expect(conditionalRequests).toBe(1);
        expect(first.body).toBe('asset');
        expect(second.body).toBe('asset');
        expect(second.statusCode).toBe(200);
      } finally {
        await cache.clear();
        await close(server);
      }
    });

    test('canonicalizes equivalent accept-encoding values', async () => {
      let requests = 0;
      const server = http.createServer((_req, res) => {
        requests++;
        res.setHeader('cache-control', 'max-age=60');
        res.end('asset');
      });
      const origin = await listen(server);
      const cache = createLocalCache(origin, []);

      try {
        await requestCache(cache, `${origin}/asset`, { 'accept-encoding': 'gzip, deflate, br' });
        await requestCache(cache, `${origin}/asset`, { 'accept-encoding': 'deflate, gzip' });
        expect(requests).toBe(1);
        expect(Object.keys(await cache.ls())).toHaveLength(1);
      } finally {
        await cache.clear();
        await close(server);
      }
    });

    test('partitions cached responses by accept-language', async () => {
      let requests = 0;
      const server = http.createServer((req, res) => {
        requests++;
        res.setHeader('cache-control', 'max-age=60');
        res.setHeader('vary', 'Accept-Language');
        res.end(req.headers['accept-language'] ?? 'none');
      });
      const origin = await listen(server);
      const cache = createLocalCache(origin, []);

      try {
        const english = await requestCache(cache, `${origin}/asset`, { 'accept-language': 'en-US' });
        const french = await requestCache(cache, `${origin}/asset`, { 'accept-language': 'fr-FR' });
        const englishAgain = await requestCache(cache, `${origin}/asset`, { 'accept-language': 'en-us' });
        expect(english.body).toBe('en-us');
        expect(french.body).toBe('fr-fr');
        expect(englishAgain.body).toBe('en-us');
        expect(requests).toBe(2);
      } finally {
        await cache.clear();
        await close(server);
      }
    });

    test('does not store responses with Vary wildcard', async () => {
      let requests = 0;
      const server = http.createServer((_req, res) => {
        requests++;
        res.setHeader('vary', '*');
        res.end(`asset ${requests}`);
      });
      const origin = await listen(server);
      const cache = createLocalCache(origin, []);

      try {
        expect((await requestCache(cache, `${origin}/asset`)).body).toBe('asset 1');
        expect((await requestCache(cache, `${origin}/asset`)).body).toBe('asset 2');
        expect(Object.keys(await cache.ls())).toHaveLength(0);
      } finally {
        await cache.clear();
        await close(server);
      }
    });

    test('stores rewritten CSS so cache hits do not repeat the transformation', async () => {
      let assetChecks = 0;
      const server = http.createServer((_req, res) => {
        res.setHeader('cache-control', 'max-age=60');
        res.setHeader('content-type', 'text/css');
        res.end(`body { background: url("${origin}/asset.png"); }`);
      });
      const origin = await listen(server);
      const cache = createLocalCache(origin, [], {
        shouldProxyPath: (url) => {
          if (url === `${origin}/asset.png`) assetChecks++;
          return url.startsWith(`${origin}/`);
        },
      });

      try {
        await requestCache(cache, `${origin}/style.css`);
        expect(assetChecks).toBe(1);
        await requestCache(cache, `${origin}/style.css`);
        expect(assetChecks).toBe(1);
        const entries = Object.values(await cache.ls());
        expect(entries).toHaveLength(1);
        expect(entries[0].metadata?.cssTransformed).toBe(true);
        const stored = await cacache.get.byDigest(cache.cachePath, entries[0].integrity);
        expect(stored.toString()).toContain('/__proxy_cache/http/127.0.0.1');
      } finally {
        await cache.clear();
        await close(server);
      }
    });

    test('invalidates transformed CSS when the transformation configuration changes', async () => {
      let requests = 0;
      const server = http.createServer((_req, res) => {
        requests++;
        res.setHeader('cache-control', 'max-age=60');
        res.setHeader('content-type', 'text/css');
        res.end(`body { background: url("${origin}/asset.png"); }`);
      });
      const origin = await listen(server);
      const cachePath = path.join(os.tmpdir(), `cdn-proxy-cache-test-${randomUUID()}`);
      const baseOptions = {
        cachePath,
        cacheSeeds: [],
        shouldProxyPath: (url: string) => url.startsWith(`${origin}/`),
      };
      const firstCache = createProxyCache({ ...baseOptions, proxyPrefix: '/cache-one' });
      const secondCache = createProxyCache({ ...baseOptions, proxyPrefix: '/cache-two' });

      try {
        expect((await requestCache(firstCache, `${origin}/style.css`)).body).toContain('/cache-one/');
        expect((await requestCache(secondCache, `${origin}/style.css`)).body).toContain('/cache-two/');
        expect(requests).toBe(2);
      } finally {
        await secondCache.clear();
        await close(server);
      }
    });

    test('stops redirect cycles', async () => {
      let origin = '';
      let requests = 0;
      const server = http.createServer((req, res) => {
        requests++;
        res.statusCode = 302;
        res.setHeader('location', `${origin}${req.url === '/a' ? '/b' : '/a'}`);
        res.end('redirect');
      });
      origin = await listen(server);
      const cache = createLocalCache(origin, [`${origin}/a`]);

      try {
        const stats = await cache.warm({});
        expect(stats.failures).toBe(1);
        expect(requests).toBe(2);
      } finally {
        await cache.clear();
        await close(server);
      }
    });

    for (const { directive, name, shouldStore } of [
      { directive: 'no-store', name: 'does not store no-store responses', shouldStore: false },
      { directive: 'no-cache', name: 'revalidates no-cache responses', shouldStore: true },
      {
        directive: 'max-age=0, must-revalidate',
        name: 'revalidates expired must-revalidate responses',
        shouldStore: true,
      },
    ]) {
      test(name, async () => {
        let requests = 0;
        const server = http.createServer((_req, res) => {
          requests++;
          res.setHeader('cache-control', directive);
          res.end(`response ${requests}`);
        });
        const origin = await listen(server);
        const cache = createLocalCache(origin, [`${origin}/asset`]);

        try {
          await cache.warm({});
          await cache.warm({});
          expect(requests).toBe(2);
          expect(Object.keys(await cache.ls()).length).toBe(shouldStore ? 1 : 0);
        } finally {
          await cache.clear();
          await close(server);
        }
      });
    }

    test('includes the origin Age when deciding whether to revalidate', async () => {
      let requests = 0;
      const server = http.createServer((_req, res) => {
        requests++;
        res.setHeader('age', '60');
        res.setHeader('cache-control', 'max-age=60, must-revalidate');
        res.end(`response ${requests}`);
      });
      const origin = await listen(server);
      const cache = createLocalCache(origin, []);

      try {
        expect((await requestCache(cache, `${origin}/asset`)).body).toBe('response 1');
        expect((await requestCache(cache, `${origin}/asset`)).body).toBe('response 2');
        expect(requests).toBe(2);
      } finally {
        await cache.clear();
        await close(server);
      }
    });

    test('reports CSS transformation stream failures during warming', async () => {
      const server = http.createServer((_req, res) => {
        res.setHeader('content-type', 'text/css');
        res.end('body { color: red; }');
      });
      const origin = await listen(server);
      const cache = createLocalCache(origin, [`${origin}/style.css`], { maxCssTransformBytes: 8 });

      try {
        const stats = await cache.warm({});
        expect(stats.failures).toBe(1);
        expect(Object.keys(await cache.ls())).toHaveLength(0);
      } finally {
        await cache.clear();
        await close(server);
      }
    });

    test('bounds cache-warming concurrency', async () => {
      let active = 0;
      let maximumActive = 0;
      const server = http.createServer((_req, res) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        setTimeout(() => {
          active--;
          res.end('asset');
        }, 30);
      });
      const origin = await listen(server);
      const seeds = Array.from({ length: 5 }, (_, index) => `${origin}/asset-${index}`);
      const cache = createLocalCache(origin, seeds);

      try {
        await cache.warm({ concurrency: 2 });
        expect(maximumActive).toBe(2);
      } finally {
        await cache.clear();
        await close(server);
      }
    });

    test('times out stalled origin requests', async () => {
      const server = http.createServer(() => {});
      const origin = await listen(server);
      const events: ProxyCacheEvent[] = [];
      const cache = createLocalCache(origin, [`${origin}/slow`], {
        onEvent: (event) => events.push(event),
        requestTimeoutMs: 25,
      });

      try {
        const stats = await cache.warm({});
        expect(stats.failures).toBe(1);
        expect(events.some((event) => event.type === 'error' && event.phase === 'fetch')).toBe(true);
      } finally {
        await cache.clear();
        await close(server);
      }
    });

    test('cancels every active origin request during cache warming', async () => {
      let requests = 0;
      let closedRequests = 0;
      const originsStarted = deferred();
      const originsClosed = deferred();
      const server = http.createServer((req) => {
        if (++requests === 2) originsStarted.resolve();
        req.once('close', () => {
          if (++closedRequests === 2) originsClosed.resolve();
        });
      });
      const origin = await listen(server);
      const cache = createLocalCache(origin, [`${origin}/slow-a`, `${origin}/slow-b`]);
      const controller = new AbortController();
      const warming = cache.warm({ concurrency: 2, signal: controller.signal });

      try {
        await originsStarted.promise;
        controller.abort(new Error('stop warming'));

        await expect(withTimeout(warming, 500)).rejects.toThrow('stop warming');
        await expect(withTimeout(originsClosed.promise, 500)).resolves.toBeUndefined();
        expect(requests).toBe(2);
        expect(Object.keys(await cache.ls())).toHaveLength(0);
      } finally {
        controller.abort();
        await Promise.allSettled([warming]);
        await cache.clear();
        await close(server);
      }
    });

    test('normalizes a non-Error cancellation reason', async () => {
      const controller = new AbortController();
      controller.abort('stop');
      const cache = createLocalCache('http://127.0.0.1', []);

      try {
        await expect(cache.warm({ signal: controller.signal })).rejects.toThrow('Operation aborted');
      } finally {
        await cache.clear();
      }
    });

    test('emits structured cache lifecycle events', async () => {
      const server = http.createServer((_req, res) => res.end('asset'));
      const origin = await listen(server);
      const events: ProxyCacheEvent[] = [];
      const cache = createLocalCache(origin, [`${origin}/asset`], { onEvent: (event) => events.push(event) });

      try {
        await cache.warm({});
        expect(events.map((event) => event.type)).toEqual(['request', 'cache-miss', 'cache-write']);
      } finally {
        await cache.clear();
        await close(server);
      }
    });
  });
});

function createLocalCache(origin: string, cacheSeeds: string[], options: Partial<ProxyCacheOptions> = {}) {
  return createProxyCache({
    proxyPrefix: '/__proxy_cache',
    cachePath: path.join(os.tmpdir(), `cdn-proxy-cache-test-${randomUUID()}`),
    cacheSeeds,
    shouldProxyPath: (url) => url.startsWith(`${origin}/`),
    ...options,
  });
}

async function requestCache(
  cache: ReturnType<typeof createProxyCache>,
  url: string,
  headers: http.IncomingHttpHeaders = {},
  signal?: AbortSignal,
  reload = false
): Promise<{ body: string; headers: Record<string, string>; statusCode: number }> {
  const response = new (class extends stream.Writable {
    chunks: Buffer[] = [];
    headers: Record<string, string> = {};
    statusCode = 200;

    setHeader(key: string, value: string | number | readonly string[]) {
      this.headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    send(chunk: string | Buffer) {
      this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      this.end();
    }
    status(code: number) {
      this.statusCode = code;
    }
    _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
      this.chunks.push(chunk);
      callback();
    }
  })();

  const proxyUrl = new URL(cache.encodeProxyPath(url), 'http://localhost');
  const query: Record<string, string> = Object.fromEntries(proxyUrl.searchParams);
  if (reload) query.reload = 'true';
  await cache.router({ headers, path: proxyUrl.pathname, query, signal }, response);
  return {
    body: Buffer.concat(response.chunks).toString(),
    headers: response.headers,
    statusCode: response.statusCode,
  };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`operation did not finish within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

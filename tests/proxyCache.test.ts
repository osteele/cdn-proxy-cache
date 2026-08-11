import { describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import stream from 'node:stream';
import zlib from 'node:zlib';
import { warmCache as runWarmCache, showCacheInfo } from '../src/commands';
import { fromReadable } from '../src/helpers/stream-helpers';
import { decodeContent, makeProxyReplacementStream } from '../src/internal/content';
import { createProxyCache } from '../src/proxyCache';

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
    for (const encoding of ['deflate', 'gzip'] as const) {
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
  });
});

function createLocalCache(origin: string, cacheSeeds: string[]) {
  return createProxyCache({
    proxyPrefix: '/__proxy_cache',
    cachePath: path.join(os.tmpdir(), `cdn-proxy-cache-test-${randomUUID()}`),
    cacheSeeds,
    shouldProxyPath: (url) => url.startsWith(`${origin}/`),
  });
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

import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import stream from 'node:stream';
import * as cacache from 'cacache';
import {
  createProxyCache,
  HTTP_RESPONSE_HEADER_CACHE_STATUS,
  type ProxyCache,
  type RequestI,
  type ResponseI,
} from '../src/proxyCache';

describe('proxy trust boundaries', () => {
  test('rejects malformed decoded origins before policy checks or network access', async () => {
    let policyChecks = 0;
    const cache = createProxyCache({
      proxyPrefix: '/__proxy_cache',
      cachePath: temporaryCachePath(),
      cacheSeeds: [],
      shouldProxyPath: () => {
        policyChecks++;
        return true;
      },
    });
    const malformedRequests: RequestI[] = [
      makeRequest('/__proxy_cache'),
      makeRequest('/__proxy_cache/'),
      makeRequest('/__proxy_cache/http/'),
      makeRequest('/__proxy_cache/https:/'),
      makeRequest('/__proxy_cache/http/example.test:99999/file'),
      makeRequest('/__proxy_cache/user@example.test/file'),
      makeRequest('/__proxy_cache/:secret@example.test/file'),
      ...[...Array.from({ length: 32 }, (_, code) => code), 127].map((code) =>
        makeRequest('/__proxy_cache/example.test/file', { search: `safe=1${String.fromCharCode(code)}unsafe` })
      ),
    ];

    try {
      for (const request of malformedRequests) {
        const response = new RecordingResponse({ rejectUnsafeHeaders: true });
        await cache.router(request, response);
        expect(response.statusCode).toBe(400);
        expect(response.body).toBe(`Invalid proxy URL: ${cache.decodeProxyPath(request.path, request.query)}`);
      }
      expect(policyChecks).toBe(0);
      expect(Object.keys(await cache.ls())).toHaveLength(0);
    } finally {
      await cache.clear();
    }
  });

  test('consults the policy for a well-formed origin and refuses a disallowed URL', async () => {
    const checked: string[] = [];
    const cache = createProxyCache({
      proxyPrefix: '/__proxy_cache',
      cachePath: temporaryCachePath(),
      cacheSeeds: [],
      shouldProxyPath: (url) => {
        checked.push(url);
        return false;
      },
    });
    const response = new RecordingResponse();

    try {
      await cache.router(makeRequest('/__proxy_cache/internal.example/secret'), response);
      expect(response.statusCode).toBe(403);
      expect(response.body).toBe('Refusing to proxy URL: https://internal.example/secret');
      expect(checked).toEqual(['https://internal.example/secret']);
    } finally {
      await cache.clear();
    }
  });

  test('warming follows allowed redirects but never fetches a disallowed transition', async () => {
    let targetRequests = 0;
    let blockedRequests = 0;
    const targetServer = http.createServer((_req, res) => {
      targetRequests++;
      res.setHeader('cache-control', 'max-age=3600');
      res.end('target');
    });
    const blockedServer = http.createServer((_req, res) => {
      blockedRequests++;
      res.end('blocked');
    });
    const targetOrigin = await listen(targetServer);
    const blockedOrigin = await listen(blockedServer);
    let sourceOrigin = '';
    const sourceServer = http.createServer((req, res) => {
      res.statusCode = 302;
      res.setHeader('cache-control', 'max-age=3600');
      if (req.url === '/allowed') res.setHeader('location', `${targetOrigin}/asset`);
      else if (req.url === '/blocked') res.setHeader('location', `${blockedOrigin}/secret`);
      else if (req.url === '/protocol-relative') {
        res.setHeader('location', `//${new URL(blockedOrigin).host}/protocol-relative`);
      } else if (req.url === '/malformed') res.setHeader('location', 'http://[::1');
      else res.statusCode = 404;
      res.end('redirect');
    });
    sourceOrigin = await listen(sourceServer);
    const seeds = ['/allowed', '/blocked', '/protocol-relative', '/malformed'].map(
      (suffix) => `${sourceOrigin}${suffix}`
    );
    const allowedOrigins = new Set([sourceOrigin, targetOrigin]);
    const cache = createProxyCache({
      proxyPrefix: '/__proxy_cache',
      cachePath: temporaryCachePath(),
      cacheSeeds: seeds,
      shouldProxyPath: (url) => /^https?:/.test(url) && allowedOrigins.has(new URL(url).origin),
    });

    try {
      const stats = await cache.warm({ concurrency: 2 });
      expect(stats).toEqual({ total: 4, failures: 0, hits: 0, misses: 4 });
      expect(targetRequests).toBe(1);
      expect(blockedRequests).toBe(0);
      const cachedOrigins = Object.values(await cache.ls()).map(
        (entry) => (entry.metadata as { originUrl: string }).originUrl
      );
      expect(cachedOrigins.sort()).toEqual([...seeds, `${targetOrigin}/asset`].sort());
      const protocolRelativeEntry = Object.values(await cache.ls()).find(
        (entry) => (entry.metadata as { originUrl: string }).originUrl === `${sourceOrigin}/protocol-relative`
      );
      expect(protocolRelativeEntry).toBeDefined();
      if (!protocolRelativeEntry) throw new Error('Expected a cached protocol-relative redirect');
      expect((protocolRelativeEntry.metadata as { headers: Record<string, string> }).headers.location).toBe(
        `${blockedOrigin}/protocol-relative`
      );

      const warmHeaders = {
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate',
      };
      const allowed = await requestCache(cache, `${sourceOrigin}/allowed`, warmHeaders);
      const blocked = await requestCache(cache, `${sourceOrigin}/blocked`, warmHeaders);
      const protocolRelative = await requestCache(cache, `${sourceOrigin}/protocol-relative`, warmHeaders);
      const malformed = await requestCache(cache, `${sourceOrigin}/malformed`, warmHeaders);
      expect(
        [allowed, blocked, protocolRelative, malformed].map(
          (response) => response.headers[HTTP_RESPONSE_HEADER_CACHE_STATUS]
        )
      ).toEqual(['HIT', 'HIT', 'HIT', 'HIT']);
      expect(allowed.headers.location).toBe(cache.encodeProxyPath(`${targetOrigin}/asset`));
      expect(blocked.headers.location).toBe(`${blockedOrigin}/secret`);
      expect(protocolRelative.headers.location).toBe(`${blockedOrigin}/protocol-relative`);
      expect(malformed.headers.location).toBe('http://[::1');
      expect(targetRequests).toBe(1);
      expect(blockedRequests).toBe(0);
    } finally {
      await cache.clear();
      await Promise.all([close(sourceServer), close(targetServer), close(blockedServer)]);
    }
  });

  test('origin headers cannot spoof proxy metadata or persist connection state', async () => {
    let originRequests = 0;
    const server = http.createServer((_req, res) => {
      originRequests++;
      res.setHeader('cache-control', 'max-age=3600');
      res.setHeader('accept-ranges', 'bytes');
      res.setHeader('accept-ch', 'Sec-CH-UA-Platform');
      res.setHeader('authentication-info', 'nextnonce="secret"');
      res.setHeader('clear-site-data', '"cookies", "storage"');
      res.setHeader('connection', 'close, x-origin-hop, x-second-hop');
      res.setHeader('critical-ch', 'Sec-CH-UA-Platform');
      res.setHeader('keep-alive', 'timeout=5');
      res.setHeader('proxy-connection', 'keep-alive');
      res.setHeader('proxy-authentication-info', 'nextnonce="secret"');
      res.setHeader('proxy-authenticate', 'Basic realm="origin"');
      res.setHeader('nel', '{"report_to":"origin"}');
      res.setHeader('report-to', '{"group":"origin"}');
      res.setHeader('reporting-endpoints', 'origin="https://reports.example/"');
      res.setHeader('server', 'origin-product');
      res.setHeader('te', 'trailers');
      res.setHeader('trailer', 'x-trailer');
      res.setHeader('upgrade', 'h2c');
      res.setHeader('www-authenticate', 'Basic realm="origin"');
      res.setHeader('transfer-encoding', 'chunked');
      res.setHeader('x-origin-hop', 'remove me');
      res.setHeader('x-second-hop', 'remove me too');
      res.setHeader(HTTP_RESPONSE_HEADER_CACHE_STATUS, 'FORGED');
      res.setHeader('x-cdn-proxy-origin-url', 'https://forged.example/');
      res.setHeader('set-cookie', ['session=origin-secret; HttpOnly', 'preference=private']);
      res.setHeader('set-cookie2', 'legacy=origin-secret');
      res.setHeader('strict-transport-security', 'max-age=31536000');
      res.setHeader('alt-svc', 'h3=":443"');
      res.setHeader('x-end-to-end', 'preserve me');
      res.setHeader('x-url-shaped-value', `${origin}/must-not-be-rewritten`);
      res.write('body');
      res.addTrailers({ 'x-trailer': 'remove me too' });
      res.end();
    });
    const origin = await listen(server);
    const cache = createCache([origin]);

    try {
      const miss = await requestCache(cache, `${origin}/asset`);
      const hit = await requestCache(cache, `${origin}/asset`);

      expect(miss.headers[HTTP_RESPONSE_HEADER_CACHE_STATUS]).toBe('MISS');
      expect(hit.headers[HTTP_RESPONSE_HEADER_CACHE_STATUS]).toBe('HIT');
      expect(miss.headers['x-cdn-proxy-origin-url']).toBe(`${origin}/asset`);
      expect(hit.headers['x-cdn-proxy-origin-url']).toBe(`${origin}/asset`);
      const strippedHeaders = [
        'accept-ranges',
        'accept-ch',
        'authentication-info',
        'clear-site-data',
        'connection',
        'critical-ch',
        'keep-alive',
        'proxy-connection',
        'proxy-authentication-info',
        'proxy-authenticate',
        'nel',
        'report-to',
        'reporting-endpoints',
        'te',
        'trailer',
        'upgrade',
        'www-authenticate',
        'transfer-encoding',
        'x-origin-hop',
        'x-second-hop',
        'strict-transport-security',
        'alt-svc',
      ];
      for (const header of strippedHeaders) {
        expect(miss.headers[header]).toBeUndefined();
        expect(hit.headers[header]).toBeUndefined();
      }
      expect(miss.headers['set-cookie']).toBeUndefined();
      expect(hit.headers['set-cookie']).toBeUndefined();
      expect(miss.headers['set-cookie2']).toBeUndefined();
      expect(hit.headers['set-cookie2']).toBeUndefined();
      expect(miss.headers.server).toBeUndefined();
      expect(hit.headers.server).toBeUndefined();
      expect(miss.headers['origin-server']).toBe('origin-product');
      expect(hit.headers['origin-server']).toBe('origin-product');
      expect(miss.headers['x-end-to-end']).toBe('preserve me');
      expect(hit.headers['x-end-to-end']).toBe('preserve me');
      expect(miss.headers['x-url-shaped-value']).toBe(`${origin}/must-not-be-rewritten`);
      expect(hit.headers['x-url-shaped-value']).toBe(`${origin}/must-not-be-rewritten`);
      expect(originRequests).toBe(1);
    } finally {
      await cache.clear();
      await close(server);
    }
  });

  test('refetches an older cache entry whose response headers were not sanitized', async () => {
    let originRequests = 0;
    const server = http.createServer((_req, res) => {
      originRequests++;
      res.setHeader('cache-control', 'max-age=3600');
      res.setHeader('x-end-to-end', 'clean origin');
      res.end('clean body');
    });
    const origin = await listen(server);
    const originUrl = `${origin}/legacy`;
    const cache = createCache([origin]);
    const cacheKey = JSON.stringify({
      url: originUrl,
      accept: '*/*',
      acceptLanguage: null,
      acceptEncoding: null,
    });
    await cacache.put(cache.cachePath, cacheKey, 'legacy body', {
      metadata: {
        originUrl,
        status: 200,
        headers: {
          'cache-control': 'max-age=3600',
          [HTTP_RESPONSE_HEADER_CACHE_STATUS]: 'FORGED',
          'x-cdn-proxy-origin-url': 'https://forged.example/',
          'set-cookie': 'session=legacy-secret',
          'set-cookie2': 'legacy=legacy-secret',
          'x-legacy-hop': 'legacy secret',
          'x-end-to-end': 'poisoned cache',
        },
      },
    });

    try {
      const response = await requestCache(cache, originUrl);
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('clean body');
      expect(response.headers[HTTP_RESPONSE_HEADER_CACHE_STATUS]).toBe('MISS');
      expect(response.headers['x-cdn-proxy-origin-url']).toBe(originUrl);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.headers['set-cookie2']).toBeUndefined();
      expect(response.headers['x-legacy-hop']).toBeUndefined();
      expect(response.headers['x-end-to-end']).toBe('clean origin');
      expect(originRequests).toBe(1);
    } finally {
      await cache.clear();
      await close(server);
    }
  });

  test('does not replay fixed unsafe fields from marked cache metadata', async () => {
    const originUrl = 'https://allowed.example/marked';
    const cache = createCache(['https://allowed.example']);
    await putCacheEntry(cache, originUrl, {
      responseHeadersSanitized: true,
      headers: {
        'cache-control': 'max-age=3600',
        [HTTP_RESPONSE_HEADER_CACHE_STATUS]: 'FORGED',
        'x-cdn-proxy-origin-url': 'https://forged.example/',
        'set-cookie': 'session=legacy-secret',
        'set-cookie2': 'legacy=legacy-secret',
        'x-end-to-end': 'preserve me',
      },
    });

    try {
      const hit = await requestCache(cache, originUrl);
      expect(hit.body).toBe('cached body');
      expect(hit.headers[HTTP_RESPONSE_HEADER_CACHE_STATUS]).toBe('HIT');
      expect(hit.headers['x-cdn-proxy-origin-url']).toBe(originUrl);
      expect(hit.headers['set-cookie']).toBeUndefined();
      expect(hit.headers['set-cookie2']).toBeUndefined();
      expect(hit.headers['x-end-to-end']).toBe('preserve me');
    } finally {
      await cache.clear();
    }
  });

  test('malformed document URLs are left opaque without invoking the allowlist', () => {
    const checked: string[] = [];
    const cache = createProxyCache({
      proxyPrefix: '/__proxy_cache',
      cachePath: temporaryCachePath(),
      cacheSeeds: [],
      shouldProxyPath: (url) => {
        checked.push(url);
        return /^https?:/.test(url) && new URL(url).hostname === 'allowed.example';
      },
    });
    for (const opaqueUrl of ['http://[::1', 'ftp://allowed.example/file', 'file:///tmp/file', '/relative']) {
      expect(cache.replaceUrlsInHtml(`<script src="${opaqueUrl}"></script>`)).toBe(
        `<script src="${opaqueUrl}"></script>`
      );
      expect(cache.replaceUrlsInHtml(`<link rel="stylesheet" href="${opaqueUrl}">`)).toBe(
        `<link rel="stylesheet" href="${opaqueUrl}">`
      );
      expect(cache.replaceUrlsInCss(`body { background: url("${opaqueUrl}"); }`)).toBe(
        `body { background: url("${opaqueUrl}"); }`
      );
    }
    expect(checked).toEqual([]);
  });

  test('rewrites valid allowed document URLs through the validated path', () => {
    const allowedUrl = 'https://allowed.example/asset.js';
    const cache = createCache(['https://allowed.example']);

    expect(cache.replaceUrlsInHtml(`<script src="${allowedUrl}"></script>`)).toBe(
      '<script src="/__proxy_cache/allowed.example/asset.js"></script>'
    );
    expect(cache.replaceUrlsInHtml(`<link rel="stylesheet" href="${allowedUrl}">`)).toBe(
      '<link rel="stylesheet" href="/__proxy_cache/allowed.example/asset.js">'
    );
    expect(cache.replaceUrlsInCss(`body { background: url("${allowedUrl}"); }`)).toContain(
      '/__proxy_cache/allowed.example/asset.js'
    );
  });
});

class RecordingResponse extends stream.Writable implements ResponseI {
  private readonly chunks: Buffer[] = [];
  readonly headers: Record<string, string> = {};
  statusCode = 200;
  private readonly rejectUnsafeHeaders: boolean;

  constructor({ rejectUnsafeHeaders = false } = {}) {
    super();
    this.rejectUnsafeHeaders = rejectUnsafeHeaders;
  }

  setHeader(key: string, value: string | number | readonly string[]) {
    const normalizedKey = key.toLowerCase();
    const stringValue = Array.isArray(value) ? value.join(', ') : String(value);
    if (this.rejectUnsafeHeaders && hasControlCharacter(stringValue)) {
      throw new TypeError(`Invalid header value for ${key}`);
    }
    this.headers[normalizedKey] = stringValue;
  }

  send(chunk: string | Buffer) {
    this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    this.end();
  }

  status(code: number) {
    this.statusCode = code;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.chunks.push(chunk);
    callback();
  }

  get body(): string {
    return Buffer.concat(this.chunks).toString();
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
}

function createCache(allowedOrigins: string[], cacheSeeds: string[] = []): ProxyCache {
  return createProxyCache({
    proxyPrefix: '/__proxy_cache',
    cachePath: temporaryCachePath(),
    cacheSeeds,
    shouldProxyPath: (url) => allowedOrigins.some((origin) => url.startsWith(`${origin}/`)),
  });
}

function temporaryCachePath(): string {
  return path.join(os.tmpdir(), `cdn-proxy-cache-security-${randomUUID()}`);
}

async function putCacheEntry(
  cache: ProxyCache,
  originUrl: string,
  metadata: { headers: Record<string, string>; responseHeadersSanitized?: boolean }
): Promise<void> {
  const cacheKey = JSON.stringify({
    url: originUrl,
    accept: '*/*',
    acceptLanguage: null,
    acceptEncoding: null,
  });
  await cacache.put(cache.cachePath, cacheKey, 'cached body', {
    metadata: { ...metadata, originUrl, status: 200 },
  });
}

function makeRequest(pathname: string, query: Record<string, unknown> = {}): RequestI {
  return { headers: {}, path: pathname, query };
}

async function requestCache(
  cache: ProxyCache,
  url: string,
  headers: http.IncomingHttpHeaders = {}
): Promise<RecordingResponse> {
  const response = new RecordingResponse();
  const request = makeRequest(cache.encodeProxyPath(url));
  request.headers = headers;
  await cache.router(request, response);
  return response;
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

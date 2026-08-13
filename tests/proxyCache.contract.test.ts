import { describe, expect, test } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import { cacheLifetimeSeconds, canStoreSharedResponse, parseCacheControl } from '../src/internal/cache-control';
import { createProxyCache, type ProxyCacheOptions } from '../src/proxyCache';

const baseOptions = {
  proxyPrefix: '/__proxy_cache',
  cachePath: path.join(os.tmpdir(), 'cdn-proxy-cache-contract'),
  cacheSeeds: [],
  shouldProxyPath: (url: string) => /^https?:/i.test(url),
} satisfies ProxyCacheOptions;

describe('Allium proxy-path codec contract', () => {
  test('round-trips a generated canonical HTTP URL grammar through both request channels', () => {
    const schemes = ['http', 'https'];
    const authorities = ['cdn.example.test', 'user:pass@cdn.example.test:8443', '[2001:db8::1]:8080'];
    const paths = [
      '/asset.js',
      '/nested/a%20b.css',
      '/unicode/%E9%9B%AA.png',
      '/__proxy_cache/asset.js',
      '/nested/__proxy_cache-other/asset.js',
      '/nested/http/asset.js',
      '/nested/https:/asset.js',
    ];
    const searches = [
      '',
      '?a=1&b=two',
      '?next=https%3A%2F%2Fexample.test%2Fa%3Fb%3D1',
      '?literal=%252F&space=hello+world&empty=',
    ];
    const fragments = ['', '#section', '#encoded%2Ffragment'];
    let cases = 0;

    for (const prefix of ['/__proxy_cache', '/nested/cache', '/proxy.v1']) {
      const cache = createProxyCache({ ...baseOptions, proxyPrefix: prefix });
      for (const scheme of schemes) {
        for (const authority of authorities) {
          for (const pathname of paths) {
            for (const search of searches) {
              for (const fragment of fragments) {
                const originUrl = new URL(`${scheme}://${authority}${pathname}${search}${fragment}`).toString();
                const proxyUrl = cache.encodeProxyPath(originUrl);
                const requestUrl = new URL(proxyUrl, 'https://proxy.test');
                const query = Object.fromEntries(requestUrl.searchParams);

                expect({ originUrl, decoded: cache.decodeProxyPath(proxyUrl) }).toEqual({
                  originUrl,
                  decoded: originUrl,
                });
                const routedOriginUrl = originUrl.replace(/#.*$/, '');
                expect({
                  originUrl: routedOriginUrl,
                  decoded: cache.decodeProxyPath(requestUrl.pathname, query),
                }).toEqual({
                  originUrl: routedOriginUrl,
                  decoded: routedOriginUrl,
                });
                cases++;
              }
            }
          }
        }
      }
    }

    expect(cases).toBe(1512);
  });

  test('passes unsupported inputs through and recognizes only complete prefix segments', () => {
    const cache = createProxyCache(baseOptions);
    for (const input of [
      '/relative/asset.js',
      '//cdn.example.test/asset.js',
      'data:text/plain,hello',
      'ftp://cdn.example.test/asset.js',
      'prefixhttps://cdn.example.test/asset.js',
    ]) {
      expect(cache.encodeProxyPath(input)).toBe(input);
    }

    expect(cache.isProxyPath('/__proxy_cache')).toBe(true);
    expect(cache.isProxyPath('/__proxy_cache/cdn.example.test/asset.js')).toBe(true);
    expect(cache.isProxyPath('/__proxy_cache-other/cdn.example.test/asset.js')).toBe(false);
    expect(cache.isProxyPath('/__proxy_cachex')).toBe(false);
  });

  test('keeps proxy-only parameters out of the decoded origin query', () => {
    const cache = createProxyCache(baseOptions);
    const originUrl = 'https://cdn.example.test/asset.js?a=1&literal=%252F#section';
    const proxyUrl = cache.encodeProxyPath(originUrl);
    const requestUrl = new URL(proxyUrl, 'https://proxy.test');
    const query = { ...Object.fromEntries(requestUrl.searchParams), reload: 'true', diagnostic: '1' };

    expect(cache.decodeProxyPath(requestUrl.pathname, query)).toBe(originUrl.replace(/#.*$/, ''));
    expect(cache.decodeProxyPath('/__proxy_cache/cdn.example.test/asset.js', { search: ['not', 'a-string'] })).toBe(
      'https://cdn.example.test/asset.js'
    );
  });
});

describe('Allium proxy-cache lifecycle contract', () => {
  test('parses shared-cache directives and rejects malformed delta seconds', () => {
    expect(parseCacheControl(undefined)).toEqual({
      isPrivate: false,
      maxAge: undefined,
      mustRevalidate: false,
      noCache: false,
      noStore: false,
      sharedMaxAge: undefined,
    });
    const policy = parseCacheControl('MAX-AGE="60", s-maxage="120", no-cache, must-revalidate');
    expect(policy).toEqual({
      isPrivate: false,
      maxAge: 60,
      mustRevalidate: true,
      noCache: true,
      noStore: false,
      sharedMaxAge: 120,
    });
    expect(cacheLifetimeSeconds(policy)).toBe(120);
    expect(canStoreSharedResponse(policy)).toBe(true);

    for (const value of ['x60', '60x', '6"0', '-1', '1.5', '']) {
      const malformed = parseCacheControl(`max-age=${value}`);
      expect({ value, maxAge: malformed.maxAge }).toEqual({ value, maxAge: undefined });
    }

    expect(parseCacheControl('no-store').noStore).toBe(true);
    expect(parseCacheControl('private').isPrivate).toBe(true);
    expect(canStoreSharedResponse(parseCacheControl('no-store'))).toBe(false);
    expect(canStoreSharedResponse(parseCacheControl('private'))).toBe(false);
  });

  test('rejects every invalid numeric configuration boundary before work begins', async () => {
    const invalidValues = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
    for (const name of ['maxCssTransformBytes', 'requestTimeoutMs', 'warmConcurrency'] as const) {
      for (const value of invalidValues) {
        expect(() => createProxyCache({ ...baseOptions, [name]: value })).toThrow(`${name} must be a positive integer`);
      }
    }

    const cache = createProxyCache(baseOptions);
    for (const concurrency of invalidValues) {
      await expect(cache.warm({ concurrency })).rejects.toThrow('concurrency must be a positive integer');
    }
  });
});

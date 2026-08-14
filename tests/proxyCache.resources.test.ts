import { describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import stream from 'node:stream';
import * as cacache from 'cacache';
import { createProxyCache, type ProxyCache, type ProxyCacheOptions, type RequestI, type ResponseI } from '../src';

describe('cache resources and maintenance', () => {
  test('rejects empty and filesystem-root cache paths', () => {
    const options = baseOptions('');
    expect(() => createProxyCache(options)).toThrow('cachePath must not be empty');
    expect(() => createProxyCache({ ...options, cachePath: path.parse(path.resolve('.')).root })).toThrow(
      'cachePath must not be a filesystem root'
    );
    expect(() => createProxyCache({ ...options, cachePath: tempCachePath() })).not.toThrow();
  });

  test('rejects a symlink alias to a filesystem root', async () => {
    const alias = tempCachePath();
    await symlink(path.parse(path.resolve('.')).root, alias, 'dir');
    expect(() => createProxyCache(baseOptions(alias))).toThrow('cachePath must not be a filesystem root');
    await rm(alias);
  });

  test('rejects a dangling symlink in the cache path', async () => {
    const alias = tempCachePath();
    await symlink(`${tempCachePath()}-missing`, alias, 'dir');
    expect(() => createProxyCache(baseOptions(path.join(alias, 'cache')))).toThrow(
      'cachePath must not contain a dangling symbolic link'
    );
    await rm(alias);
  });

  test('canonicalizes a symlinked parent for storage and locking', async () => {
    const physicalParent = tempCachePath();
    const aliasParent = tempCachePath();
    await mkdir(physicalParent, { recursive: true });
    await symlink(physicalParent, aliasParent, 'dir');

    const physicalPath = path.join(physicalParent, 'cache');
    const aliasPath = path.join(aliasParent, 'cache');
    const physical = createProxyCache(baseOptions(physicalPath));
    const alias = createProxyCache(baseOptions(aliasPath));
    expect(alias.cachePath).toBe(physical.cachePath);

    await cacache.put(physical.cachePath, 'entry', 'body');
    expect(Object.keys(await alias.ls())).toEqual(['entry']);
    await alias.clear();
    expect(await physical.ls()).toEqual({});
    await rm(aliasParent);
    await rm(physicalParent, { recursive: true });
  });

  test('shares a lock between nonexistent case aliases on a case-insensitive filesystem', async () => {
    const parent = tempCachePath();
    const probe = path.join(parent, 'case-probe');
    await mkdir(probe, { recursive: true });
    const caseInsensitive = await stat(path.join(parent, 'CASE-PROBE')).then(
      () => true,
      () => false
    );
    await rm(probe, { recursive: true });
    if (!caseInsensitive) {
      await rm(parent, { recursive: true });
      return;
    }

    const upper = createProxyCache(baseOptions(path.join(parent, 'Cache')));
    const lower = createProxyCache(baseOptions(path.join(parent, 'cache')));
    const clearEntered = deferred<void>();
    const releaseClear = deferred<void>();
    const clear = spyOn(cacache.rm, 'all').mockImplementationOnce(async () => {
      clearEntered.resolve();
      await releaseClear.promise;
    });
    try {
      const clearing = upper.clear();
      await clearEntered.promise;
      const listing = lower.ls();
      expect(await settlesNextTurn(listing)).toBe(false);
      releaseClear.resolve();
      await clearing;
      await expect(listing).resolves.toEqual({});
    } finally {
      releaseClear.resolve();
      clear.mockRestore();
      await rm(parent, { recursive: true });
    }
  });

  test('rejects invalid byte bounds', () => {
    const options = baseOptions(tempCachePath());
    for (const maxCacheSizeBytes of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => createProxyCache({ ...options, maxCacheSizeBytes })).toThrow(
        'maxCacheSizeBytes must be a positive integer'
      );
    }
  });

  test('clear removes cache-owned artifacts and preserves unrelated files', async () => {
    const cachePath = tempCachePath();
    const cache = createProxyCache(baseOptions(cachePath));
    await cacache.put(cachePath, 'entry', 'body');
    await mkdir(path.join(cachePath, 'tmp'), { recursive: true });
    await writeFile(path.join(cachePath, 'tmp', 'partial'), 'partial');
    await writeFile(path.join(cachePath, '_lastverified'), '1');
    await writeFile(path.join(cachePath, 'sentinel'), 'unrelated');

    await cache.clear();

    expect(await cache.ls()).toEqual({});
    await expect(stat(path.join(cachePath, 'tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(cachePath, '_lastverified'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(path.join(cachePath, 'sentinel'))).isFile()).toBe(true);
  });

  test('clear waits for active writes across cache instances', async () => {
    let releaseOrigin = () => {};
    let signalOriginStarted = () => {};
    const originStarted = new Promise<void>((resolve) => {
      signalOriginStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseOrigin = resolve;
    });
    const server = http.createServer(async (_req, res) => {
      res.setHeader('cache-control', 'max-age=3600');
      res.write('first');
      signalOriginStarted();
      await release;
      res.end('second');
    });
    const origin = await listen(server);
    const physicalParent = tempCachePath();
    const aliasParent = tempCachePath();
    await mkdir(physicalParent, { recursive: true });
    await symlink(physicalParent, aliasParent, 'dir');
    const first = localCache(path.join(physicalParent, 'cache'), origin);
    const second = localCache(path.join(aliasParent, 'cache'), origin);
    expect(second.cachePath).toBe(first.cachePath);
    try {
      const responsePromise = requestCache(first, `${origin}/asset`);
      await originStarted;
      let clearFinished = false;
      const clearPromise = second.clear().then(() => {
        clearFinished = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(clearFinished).toBe(false);

      releaseOrigin();
      expect((await responsePromise).body).toBe('firstsecond');
      await clearPromise;
      expect(await first.ls()).toEqual({});

      await requestCache(first, `${origin}/asset`);
      expect(Object.keys(await first.ls())).toHaveLength(1);
    } finally {
      releaseOrigin();
      await first.clear();
      await close(server);
      await rm(aliasParent);
      await rm(physicalParent, { recursive: true });
    }
  });

  test('prune reclaims orphaned content and temporary files while preserving live entries', async () => {
    const cachePath = tempCachePath();
    const cache = createProxyCache(baseOptions(cachePath));
    await cacache.put(cachePath, 'entry', 'old body');
    const oldEntry = (await cacache.get.info(cachePath, 'entry'))!;
    await cacache.put(cachePath, 'entry', 'new body');
    await mkdir(path.join(cachePath, 'tmp'), { recursive: true });
    await writeFile(path.join(cachePath, 'tmp', 'partial'), 'partial');

    const stats = await cache.prune();

    expect(stats.reclaimedCount).toBeGreaterThanOrEqual(1);
    expect(stats.reclaimedSize).toBeGreaterThanOrEqual(Buffer.byteLength('old body'));
    expect(stats.totalEntries).toBe(1);
    expect((await cacache.get(cachePath, 'entry')).data.toString()).toBe('new body');
    await expect(stat(oldEntry.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(cachePath, 'tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
    await cache.clear();
  });

  test('prune removes corrupted live content and its index entry', async () => {
    const cachePath = tempCachePath();
    const cache = createProxyCache(baseOptions(cachePath));
    await cacache.put(cachePath, 'corrupt', 'original');
    const entry = (await cacache.get.info(cachePath, 'corrupt'))!;
    await writeFile(entry.path, 'tampered');

    const stats = await cache.prune();

    expect(stats.badContentCount).toBe(1);
    expect(stats.rejectedEntries).toBe(1);
    expect(await cache.ls()).toEqual({});
    await cache.clear();
  });

  test('prune removes an index entry whose content is missing', async () => {
    const cachePath = tempCachePath();
    const cache = createProxyCache(baseOptions(cachePath));
    await cacache.put(cachePath, 'missing', 'body');
    const entry = (await cacache.get.info(cachePath, 'missing'))!;
    await rm(entry.path);

    const stats = await cache.prune();

    expect(stats.missingContent).toBe(1);
    expect(stats.rejectedEntries).toBe(1);
    expect(await cache.ls()).toEqual({});
    await cache.clear();
  });

  test('prune reports failures and permits later operations', async () => {
    const cachePath = tempCachePath();
    const cache = createProxyCache(baseOptions(cachePath));
    const failure = new Error('verification failed');
    const verify = spyOn(cacache, 'verify').mockRejectedValueOnce(failure);
    try {
      await expect(cache.prune()).rejects.toBe(failure);
    } finally {
      verify.mockRestore();
    }
    await cacache.put(cachePath, 'entry', 'body');
    expect(Object.keys(await cache.ls())).toEqual(['entry']);
    await cache.clear();
  });

  test('clear reports failures, releases its barrier, and permits a retry', async () => {
    const cachePath = tempCachePath();
    const cache = createProxyCache(baseOptions(cachePath));
    await cacache.put(cachePath, 'entry', 'body');
    const failure = new Error('clear failed');
    const clear = spyOn(cacache.rm, 'all').mockRejectedValueOnce(failure);
    try {
      await expect(cache.clear()).rejects.toBe(failure);
    } finally {
      clear.mockRestore();
    }
    expect(Object.keys(await cache.ls())).toEqual(['entry']);
    await expect(cache.clear()).resolves.toBeUndefined();
    expect(await cache.ls()).toEqual({});
  });

  test('evicts the oldest unique body to satisfy the byte bound', async () => {
    const server = bodyServer();
    const origin = await listen(server);
    const cache = localCache(tempCachePath(), origin, { maxCacheSizeBytes: 10 });
    try {
      await requestCache(cache, `${origin}/six-a`);
      const [firstEntry] = Object.values(await cache.ls());
      await cacache.index.insert(cache.cachePath, firstEntry.key, firstEntry.integrity, {
        metadata: firstEntry.metadata,
        size: firstEntry.size,
        time: 1,
      });
      await requestCache(cache, `${origin}/six-b`);

      const entries = Object.values(await cache.ls());
      expect(entries).toHaveLength(1);
      expect(entries[0].metadata).toMatchObject({ originUrl: `${origin}/six-b` });
      expect(uniqueBodyBytes(entries)).toBe(6);
    } finally {
      await cache.clear();
      await close(server);
    }
  });

  test('counts duplicate bodies once and does not retain an oversized response', async () => {
    const server = bodyServer();
    const origin = await listen(server);
    const duplicateCache = localCache(tempCachePath(), origin, { maxCacheSizeBytes: 4 });
    const oversizedCache = localCache(tempCachePath(), origin, { maxCacheSizeBytes: 5 });
    try {
      await requestCache(duplicateCache, `${origin}/same-a`);
      await requestCache(duplicateCache, `${origin}/same-b`);
      const duplicates = Object.values(await duplicateCache.ls());
      expect(duplicates).toHaveLength(2);
      expect(uniqueBodyBytes(duplicates)).toBe(4);

      const response = await requestCache(oversizedCache, `${origin}/twelve`);
      expect(response.body).toBe('123456789012');
      expect(await oversizedCache.ls()).toEqual({});
    } finally {
      await duplicateCache.clear();
      await oversizedCache.clear();
      await close(server);
    }
  });

  test('preserves the byte bound through generated maintenance sequences', async () => {
    const seed = Number(process.env.RESOURCE_TEST_SEED ?? 0x51ce);
    const random = mulberry32(seed);
    const server = bodyServer();
    const origin = await listen(server);
    const cache = localCache(tempCachePath(), origin, { maxCacheSizeBytes: 24 });
    const counts = { clear: 0, duplicate: 0, oversized: 0, prune: 0, request: 0 };
    const fixedPaths = ['/same-a', '/same-b', '/twelve'];
    try {
      for (let step = 0; step < 100; step++) {
        const choice = random();
        if (step === 10 || choice < 0.08) {
          counts.clear++;
          await cache.clear();
        } else if (step === 20 || choice < 0.16) {
          counts.prune++;
          await cache.prune();
        } else {
          const requestPath = fixedPaths[step] ?? generatedBodyPath(random);
          counts.request++;
          if (requestPath.startsWith('/same-')) counts.duplicate++;
          if (requestPath === '/twelve' || requestPath.startsWith('/body-32-')) counts.oversized++;
          await requestCache(cache, `${origin}${requestPath}`);
        }
        const entries = Object.values(await cache.ls());
        try {
          expect(uniqueBodyBytes(entries)).toBeLessThanOrEqual(24);
          await Promise.all(entries.map((entry) => cacache.get.byDigest(cache.cachePath, entry.integrity)));
        } catch (cause) {
          throw new Error(`resource sequence failed at seed=${seed} step=${step}`, { cause });
        }
      }
      for (const count of Object.values(counts)) expect(count).toBeGreaterThan(0);
    } finally {
      await cache.clear();
      await close(server);
    }
  }, 15_000);
});

class RecordingResponse extends stream.Writable implements ResponseI {
  readonly chunks: Buffer[] = [];
  readonly headers: Record<string, string> = {};
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

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.chunks.push(chunk);
    callback();
  }

  get body(): string {
    return Buffer.concat(this.chunks).toString();
  }
}

function baseOptions(cachePath: string): ProxyCacheOptions {
  return {
    cachePath,
    cacheSeeds: [],
    proxyPrefix: '/cache',
    shouldProxyPath: () => true,
  };
}

function localCache(cachePath: string, origin: string, options: Partial<ProxyCacheOptions> = {}): ProxyCache {
  return createProxyCache({
    ...baseOptions(cachePath),
    shouldProxyPath: (url) => url.startsWith(`${origin}/`),
    ...options,
  });
}

function tempCachePath(): string {
  return path.join(os.tmpdir(), `cdn-proxy-cache-resources-${randomUUID()}`);
}

function bodyServer(): http.Server {
  return http.createServer((req, res) => {
    const bodies: Record<string, string> = {
      '/same-a': 'same',
      '/same-b': 'same',
      '/six-a': 'aaaaaa',
      '/six-b': 'bbbbbb',
      '/twelve': '123456789012',
    };
    const generated = req.url?.match(/^\/body-(\d+)-(\d+)$/);
    const body = generated ? generated[2].repeat(Number(generated[1])) : bodies[req.url ?? ''];
    res.setHeader('cache-control', 'max-age=3600');
    res.end(body ?? 'missing');
  });
}

function makeRequest(proxyPath: string): RequestI & EventEmitter {
  return Object.assign(new EventEmitter(), {
    headers: {},
    path: proxyPath,
    query: {},
  });
}

async function requestCache(cache: ProxyCache, url: string): Promise<RecordingResponse> {
  const response = new RecordingResponse();
  await cache.router(makeRequest(cache.encodeProxyPath(url)), response);
  return response;
}

function uniqueBodyBytes(entries: { integrity: string; size: number }[]): number {
  return [...new Map(entries.map((entry) => [entry.integrity, entry.size])).values()].reduce(
    (total, size) => total + size,
    0
  );
}

function generatedBodyPath(random: () => number): string {
  const sizes = [0, 1, 4, 8, 16, 32];
  const size = sizes[Math.floor(random() * sizes.length)];
  const identity = Math.floor(random() * 6);
  return `/body-${size}-${identity}`;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function settlesNextTurn(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([promise.then(() => true), new Promise<false>((resolve) => setImmediate(() => resolve(false)))]);
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

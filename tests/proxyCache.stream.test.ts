import { describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import stream from 'node:stream';
import * as cacache from 'cacache';
import { multiplexStreamWriter } from '../src/helpers/stream-helpers';
import { createProxyCache, type ProxyCacheEvent, type RequestI, type ResponseI } from '../src/proxyCache';

describe('stream fault boundaries', () => {
  test('waits for every destination before accepting the next chunk', async () => {
    const writes: string[] = [];
    const callbacks: (() => void)[] = [];
    const delayed = new stream.Writable({
      write(chunk, _encoding, callback) {
        writes.push(`delayed:${chunk}`);
        callbacks.push(callback);
      },
    });
    const immediate = new stream.Writable({
      write(chunk, _encoding, callback) {
        writes.push(`immediate:${chunk}`);
        callback();
      },
    });
    const multiplexed = multiplexStreamWriter([delayed, immediate]);

    multiplexed.write('one');
    multiplexed.write('two');
    await Promise.resolve();
    expect(writes).toEqual(['delayed:one', 'immediate:one']);

    callbacks.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(writes).toEqual(['delayed:one', 'immediate:one', 'delayed:two', 'immediate:two']);

    callbacks.shift()?.();
    multiplexed.end();
    await stream.promises.finished(multiplexed, { readable: false });
  });

  test('propagates one destination failure and destroys its peers', async () => {
    const failure = new Error('destination failed');
    const failing = new stream.Writable({
      write(_chunk, _encoding, callback) {
        callback(failure);
      },
    });
    const peer = new stream.PassThrough();
    const multiplexed = multiplexStreamWriter([failing, peer]);

    multiplexed.end('body');

    await expect(stream.promises.finished(multiplexed)).rejects.toThrow('destination failed');
    expect(peer.destroyed).toBe(true);
  });

  test('uses the first callback error without relying on destination error events', async () => {
    const first = new Error('first');
    const second = new Error('second');
    const destination = (error: Error) =>
      ({
        destroy() {},
        emit() {
          return false;
        },
        end(callback: () => void) {
          callback();
          return this;
        },
        on() {
          return this;
        },
        once() {
          return this;
        },
        off() {
          return this;
        },
        write(_chunk: unknown, _encoding: BufferEncoding, callback: (cause?: Error) => void) {
          callback(error);
          return false;
        },
      }) as unknown as NodeJS.WritableStream & { destroy(error?: Error): void };
    const multiplexed = multiplexStreamWriter([destination(first), destination(second)]);

    multiplexed.end('body');

    await expect(stream.promises.finished(multiplexed, { readable: false })).rejects.toBe(first);
  });

  test('waits for every destination to finalize and removes its listeners', async () => {
    const finalCallbacks: (() => void)[] = [];
    const destinations = [0, 1].map(
      () =>
        new stream.Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
          final(callback) {
            finalCallbacks.push(callback);
          },
        })
    );
    const multiplexed = multiplexStreamWriter(destinations);
    let finished = false;
    multiplexed.on('finish', () => {
      finished = true;
    });

    multiplexed.end('body');
    await new Promise((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    finalCallbacks.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    finalCallbacks.shift()?.();
    await stream.promises.finished(multiplexed, { readable: false });
    expect(destinations.map((destination) => destination.listenerCount('error'))).toEqual([0, 0]);
  });

  test('propagates an asynchronous destination error', async () => {
    const failure = new Error('asynchronous failure');
    const failing = new stream.PassThrough();
    const peer = new stream.PassThrough();
    const multiplexed = multiplexStreamWriter([failing, peer]);

    failing.emit('error', failure);

    await expect(stream.promises.finished(multiplexed, { readable: false })).rejects.toBe(failure);
    expect(peer.destroyed).toBe(true);
  });

  test('does not commit a truncated origin body', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        'cache-control': 'max-age=60',
        'content-length': '100',
      });
      res.flushHeaders();
      res.write('partial');
      setTimeout(() => res.socket?.destroy(), 10);
    });
    const origin = await listen(server);
    const events: ProxyCacheEvent[] = [];
    const cache = createLocalCache(origin, (event) => events.push(event), 100);

    try {
      const response = await requestCache(cache, `${origin}/truncated`);

      expect(response.streamError).toBeDefined();
      expect(Object.keys(await cache.ls())).toHaveLength(0);
      expect(events.some((event) => event.type === 'error' && event.phase === 'stream')).toBe(true);
    } finally {
      await cache.clear();
      await close(server);
    }
  });

  test('abandons the cache write after the client disconnects', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'cache-control': 'max-age=60' });
      const interval = setInterval(() => res.write(Buffer.alloc(4_096)), 2);
      res.on('close', () => clearInterval(interval));
    });
    const origin = await listen(server);
    const events: ProxyCacheEvent[] = [];
    const cache = createLocalCache(origin, (event) => events.push(event));
    const response = new RecordingResponse({ disconnectAfterFirstChunk: true });

    try {
      await cache.router(makeRequest(cache.encodeProxyPath(`${origin}/large`)), response);

      expect(response.streamError?.message).toBe('client disconnected');
      expect(Object.keys(await cache.ls())).toHaveLength(0);
      expect(events.some((event) => event.type === 'error' && event.phase === 'stream')).toBe(true);
    } finally {
      await cache.clear();
      await close(server);
    }
  });

  test('disconnects a coalesced follower without canceling the shared transfer', async () => {
    let requests = 0;
    let misses = 0;
    const events: ProxyCacheEvent[] = [];
    const originStarted = deferred();
    const followerJoined = deferred();
    const originRelease = deferred();
    const server = http.createServer((_req, res) => {
      requests++;
      originStarted.resolve();
      res.setHeader('cache-control', 'max-age=60');
      void originRelease.promise.then(() => res.end('asset'));
    });
    const origin = await listen(server);
    const cache = createLocalCache(origin, (event) => {
      events.push(event);
      if (event.type === 'cache-miss' && ++misses === 2) followerJoined.resolve();
    });
    const proxyPath = cache.encodeProxyPath(`${origin}/asset`);
    const ownerResponse = new RecordingResponse();
    const followerResponse = new RecordingResponse();
    const followerRequest = makeRequest(proxyPath);
    let owner: Promise<void> | undefined;
    let follower: Promise<void> | undefined;

    try {
      owner = cache.router(makeRequest(proxyPath), ownerResponse);
      await originStarted.promise;
      follower = cache.router(followerRequest, followerResponse);
      await followerJoined.promise;
      followerRequest.emit('aborted');

      await expect(withTimeout(follower, 100)).resolves.toBeUndefined();
      expect(requests).toBe(1);
      expect(followerResponse.body).toHaveLength(0);
      expect(followerRequest.listenerCount('aborted')).toBe(0);
      expect(followerResponse.listenerCount('close')).toBe(0);
      expect(events.some((event) => event.type === 'error')).toBe(false);

      originRelease.resolve();
      await expect(owner).resolves.toBeUndefined();
      expect(ownerResponse.body.toString()).toBe('asset');
      expect(Object.keys(await cache.ls())).toHaveLength(1);
    } finally {
      originRelease.resolve();
      await Promise.allSettled([owner, follower].filter((promise) => promise !== undefined));
      await cache.clear();
      await close(server);
    }
  });

  test('observes a follower disconnect that happens before it joins shared work', async () => {
    let requests = 0;
    const originStarted = deferred();
    const originRelease = deferred();
    const server = http.createServer((_req, res) => {
      requests++;
      originStarted.resolve();
      res.setHeader('cache-control', 'max-age=60');
      void originRelease.promise.then(() => res.end('asset'));
    });
    const origin = await listen(server);
    const cache = createLocalCache(origin);
    const proxyPath = cache.encodeProxyPath(`${origin}/asset`);
    const ownerResponse = new RecordingResponse();
    const followerResponse = new RecordingResponse();
    followerResponse.destroy();
    let owner: Promise<void> | undefined;
    let follower: Promise<void> | undefined;

    try {
      owner = cache.router(makeRequest(proxyPath), ownerResponse);
      await originStarted.promise;
      follower = cache.router(makeRequest(proxyPath), followerResponse);

      await expect(withTimeout(follower, 100)).resolves.toBeUndefined();
      expect(requests).toBe(1);

      originRelease.resolve();
      await expect(owner).resolves.toBeUndefined();
      expect(ownerResponse.body.toString()).toBe('asset');
    } finally {
      originRelease.resolve();
      await Promise.allSettled([owner, follower].filter((promise) => promise !== undefined));
      await cache.clear();
      await close(server);
    }
  });

  test('rejects a pre-aborted coalesced follower without waiting for shared work', async () => {
    let requests = 0;
    const originStarted = deferred();
    const originRelease = deferred();
    const server = http.createServer((_req, res) => {
      requests++;
      originStarted.resolve();
      res.setHeader('cache-control', 'max-age=60');
      void originRelease.promise.then(() => res.end('asset'));
    });
    const origin = await listen(server);
    const cache = createLocalCache(origin);
    const proxyPath = cache.encodeProxyPath(`${origin}/asset`);
    const ownerResponse = new RecordingResponse();
    const controller = new AbortController();
    controller.abort(new Error('already canceled'));
    let owner: Promise<void> | undefined;

    try {
      owner = cache.router(makeRequest(proxyPath), ownerResponse);
      await originStarted.promise;
      const follower = cache.router({ ...makeRequest(proxyPath), signal: controller.signal }, new RecordingResponse());

      await expect(withTimeout(follower, 100)).rejects.toThrow('already canceled');
      expect(requests).toBe(1);

      originRelease.resolve();
      await expect(owner).resolves.toBeUndefined();
    } finally {
      originRelease.resolve();
      await Promise.allSettled([owner].filter((promise) => promise !== undefined));
      await cache.clear();
      await close(server);
    }
  });

  test('rejects a pre-aborted generation owner before origin work', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already canceled owner'));
    const cache = createLocalCache('http://127.0.0.1');

    try {
      await expect(
        cache.router(
          { ...makeRequest(cache.encodeProxyPath('http://127.0.0.1/asset')), signal: controller.signal },
          new RecordingResponse()
        )
      ).rejects.toThrow('already canceled owner');
      expect(Object.keys(await cache.ls())).toHaveLength(0);
    } finally {
      await cache.clear();
    }
  });

  test('does not serve a cached body to a pre-aborted signal', async () => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests++;
      res.setHeader('cache-control', 'max-age=60');
      res.end('asset');
    });
    const origin = await listen(server);
    const cache = createLocalCache(origin);
    const controller = new AbortController();
    const response = new RecordingResponse();

    try {
      await requestCache(cache, `${origin}/asset`);
      controller.abort(new Error('already canceled cache hit'));

      await expect(
        cache.router(
          {
            ...makeRequest(cache.encodeProxyPath(`${origin}/asset`)),
            signal: controller.signal,
          },
          response
        )
      ).rejects.toThrow('already canceled cache hit');
      expect(response.body).toHaveLength(0);
      expect(requests).toBe(1);
    } finally {
      await cache.clear();
      await close(server);
    }
  });

  test('observes a signal canceled after router entry but before origin setup', async () => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests++;
      res.setHeader('cache-control', 'max-age=60');
      res.end('unexpected');
    });
    const origin = await listen(server);
    const controller = new AbortController();
    let cancelDuringLookup = false;
    const cache = createLocalCache(origin, (event) => {
      if (cancelDuringLookup && event.type === 'request') controller.abort(new Error('canceled during lookup'));
    });
    const response = new RecordingResponse();

    try {
      await requestCache(cache, `${origin}/asset`);
      cancelDuringLookup = true;
      await expect(
        cache.router(
          {
            ...makeRequest(cache.encodeProxyPath(`${origin}/asset`)),
            signal: controller.signal,
          },
          response
        )
      ).rejects.toThrow('canceled during lookup');
      expect(response.body).toHaveLength(0);
      expect(requests).toBe(1);
    } finally {
      await cache.clear();
      await close(server);
    }
  });

  test('observes a response closed after router entry but before a cache hit', async () => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests++;
      res.setHeader('cache-control', 'max-age=60');
      res.end('asset');
    });
    const origin = await listen(server);
    let closeDuringLookup = false;
    const response = new RecordingResponse();
    const cache = createLocalCache(origin, (event) => {
      if (closeDuringLookup && event.type === 'request') response.destroy();
    });

    try {
      await requestCache(cache, `${origin}/asset`);
      closeDuringLookup = true;

      await expect(
        withTimeout(cache.router(makeRequest(cache.encodeProxyPath(`${origin}/asset`)), response), 100)
      ).resolves.toBeUndefined();
      expect(response.body).toHaveLength(0);
      expect(requests).toBe(1);
    } finally {
      await cache.clear();
      await close(server);
    }
  });

  test('does not serve a cached body to an already disconnected request', async () => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests++;
      res.setHeader('cache-control', 'max-age=60');
      res.end('asset');
    });
    const origin = await listen(server);
    const cache = createLocalCache(origin);
    const proxyPath = cache.encodeProxyPath(`${origin}/asset`);
    const disconnected = makeRequest(proxyPath);
    disconnected.aborted = true;
    const response = new RecordingResponse();

    try {
      await requestCache(cache, `${origin}/asset`);
      await cache.router(disconnected, response);

      expect(response.body).toHaveLength(0);
      expect(requests).toBe(1);
    } finally {
      await cache.clear();
      await close(server);
    }
  });

  test('does not serve a cached body to an already destroyed response', async () => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests++;
      res.setHeader('cache-control', 'max-age=60');
      res.end('asset');
    });
    const origin = await listen(server);
    const cache = createLocalCache(origin);
    const response = new RecordingResponse();
    response.destroy();

    try {
      await requestCache(cache, `${origin}/asset`);
      await cache.router(makeRequest(cache.encodeProxyPath(`${origin}/asset`)), response);

      expect(response.body).toHaveLength(0);
      expect(requests).toBe(1);
    } finally {
      await cache.clear();
      await close(server);
    }
  });

  test('disconnects a coalesced follower when its response closes', async () => {
    let requests = 0;
    const originStarted = deferred();
    const originRelease = deferred();
    const server = http.createServer((_req, res) => {
      requests++;
      originStarted.resolve();
      res.setHeader('cache-control', 'max-age=60');
      void originRelease.promise.then(() => res.end('asset'));
    });
    const origin = await listen(server);
    const cache = createLocalCache(origin);
    const proxyPath = cache.encodeProxyPath(`${origin}/asset`);
    const ownerResponse = new RecordingResponse();
    const followerResponse = new RecordingResponse();
    let owner: Promise<void> | undefined;
    let follower: Promise<void> | undefined;

    try {
      owner = cache.router(makeRequest(proxyPath), ownerResponse);
      await originStarted.promise;
      follower = cache.router(makeRequest(proxyPath), followerResponse);
      followerResponse.destroy();

      await expect(withTimeout(follower, 100)).resolves.toBeUndefined();
      expect(requests).toBe(1);

      originRelease.resolve();
      await expect(owner).resolves.toBeUndefined();
    } finally {
      originRelease.resolve();
      await Promise.allSettled([owner, follower].filter((promise) => promise !== undefined));
      await cache.clear();
      await close(server);
    }
  });

  test('removes cancellation listeners after a coalesced follower completes', async () => {
    const originStarted = deferred();
    const originRelease = deferred();
    const server = http.createServer((_req, res) => {
      originStarted.resolve();
      res.setHeader('cache-control', 'max-age=60');
      void originRelease.promise.then(() => res.end('asset'));
    });
    const origin = await listen(server);
    const cache = createLocalCache(origin);
    const proxyPath = cache.encodeProxyPath(`${origin}/asset`);
    const ownerResponse = new RecordingResponse();
    const followerRequest = makeRequest(proxyPath);
    const followerResponse = new RecordingResponse();
    const controller = new AbortController();
    const removeSignalListener = spyOn(controller.signal, 'removeEventListener');
    followerRequest.signal = controller.signal;
    let owner: Promise<void> | undefined;
    let follower: Promise<void> | undefined;

    try {
      owner = cache.router(makeRequest(proxyPath), ownerResponse);
      await originStarted.promise;
      follower = cache.router(followerRequest, followerResponse);
      originRelease.resolve();
      await Promise.all([owner, follower]);

      expect(followerResponse.body.toString()).toBe('asset');
      expect(followerRequest.listenerCount('aborted')).toBe(0);
      expect(followerResponse.listenerCount('close')).toBe(0);
      expect(removeSignalListener).toHaveBeenCalledWith('abort', expect.any(Function));
    } finally {
      removeSignalListener.mockRestore();
      originRelease.resolve();
      await Promise.allSettled([owner, follower].filter((promise) => promise !== undefined));
      await cache.clear();
      await close(server);
    }
  });

  test('does not write an error response after the generation owner disconnects before headers', async () => {
    const originStarted = deferred();
    const originClosed = deferred();
    const server = http.createServer((req) => {
      originStarted.resolve();
      req.socket.once('close', originClosed.resolve);
    });
    const origin = await listen(server);
    const events: ProxyCacheEvent[] = [];
    const cache = createLocalCache(origin, (event) => events.push(event));
    const request = makeRequest(cache.encodeProxyPath(`${origin}/slow`));
    const response = new RecordingResponse();
    let operation: Promise<void> | undefined;

    try {
      operation = cache.router(request, response);
      await originStarted.promise;
      request.aborted = true;
      request.emit('aborted');

      await expect(withTimeout(operation, 500)).resolves.toBeUndefined();
      await expect(withTimeout(originClosed.promise, 500)).resolves.toBeUndefined();
      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveLength(0);
      expect(events.find((event) => event.type === 'error')).toMatchObject({
        type: 'error',
        phase: 'fetch',
        error: expect.objectContaining({ message: 'Client disconnected' }),
      });
    } finally {
      request.emit('aborted');
      await Promise.allSettled([operation].filter((promise) => promise !== undefined));
      await cache.clear();
      await close(server);
    }
  });

  test('returns a timeout diagnostic when an origin stalls before headers', async () => {
    const server = http.createServer(() => {});
    const origin = await listen(server);
    const cache = createLocalCache(origin, undefined, 25);

    try {
      const response = await requestCache(cache, `${origin}/slow`);

      expect(response.statusCode).toBe(504);
      expect(response.body.toString()).toContain('Origin request timed out after 25ms');
    } finally {
      await cache.clear();
      await close(server);
    }
  });

  test('returns a bad-gateway diagnostic for a non-timeout fetch failure', async () => {
    const server = http.createServer();
    const origin = await listen(server);
    await close(server);
    const cache = createLocalCache(origin, undefined, 250);

    try {
      const response = await requestCache(cache, `${origin}/unavailable`);

      expect(response.statusCode).toBe(502);
      expect(response.body.toString()).not.toContain('timed out');
    } finally {
      await cache.clear();
    }
  });

  test('cancels a stale refresh when its client disconnects', async () => {
    let requests = 0;
    const refreshStarted = deferred();
    const server = http.createServer((_req, res) => {
      requests++;
      if (requests === 1) {
        res.setHeader('cache-control', 'max-age=0');
        res.end('stale body');
      } else {
        refreshStarted.resolve();
      }
    });
    const origin = await listen(server);
    const cache = createLocalCache(origin);
    const proxyPath = cache.encodeProxyPath(`${origin}/asset`);
    const request = makeRequest(proxyPath);
    const response = new RecordingResponse();
    let refresh: Promise<void> | undefined;

    try {
      await requestCache(cache, `${origin}/asset`);
      refresh = cache.router(request, response);
      await refreshStarted.promise;
      request.aborted = true;
      request.emit('aborted');

      await expect(withTimeout(refresh, 500)).resolves.toBeUndefined();
      expect(response.body.toString()).toBe('stale body');
      expect(request.listenerCount('aborted')).toBe(0);
    } finally {
      request.emit('aborted');
      await Promise.allSettled([refresh].filter((promise) => promise !== undefined));
      await cache.clear();
      await close(server);
    }
  });

  test('retries a forced follower after its shared cache write fails', async () => {
    let requests = 0;
    let misses = 0;
    const cacheWriteStarted = deferred();
    const failCacheWrite = deferred();
    const followerJoined = deferred();
    const server = http.createServer((_req, res) => {
      requests++;
      res.setHeader('cache-control', 'max-age=60');
      res.end(requests < 3 ? 'version one' : 'version two');
    });
    const origin = await listen(server);
    const cache = createLocalCache(origin, (event) => {
      if (event.type === 'cache-miss' && ++misses === 3) {
        failCacheWrite.resolve();
        followerJoined.resolve();
      }
    });
    const proxyPath = cache.encodeProxyPath(`${origin}/asset`);
    const reloadRequest = () => ({ ...makeRequest(proxyPath), query: { reload: 'true' } });
    const ownerResponse = new RecordingResponse();
    const followerResponse = new RecordingResponse();
    let putStream: ReturnType<typeof spyOn> | undefined;
    let owner: Promise<void> | undefined;
    let follower: Promise<void> | undefined;

    try {
      await requestCache(cache, `${origin}/asset`);
      const failure = new Error('shared cache write failed');
      putStream = spyOn(cacache.put, 'stream').mockImplementation(() => {
        const writer = new stream.Writable({
          write(_chunk, _encoding, callback) {
            cacheWriteStarted.resolve();
            void failCacheWrite.promise.then(() => callback(failure));
          },
        });
        return writer as ReturnType<typeof cacache.put.stream>;
      });
      owner = cache.router(reloadRequest(), ownerResponse);
      await cacheWriteStarted.promise;
      follower = cache.router(reloadRequest(), followerResponse);
      await followerJoined.promise;
      putStream.mockRestore();

      await expect(withTimeout(owner, 500)).resolves.toBeUndefined();
      await expect(withTimeout(follower, 500)).resolves.toBeUndefined();
      expect(ownerResponse.streamError?.message).toBe(failure.message);
      expect(followerResponse.body.toString()).toBe('version two');
      expect(requests).toBe(3);
    } finally {
      failCacheWrite.resolve();
      putStream?.mockRestore();
      await Promise.allSettled([owner, follower].filter((promise) => promise !== undefined));
      await cache.clear();
      await close(server);
    }
  });

  test('retries a forced follower after its shared request times out before headers', async () => {
    let requests = 0;
    let misses = 0;
    let fireOriginTimeout: (() => void) | undefined;
    const stalledRequestStarted = deferred();
    const followerJoined = deferred();
    const server = http.createServer((_req, res) => {
      requests++;
      res.setHeader('cache-control', 'max-age=60');
      if (requests === 1) {
        res.end('version one');
      } else if (requests === 2) {
        stalledRequestStarted.resolve();
      } else {
        res.end('version two');
      }
    });
    const origin = await listen(server);
    const originalSetTimeout = globalThis.setTimeout;
    const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 12_345) {
        fireOriginTimeout = () => callback(...args);
        return undefined as unknown as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    const cache = createLocalCache(
      origin,
      (event) => {
        if (event.type === 'cache-miss' && ++misses === 3) {
          fireOriginTimeout!();
          timeoutSpy.mockRestore();
          followerJoined.resolve();
        }
      },
      12_345
    );
    const proxyPath = cache.encodeProxyPath(`${origin}/asset`);
    const reloadRequest = () => ({ ...makeRequest(proxyPath), query: { reload: 'true' } });
    const ownerResponse = new RecordingResponse();
    const followerResponse = new RecordingResponse();
    let owner: Promise<void> | undefined;
    let follower: Promise<void> | undefined;

    try {
      await requestCache(cache, `${origin}/asset`);
      owner = cache.router(reloadRequest(), ownerResponse);
      await stalledRequestStarted.promise;
      follower = cache.router(reloadRequest(), followerResponse);
      await followerJoined.promise;

      await expect(withTimeout(owner, 500)).resolves.toBeUndefined();
      await expect(withTimeout(follower, 500)).resolves.toBeUndefined();
      expect(followerResponse.body.toString()).toBe('version two');
      expect(requests).toBe(3);
    } finally {
      timeoutSpy.mockRestore();
      await Promise.allSettled([owner, follower].filter((promise) => promise !== undefined));
      await cache.clear();
      await close(server);
    }
  });

  test('retries a forced follower after its shared stale refresh is disconnected', async () => {
    let requests = 0;
    let misses = 0;
    const refreshStarted = deferred();
    const followerJoined = deferred();
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
    const staleRequest = makeRequest('');
    const cache = createLocalCache(origin, (event) => {
      if (event.type === 'cache-miss' && ++misses === 3) {
        staleRequest.aborted = true;
        staleRequest.emit('aborted');
        followerJoined.resolve();
      }
    });
    const proxyPath = cache.encodeProxyPath(`${origin}/asset`);
    staleRequest.path = proxyPath;
    const staleResponse = new RecordingResponse();
    const followerResponse = new RecordingResponse();
    let staleOwner: Promise<void> | undefined;
    let forcedFollower: Promise<void> | undefined;

    try {
      await requestCache(cache, `${origin}/asset`);
      staleOwner = cache.router(staleRequest, staleResponse);
      await refreshStarted.promise;
      forcedFollower = cache.router({ ...makeRequest(proxyPath), query: { reload: 'true' } }, followerResponse);
      await followerJoined.promise;

      await expect(withTimeout(staleOwner, 500)).resolves.toBeUndefined();
      await expect(withTimeout(forcedFollower, 500)).resolves.toBeUndefined();
      expect(staleResponse.body.toString()).toBe('version one');
      expect(followerResponse.body.toString()).toBe('version two');
      expect(requests).toBe(3);
    } finally {
      staleRequest.emit('aborted');
      await Promise.allSettled([staleOwner, forcedFollower].filter((promise) => promise !== undefined));
      await cache.clear();
      await close(server);
    }
  });

  test('propagates a cache-writer failure without committing an entry', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('cache-control', 'max-age=60');
      res.end('body');
    });
    const origin = await listen(server);
    const events: ProxyCacheEvent[] = [];
    const cache = createLocalCache(origin, (event) => events.push(event));
    const failure = new Error('cache writer failed');
    const putStream = spyOn(cacache.put, 'stream').mockImplementation(
      () =>
        new stream.Writable({
          write(_chunk, _encoding, callback) {
            callback(failure);
          },
        }) as ReturnType<typeof cacache.put.stream>
    );

    try {
      const response = await requestCache(cache, `${origin}/asset`);

      expect(response.streamError?.message).toBe(failure.message);
      expect(Object.keys(await cache.ls())).toHaveLength(0);
      expect(events.some((event) => event.type === 'error' && event.phase === 'stream')).toBe(true);
    } finally {
      putStream.mockRestore();
      await cache.clear();
      await close(server);
    }
  });

  test('tears down the origin after an asynchronous cache-writer failure', async () => {
    let resolveOriginClosed: () => void = () => {};
    const originClosed = new Promise<void>((resolve) => {
      resolveOriginClosed = resolve;
    });
    const server = http.createServer((req, res) => {
      req.socket.once('close', resolveOriginClosed);
      res.writeHead(200, { 'cache-control': 'max-age=60' });
      const interval = setInterval(() => res.write(Buffer.alloc(4_096)), 2);
      res.on('close', () => clearInterval(interval));
    });
    const origin = await listen(server);
    const cache = createLocalCache(origin);
    const failure = new Error('asynchronous cache failure');
    let injectedFailure = false;
    const putStream = spyOn(cacache.put, 'stream').mockImplementation(() => {
      const writer = new stream.Writable({
        write(_chunk, _encoding, callback) {
          callback();
          if (!injectedFailure) {
            injectedFailure = true;
            setImmediate(() => writer.destroy(failure));
          }
        },
      });
      return writer as ReturnType<typeof cacache.put.stream>;
    });

    try {
      const response = await requestCache(cache, `${origin}/asset`);

      expect(response.streamError?.message).toBe(failure.message);
      expect(Object.keys(await cache.ls())).toHaveLength(0);
      await expect(withTimeout(originClosed, 500)).resolves.toBeUndefined();
    } finally {
      putStream.mockRestore();
      await cache.clear();
      await close(server);
    }
  });

  for (const encoding of ['br', 'gzip, br']) {
    test(`passes ${encoding} CSS through opaquely on misses and hits`, async () => {
      let origin = '';
      let encoded = Buffer.alloc(0);
      let requests = 0;
      const server = http.createServer((_req, res) => {
        requests++;
        res.setHeader('cache-control', 'max-age=60');
        res.setHeader('content-encoding', encoding);
        res.setHeader('content-type', 'text/css');
        res.end(encoded);
      });
      origin = await listen(server);
      encoded = Buffer.from(`body { background: url("${origin}/asset.png"); }`);
      const events: ProxyCacheEvent[] = [];
      const cache = createLocalCache(origin, (event) => events.push(event));

      try {
        const miss = await requestCache(cache, `${origin}/style.css`);
        expect(events.map((event) => event.type)).toEqual(['request', 'cache-miss', 'cache-write']);
        expect(Object.keys(await cache.ls())).toHaveLength(1);
        const hit = await requestCache(cache, `${origin}/style.css`);

        expect(miss.body).toEqual(encoded);
        expect(hit.body).toEqual(encoded);
        expect(hit.headers['x-cdn-proxy-cache-hit']).toBe('HIT');
        expect(miss.listenerCount('error')).toBe(1);
        expect(hit.listenerCount('error')).toBe(1);
        expect(requests).toBe(1);
      } finally {
        await cache.clear();
        await close(server);
      }
    });
  }
});

class RecordingResponse extends stream.Writable implements ResponseI {
  chunks: Buffer[] = [];
  headers: Record<string, string> = {};
  statusCode = 200;
  streamError?: Error;
  private readonly disconnectAfterFirstChunk: boolean;

  constructor({ disconnectAfterFirstChunk = false } = {}) {
    super();
    this.disconnectAfterFirstChunk = disconnectAfterFirstChunk;
    this.on('error', (error) => {
      this.streamError = error;
    });
  }

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
    if (this.disconnectAfterFirstChunk && this.chunks.length === 1) {
      this.destroy(new Error('client disconnected'));
    }
    callback();
  }

  get body(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function createLocalCache(origin: string, onEvent?: (event: ProxyCacheEvent) => void, requestTimeoutMs?: number) {
  return createProxyCache({
    proxyPrefix: '/__proxy_cache',
    cachePath: path.join(os.tmpdir(), `cdn-proxy-cache-stream-test-${randomUUID()}`),
    cacheSeeds: [],
    onEvent,
    requestTimeoutMs,
    shouldProxyPath: (url) => url.startsWith(`${origin}/`),
  });
}

function makeRequest(proxyPath: string): RequestI & EventEmitter & { aborted: boolean } {
  return Object.assign(new EventEmitter(), {
    aborted: false,
    headers: {},
    path: proxyPath,
    query: {},
  });
}

async function requestCache(cache: ReturnType<typeof createProxyCache>, url: string): Promise<RecordingResponse> {
  const response = new RecordingResponse();
  await cache.router(makeRequest(cache.encodeProxyPath(url)), response);
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

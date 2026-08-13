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

function makeRequest(proxyPath: string): RequestI {
  return Object.assign(new EventEmitter(), {
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

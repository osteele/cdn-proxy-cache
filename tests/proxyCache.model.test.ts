import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import stream from 'node:stream';
import { createProxyCache, HTTP_RESPONSE_HEADER_CACHE_STATUS, type ProxyCache } from '../src/proxyCache';

// This suite treats the origin and cache as a state machine. The reference model
// predicts only public observations; it does not call cache-policy implementation
// helpers from the library under test.

type CacheBehavior = 'fresh' | 'stale' | 'revalidate' | 'must-revalidate' | 'uncacheable';
type Policy = keyof typeof policySpecs;

const policySpecs = {
  fresh: { behavior: 'fresh', cacheControl: 'max-age=3600', status: 200 },
  stale: { behavior: 'stale', cacheControl: 'max-age=0', status: 200 },
  revalidate: { behavior: 'revalidate', cacheControl: 'no-cache', status: 200 },
  'must-revalidate': { behavior: 'must-revalidate', cacheControl: 'max-age=0, must-revalidate', status: 200 },
  'no-store': { behavior: 'uncacheable', cacheControl: 'no-store', status: 200 },
  private: { behavior: 'uncacheable', cacheControl: 'private, max-age=3600', status: 200 },
  'vary-star': { behavior: 'uncacheable', cacheControl: 'max-age=3600', status: 200 },
  empty: { behavior: 'fresh', cacheControl: 'max-age=3600', status: 204 },
  'not-found': { behavior: 'uncacheable', cacheControl: 'max-age=3600', status: 404 },
  'server-error': { behavior: 'uncacheable', cacheControl: 'max-age=3600', status: 500 },
} as const satisfies Record<string, { behavior: CacheBehavior; cacheControl: string; status: number }>;

type ModelRequest = {
  acceptEncoding?: string;
  acceptLanguage: string;
  policy: Policy;
  reload?: boolean;
  resource: string;
};

type ModelAction =
  | { type: 'request'; request: ModelRequest }
  | { type: 'mutate'; resource: string }
  | { type: 'clear' };

type ObservedResponse = {
  body: string;
  cacheStatus: 'HIT' | 'MISS';
  status: number;
};

type ModelEntry = {
  body: string;
  status: number;
};

class ReferenceCacheModel {
  readonly entries = new Map<string, ModelEntry>();
  readonly versions = new Map<string, number>();
  originRequests = 0;

  apply(action: ModelAction): ObservedResponse | null {
    switch (action.type) {
      case 'clear':
        this.entries.clear();
        return null;
      case 'mutate':
        this.versions.set(action.resource, this.version(action.resource) + 1);
        return null;
      case 'request':
        return this.request(action.request);
    }
  }

  private request(request: ModelRequest): ObservedResponse {
    const spec = policySpecs[request.policy];
    const key = modelCacheKey(request);
    const entry = this.entries.get(key);
    const current = this.currentEntry(request);

    switch (spec.behavior) {
      case 'fresh':
        if (entry && !request.reload) return asResponse(entry, 'HIT');
        this.originRequests++;
        this.entries.set(key, current);
        return asResponse(current, 'MISS');

      case 'stale':
        if (entry && !request.reload) {
          this.originRequests++;
          this.entries.set(key, current);
          return asResponse(entry, 'HIT');
        }
        this.originRequests++;
        this.entries.set(key, current);
        return asResponse(current, 'MISS');

      case 'revalidate':
        this.originRequests++;
        if (entry && !request.reload && entry.body === current.body) return asResponse(entry, 'HIT');
        this.entries.set(key, current);
        return asResponse(current, 'MISS');

      case 'must-revalidate':
        this.originRequests++;
        this.entries.set(key, current);
        return asResponse(current, 'MISS');

      case 'uncacheable':
        this.originRequests++;
        return asResponse(current, 'MISS');
    }
  }

  private currentEntry(request: ModelRequest): ModelEntry {
    const status = policySpecs[request.policy].status;
    if (request.policy === 'empty') return { body: '', status };
    if (status >= 400) return { body: http.STATUS_CODES[status] ?? '', status };
    const language = normalizeLanguage(request.acceptLanguage);
    return {
      body: `${request.policy}:${request.resource}:${language}:v${this.version(request.resource)}`,
      status,
    };
  }

  private version(resource: string): number {
    return this.versions.get(resource) ?? 1;
  }
}

class ModelOrigin {
  requests = 0;
  readonly versions = new Map<string, number>();

  mutate(resource: string): void {
    this.versions.set(resource, this.version(resource) + 1);
  }

  respond(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.requests++;
    const url = new URL(req.url ?? '/', 'http://origin.test');
    const [, rawPolicy, resource] = url.pathname.split('/');
    if (!isPolicy(rawPolicy) || !resource) {
      res.statusCode = 500;
      res.end('invalid model request');
      return;
    }

    const spec = policySpecs[rawPolicy];
    const language = normalizeLanguage(headerString(req.headers['accept-language']) ?? 'none');
    const body = `${rawPolicy}:${resource}:${language}:v${this.version(resource)}`;
    res.statusCode = spec.status;
    res.setHeader('cache-control', spec.cacheControl);
    res.setHeader('vary', rawPolicy === 'vary-star' ? '*' : 'Accept-Language');

    if (rawPolicy === 'revalidate') {
      const etag = `"${body}"`;
      res.setHeader('etag', etag);
      if (req.headers['if-none-match'] === etag) {
        res.statusCode = 304;
        res.end();
        return;
      }
    }

    if (rawPolicy === 'empty') {
      res.end();
    } else if (spec.status >= 400) {
      res.end('origin body is deliberately hidden by the proxy');
    } else {
      res.end(body);
    }
  }

  private version(resource: string): number {
    return this.versions.get(resource) ?? 1;
  }
}

describe('proxy cache reference model', () => {
  test('matches the reference model across explicit lifecycle transitions', async () => {
    const repeatedCompressedRequest: ModelRequest = {
      policy: 'fresh',
      resource: 'alpha',
      acceptLanguage: 'en-US',
      acceptEncoding: 'gzip, deflate, br',
    };
    const actions: ModelAction[] = [
      { type: 'request', request: repeatedCompressedRequest },
      { type: 'request', request: { ...repeatedCompressedRequest, acceptEncoding: 'deflate, gzip' } },
      { type: 'mutate', resource: 'alpha' },
      { type: 'request', request: repeatedCompressedRequest },
      { type: 'request', request: { ...repeatedCompressedRequest, reload: true } },
      { type: 'request', request: { ...repeatedCompressedRequest, acceptLanguage: 'fr-FR' } },
      modelRequest('revalidate', 'alpha'),
      modelRequest('revalidate', 'alpha'),
      { type: 'mutate', resource: 'alpha' },
      modelRequest('revalidate', 'alpha'),
      modelRequest('stale', 'beta'),
      { type: 'mutate', resource: 'beta' },
      modelRequest('stale', 'beta'),
      modelRequest('stale', 'beta'),
      modelRequest('must-revalidate', 'beta'),
      modelRequest('must-revalidate', 'beta'),
      modelRequest('no-store', 'alpha'),
      modelRequest('no-store', 'alpha'),
      modelRequest('private', 'alpha'),
      modelRequest('vary-star', 'alpha'),
      modelRequest('empty', 'alpha'),
      modelRequest('empty', 'alpha'),
      modelRequest('not-found', 'alpha'),
      modelRequest('not-found', 'alpha'),
      modelRequest('server-error', 'alpha'),
      modelRequest('server-error', 'alpha'),
      { type: 'clear' },
      modelRequest('fresh', 'alpha'),
    ];

    await executeModelSequences([{ name: 'explicit', actions }]);
  });

  test('matches deterministic generated operation sequences', async () => {
    const sequences = Array.from({ length: 10 }, (_, seed) => ({
      name: `seed-${seed + 1}`,
      actions: generateActions(seed + 1, 30),
    }));
    await executeModelSequences(sequences);
  });

  test('matches modeled coalescing transitions', async () => {
    const originState = new ModelOrigin();
    const server = http.createServer((req, res) => originState.respond(req, res));
    const origin = await listen(server);
    const cache = createModelCache(origin);
    const fresh = requestFor(origin, modelRequestValue('fresh', 'alpha'));
    const stale = requestFor(origin, modelRequestValue('stale', 'beta'));

    try {
      const coldBurst = await Promise.all(Array.from({ length: 8 }, () => requestCache(cache, fresh)));
      expect(coldBurst.map((response) => response.body)).toEqual(Array(8).fill('fresh:alpha:en-us:v1'));
      expect(coldBurst.filter((response) => response.cacheStatus === 'MISS')).toHaveLength(1);
      expect(originState.requests).toBe(1);
      expect(Object.keys(await cache.ls())).toHaveLength(1);

      const primedStale = await requestCache(cache, stale);
      expect(primedStale).toEqual({ body: 'stale:beta:en-us:v1', cacheStatus: 'MISS', status: 200 });
      originState.mutate('beta');
      const staleBurst = await Promise.all(Array.from({ length: 8 }, () => requestCache(cache, stale)));
      expect(staleBurst).toEqual(Array(8).fill({ body: 'stale:beta:en-us:v1', cacheStatus: 'HIT', status: 200 }));
      expect(originState.requests).toBe(3);

      const refreshed = await requestCache(cache, stale);
      expect(refreshed).toEqual({ body: 'stale:beta:en-us:v2', cacheStatus: 'HIT', status: 200 });
      expect(originState.requests).toBe(4);
    } finally {
      await cache.clear();
      await close(server);
    }
  });
});

async function executeModelSequences(sequences: { name: string; actions: ModelAction[] }[]): Promise<void> {
  const originState = new ModelOrigin();
  const server = http.createServer((req, res) => originState.respond(req, res));
  const origin = await listen(server);

  try {
    for (const sequence of sequences) {
      const cache = createModelCache(origin);
      const model = new ReferenceCacheModel();
      originState.requests = 0;
      originState.versions.clear();
      try {
        for (const [step, action] of sequence.actions.entries()) {
          const expectedResponse = model.apply(action);
          let actualResponse: ObservedResponse | null = null;
          switch (action.type) {
            case 'clear':
              await cache.clear();
              break;
            case 'mutate':
              originState.mutate(action.resource);
              break;
            case 'request':
              actualResponse = await requestCache(cache, requestFor(origin, action.request));
              break;
          }

          const actualState = {
            cacheEntries: Object.keys(await cache.ls()).length,
            originRequests: originState.requests,
            response: actualResponse,
          };
          const expectedState = {
            cacheEntries: model.entries.size,
            originRequests: model.originRequests,
            response: expectedResponse,
          };
          expect({ sequence: sequence.name, step, action, state: actualState }).toEqual({
            sequence: sequence.name,
            step,
            action,
            state: expectedState,
          });
        }
      } finally {
        await cache.clear();
      }
    }
  } finally {
    await close(server);
  }
}

function generateActions(seed: number, length: number): ModelAction[] {
  const random = mulberry32(seed);
  const policies = Object.keys(policySpecs) as Policy[];
  const resources = ['alpha', 'beta'];
  const languages = ['en-US', 'fr-FR'];
  const encodings = [undefined, 'gzip', 'gzip, deflate, br', 'deflate, gzip'];
  const actions: ModelAction[] = [];
  let previousRequest: ModelRequest | undefined;

  for (let index = 0; index < length; index++) {
    const choice = random();
    if (choice < 0.12) {
      actions.push({ type: 'clear' });
    } else if (choice < 0.28) {
      actions.push({ type: 'mutate', resource: pick(random, resources) });
    } else {
      const reusePrevious = previousRequest && random() < 0.55;
      const request: ModelRequest = reusePrevious
        ? { ...previousRequest, reload: random() < 0.12 }
        : {
            policy: pick(random, policies),
            resource: pick(random, resources),
            acceptLanguage: pick(random, languages),
            acceptEncoding: pick(random, encodings),
            reload: random() < 0.12,
          };
      if (request.acceptEncoding === 'gzip, deflate, br' && random() < 0.5) {
        request.acceptEncoding = 'deflate, gzip';
      }
      actions.push({ type: 'request', request });
      previousRequest = request;
    }
  }
  return actions;
}

function modelRequest(policy: Policy, resource: string): ModelAction {
  return { type: 'request', request: modelRequestValue(policy, resource) };
}

function modelRequestValue(policy: Policy, resource: string): ModelRequest {
  return { policy, resource, acceptLanguage: 'en-US' };
}

function requestFor(origin: string, request: ModelRequest): ModelRequest & { url: string } {
  return { ...request, url: `${origin}/${request.policy}/${request.resource}` };
}

function modelCacheKey(request: ModelRequest): string {
  return JSON.stringify({
    policy: request.policy,
    resource: request.resource,
    acceptLanguage: normalizeLanguage(request.acceptLanguage),
    acceptEncoding: normalizeEncoding(request.acceptEncoding),
  });
}

function normalizeEncoding(value: string | undefined): string | null {
  if (!value) return null;
  const encodings = value
    .split(',')
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding !== 'br')
    .sort();
  return encodings.join(', ') || null;
}

function normalizeLanguage(value: string): string {
  return value.toLowerCase();
}

function asResponse(entry: ModelEntry, cacheStatus: 'HIT' | 'MISS'): ObservedResponse {
  return { ...entry, cacheStatus };
}

function isPolicy(value: string): value is Policy {
  return value in policySpecs;
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(',') : value;
}

function createModelCache(origin: string): ProxyCache {
  return createProxyCache({
    proxyPrefix: '/__proxy_cache',
    cachePath: path.join(os.tmpdir(), `cdn-proxy-cache-model-${randomUUID()}`),
    cacheSeeds: [],
    shouldProxyPath: (url) => url.startsWith(`${origin}/`),
  });
}

async function requestCache(cache: ProxyCache, request: ModelRequest & { url: string }): Promise<ObservedResponse> {
  const response = new (class extends stream.Writable {
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
    _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
      this.chunks.push(chunk);
      callback();
    }
  })();

  const headers: http.IncomingHttpHeaders = {
    accept: '*/*',
    'accept-language': request.acceptLanguage,
  };
  if (request.acceptEncoding) headers['accept-encoding'] = request.acceptEncoding;
  await cache.router(
    {
      headers,
      path: cache.encodeProxyPath(request.url),
      query: request.reload ? { reload: 'true' } : {},
    },
    response
  );
  return {
    body: Buffer.concat(response.chunks).toString(),
    cacheStatus: response.headers[HTTP_RESPONSE_HEADER_CACHE_STATUS] as 'HIT' | 'MISS',
    status: response.statusCode,
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)];
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
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

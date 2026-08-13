# cdn-proxy-cache

[![CI](https://github.com/osteele/cdn-proxy-cache/workflows/CI/badge.svg)](https://github.com/osteele/cdn-proxy-cache/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >= 18.17](https://img.shields.io/badge/node-%3E%3D18.17-339933?logo=node.js&logoColor=white)](package.json)

`cdn-proxy-cache` is an Express middleware library for caching CDN resources on disk. It rewrites CDN URLs in HTML and CSS so applications can continue to load cached assets while offline.

## Features

- Stores responses in a content-addressable cache managed by `cacache`.
- Rewrites matching `<script src>`, stylesheet `<link href>`, and CSS `url()` values.
- Preserves gzip and deflate encoding while rewriting CSS.
- Coalesces simultaneous misses and stale refreshes for the same cache key.
- Revalidates cached responses with ETag and Last-Modified validators.
- Serves ordinary expired entries while refreshing them in the background.
- Honors `no-store`, `private`, `no-cache`, and `must-revalidate` cache directives.
- Warms the cache from seed URLs and follows references found in CSS.
- Supports Express 4 and 5 on Node.js 18.17 or later.
- Reports structured request, cache, and error events.

## Installation

Install the library and its Express peer dependency:

```bash
npm install cdn-proxy-cache express
```

With Bun:

```bash
bun add cdn-proxy-cache express
```

## Quick start

```typescript
import express from 'express';
import { createProxyCache } from 'cdn-proxy-cache';
import os from 'node:os';
import path from 'node:path';

const app = express();
const cdnHosts = new Set(['cdn.jsdelivr.net', 'cdnjs.cloudflare.com']);

const cache = createProxyCache({
  proxyPrefix: '/__proxy_cache',
  cachePath: path.join(os.homedir(), '.cache', 'my-app'),
  cacheSeeds: [
    'https://cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js',
  ],
  shouldProxyPath: (url) => /^https?:/.test(url) && cdnHosts.has(new URL(url).hostname),
});

app.use(cache.proxyPrefix, cache.router);

app.get('/', (_req, res) => {
  const html = `
    <!doctype html>
    <html>
      <head>
        <script src="https://cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js"></script>
      </head>
      <body><h1>Hello</h1></body>
    </html>
  `;
  res.send(cache.replaceUrlsInHtml(html));
});

app.listen(3000);
```

`shouldProxyPath` is the proxy allowlist. Rewriting methods leave rejected URLs unchanged. Requests that address a rejected URL through `cache.router` receive HTTP 403.

## Cache warming

`cache.warm()` fetches seed URLs concurrently and follows relative or proxied URLs found in CSS. It does not inspect HTML or JavaScript for more dependencies.

```typescript
const stats = await cache.warm({ concurrency: 8 }, (message) => {
  if (message.type === 'progress') {
    const completed = message.stats.hits + message.stats.misses + message.stats.failures;
    console.log(`Completed ${completed} requests`);
  }
});

console.log(stats);
```

Pass an `AbortSignal` to cancel warming and its active origin requests:

```typescript
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
try {
  await cache.warm({ signal: controller.signal });
} catch (error) {
  if (!controller.signal.aborted) throw error;
}
```

## API

### `createProxyCache(options)`

Creates a `ProxyCache` instance.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `proxyPrefix` | `string` | required | URL prefix mounted on the Express application. |
| `cachePath` | `string` | required | Directory used for cached content and metadata. |
| `cacheSeeds` | `string[]` | required | Starting URLs for `cache.warm()`. Use an empty array when warming is not needed. |
| `shouldProxyPath` | `(url: string) => boolean` | required | Return `true` for URLs that the cache may rewrite and proxy. |
| `cssTransformVersion` | `string` | `''` | Bump when configuration captured by `shouldProxyPath` changes without changing the callback source. |
| `requestTimeoutMs` | `number` | `30000` | Maximum origin-request time, including response streaming. |
| `maxCssTransformBytes` | `number` | `5242880` | Maximum decompressed CSS size buffered for rewriting. |
| `warmConcurrency` | `number` | `20` | Default maximum number of simultaneous warming requests. |
| `onEvent` | `(event: ProxyCacheEvent) => void` | none | Receives structured lifecycle events. |

The three numeric options must be positive integers. An origin timeout produces HTTP 504 if response headers have not been sent. CSS that exceeds `maxCssTransformBytes` fails the response and emits a stream error event.

### `cache.router(req, res)`

Handles a proxy request. Mount it at the configured prefix:

```typescript
app.use(cache.proxyPrefix, cache.router);
```

Responses include these diagnostic headers:

- `x-cdn-proxy-cache-hit`: `HIT` or `MISS`.
- `x-cdn-proxy-origin-url`: decoded origin URL.

The cache does not store responses marked `no-store` or `private`, or responses with `Vary: *`. It fetches `no-cache` responses before serving them. Expired responses marked `must-revalidate` are also fetched before they are served. Other expired responses are served immediately and refreshed in the background.

### `cache.replaceUrlsInHtml(html)`

Rewrites allowed URLs in `<script src>` and `<link rel="stylesheet" href>` attributes.

```typescript
const rewrittenHtml = cache.replaceUrlsInHtml(originalHtml);
```

### `cache.replaceUrlsInCss(css)`

Rewrites allowed absolute URLs in CSS `url()` values. Relative URLs and data URLs remain unchanged.

```typescript
const rewrittenCss = cache.replaceUrlsInCss(originalCss);
```

### `cache.warm(options, callback?)`

Fetches seed URLs and CSS dependencies. The options are:

- `force`: bypass existing cache entries.
- `reload`: start from URLs already in the cache instead of `cacheSeeds`. Combine it with `force` to refetch them.
- `concurrency`: override `warmConcurrency` for this operation.
- `signal`: cancel warming with an `AbortSignal`.

The callback receives one of these messages:

```typescript
type CacheWarmMessage =
  | { type: 'initial'; total: number }
  | { type: 'prefetch'; url: string }
  | { type: 'progress'; stats: CacheWarmStats }
  | { type: 'error'; url: string; status: number };
```

The returned `CacheWarmStats` contains `total`, `hits`, `misses`, and `failures`.

### Cache management

```typescript
await cache.clear();

const entries = await cache.ls();

cache.isProxyPath('/__proxy_cache/cdn.jsdelivr.net/example.js');

const proxyPath = cache.encodeProxyPath('https://cdn.jsdelivr.net/example.js');
const originUrl = cache.decodeProxyPath(proxyPath);
```

`cache.ls()` returns the underlying `cacache.ls()` result. The encoding methods preserve an origin query string inside the proxy's `search` parameter. This leaves room for proxy-specific query parameters without changing the origin URL.

## Lifecycle events

The optional `onEvent` callback receives these events:

```typescript
type ProxyCacheEvent =
  | { type: 'request'; url: string }
  | { type: 'cache-hit'; url: string; stale: boolean }
  | { type: 'cache-miss'; url: string }
  | { type: 'cache-write'; url: string; bytes: number }
  | { type: 'cache-skip'; url: string; reason: 'no-store' | 'private' | 'vary-star' }
  | { type: 'error'; url: string; phase: 'fetch' | 'stream'; error: Error };
```

```typescript
const cache = createProxyCache({
  // Other options...
  onEvent: (event) => {
    if (event.type === 'error') console.error(event.url, event.error);
  },
});
```

## Command helpers

The package exports functions for applications that provide their own command-line interface:

```typescript
import { clearCache, listCache, showCacheInfo, warmCache } from 'cdn-proxy-cache';

await clearCache(cache);
await warmCache(cache, { force: false, verbose: true });
await listCache(cache, { json: false, verbose: true });
await showCacheInfo(cache);
await showCacheInfo(cache, 'https://cdn.jsdelivr.net/example.js');
```

The package does not install a command-line executable.

## Request flow

Each request uses a cache key built from the origin URL and canonicalized `Accept`, `Accept-Language`, and `Accept-Encoding` values. These are all the representation-selecting request headers forwarded to the origin; the browser's `User-Agent` is not forwarded. The proxy removes Brotli from `Accept-Encoding` so browsers can share gzip or deflate entries without creating duplicates for equivalent header orderings.

On a miss, ordinary origin bodies are sent to the client and `cacache` at the same time. CSS takes a separate transformation path because `css-tree` needs the complete decompressed stylesheet; the rewritten result is cached so subsequent hits do not repeat parsing and compression. The cache records a fingerprint of the transformation configuration and refetches transformed CSS when that fingerprint changes. Set `cssTransformVersion` when `shouldProxyPath` depends on closed-over configuration that may change between cache instances. Other response bodies remain streaming.

## Development

The project uses Bun for dependency management and tests, Biome for formatting and linting, and TypeScript for type checking.

```bash
bun install
just check
just build
```

Run `just` to list the available development tasks.

## License

MIT © Oliver Steele

## Related project

[p5-server](https://github.com/osteele/p5-server) contains the implementation from which this package was extracted.

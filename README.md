# cdn-proxy-cache

[![CI](https://github.com/osteele/cdn-proxy-cache/workflows/CI/badge.svg)](https://github.com/osteele/cdn-proxy-cache/actions)
[![npm version](https://img.shields.io/npm/v/cdn-proxy-cache.svg)](https://www.npmjs.com/package/cdn-proxy-cache)
[![Bun](https://img.shields.io/badge/Bun-000000?logo=bun&logoColor=white)](https://bun.sh)
[![License](https://img.shields.io/npm/l/cdn-proxy-cache.svg)](LICENSE)
[![Node Version](https://img.shields.io/node/v/cdn-proxy-cache.svg)](https://www.npmjs.com/package/cdn-proxy-cache)

A caching proxy for CDN resources with URL rewriting, content transformation, and Express integration. Enables offline development by caching CDN assets locally.

## Features

- **Intelligent Caching**: Disk-based caching using npm's `cacache` library
- **URL Rewriting**: Automatically rewrites CDN URLs in HTML and CSS files
- **Content Transformation**: Handles gzip/deflate compression transparently
- **Stale-While-Revalidate**: Serves cached content while updating in background
- **Cache Warming**: Pre-fetch resources with recursive dependency resolution
- **Express Middleware**: Easy integration with Express applications
- **CLI Commands**: Programmatic cache management (clear, warm, list, info)
- **Configurable**: Callback-based CDN detection for maximum flexibility

## Installation

```bash
bun add cdn-proxy-cache express
```

## Quick Start

### Basic Usage

```typescript
import express from 'express';
import { createProxyCache } from 'cdn-proxy-cache';
import os from 'node:os';
import path from 'node:path';

const app = express();
const cdnHosts = new Set(['cdn.jsdelivr.net', 'cdnjs.cloudflare.com']);

// Create a proxy cache instance
const cache = createProxyCache({
  proxyPrefix: '/__proxy_cache',
  cachePath: path.join(os.homedir(), '.cache', 'my-app'),
  cacheSeeds: [
    'https://cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js',
  ],
  shouldProxyPath: (url) => /^https?:/.test(url) && cdnHosts.has(new URL(url).hostname),
  requestTimeoutMs: 30_000,
  maxCssTransformBytes: 5 * 1024 * 1024,
  warmConcurrency: 20,
  onEvent: (event) => console.debug(event),
});

// Mount the proxy router
app.use(cache.proxyPrefix, cache.router);

// Rewrite HTML to use cached URLs
app.get('/', (req, res) => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <script src="https://cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js"></script>
      </head>
      <body>
        <h1>Hello World</h1>
      </body>
    </html>
  `;
  res.send(cache.replaceUrlsInHtml(html));
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
```

### With Cache Warming

```typescript
// Warm the cache at startup
await cache.warm({ force: false }, (message) => {
  if (message.type === 'progress') {
    console.log(`Cached ${message.stats.total} resources`);
  }
});
```

## API Reference

### `createProxyCache(options)`

Creates a new proxy cache instance.

**Options:**

- `proxyPrefix` (string): URL prefix for proxied resources (e.g., `'/__proxy_cache'`)
- `cachePath` (string): Local directory for cache storage
- `cacheSeeds` (string[]): URLs to pre-fetch when warming the cache
- `shouldProxyPath` (function): Callback to determine if a URL should be proxied
  - Signature: `(url: string) => boolean`
  - Return `true` to proxy the URL, `false` to pass through
- `requestTimeoutMs` (number, default `30000`): Origin-request timeout, including response streaming
- `maxCssTransformBytes` (number, default `5242880`): Maximum decompressed CSS size buffered for rewriting
- `warmConcurrency` (number, default `20`): Default cache-warming concurrency
- `onEvent` (function): Receives structured request, hit, miss, write, skip, and error events

Responses marked `no-store` or `private` are not stored. Responses marked `no-cache`, and expired responses marked
`must-revalidate`, are fetched from the origin before they are served.

**Returns:** `ProxyCache` instance with the following methods:

#### `cache.router(req, res)`

Express middleware that handles proxy requests. Mount this at the `proxyPrefix` path.

```typescript
app.use(cache.proxyPrefix, cache.router);
```

#### `cache.replaceUrlsInHtml(html)`

Rewrites CDN URLs in HTML `<script src>` and `<link href>` attributes to use the proxy.

```typescript
const rewrittenHtml = cache.replaceUrlsInHtml(originalHtml);
```

#### `cache.warm(options, callback?)`

Pre-fetches resources into the cache.

**Options:**
- `force` (boolean): Re-fetch even if already cached
- `reload` (boolean): Re-fetch all currently cached items (requires `force: true`)
- `concurrency` (number): Override the instance's cache-warming concurrency
- `signal` (AbortSignal): Cancel warming and its in-flight origin requests

**Callback:** Receives progress messages:
- `{ type: 'initial', total: number }` - Cache warming started
- `{ type: 'prefetch', url: string }` - Fetching a URL
- `{ type: 'progress', stats: CacheWarmStats }` - Progress update
- `{ type: 'error', url: string, status: number }` - Fetch failed

**Returns:** Promise<CacheWarmStats>

```typescript
const stats = await cache.warm({ force: false }, (msg) => {
  if (msg.type === 'prefetch') {
    console.log(`Fetching: ${msg.url}`);
  }
});
console.log(`Cached ${stats.total} resources (${stats.hits} hits, ${stats.misses} misses)`);
```

#### `cache.clear()`

Clears all cached entries.

```typescript
await cache.clear();
```

#### `cache.ls()`

Lists all cached entries. Returns cacache's `ls()` result.

```typescript
const entries = await cache.ls();
for (const [key, entry] of Object.entries(entries)) {
  console.log(entry.metadata.originUrl);
}
```

#### `cache.isProxyPath(url)`

Checks if a URL is a proxy path.

```typescript
cache.isProxyPath('/__proxy_cache/cdn.jsdelivr.net/...') // true
```

#### `cache.encodeProxyPath(url)` / `cache.decodeProxyPath(path, query?)`

URL encoding/decoding utilities (primarily for testing).

## CLI Commands

The library exports command functions that can be integrated into your application's CLI:

```typescript
import { clearCache, warmCache, listCache, showCacheInfo } from 'cdn-proxy-cache';

// Clear the cache
await clearCache(cache);

// Warm the cache
await warmCache(cache, { force: false, verbose: true });

// List cached entries
await listCache(cache, { json: false, verbose: true });

// Show cache info
await showCacheInfo(cache); // Overall stats
await showCacheInfo(cache, 'https://cdn.jsdelivr.net/...'); // Specific entry
```

### Integrating with Commander.js

```typescript
import { program } from 'commander';
import { clearCache, warmCache, listCache, showCacheInfo } from 'cdn-proxy-cache';

program
  .command('cache:clear')
  .description('Clear the proxy cache')
  .action(() => clearCache(cache));

program
  .command('cache:warm')
  .description('Warm the proxy cache')
  .option('-f, --force', 'Re-fetch all resources')
  .option('-v, --verbose', 'Verbose output')
  .action((options) => warmCache(cache, options));

program
  .command('cache:ls')
  .description('List cached entries')
  .option('--json', 'Output as JSON')
  .option('-v, --verbose', 'Show detailed information')
  .action((options) => listCache(cache, options));

program
  .command('cache:info [url]')
  .description('Show cache information')
  .action((url) => showCacheInfo(cache, url));
```

## Development

This project uses [just](https://github.com/casey/just) as a command runner. Run `just` to see all available commands:

```bash
just                # List all commands
just install        # Install dependencies
just check          # Run all checks (format, lint, typecheck, test)
just build          # Build the project
just test           # Run tests
just test-watch     # Run tests in watch mode
just format         # Auto-format code
just lint           # Run linting
just typecheck      # Type check
just fix            # Fix formatting and linting issues
just clean          # Clean build artifacts
just prepublish     # Prepare for publishing
```

### Common Tasks

**Setup:**
```bash
bun install
# or
just install
```

**Run all checks:**
```bash
just check
# Runs: format, lint, typecheck, and test
```

**Build:**
```bash
just build
# Compiles TypeScript to the dist/ directory
```

**Test:**
```bash
just test           # Run once
just test-watch     # Watch mode
```

**Development workflow:**
```bash
# Make changes, then run:
just fix            # Auto-fix formatting and linting
just check          # Verify everything passes
```

### Direct npm/bun Commands

You can also use npm/bun scripts directly:

```bash
bun run check       # Run all checks
bun run build       # Build
bun test            # Test
bun run typecheck   # Type check
bun run lint        # Lint
bun run format      # Format
```

## How It Works

### Caching Strategy

1. **Request Interception**: The proxy intercepts requests to CDN URLs
2. **Cache Lookup**: Checks local cache using a composite key (URL + accept headers)
3. **Cache Hit**: Returns cached response with proper headers (`Age`, `Cache-Control`)
4. **Cache Miss**: Fetches from origin, stores in cache, and streams to client
5. **Expiration**: Uses `max-age`/`s-maxage` directives; serves stale content while revalidating

### URL Encoding

CDN URLs are transformed to proxy paths:

```
https://cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js
↓
/__proxy_cache/cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js
```

Query parameters are packaged into a single `?search=` parameter to avoid cache fragmentation.

### Content Rewriting

- **HTML**: Rewrites `<script src>` and `<link href>` attributes
- **CSS**: Parses and rewrites `url()` references using css-tree
- **Compression**: Transparently handles gzip/deflate encoding

### Stream Processing

The proxy uses stream pipelines to:
1. Pipe response to client
2. Write to cache simultaneously
3. Decompress and recompress transformed content as needed

CSS bodies are buffered before rewriting because css-tree parses a complete stylesheet into an AST. Other response bodies remain streaming.

## License

MIT © Oliver Steele

## Related Projects

- [p5-server](https://github.com/osteele/p5-server) - The original implementation that this library was extracted from

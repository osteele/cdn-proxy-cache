import path from 'node:path';
import nunjucks from 'nunjucks';
import type { ProxyCache } from './proxyCache';

function configureNunjucks() {
  nunjucks.configure(path.join(__dirname, 'templates'), { autoescape: false });
}

export async function clearCache(cache: ProxyCache): Promise<void> {
  let count = 0;
  await cache.ls().then((cacheData) => {
    count = Object.keys(cacheData).length;
  });
  await cache.clear();
  console.log(count ? `Cleared ${count} entries` : 'Cache cleared');
}

export async function warmCache(
  cache: ProxyCache,
  { force = false, verbose = false, reload = false }: { force?: boolean; verbose?: boolean; reload?: boolean } = {}
): Promise<void> {
  const stats = await cache.warm({ force, reload }, (message) => {
    switch (message.type) {
      case 'initial':
        if (!verbose) {
          process.stdout.write(`Warming cache from ${message.total} ${reload ? 'keys' : 'seeds'}...`);
        }
        break;
      case 'prefetch':
        if (verbose) {
          process.stdout.write(verbose ? `Prefetching ${message.url}...\n` : '.');
        }
        break;
      case 'progress':
        if (!verbose) {
          process.stdout.write('.');
        }
        break;
      case 'error':
        if (!verbose) process.stdout.write('\n');
        process.stderr.write(`Error: failed to fetch ${message.url}; error code: ${message.status}\n`);
        break;
    }
  });
  if (!verbose) {
    process.stdout.write('done\n');
  }
  const { total, failures, misses } = stats;
  if (failures > 0) {
    throw new Error(`Failed to fetch ${failures} of ${total} cache entries`);
  }
  console.log(
    misses > 0 ? `Added ${misses} entries, for a total of ${total}` : `All ${total} entries were already in the cache`
  );
}

export async function listCache(
  cache: ProxyCache,
  { json = false, verbose = false }: { json?: boolean; verbose?: boolean } = {}
): Promise<void> {
  configureNunjucks();
  const cacheData = await cache.ls();
  const entries = Object.entries(cacheData).map(entryToObject);
  // sort entries by origin url
  entries.sort((a, b) => a.originUrl.localeCompare(b.originUrl));
  if (json) {
    console.log(JSON.stringify(entries, null, 2));
  } else {
    const formatTime = (dt?: Date) => dt?.toLocaleString() ?? 'n/a';
    console.log(nunjucks.render('proxy-cache-entries.njk', { entries, formatTime, verbose }));
  }
}

export async function showCacheInfo(cache: ProxyCache, urlOrPath?: string): Promise<void> {
  configureNunjucks();
  const cacheData = await cache.ls();
  if (urlOrPath) {
    const proxyUrl = getProxyUrl(cache, urlOrPath);
    const originUrl = proxyUrl
      ? cache.decodeProxyPath(proxyUrl.pathname, Object.fromEntries(proxyUrl.searchParams))
      : urlOrPath;
    const entries = Object.entries(cacheData)
      .map(entryToObject)
      .filter((entry) => entry.originUrl === originUrl);
    for (const entry of entries) {
      console.log(JSON.stringify(entry, null, 2));
    }
    if (entries.length === 0) {
      console.log(`No entry found for ${urlOrPath}`);
    }
  } else {
    const entries = Object.values(cacheData);
    const totalSize = entries.reduce((acc, entry) => acc + entry.size, 0);
    const oldest = entries.reduce((acc, entry) => Math.min(acc, entry.time), Number.MAX_SAFE_INTEGER);
    const info = {
      entries,
      totalSize,
      proxyCachePath: cache.cachePath,
      oldest: oldest < Number.MAX_SAFE_INTEGER ? new Date(oldest) : null,
    };
    process.stdout.write(nunjucks.render('proxy-cache-info.njk', info));
  }
}

type CacheEntry = Awaited<ReturnType<ProxyCache['ls']>>[string];
type CacheMetadata = {
  headers: Record<string, string>;
  originUrl: string;
  status: number;
};

function entryToObject([key, value]: [string, CacheEntry]) {
  const metadata = value.metadata as CacheMetadata;
  const cacheControl = metadata.headers['cache-control'];
  const maxAge = (cacheControl?.match(/(?:^|\b)s-maxage=(\d+)/) || cacheControl?.match(/(?:^|\b)max-age=(\d+)/))?.[1];
  const expires = maxAge ? new Date(value.time + Number(maxAge) * 1000) : null;
  const requestHeaders = { ...JSON.parse(key), url: undefined };
  return {
    ...value,

    // inline metadata
    metadata: undefined,
    ...metadata,

    // replace time (number) by created (Date)
    time: undefined,
    created: new Date(value.time),

    // add properties
    expires,
    maxAge,
    requestHeaders,
  };
}

function getProxyUrl(cache: ProxyCache, url: string): URL | null {
  const parsedUrl = new URL(url, 'http://localhost');
  const isLocal = parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1';
  return /^https?:$/.test(parsedUrl.protocol) && isLocal && cache.isProxyPath(parsedUrl.pathname) ? parsedUrl : null;
}

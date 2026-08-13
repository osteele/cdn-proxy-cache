import { type CachePruneStats, createProxyCache, type ProxyCacheEntry, type ProxyCacheOptions } from 'cdn-proxy-cache';

const options: ProxyCacheOptions = {
  proxyPrefix: '/cache',
  cachePath: './cache',
  cacheSeeds: [],
  maxCacheSizeBytes: 10 * 1024 * 1024,
  shouldProxyPath: () => false,
};

const cache = createProxyCache(options);
const prefix: string = cache.proxyPrefix;
const entries: Promise<Record<string, ProxyCacheEntry>> = cache.ls();
const pruneStats: Promise<CachePruneStats> = cache.prune();
void prefix;
void entries;
void pruneStats;

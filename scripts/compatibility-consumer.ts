import { createProxyCache, type ProxyCacheEntry, type ProxyCacheOptions } from 'cdn-proxy-cache';

const options: ProxyCacheOptions = {
  proxyPrefix: '/cache',
  cachePath: './cache',
  cacheSeeds: [],
  shouldProxyPath: () => false,
};

const cache = createProxyCache(options);
const prefix: string = cache.proxyPrefix;
const entries: Promise<Record<string, ProxyCacheEntry>> = cache.ls();
void prefix;
void entries;

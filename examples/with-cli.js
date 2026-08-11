#!/usr/bin/env node

/**
 * Example showing how to integrate CLI commands with Commander.js
 *
 * This example demonstrates:
 * - Creating a CLI tool with cache management commands
 * - Using the embeddable command functions
 * - Integration with Commander.js
 */

const { program } = require('commander');
const { createProxyCache, clearCache, warmCache, listCache, showCacheInfo } = require('cdn-proxy-cache');
const path = require('path');
const os = require('os');
const cdnHosts = new Set(['cdn.jsdelivr.net', 'cdnjs.cloudflare.com']);

// Create proxy cache instance
const cache = createProxyCache({
  proxyPrefix: '/__proxy_cache',
  cachePath: path.join(os.homedir(), '.cache', 'cdn-proxy-cache-cli'),
  cacheSeeds: [
    'https://cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js',
    'https://cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js',
  ],
  shouldProxyPath: (url) => /^https?:/.test(url) && cdnHosts.has(new URL(url).hostname),
});

// Define CLI
program
  .name('cache-cli')
  .description('CDN Proxy Cache Management CLI')
  .version('1.0.0');

// Clear command
program
  .command('clear')
  .description('Clear all cached entries')
  .action(async () => {
    await clearCache(cache);
  });

// Warm command
program
  .command('warm')
  .description('Pre-fetch resources into the cache')
  .option('-f, --force', 'Re-fetch resources even if already cached')
  .option('-r, --reload', 'Re-fetch all currently cached items')
  .option('-v, --verbose', 'Show detailed progress')
  .action(async (options) => {
    await warmCache(cache, options);
  });

// List command
program
  .command('ls')
  .description('List cached entries')
  .option('--json', 'Output as JSON')
  .option('-v, --verbose', 'Show detailed information')
  .action(async (options) => {
    await listCache(cache, options);
  });

// Info command
program
  .command('info [url]')
  .description('Show cache information (overall stats or specific entry)')
  .action(async (url) => {
    await showCacheInfo(cache, url);
  });

// Example server command (integration with express)
program
  .command('serve')
  .description('Start example server with proxy cache')
  .option('-p, --port <port>', 'Port to listen on', '3000')
  .action(async (options) => {
    const express = require('express');
    const app = express();

    app.use(cache.proxyPrefix, cache.router);

    app.get('/', (req, res) => {
      res.send(cache.replaceUrlsInHtml(`
        <!DOCTYPE html>
        <html>
          <head>
            <script src="https://cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js"></script>
          </head>
          <body>
            <h1>CDN Proxy Cache Server</h1>
            <p>Resources loaded from cache: ${cache.cachePath}</p>
          </body>
        </html>
      `));
    });

    // Warm cache before starting server
    console.log('Warming cache...');
    await warmCache(cache, { force: false, verbose: false });

    app.listen(options.port, () => {
      console.log(`Server running at http://localhost:${options.port}`);
    });
  });

// Parse command line
program.parse();

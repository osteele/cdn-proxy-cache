#!/usr/bin/env node

/**
 * Basic Express server example using cdn-proxy-cache
 *
 * This example shows how to:
 * - Create a proxy cache instance
 * - Mount the proxy middleware
 * - Rewrite HTML content to use cached CDN resources
 * - Warm the cache at startup
 */

const express = require('express');
const { createProxyCache } = require('cdn-proxy-cache');
const path = require('path');
const os = require('os');

const app = express();
const port = process.env.PORT || 3000;

// Create proxy cache instance
const cache = createProxyCache({
  proxyPrefix: '/__proxy_cache',
  cachePath: path.join(os.homedir(), '.cache', 'cdn-proxy-cache-example'),
  cacheSeeds: [
    'https://cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js',
    'https://cdn.jsdelivr.net/npm/jquery@3.6/dist/jquery.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/bootstrap/5.3.0/css/bootstrap.min.css',
  ],
  shouldProxyPath: (url) => {
    // Proxy jsdelivr and cdnjs URLs
    return url.includes('cdn.jsdelivr.net') || url.includes('cdnjs.cloudflare.com');
  },
});

// Mount the proxy middleware
app.use(cache.proxyPrefix, cache.router);

// Serve a test page
app.get('/', (req, res) => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>CDN Proxy Cache Example</title>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/bootstrap/5.3.0/css/bootstrap.min.css">
        <script src="https://cdn.jsdelivr.net/npm/jquery@3.6/dist/jquery.min.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/p5@1.4/lib/p5.min.js"></script>
      </head>
      <body class="container mt-5">
        <h1>CDN Proxy Cache Example</h1>
        <p>This page loads resources from CDN through a local cache.</p>
        <ul>
          <li>Bootstrap CSS from cdnjs.cloudflare.com</li>
          <li>jQuery from cdn.jsdelivr.net</li>
          <li>p5.js from cdn.jsdelivr.net</li>
        </ul>
        <div class="alert alert-info">
          Open the browser's Network tab to see that resources are served from localhost.
        </div>
        <script>
          $(document).ready(() => {
            console.log('jQuery loaded:', typeof $ !== 'undefined');
            console.log('p5.js loaded:', typeof p5 !== 'undefined');
          });
        </script>
      </body>
    </html>
  `;

  // Rewrite CDN URLs to use the proxy
  res.send(cache.replaceUrlsInHtml(html));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', cache: cache.cachePath });
});

// Start server and warm cache
async function start() {
  console.log('Starting server...');

  // Warm the cache
  console.log('Warming cache...');
  const stats = await cache.warm({ force: false }, (message) => {
    if (message.type === 'prefetch') {
      process.stdout.write('.');
    } else if (message.type === 'error') {
      console.error(`\nError fetching ${message.url}: ${message.status}`);
    }
  });
  console.log(`\nCache ready: ${stats.total} resources (${stats.hits} hits, ${stats.misses} new)`);

  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log(`Cache location: ${cache.cachePath}`);
    console.log('\nTry going offline and refreshing the page!');
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

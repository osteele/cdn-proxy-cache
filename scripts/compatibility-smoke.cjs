'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { mkdtemp, rm } = require('node:fs/promises');

const requireFromConsumer = createRequire(path.resolve('package.json'));
const express = requireFromConsumer('express');
const packageJson = requireFromConsumer('cdn-proxy-cache/package.json');
const { createProxyCache, HTTP_RESPONSE_HEADER_CACHE_STATUS, listCache } =
  requireFromConsumer('cdn-proxy-cache');

async function main() {
  assertExpectedNodeVersion();
  const cachePath = await mkdtemp(path.join(os.tmpdir(), 'cdn-proxy-cache-compatibility-'));
  let originRequests = 0;
  let origin = '';
  const originServer = http.createServer((request, response) => {
    originRequests++;
    response.setHeader('cache-control', 'max-age=3600');
    response.setHeader('content-type', 'text/css; charset=utf-8');
    response.end(`body { background: url("${origin}/asset.png"); }`);
  });
  const proxyServer = http.createServer();

  try {
    origin = await listen(originServer);
    const cache = createProxyCache({
      proxyPrefix: '/cache',
      cachePath,
      cacheSeeds: [],
      shouldProxyPath: (url) => new URL(url).origin === origin,
    });
    const importedPackage = await import(pathToFileURL(requireFromConsumer.resolve('cdn-proxy-cache')).href);
    assert.equal(importedPackage.createProxyCache, createProxyCache);
    assert.equal(importedPackage.HTTP_RESPONSE_HEADER_CACHE_STATUS, HTTP_RESPONSE_HEADER_CACHE_STATUS);
    const app = express();
    app.use(cache.proxyPrefix, cache.router);
    proxyServer.on('request', app);
    const proxyOrigin = await listen(proxyServer);
    const proxyPath = cache.encodeProxyPath(`${origin}/style.css`);

    const miss = await fetch(`${proxyOrigin}${proxyPath}`);
    const missBody = await miss.text();
    assert.equal(miss.status, 200);
    assert.equal(miss.headers.get(HTTP_RESPONSE_HEADER_CACHE_STATUS), 'MISS');
    assert.equal(miss.headers.get('x-cdn-proxy-origin-url'), `${origin}/style.css`);
    assert.match(missBody, new RegExp(escapeRegExp(cache.encodeProxyPath(`${origin}/asset.png`))));

    const hit = await fetch(`${proxyOrigin}${proxyPath}`);
    assert.equal(hit.status, 200);
    assert.equal(hit.headers.get(HTTP_RESPONSE_HEADER_CACHE_STATUS), 'HIT');
    assert.equal(await hit.text(), missBody);
    assert.equal(originRequests, 1);

    const entries = await cache.ls();
    assert.equal(Object.keys(entries).length, 1);
    const logged = [];
    const originalLog = console.log;
    console.log = (value) => logged.push(String(value));
    try {
      await listCache(cache, { verbose: true });
    } finally {
      console.log = originalLog;
    }
    assert.match(logged.join('\n'), new RegExp(escapeRegExp(`${origin}/style.css`)));
    assert.match(logged.join('\n'), /Content-Type: text\/css/);

    console.log(
      JSON.stringify({
        node: process.version,
        express: requireFromConsumer('express/package.json').version,
        package: packageJson.version,
        originRequests,
      })
    );
  } finally {
    await Promise.allSettled([close(proxyServer), close(originServer)]);
    await rm(cachePath, { force: true, recursive: true });
  }
}

function assertExpectedNodeVersion() {
  const expected = process.env.COMPAT_EXPECTED_NODE;
  if (!expected) return;
  if (expected.endsWith('.x')) {
    assert.equal(process.versions.node.split('.')[0], expected.slice(0, -2));
  } else {
    assert.equal(process.versions.node, expected);
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

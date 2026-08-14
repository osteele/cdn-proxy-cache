# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-08-13

### Added

- Added cache pruning with typed reclamation statistics and an optional unique-body byte bound with oldest-body eviction.

### Changed

- Canonicalized `Accept` and `Accept-Encoding` cache-key values so equivalent requests share entries.
- Cached rewritten CSS and reused cached content by digest, avoiding repeated index lookups, CSS parsing, and recompression.
- Reworked cache warming to avoid retaining non-CSS bodies and to deduplicate its dynamic URL queue in constant time.

### Fixed

- Made clear and prune exclusive with active same-process cache operations, including filesystem aliases, removed cache-owned temporary artifacts during clear, and rejected unsafe cache paths.
- Removed a transitive `@types/cacache` requirement from the public declarations returned by `ProxyCache.ls()`.
- Coalesced simultaneous misses and stale refreshes for the same cache key.
- Revalidated cached responses with `ETag` and `Last-Modified` validators and reused cached bodies after `304 Not Modified` responses.
- Restored backpressure progress for background stale refreshes, which could previously stall until the origin timeout.
- Preserved percent-encoded origin query strings without double decoding.
- Resolved and followed relative redirect locations through the proxy.
- Reported body-stream and CSS transformation failures during cache warming.
- Partitioned shared entries by `Accept-Language`, rejected `Vary: *`, and stopped forwarding browser user agents.
- Invalidated transformed CSS when its proxy transformation configuration changes.
- Included the origin's `Age` value in freshness and revalidation decisions.
- Cached successful zero-length responses instead of repeatedly fetching them after `cacache` rejected an empty stream.
- Treated only complete proxy-prefix path segments as proxy paths and preserved matching text inside origin pathnames.
- Rejected malformed proxy targets before allowlist evaluation, network access, or diagnostic-header construction.
- Prevented origins and legacy cache entries from spoofing proxy diagnostics, setting cookies on the proxy origin, or replaying cached cookies.
- Removed fixed and `Connection`-nominated hop-by-hop fields plus origin-wide state headers from relayed and cached responses.
- Isolated coalesced waiter cancellation and client disconnects so they finish promptly without canceling another caller's origin transfer.
- Coalesced concurrent forced reloads after a successful shared transfer and retried them when the shared generation was canceled or failed.
- Preserved timeout and client-disconnect reasons in proxy diagnostics instead of replacing them with a generic fetch-abort error.

### Testing

- Added Allium contracts, generated codec/lifecycle contract tests, a cache reference model, adversarial trust-boundary tests, and bounded StrykerJS mutation slices that run through Bun.
- Added mixed-process tests for Bun-to-Node warm visibility, warm-to-serve reuse, overlapping cold writes, and recovery after a writer is terminated before commit.
- Replaced the import-only compatibility check with installed-tarball tests that exercise CommonJS and ES module imports, public declarations, packaged templates, and real cache misses and hits across supported Node.js and Express versions.
- Added shared-generation cancellation contracts, deterministic owner/follower schedules, and a focused mutation campaign for cleanup and retry behavior.

### Performance

- In a local loopback benchmark with Bun 1.3.14 on arm64 macOS and 512 KiB responses, 12 simultaneous cold requests dropped from 12 origin transfers (6 MiB) to one (512 KiB), a 91.7% body-bandwidth reduction. Two conditional accesses dropped from 1 MiB to 512 KiB, and two equivalent encoding variants dropped from 1 MiB to 512 KiB. Across those three scenarios, origin body transfer fell from 8 MiB to 1.5 MiB (81.25%).
- Five cached 512 KiB CSS responses fell from 101.4 ms to 3.6 ms in the same benchmark after caching the transformed representation, a 96.4% reduction. A 12-request stale-refresh burst completed in 29.4 ms instead of exceeding the benchmark's 10-second watchdog.
- Warming 20 concurrent 512 KiB non-CSS assets no longer retains up to 10 MiB of complete response bodies for dependency inspection; those bodies remain streaming.

## [0.2.0] - 2026-08-11

This is the first public release.

### Added

- Disk-backed CDN response caching with Express 4 and 5 middleware.
- HTML and CSS URL rewriting with gzip and deflate preservation.
- Cache warming from seed URLs and dependencies found in CSS.
- Configurable origin timeouts, cancellation, CSS transformation limits, and warming concurrency.
- Structured events for requests, cache activity, and failures.
- Programmatic helpers for clearing, warming, listing, and inspecting the cache.

### Changed

- Set the minimum supported Node.js version to 18.17.
- Made Express a peer dependency so applications control the installed Express major version.
- Upgraded the runtime dependencies, Biome, TypeScript, and type definitions.
- Documented the public API, cache policy, limits, events, and runtime requirements.

### Fixed

- Enforced `shouldProxyPath` after decoding proxy URLs to prevent allowlist bypasses.
- Honored `no-store`, `private`, `no-cache`, and `must-revalidate` response directives.
- Corrected gzip and deflate CSS rewriting and propagated stream failures.
- Prevented cache writes and client responses from competing for the same origin stream.
- Detected redirect cycles and bounded redirect chains during cache warming.
- Waited for the cache index commit before reporting a completed write.
- Returned cache-warming failures to callers instead of terminating the process.
- Included runtime templates in the published package.

[Unreleased]: https://github.com/osteele/cdn-proxy-cache/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/osteele/cdn-proxy-cache/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/osteele/cdn-proxy-cache/releases/tag/v0.2.0

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/osteele/cdn-proxy-cache/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/osteele/cdn-proxy-cache/releases/tag/v0.2.0

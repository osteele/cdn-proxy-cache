# Audit History

This file records shared coverage claims and remaining audit gaps. Keep detailed working matrices, hypotheses, and review-session data out of the repository.

## 2026-08-13 — `fbd70a2`

Scope: Cache representation handling, URL decoding, redirects, freshness, request variants, and warming behavior.

Evidence: Targeted regressions and loopback integration tests for concurrent misses, conditional revalidation, cache directives, representation selection, CSS storage, timeouts, cancellation, and events.

Resolved: Query double decoding, relative redirects, incomplete response handling, unsafe shared-cache variants, stale-refresh backpressure, CSS transformation invalidation, origin-age accounting, and several avoidable bandwidth and memory costs.

Remaining gaps: Stateful sequence coverage, stream-fault behavior, trust boundaries, installed-package compatibility, and resource bounds.

## 2026-08-13 — `f1fb7f1`

Scope: Explicit proxy-path and cache-lifecycle contracts plus stateful cache behavior.

Evidence: Allium codec and lifecycle specifications, generated contract tests, a deterministic reference-model suite, and a bounded mutation campaign.

Resolved: Empty-response storage and proxy-prefix boundary handling; the audit gained repeatable contract and sequence oracles instead of relying only on examples.

Remaining gaps: Stream and runtime divergence, adversarial trust-boundary cases, more concurrent cancellation transitions, installed-package compatibility, and resource bounds.

## 2026-08-13 — `4e3c0ca`

Scope: Stream multiplexing, compression and transformation faults, client disconnects, cache-write failures, and Bun/Node runtime parity.

Evidence: Fault-injected stream tests, opaque-encoding miss/hit tests, Node CommonJS loading, package dry runs, and a bounded stream mutation campaign.

Resolved: Truncated-body commits, stalled or incomplete stream teardown, retained listeners, cache-writer error propagation, and Bun substitution of its fetch implementation for the required package behavior.

Remaining gaps: Longer concurrent fault stress, per-client cancellation during shared work, trust boundaries, installed-package compatibility, and resource exhaustion.

## 2026-08-13 — `88a56c5`

Scope: URL and redirect validation, allowlist enforcement, response-header trust, and legacy cache metadata.

Evidence: Adversarial router and document inputs, redirect transitions, fixed and connection-nominated header tests, legacy-entry regressions, and a bounded security mutation campaign.

Resolved: Malformed and credential-bearing targets reaching policy or network work, redirect allowlist bypasses, diagnostic-header spoofing, cookie replay, unsafe hop-by-hop fields, and reuse of unsanitized legacy entries.

Remaining gaps: Installed-package compatibility, cache-path ownership and symlink assumptions, input and cache-growth limits, and deeper cancellation races.

## 2026-08-13 — installed-package compatibility

Scope: The packed CommonJS artifact under the minimum and current Node.js runtimes with both supported Express major versions.

Evidence: External-consumer installation, strict declaration compilation, CommonJS and ES module loading, packaged-template rendering, and real Express cache-miss and cache-hit requests across Node.js 18.17/24 and Express 4/5. CI is configured to cover the additional supported Node.js lines.

Resolved: The previous import-only check could run through Bun instead of the selected Node.js matrix runtime and did not exercise requests. The external declaration check also exposed and removed an undeclared `@types/cacache` requirement from `ProxyCache.ls()`.

Remaining gaps: Observe the Node.js 20/22/26 cells in CI; audit shared-work cancellation races; audit cache-path and symlink assumptions; and define bounded input, disk-growth, and cleanup behavior.

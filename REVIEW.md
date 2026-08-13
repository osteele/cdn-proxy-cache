# Review Ledger

## Protocol

- Extend this ledger instead of starting another open-ended review.
- Record inspected surfaces even when they produce no finding.
- Link findings to an invariant and audit-matrix cell where possible.
- Preserve rejected hypotheses and residual uncertainty.
- A defect discovery does not end an audit slice. Continue until the slice's evidence and stop conditions are satisfied.
- `evidenced` means the declared cell has evidence; it does not mean the implementation is defect-free.

Status values: `pending`, `in-progress`, `evidenced`, `deferred`, `blocked`, `not-applicable`.

## Audit metadata

| Field | Value |
| --- | --- |
| Scope | Entire `cdn-proxy-cache` package |
| Baseline | Commit `fbd70a2e` plus the current contract/model-suite working copy |
| Started | 2026-08-13 |
| Last updated | 2026-08-13 |
| Size | Small: 1,409 source lines, one package, one primary stateful component |
| Current automated evidence | 48 tests, 3,489 assertions, `just check`, `just build`, and a 121-mutant bounded StrykerJS baseline |

This repository is small enough for a bounded whole-project audit. Its HTTP semantics, persistent cache, streams, and concurrency still merit separate focused passes.

## Area inventory

| ID | Area | Risk | Status | Evidence | Remaining work |
| --- | --- | --- | --- | --- | --- |
| AREA-001 | Public API and documented contracts | High | in-progress | README API examples; Allium codec/lifecycle contracts; propagated contract tests; type checking; integration tests | Translate remaining README guarantees into the contract inventory; check command-helper output contracts |
| AREA-002 | URL encoding, decoding, rewriting, and redirects | High | in-progress | 1,512-case URL grammar, prefix-boundary/pathname regressions, percent-encoding regression, HTML rewrite test, CSS discovery, redirect-cycle and relative-redirect tests | Malformed proxy paths; protocol-relative and disallowed redirect targets; broader HTML attribute syntax |
| AREA-003 | HTTP cache policy and freshness | High | in-progress | Fresh/stale/no-cache/no-store/private/must-revalidate/`Vary: *`/`Age` tests; reference model | `Date` and corrected-age calculations; directives listed as unsupported; 304 policy changes; request directives; absent freshness metadata |
| AREA-004 | Representation selection and cache keys | High | in-progress | `Accept`, `Accept-Encoding`, and `Accept-Language` canonicalization/partition tests | Formal `Accept` ordering semantics; unsupported `Vary` fields; wildcard/identity encoding edge cases; header grammar fuzzing |
| AREA-005 | Stored representations and migration | High | in-progress | CSS transformation fingerprint regression; digest reads; empty-body regression | Legacy metadata matrix; corrupt/missing content; configuration changes captured by closures; schema/version migration policy |
| AREA-006 | Streams, compression, and transformation | High | in-progress | Plain/gzip/deflate CSS; corrupt compression; size limit; error propagation; non-CSS streaming; zero-length body | Cache-writer failure injection; client disconnect during each phase; truncated origin bodies; unknown/stacked encodings; backpressure and listener cleanup |
| AREA-007 | Concurrency, coalescing, cancellation, and cleanup | High | in-progress | Concurrent cold misses; stale bursts; warming concurrency; timeout and abort tests; modeled bursts | Revalidation bursts; per-client cancellation during shared work; cache clear during requests; event ordering; race/fault stress campaign |
| AREA-008 | Cache warming and dependency discovery | Medium | in-progress | CSS dependency discovery, queue deduplication, redirects/cycles, failures, cancellation | CSS import variants; query/fragment deduplication; redirect status matrix; dependency failure aggregation; reload/force combinations |
| AREA-009 | Security and trust boundaries | High | in-progress | Decoded-origin allowlist enforcement; refused URL test | Proxy-prefix boundary semantics; malformed paths; redirect allowlist transitions; header injection; cache-path assumptions; denial-of-service bounds |
| AREA-010 | Commands, diagnostics, and observability | Medium | in-progress | Command failure behavior; cache-info relative path; lifecycle event test | All event branches/order; output snapshots; empty cache; corrupt/legacy metadata; diagnostic-header collision behavior |
| AREA-011 | Packaging and runtime compatibility | Medium | in-progress | CI matrix declares Node 18–26 and Express 4–5; package build passes | Run packed-consumer matrix or a representative local package smoke test; verify npm contents and CommonJS loading after current changes |
| AREA-012 | Documentation consistency | Medium | in-progress | README and cache-policy documentation reconciled in `fbd70a2e` | Turn remaining feature/limitation statements into contract rows; compare examples and templates to runtime behavior |
| AREA-013 | Performance and resource bounds | Medium | pending | Performance notes and bounded warming test | Reproducible benchmark harness; memory limits; backpressure evidence; cache growth and cleanup behavior |
| AREA-014 | Mutation testing | High | in-progress | StrykerJS 9.6.1 command runner with Bun: 121 mutants, 108 killed, 13 classified survivors, 89.26% raw score | Expand from cache policy/codec into stream and queue slices after their contract/fault oracles are ready |
| AREA-015 | Independent structured review passes | High | pending | One general review and one model-suite implementation pass | Run two non-overlapping passes after the matrix is populated; require no new medium-or-higher findings |

## Invariants and contracts

| ID | Invariant or contract | Source | Status | Evidence | Remaining uncertainty |
| --- | --- | --- | --- | --- | --- |
| INV-001 | Proxy-path encoding and decoding preserve every supported origin URL exactly | README cache management | evidenced | Allium contract plus 1,512 canonical generated cases across direct and routed request channels | Exact-prefix and non-prefixed decode inputs are outside the declared codec domain; broader malformed inputs remain a security-review concern |
| INV-002 | Every fetched origin URL, including redirect and CSS dependency transitions, satisfies `shouldProxyPath` | README `shouldProxyPath` contract | in-progress | Rejected direct URL, relative redirect, and CSS discovery tests | Cross-origin/disallowed redirects and malformed `Location` remain pending |
| INV-003 | Requests documented as equivalent share a cache entry; distinct representation selectors do not | README request flow | in-progress | Encoding canonicalization and language partition tests; model key checks | `Accept` grammar and additional `Vary` values remain pending |
| INV-004 | A cache hit is observationally equivalent to the successful miss that populated it, except documented diagnostics and freshness headers | README request flow | in-progress | Reference model compares body, status, cache status, entry count, and origin count | Full response-header equivalence and redirect responses remain pending |
| INV-005 | Failed, canceled, private, non-storable, or incomplete responses do not leave reusable partial entries | README policy/limits | in-progress | `no-store`, private, `Vary: *`, oversized CSS, timeout, abort, and stream failure tests | Cache-writer faults, truncated bodies, and client disconnects remain pending |
| INV-006 | Freshness and revalidation follow the documented cache policy | README router contract | in-progress | Fresh, stale, ETag/304, `no-cache`, `must-revalidate`, and origin `Age` tests/model | Corrected age using `Date`, 304 policy updates, and unsupported directives remain pending |
| INV-007 | Concurrent cold or stale requests do not multiply origin transfers beyond the documented coalescing semantics | README features | in-progress | Eight-request cold and stale bursts plus modeled transitions | Revalidation bursts, cancellation, and failure of the shared request remain pending |
| INV-008 | Cached transformed CSS is reused only under a compatible transformation configuration | README request flow | evidenced | Fingerprint regression across proxy-prefix changes | Closed-over callback changes require the documented `cssTransformVersion` discipline |
| INV-009 | Cache warming terminates, respects its concurrency bound, follows supported dependencies, and reports every failed resource | README warming contract | in-progress | Discovery, bounds, redirect cycle, timeout, abort, and transformation failure tests | Force/reload matrix and mixed dependency failures remain pending |
| INV-010 | Successful zero-length responses can be cached and subsequently served as hits | General cache equivalence | evidenced | Explicit and generated model traces for HTTP 204 | Other zero-length statuses and redirects remain pending |
| INV-011 | Structured events accurately describe request, hit/miss/write/skip, and failure lifecycle transitions | README lifecycle events | in-progress | One lifecycle sequence and selected error/skip tests | Full event-order matrix and callback failures remain pending |
| INV-012 | Numeric limits reject non-positive or non-integral values before work begins | README option contract | evidenced | Propagated boundary matrix for three constructor options and per-call warming concurrency | None within the documented numeric options |

## Candidate Allium specifications

| ID | Specification boundary | Why it fits | Status |
| --- | --- | --- | --- |
| SPEC-001 | Proxy-path codec and URL-rewrite decisions | Pure input/output relations, round trips, and allowlist decisions | authored and propagated in `specs/proxy-path-codec.allium`; CLI unavailable, so obligations were checked manually against Allium v3 and mapped to `tests/proxyCache.contract.test.ts` |
| SPEC-002 | Proxy-cache lifecycle | Stateful sequences over absent/fresh/stale/revalidating/non-storable entries map directly to the reference model | authored and propagated in `specs/proxy-cache-lifecycle.allium`; mapped to the contract and reference-model suites; CLI unavailable |
| SPEC-003 | Cache-warming queue | Queue/deduplication/redirect/failure transitions are stateful, but concurrency bounds and stream faults may need external tests | pending |

Distill current behavior only after labeling intentional semantics versus accidental implementation details. Use an elicited intended-behavior spec for HTTP policy where documentation or standards are authoritative. Generated tests should complement, not replace, fuzzing and fault injection.

## Audit matrix

| ID | Operation | Input/state | Configuration | Outcome/failure | Execution | Status | Evidence or pending work |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CELL-001 | URL codec | HTTP/HTTPS, query, fragment, percent escapes | Prefix | Round trip | Sequential | evidenced | 1,512 generated canonical cases across three prefixes and direct/routed channels; adversarial prefix-boundary regressions |
| CELL-002 | Router | Absent/fresh/stale entry | Normal cacheable 200 | Miss/hit/background refresh | Sequential | evidenced | Integration tests and reference model |
| CELL-003 | Router | Cached entry | ETag plus unchanged/changed origin | 304 reuse/200 replace | Sequential | evidenced | Revalidation integration/model tests |
| CELL-004 | Router | Any entry state | `no-store`, private, `Vary: *` | Serve without storing | Sequential | evidenced | Integration/model tests |
| CELL-005 | Router | Empty representation | Cacheable 204 | Miss then hit | Sequential | evidenced | Model suite; lazy empty writer |
| CELL-006 | Router | 404/500 | Cacheable-looking headers | Error response without storage | Sequential | evidenced | Model suite |
| CELL-007 | Router | Same URL with header variants | Language/encoding variants | Share or partition correctly | Sequential | in-progress | Language and encoding tests; `Accept` pending |
| CELL-008 | Router | Cold/stale same key | Cacheable origin | Coalesced result | Concurrent | evidenced | Eight-request bursts/model |
| CELL-009 | Router | Revalidating same key | ETag/no-cache | Coalescing/revalidation burst | Concurrent | pending | Define expected semantics, then test |
| CELL-010 | Router | Body mid-stream | Timeout, truncation, client/cache failure | No partial entry; cleanup | Sequential/concurrent | in-progress | Timeout and CSS failure exist; full fault matrix pending |
| CELL-011 | CSS pipeline | Plain/gzip/deflate | Within/over limit | Rewrite or fail | Streaming | in-progress | Existing tests; unknown/stacked encodings pending |
| CELL-012 | Redirect | Relative/absolute/cyclic | Allowed/disallowed target | Rewrite/follow/refuse | Sequential/warming | in-progress | Relative and cycle tests; full status/allowlist matrix pending |
| CELL-013 | Warm queue | Seeds/dependencies/duplicates | Force/reload/concurrency/signal | Stats and termination | Concurrent | in-progress | Core tests exist; option matrix pending |
| CELL-014 | Persistent cache | Current/legacy/corrupt metadata | Changed transform configuration | Reuse/invalidate/recover | Across instances | in-progress | Transform fingerprint test; legacy/corruption pending |
| CELL-015 | Commands | Empty/populated/corrupt cache | JSON/verbose/path forms | Stable output/errors | Sequential | pending | Two narrow tests only |
| CELL-016 | Package | Built tarball | Supported Node/Express versions | Install and load | Runtime matrix | pending | CI configuration exists; current artifact not exercised here |

## Verification campaigns

| ID | Mechanism | Scope | Budget/threshold | Result | Evidence |
| --- | --- | --- | --- | --- | --- |
| CAMP-001 | Contract tests | Current documented cache guarantees | Every README guarantee mapped or flagged ambiguous | in-progress | `specs/*.allium`; `tests/proxyCache.contract.test.ts`; `tests/proxyCache.test.ts` |
| CAMP-002 | Model/property sequences | Cache lifecycle, policies, variants, mutation, clear, reload | Explicit trace plus 10 deterministic seeds × 30 operations | passing | `tests/proxyCache.model.test.ts` |
| CAMP-003 | URL property matrix | Supported canonical origin URL grammar | Schemes × authorities × paths × searches × fragments × prefixes; bounded deterministic runtime | passing | 1,512 cases and 3,024 channel comparisons in `tests/proxyCache.contract.test.ts` |
| CAMP-004 | Stream fault injection | Origin/decompressor/transformer/client/cache writer | One injected failure at each boundary | pending | Partial examples only |
| CAMP-005 | Mutation testing | Cache policy and URL codec baseline | Baseline high threshold 80%; every survivor classified | passing for selected slice | StrykerJS 9.6.1, Node 24.19.0, Bun 1.3.14; 121 total, 108 killed, 13 survived, 0 timeout/no-coverage/error; 89.26% raw score; `.cache/mutation-report.json` |
| CAMP-006 | Independent structured passes | HTTP semantics; streams/concurrency/security | Two passes with no new medium-or-higher findings | pending | None |

## Findings

| ID | Severity | Status | Invariant/cell | Summary | Evidence | Resolution |
| --- | --- | --- | --- | --- | --- | --- |
| FIND-001 | High | resolved | INV-001/CELL-001 | Origin query strings were decoded twice | Percent-encoded round-trip reproduction | Commit `fbd70a2e` |
| FIND-002 | High | resolved | INV-002/CELL-012 | Relative redirects were not resolved through the proxy or followed during warming | Relative `Location` integration test | Commit `fbd70a2e` |
| FIND-003 | High | resolved | INV-005/CELL-010 | Body-stream failures appeared as successful warming | Oversized CSS warming regression | Commit `fbd70a2e` |
| FIND-004 | Medium | resolved | INV-003/CELL-004 | Cache keys omitted language variants and stored `Vary: *` | Language and wildcard tests | Commit `fbd70a2e` |
| FIND-005 | Medium | resolved | INV-008/CELL-014 | Transformed CSS was reused under incompatible configuration | Cross-instance prefix regression | Commit `fbd70a2e` |
| FIND-006 | Medium | resolved | INV-006/CELL-003 | Freshness ignored the origin `Age` | `Age: 60` revalidation regression | Commit `fbd70a2e` |
| FIND-007 | Low | resolved | AREA-012 | Cache-policy documentation contradicted behavior | Documentation comparison | Commit `fbd70a2e` |
| FIND-008 | Medium | fixed-uncommitted | INV-010/CELL-005 | `cacache.put.stream` rejects empty input, so successful 204 responses were never cached | Reference model failed on explicit and generated 204 transitions | Lazy cache writer in current working copy |
| FIND-009 | Medium | fixed-uncommitted | INV-001/CELL-001 | Prefix lookalikes such as `/__proxy_cache-other` were classified as proxy paths | Propagated prefix-boundary contract and CSS-warming integration test | Segment-aware `isProxyPath` in current working copy |
| FIND-010 | Medium | fixed-uncommitted | INV-001/CELL-001 | Decoding removed the configured proxy-prefix text when it occurred inside the origin pathname | Generated pathname grammar and CSS-warming regression | Anchored prefix removal in current working copy |

No confirmed findings are currently open. Pending areas have not yet received enough evidence to make that a closure claim.

## Rejected hypotheses

| ID | Hypothesis | Evidence checked | Conclusion |
| --- | --- | --- | --- |
| HYP-001 | Only empty redirect bodies fail to create cache entries | Direct `cacache.put.stream` experiment and model 204 transition | Rejected: the streaming API rejects any empty input with `ENODATA`; fixed generically |
| HYP-002 | Equivalent gzip/deflate orderings require separate entries | Canonicalization integration and model traces | Rejected for the supported grammar: both spellings share one entry |

## Mutation survivor classification

The raw mutation score is retained. Classification does not rewrite it into an adjusted score.

| Class | Count | Mutations | Rationale |
| --- | --- | --- | --- |
| Equivalent in declared domain | 4 | Cache-control empty fallback, empty directive name, boolean sentinel, and redundant runtime type guard | The parser exposes only recognized directive keys and its internal map values are constrained to `string \| true`; these changes cannot affect the returned policy |
| Equivalent in declared domain | 6 | Two scheme-replacement anchors, leading-slash anchor, and three `>= 0` to `> 0` index changes | Earlier guards and canonical proxy-path structure make the altered positions unreachable for supported inputs |
| Outside codec contract | 3 | Two exact-prefix decoding mutations and one non-prefixed decoding mutation | `decodeProxyPath` accepts a path produced by `encodeProxyPath`; a bare prefix and arbitrary non-prefixed strings encode no origin URL. Revisit during the malformed-path security pass |

## Pending work ordered by risk and information gain

| Priority | Area/cell | Why next | Recommended action |
| --- | --- | --- | --- |
| 1 | AREA-006/CELL-010 | Stream failures can corrupt responses or persistent state | Add injectable origin, transformer, client-writer, and cache-writer failures, then mutate the covered stream slice |
| 2 | AREA-009 | Trust-boundary defects can bypass the proxy's main safety property | Audit malformed paths, remaining prefix boundaries, redirects, and header injection |
| 3 | AREA-011 | Published compatibility is broader than local evidence | Pack and smoke-test representative Node/Express consumer combinations |

## Stop conditions

- [ ] Every selected matrix cell has test or inspection evidence.
- [ ] Every documented contract in scope has a test or an ambiguity finding.
- [ ] Supported input/token types and option states in scope are exercised.
- [x] The bounded URL and operation-sequence property campaigns produce no unaddressed failures.
- [x] The selected mutation baseline exceeds 80%, and every survivor is classified.
- [ ] Two independent focused passes find no new medium-or-higher issues.
- [ ] Every fix receives targeted adversarial review.
- [x] Remaining uncertainty and deferred areas are explicit.

The audit is not closed.

## Audit log

| Date | Reviewer | Slice | Result | Next step |
| --- | --- | --- | --- | --- |
| 2026-08-13 | Codex | General implementation and latest performance-change review | Seven findings recorded | Fix findings and add regressions |
| 2026-08-13 | Codex | Finding remediation | `fbd70a2e`; 39 tests passing | Replace example accumulation with a reference model |
| 2026-08-13 | Codex | Cache lifecycle model | Added explicit trace, 10 seeded traces, and coalescing bursts; found FIND-008 | Formalize contracts, then run mutation baseline |
| 2026-08-13 | Codex | Allium codec/lifecycle contracts and bounded mutation baseline | Added two specs, propagated contract/property tests, fixed FIND-009/FIND-010, and classified all 13 survivors at 89.26% raw score | Stream fault injection and its mutation slice |

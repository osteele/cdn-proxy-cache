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
| Baseline | Commits through the security trust-boundary slice |
| Started | 2026-08-13 |
| Last updated | 2026-08-13 |
| Size | Small: 1,409 source lines, one package, one primary stateful component |
| Current automated evidence | 71 tests, 3,724 assertions, `just check`, `just build`, Node CommonJS smoke test, npm pack inspection, and three bounded StrykerJS slices |

This repository is small enough for a bounded whole-project audit. Its HTTP semantics, persistent cache, streams, and concurrency still merit separate focused passes.

Development uses Bun 1.3.14 for package management, scripts, and tests. npm remains the publication format and registry; the built CommonJS library must remain compatible with the Node extension host used by the VS Code consumer. Bun and Node must execute the same network implementation rather than relying on Bun's bare-import substitution for `node-fetch`.

## Area inventory

| ID | Area | Risk | Status | Evidence | Remaining work |
| --- | --- | --- | --- | --- | --- |
| AREA-001 | Public API and documented contracts | High | in-progress | README API examples; Allium codec/lifecycle contracts; propagated contract tests; type checking; integration tests | Translate remaining README guarantees into the contract inventory; check command-helper output contracts |
| AREA-002 | URL encoding, decoding, rewriting, and redirects | High | in-progress | 1,512-case URL grammar, prefix-boundary/pathname regressions, malformed-target matrix, HTML/CSS opaque-input tests, CSS discovery, and allowed/disallowed/protocol-relative/malformed redirect tests | Broader HTML attribute syntax and redirect status matrix |
| AREA-003 | HTTP cache policy and freshness | High | in-progress | Fresh/stale/no-cache/no-store/private/must-revalidate/`Vary: *`/`Age` tests; reference model | `Date` and corrected-age calculations; directives listed as unsupported; 304 policy changes; request directives; absent freshness metadata |
| AREA-004 | Representation selection and cache keys | High | in-progress | `Accept`, `Accept-Encoding`, and `Accept-Language` canonicalization/partition tests | Formal `Accept` ordering semantics; unsupported `Vary` fields; wildcard/identity encoding edge cases; header grammar fuzzing |
| AREA-005 | Stored representations and migration | High | in-progress | CSS transformation fingerprint regression; digest reads; empty-body regression | Legacy metadata matrix; corrupt/missing content; configuration changes captured by closures; schema/version migration policy |
| AREA-006 | Streams, compression, and transformation | High | evidenced | Plain/gzip/x-gzip/deflate CSS; opaque Brotli/stacked encodings; corrupt/truncated input; cache-writer and client faults; backpressure, finalization, and listener cleanup; 100% bounded mutation score | Broader client-disconnect timing and prolonged randomized fault stress belong to AREA-007 |
| AREA-007 | Concurrency, coalescing, cancellation, and cleanup | High | in-progress | Concurrent cold misses; stale bursts; warming concurrency; timeout and abort tests; modeled bursts | Revalidation bursts; per-client cancellation during shared work; cache clear during requests; event ordering; race/fault stress campaign |
| AREA-008 | Cache warming and dependency discovery | Medium | in-progress | CSS dependency discovery, queue deduplication, redirects/cycles, failures, cancellation | CSS import variants; query/fragment deduplication; redirect status matrix; dependency failure aggregation; reload/force combinations |
| AREA-009 | Security and trust boundaries | High | in-progress | Canonical credential-free target validation; all C0 controls plus DEL; allowlist-safe redirects; malformed document URLs; fixed/dynamic hop-by-hop and origin-state filtering; cookie isolation; legacy-entry invalidation; 95.89% bounded mutation score | Cache-path ownership/symlink assumptions and denial-of-service/resource-exhaustion bounds |
| AREA-010 | Commands, diagnostics, and observability | Medium | in-progress | Command failure behavior; cache-info relative path; lifecycle event test; diagnostic-header ownership on misses, hits, and legacy entries | All event branches/order; output snapshots; empty cache; broader corrupt metadata behavior |
| AREA-011 | Packaging and runtime compatibility | Medium | in-progress | Bun is declared as the development package manager; build passes; built CommonJS loads under Node; npm dry-run tarball contains the expected 20 files | Run installed-tarball smoke tests across representative supported Node/Express combinations |
| AREA-012 | Documentation consistency | Medium | in-progress | README and cache-policy documentation reconciled in `fbd70a2e` | Turn remaining feature/limitation statements into contract rows; compare examples and templates to runtime behavior |
| AREA-013 | Performance and resource bounds | Medium | pending | Performance notes and bounded warming test | Reproducible benchmark harness; memory limits; backpressure evidence; cache growth and cleanup behavior |
| AREA-014 | Mutation testing | High | in-progress | Policy/codec baseline: 121 mutants at 89.26%; stream slice: 49 mutants at 100%; security slice: 146 mutants at 95.89%; every survivor classified | Add a queue/concurrency slice after its state/fault oracle is ready |
| AREA-015 | Independent structured review passes | High | pending | One general review and one model-suite implementation pass | Run two non-overlapping passes after the matrix is populated; require no new medium-or-higher findings |

## Invariants and contracts

| ID | Invariant or contract | Source | Status | Evidence | Remaining uncertainty |
| --- | --- | --- | --- | --- | --- |
| INV-001 | Proxy-path encoding and decoding preserve every supported origin URL exactly | README cache management | evidenced | Allium contract plus 1,512 canonical generated cases across direct and routed request channels | Decoder behavior outside encoded HTTP(S) inputs is constrained at the router boundary rather than added to the codec contract |
| INV-002 | Every fetched origin URL, including redirect and CSS dependency transitions, satisfies `shouldProxyPath` | README `shouldProxyPath` contract | evidenced | Rejected direct URL; relative, cross-origin, protocol-relative, disallowed, malformed, and cyclic redirects; CSS discovery | The allowlist's policy quality remains the embedding application's responsibility |
| INV-003 | Requests documented as equivalent share a cache entry; distinct representation selectors do not | README request flow | in-progress | Encoding canonicalization and language partition tests; model key checks | `Accept` grammar and additional `Vary` values remain pending |
| INV-004 | A cache hit is observationally equivalent to the successful miss that populated it, except documented diagnostics and freshness headers | README request flow | in-progress | Reference model compares body, status, cache status, entry count, and origin count | Full response-header equivalence and redirect responses remain pending |
| INV-005 | Failed, canceled, private, non-storable, or incomplete responses do not leave reusable partial entries | README policy/limits | evidenced | `no-store`, private, `Vary: *`, oversized CSS, timeout, abort, decompressor/source/cache-writer failures, truncation, and client disconnect tests | Prolonged concurrent fault stress remains under AREA-007 |
| INV-006 | Freshness and revalidation follow the documented cache policy | README router contract | in-progress | Fresh, stale, ETag/304, `no-cache`, `must-revalidate`, and origin `Age` tests/model | Corrected age using `Date`, 304 policy updates, and unsupported directives remain pending |
| INV-007 | Concurrent cold or stale requests do not multiply origin transfers beyond the documented coalescing semantics | README features | in-progress | Eight-request cold and stale bursts plus modeled transitions | Revalidation bursts, cancellation, and failure of the shared request remain pending |
| INV-008 | Cached transformed CSS is reused only under a compatible transformation configuration | README request flow | evidenced | Fingerprint regression across proxy-prefix changes | Closed-over callback changes require the documented `cssTransformVersion` discipline |
| INV-009 | Cache warming terminates, respects its concurrency bound, follows supported dependencies, and reports every failed resource | README warming contract | in-progress | Discovery, bounds, redirect cycle, timeout, abort, and transformation failure tests | Force/reload matrix and mixed dependency failures remain pending |
| INV-010 | Successful zero-length responses can be cached and subsequently served as hits | General cache equivalence | evidenced | Explicit and generated model traces for HTTP 204 | Other zero-length statuses and redirects remain pending |
| INV-011 | Structured events accurately describe request, hit/miss/write/skip, and failure lifecycle transitions | README lifecycle events | in-progress | One lifecycle sequence and selected error/skip tests | Full event-order matrix and callback failures remain pending |
| INV-012 | Numeric limits reject non-positive or non-integral values before work begins | README option contract | evidenced | Propagated boundary matrix for three constructor options and per-call warming concurrency | None within the documented numeric options |
| INV-013 | Only canonical credential-free HTTP(S) URLs reach `shouldProxyPath`; malformed router targets fail before policy, network, or response-header work, while malformed document URLs remain opaque | README allowlist contract | evidenced | 40 malformed router cases, malformed HTML/CSS cases, well-formed refusal control, and mutation testing | URL resource-exhaustion bounds remain under AREA-013 |
| INV-014 | Origin and stored response metadata cannot replace proxy-owned diagnostics, set or replay cookies on the proxy origin, or relay fixed/dynamic hop-by-hop and origin-specific state | README router contract | evidenced | Miss/hit integration tests across 22 fixed and dynamic fields plus multi-value origin cookies, ordinary end-to-end controls, consistent `Origin-Server`, and forced refetch of pre-sanitization entries | General corrupt metadata recovery remains CELL-014 |

## Candidate Allium specifications

| ID | Specification boundary | Why it fits | Status |
| --- | --- | --- | --- |
| SPEC-001 | Proxy-path codec and URL-rewrite decisions | Pure input/output relations, round trips, and allowlist decisions | authored and propagated; Allium CLI 3.5.3 `check`, `analyse`, `plan`, and `model` are clean; three generated signature obligations map to `tests/proxyCache.contract.test.ts` |
| SPEC-002 | Proxy-cache lifecycle | Stateful sequences over absent/fresh/stale/revalidating/non-storable entries map directly to the reference model | authored and propagated; CLI parse/plan/model succeed and analysis finds no conflicts, but `check` reports 12 modeling diagnostics: two warnings and ten informational items for an unbound external entity, unused fields/entity, and externally sourced triggers |
| SPEC-003 | Cache-warming queue | Queue/deduplication/redirect/failure transitions are stateful, but concurrency bounds and stream faults may need external tests | pending |
| SPEC-004 | Security target and response-header boundaries | The selected behavior is stateless validation/filtering plus real HTTP integration; direct falsifiable invariants, adversarial matrices, and mutation testing provide a clearer oracle than an Allium state model | not applicable for this slice |

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
| CELL-010 | Router | Body mid-stream | Timeout, truncation, client/cache failure | No partial entry; cleanup | Sequential/concurrent | evidenced | Faults at origin, decompressor, transformer limit, client, and cache writer; incomplete entries rejected and origins torn down |
| CELL-011 | CSS pipeline | Plain/gzip/x-gzip/deflate/opaque | Within/over limit | Rewrite, pass through, or fail | Streaming | evidenced | Content-type parameters, corrupt/source errors, size bound, Brotli and stacked opaque encodings; mutation slice at 100% |
| CELL-012 | Redirect | Relative/absolute/cyclic | Allowed/disallowed target | Rewrite/follow/refuse | Sequential/warming | in-progress | Relative and cycle tests; full status/allowlist matrix pending |
| CELL-013 | Warm queue | Seeds/dependencies/duplicates | Force/reload/concurrency/signal | Stats and termination | Concurrent | in-progress | Core tests exist; option matrix pending |
| CELL-014 | Persistent cache | Current/legacy/corrupt metadata | Changed transform configuration | Reuse/invalidate/recover | Across instances | in-progress | Transform fingerprint test; legacy/corruption pending |
| CELL-015 | Commands | Empty/populated/corrupt cache | JSON/verbose/path forms | Stable output/errors | Sequential | pending | Two narrow tests only |
| CELL-016 | Package | Built tarball | Supported Node/Express versions | Install and load | Runtime matrix | in-progress | Current CommonJS artifact loads and its codec runs under Node; npm dry-run tarball inspected; installed multi-version matrix pending |
| CELL-017 | Router trust boundary | Empty, malformed, control-bearing, credential-bearing, valid disallowed | Credential-free HTTP(S) canonicalization and allowlist | 400 before policy/network or 403 after policy | Sequential/bounded generated | evidenced | 40 malformed cases spanning empty forms, invalid authority/port, username/password cases, every C0 byte, and DEL; valid refusal control |
| CELL-018 | Response header boundary | Live origin and legacy cached metadata | Proxy-owned, hop-by-hop, transport, cookie, ordinary end-to-end | Strip, preserve, or invalidate safely | Miss/hit/across cache versions | evidenced | Adversarial origin plus forced refetch of an injected pre-sanitization entry; dynamic `Connection` tokens and multi-value `Set-Cookie` |

## Verification campaigns

| ID | Mechanism | Scope | Budget/threshold | Result | Evidence |
| --- | --- | --- | --- | --- | --- |
| CAMP-001 | Contract tests | Current documented cache guarantees | Every README guarantee mapped or flagged ambiguous | in-progress | `specs/*.allium`; `tests/proxyCache.contract.test.ts`; `tests/proxyCache.test.ts` |
| CAMP-002 | Model/property sequences | Cache lifecycle, policies, variants, mutation, clear, reload | Explicit trace plus 10 deterministic seeds × 30 operations | passing | `tests/proxyCache.model.test.ts` |
| CAMP-003 | URL property matrix | Supported canonical origin URL grammar | Schemes × authorities × paths × searches × fragments × prefixes; bounded deterministic runtime | passing | 1,512 cases and 3,024 channel comparisons in `tests/proxyCache.contract.test.ts` |
| CAMP-004 | Stream fault injection | Origin/decompressor/transformer/client/cache writer | One injected failure at each boundary | passing | `tests/proxyCache.stream.test.ts`; incomplete origin, gzip source/decompression, size-bound transformation, disconnect, synchronous/asynchronous cache failures, backpressure, finalization, and listener assertions |
| CAMP-005 | Mutation testing | Cache policy and URL codec baseline | Baseline high threshold 80%; every survivor classified | passing for selected slice | StrykerJS 9.6.1, Node 24.19.0, Bun 1.3.14; 121 total, 108 killed, 13 survived, 0 timeout/no-coverage/error; 89.26% raw score; `.cache/mutation-report.json` |
| CAMP-007 | Mutation testing | Stream fan-out, encoding selection, and router cache-write orchestration | At least 80%; every survivor classified | passing | Final bounded scope: 49 mutants, 25 killed, 24 timed out, 0 survived/no-coverage/error, 100%; `.cache/mutation-stream-report.json`. An initial 216-mutant scouting run scored 49.54% and drove scope correction and new oracles |
| CAMP-008 | Mutation testing | Target validation, rewrite/redirect policy transitions, and response-header filtering | At least 80%; every survivor classified | passing | 146 total, 140 killed, 6 equivalent survivors, 0 timeout/no-coverage/error; 95.89% raw score; `.cache/mutation-security-report.json` |
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
| FIND-008 | Medium | resolved | INV-010/CELL-005 | `cacache.put.stream` rejects empty input, so successful 204 responses were never cached | Reference model failed on explicit and generated 204 transitions | Lazy empty writer in `f1fb7f15` |
| FIND-009 | Medium | resolved | INV-001/CELL-001 | Prefix lookalikes such as `/__proxy_cache-other` were classified as proxy paths | Propagated prefix-boundary contract and CSS-warming integration test | Segment-aware `isProxyPath` in `f1fb7f15` |
| FIND-010 | Medium | resolved | INV-001/CELL-001 | Decoding removed the configured proxy-prefix text when it occurred inside the origin pathname | Generated pathname grammar and CSS-warming regression | Anchored prefix removal in `f1fb7f15` |
| FIND-011 | High | resolved | AREA-006/AREA-011 | Bun substitutes a bare `node-fetch` import with its native fetch shim, which eagerly decoded Brotli despite `compress: false`, producing runtime behavior different from Node and potentially mismatching cached bytes and headers | Opaque Brotli integration failed under Bun while the actual node-fetch package preserves bytes | Load the pinned node-fetch v2 package entry explicitly; opaque Brotli and stacked-encoding miss/hit tests pass under Bun, and the build loads under Node |
| FIND-012 | Medium | resolved | INV-004/CELL-010 | The router could complete before cacache's index commit event, allowing an immediate follow-up request to miss nondeterministically | Repeated opaque-encoding miss/hit tests observed `cache-write` followed by an empty index | Complete the wrapper only after cacache emits its post-index `size` event; five repeated fault-suite runs and mutation testing pass |
| FIND-013 | Medium | resolved | INV-005/CELL-010 | `Promise.all` returned on the first stream failure while sibling stream branches were still settling, causing cleanup races and late errors | Initial client-disconnect fault produced late unhandled abort errors | Await all stream settlements, preserve the first rejection, and treat premature close as failure |
| FIND-014 | Medium | resolved | INV-005/CELL-010 | A response's normal post-finish `close` event was classified as a client disconnect and could abort a successful cache commit | Repeated opaque response tests intermittently lacked their committed entry | Ignore response close after `writableFinished`; repeated stream suite is stable |
| FIND-015 | Low | resolved | AREA-006 | Multiplex destinations retained error listeners after successful finalization | Listener-count assertion after two-destination finalization | Remove listeners on finish or close; finalized helper mutation scope scores 100% |
| FIND-016 | Medium | resolved | INV-013/CELL-017 | Malformed decoded targets reached allowlist/fetch processing, and control-bearing query data could reach proxy diagnostic-header construction | Initial malformed-target regressions returned 502 or rejected instead of a bounded 400; README-style URL parsing could also throw on malformed redirects/documents | Canonicalize and validate HTTP(S) targets before policy evaluation; leave malformed rewrite inputs opaque |
| FIND-017 | High | resolved | INV-014/CELL-018 | Origins could overwrite proxy diagnostics, set or persist cookies on the proxy application's origin, and relay hop-by-hop or origin-specific transport state | Adversarial origin produced forged cache status/origin URL and reusable `Set-Cookie`, `Connection`-nominated, HSTS, and Alt-Svc fields | Separate relay/cache exclusions, honor dynamic `Connection` tokens, reserve proxy headers, strip origin cookies, and invalidate pre-sanitization entries |

No confirmed findings are currently open. Pending areas have not yet received enough evidence to make that a closure claim.

## Rejected hypotheses

| ID | Hypothesis | Evidence checked | Conclusion |
| --- | --- | --- | --- |
| HYP-001 | Only empty redirect bodies fail to create cache entries | Direct `cacache.put.stream` experiment and model 204 transition | Rejected: the streaming API rejects any empty input with `ENODATA`; fixed generically |
| HYP-002 | Equivalent gzip/deflate orderings require separate entries | Canonicalization integration and model traces | Rejected for the supported grammar: both spellings share one entry |
| HYP-003 | Cache warming follows a redirect to a disallowed origin | Cross-origin absolute and protocol-relative targets with request counters | Rejected: allowed redirects are proxied and followed; disallowed targets remain external `Location` values and receive zero proxy fetches |

## Mutation survivor classification

The raw mutation score is retained. Classification does not rewrite it into an adjusted score.

| Class | Count | Mutations | Rationale |
| --- | --- | --- | --- |
| Equivalent in declared domain | 4 | Cache-control empty fallback, empty directive name, boolean sentinel, and redundant runtime type guard | The parser exposes only recognized directive keys and its internal map values are constrained to `string \| true`; these changes cannot affect the returned policy |
| Equivalent in declared domain | 6 | Two scheme-replacement anchors, leading-slash anchor, and three `>= 0` to `> 0` index changes | Earlier guards and canonical proxy-path structure make the altered positions unreachable for supported inputs |
| Resolved outside codec contract | 3 | Two exact-prefix decoding mutations and one non-prefixed decoding mutation | The codec contract remains limited to encoder output; the router now rejects empty/malformed decoded targets with 400 before policy or network work |
| Outside finalized stream slice | 103 | Survivors from the initial 216-mutant exploratory scope | Generic `fromReadable`, broad fetch/catch/abort branches, diagnostics, and cache-writer internals exceeded the declared fan-out/encoding/orchestration slice; they remain in their corresponding ledger areas rather than being silently counted as stream closure evidence |
| Oracle gaps resolved | 4 | Content-type suffix, gzip source-error forwarding, and two opaque-encoding fallback mutations | Added parameterized content-type, direct source fault, and rewrite-sensitive opaque-body tests; all are killed or timed out in the final run |
| Redundant implementation removed | 2 | Reverse response-sink error listener mutations | Multiplex failure already destroys the response, whose close handler aborts the origin; removing the duplicate listener left origin-teardown evidence passing |
| Final stream survivors | 0 | Finalized 49-mutant slice | 25 killed and 24 timed out; no survivors, no-coverage mutants, or errors |
| Equivalent in security runtime | 2 | Removing cached-`Location` resolution conditional | The pinned node-fetch v2 manual-redirect response already exposes an absolute `Location`; stored-metadata and cache-hit assertions are unchanged |
| Equivalent in URL-constructor domain | 2 | Empty catch body and unconditional TypeError handling | The only operation in the block is the standard URL constructor, whose invalid-input failure is TypeError; both mutations return `undefined` identically |
| Equivalent empty connection tokens | 2 | Retaining empty split tokens and substituting a fallback token when `Connection` is absent | Empty/nonexistent token names cannot equal an actual response field name, so the exclusion set and emitted headers are unchanged |

## Closure profiles

| Profile | Scope | Status | Evidence | Deferred work |
| --- | --- | --- | --- | --- |
| Functional correctness | Entire package | in-progress | Contract, model, integration, and stream-fault suites | Pending ledger cells and two independent final passes |
| Security | Malformed target, redirect allowlist, and response-header trust slice | evidenced | CELL-017/CELL-018 plus 95.89% mutation slice | Cache-path assumptions and resource exhaustion remain separately pending |
| Compatibility | Bun development plus published Node/Express consumers | in-progress | Bun suite/build and one Node CommonJS smoke | Installed Node/Express version matrix |
| Performance/resources | Streaming, warming bounds, and cache lifecycle | in-progress | Backpressure/fault evidence and bounded warming concurrency | Reproducible performance harness, cache growth/cleanup, stress bounds |

## Pending work ordered by risk and information gain

| Priority | Area/cell | Why next | Recommended action |
| --- | --- | --- | --- |
| 1 | AREA-011 | Published compatibility is broader than one local Node smoke test | Install the packed artifact and exercise representative Node 18/current plus Express 4/5 combinations |
| 2 | AREA-007/CELL-009 | Shared revalidation and cancellation are the highest remaining stateful race surface | Define expected per-client cancellation semantics, add a reference-model burst, then mutate the queue/coalescing slice |
| 3 | AREA-009/AREA-013 | The completed trust slice does not establish filesystem or resource-exhaustion safety | Audit cache-path ownership/symlinks, oversized headers/URLs, and cache-growth limits |

## Stop conditions

- [ ] Every selected matrix cell has test or inspection evidence.
- [ ] Every documented contract in scope has a test or an ambiguity finding.
- [ ] Supported input/token types and option states in scope are exercised.
- [x] The bounded URL and operation-sequence property campaigns produce no unaddressed failures.
- [x] The selected mutation baseline exceeds 80%, and every survivor is classified.
- [ ] Two independent focused passes find no new medium-or-higher issues.
- [x] Every fix receives targeted adversarial review.
- [x] Remaining uncertainty and deferred areas are explicit.

The audit is not closed.

## Audit log

| Date | Reviewer | Slice | Result | Next step |
| --- | --- | --- | --- | --- |
| 2026-08-13 | Codex | General implementation and latest performance-change review | Seven findings recorded | Fix findings and add regressions |
| 2026-08-13 | Codex | Finding remediation | `fbd70a2e`; 39 tests passing | Replace example accumulation with a reference model |
| 2026-08-13 | Codex | Cache lifecycle model | Added explicit trace, 10 seeded traces, and coalescing bursts; found FIND-008 | Formalize contracts, then run mutation baseline |
| 2026-08-13 | Codex | Allium codec/lifecycle contracts and bounded mutation baseline | Added two specs, propagated contract/property tests, fixed FIND-009/FIND-010, and classified all 13 survivors at 89.26% raw score | Stream fault injection and its mutation slice |
| 2026-08-13 | Codex | Stream fault and runtime-compatibility slice | Installed Allium 3.5.3; recorded lifecycle-spec diagnostics; fixed FIND-011–FIND-015; final 49-mutant slice scored 100%; Node CommonJS and npm-pack smoke checks passed | AREA-009 malformed-path, redirect, and header-injection audit |
| 2026-08-13 | Codex | Security trust boundaries | Fixed FIND-016/FIND-017; 40 malformed targets plus redirect/header/legacy-cache adversarial tests pass; final 146-mutant slice scored 95.89% with all six survivors classified | AREA-011 installed Node/Express compatibility matrix |

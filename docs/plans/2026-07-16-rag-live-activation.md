---
title: "RAG E3-E7 production activation closure"
type: sprint
status: completed
created: "2026-07-16"
updated: "2026-07-16"
checkpoints: 0
tasks_total: 8
tasks_completed: 8
risk_level: L4
tags: [sprint, rag, production, hybrid-search, graphrag, multimodal, durable-workflow]
aliases: ["rag-live-activation"]
invariants:
  - "dense 2-step remains the control and rollback path"
  - "tenant/corpus/document/version/trust identity is server-owned and fail closed"
  - "shadow work never changes prompt-visible evidence"
  - "ordered context requires a complete bounded corpus proof"
  - "Graph artifacts publish atomically and no partial result survives failure"
  - "durable cancellation is terminal and late provider work cannot commit"
invariant_tests:
  - "pnpm test:rag-security"
  - "pnpm test:rag-kernel"
  - "pnpm rag:eval:contracts"
  - "git diff --check"
deferred:
  - sprint: live-environment-validation
    item: "Real Zilliz/Milvus shadow backfill and p95/quality cutover"
    deadline: "2026-08-16"
    reason: "Requires deployment credentials and production corpus"
  - sprint: live-environment-validation
    item: "Cross-host durable and Graph shared-provider failover drill"
    deadline: "2026-08-16"
    reason: "Requires shared external persistence infrastructure"
---

# RAG E3-E7 production activation closure

## Phase 1: Think

### Scope

- Close the production wiring gaps found after the E2b-E7 contract sprint, in this order: E4, E5, E3, E6, E7.
- Every capability must have a real route/ingest/query caller, a server-owned feature gate, dense/text rollback, and L3/L4 regression coverage.
- Replace the misleading hermetic-only completion signal with route-level integration contracts that exercise the actual orchestration seam.

### Non-scope

- No production credential creation, cloud data mutation, model download, or irreversible collection migration.
- No default cutover without corpus-native quality, security, latency, and cost evidence.
- No second RAG orchestration stack and no client-supplied tenant/filter/provider endpoint.

### Upstream refresh (2026-07-16)

- [MiroFish](https://github.com/666ghj/MiroFish) official `main` remains
  `96096ea0ff42b1a30cbc41a1560b8c91090f9968`; latest release remains
  [`v0.1.2`](https://github.com/666ghj/MiroFish/releases/tag/v0.1.2). There is
  no source delta to manufacture locally.
- [OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) official `main` advanced
  six commits from the 2026-07-15 anchor `0db93bd` to
  [`65bf20a`](https://github.com/THU-MAIC/OpenMAIC/commit/65bf20a84b0324761fd0d0387421e936bbe23c8b);
  latest release remains [`v0.3.0`](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v0.3.0).
- Portable security delta: upstream hardened provider redirects and detected
  ISATAP addresses embedding private IPv4 targets. This repository already
  manually validates and DNS-repins every redirect hop; it now also rejects
  private IPv4 targets embedded in either ISATAP interface-ID form, with public
  and private regression cases.
- Portable state signal: upstream moved runtime chat sessions into its
  RuntimeStore. E7 below keeps this repository's own scoped checkpoint/result
  provider instead of importing the incompatible editor/runtime store.
- Interactive-deck export, video export and JSON-Patch editor changes have no
  matching local product seam and are intentionally not copied.

### Success

- E4 mode can activate only with a complete bounded reader and routes before retrieval execution.
- Graph API output becomes an immutable scoped artifact consumable by `/api/ask`, with promotion and lifecycle deletion.
- Hybrid and Contextual v2 have production adapters/callers while off/shadow preserves current output.
- PDF visual and durable workflow code are reachable from concrete production routes with safe fallback.
- Full tests, TypeScript, scoped lint, build, doc-to-code review, and independent L4 review pass.

### Risks

- L4: tenant/corpus/trust isolation and persisted state.
- L3: Milvus schema/version compatibility, multimodal resource amplification, and durable at-least-once semantics.
- Live infrastructure remains separately evidenced; code completion must not be reported as a production cutover.

## Phase 2: Plan

### Invariants inherited

| Subsystem | Invariant | Preservation |
|---|---|---|
| Kernel/API | plan-before-policy; one envelope/trace | pre-route capability is server-derived and becomes plan input |
| Retrieval | dense 2-step is control | optional lanes fail closed or fall back without widening scope |
| Evidence | authoritative scalar provenance wins | all new readers/adapters emit canonical scoped evidence |
| Security | quarantined never reaches generation | composer and every new provider boundary revalidate trust |
| Graph | all-or-nothing artifact publication | durable store write precedes task completion/promotion |
| Durable | cancellation wins and replay is fenced | persistent store uses CAS, integrity, lease owner and revision |

### Integration paths

| Capability | Trigger | Runtime path | Persistence | Rollback |
|---|---|---|---|---|
| E4 ordered | `/api/ask` global query + active gate | capability/inventory -> pre-router -> bounded reader -> composer | none | dense retrieval |
| E5 Graph | `/api/mirofish/graph` build | builder -> scoped immutable artifact -> active pointer -> graph lane | File/provider store | dense lane |
| E3 hybrid | `/api/ask` identifier query + shadow/active | Milvus capability -> hybrid port -> lane -> router | shadow collection manifest | dense lane/off |
| E3 contextual | document pipeline ingest | source-aligned chunks -> v2 contextualizer -> dense index | versioned chunk identity | raw text/off |
| E6 visual | PDF ingest/query | page images -> manifest -> modality router -> analyzer -> evidence | scoped sidecar manifest/assets | text/OCR |
| E7 durable | registered long RAG workflow | route -> persistent checkpoint store -> adapter -> management resume/cancel | local durable provider port | synchronous/off |

### Half-complete debt disposition

| Source | Debt | Decision |
|---|---|---|
| 2026-07-15 sprint | E4 ordered capability hardcoded false | Task 2 closes |
| 2026-07-15 sprint | Graph producer and read store disconnected | Task 3 closes |
| 2026-07-15 sprint | Hybrid/contextual have no production caller | Task 4 closes |
| 2026-07-15 sprint | PDF visual has no caller | Task 5 closes |
| 2026-07-15 sprint | Durable store/caller are hermetic only | Task 6 closes |
| 2026-07-16 audit | route-level contract misses dead activation | Task 7 closes |

### Tasks

| ID | Task | Status | Risk | Acceptance |
|---|---|---|---|---|
| T1 | Follow-up sprint, baseline, dependency and invariant audit | completed | L1 | scope/integration/debt recorded; clean baseline |
| T2 | E4 bounded ordered reader, pre-execution router, API contract | completed | L4 | active only with complete bounded corpus; otherwise dense |
| T3 | E5 immutable Graph publication, active resolution, lifecycle | completed | L4 | API-built graph is queryable; active pointer must be CAS-deactivated before delete removes task/artifact |
| T4 | E3 Milvus hybrid shadow/active adapter and Contextual v2 ingest | completed | L4 | real production callers; off/shadow cannot change generation |
| T5 | E6 PDF page-image manifest, visual provider and callers | completed | L4 | scoped digest-verified assets; pure text stays text |
| T6 | E7 persistent checkpoint provider and concrete workflow route | completed | L4 | restart/resume/cancel/idempotency/integrity tested |
| T7 | Route-level integration matrix, config docs, full verification | completed | L4 | actual API seams covered; production quality claim remains honest |
| T8 | Independent review, P0/P1/P2 fixes, compound | completed | L4 | independent review P0/P1/P2 = 0; solution/rules updated |

## Phase 3: Work log

- Baseline HEAD: `d53b05de74fe8c958693feecef66fd9c08839bbd`; worktree clean; prior full suite 52 files / 545 cases passed.
- T2: added server-scoped Milvus ordered query, scalar order schema, bounded completeness proof, routed ordered lane, stable ingest version/span, and real /api/ask active/shadow/off/fallback/fail-closed tests.
- T2 final focused verification: ordered reader 13/13, Ask route 43/43, Milvus adapter 16/16, TypeScript no-emit passed.
- T2 live boundary: existing collections without document_version/chunk_index/total_chunks remain dense until migrated or rebuilt.

- T3: added immutable/idempotent graph publication, bounded scoped catalog, revision-CAS active pointers, TTL/tombstone lifecycle, metadata alias sanitization, and a process-local topology guard.
- T3: the builder now commits durable artifacts before task completion; Graph API data/list/PATCH/DELETE and /api/ask resolve the same store, with pinned-env rollback compatibility.

- T5: added bounded PDF page rendering, immutable manifest-last page assets, exact tenant/corpus/document/version/trust revalidation, and process-local topology guards.
- T5: document ingest publishes the visual sidecar only after authoritative text persistence; `/api/ask` appends an optional visual lane after every text rollback route and keeps off/pure-text at zero visual I/O.
- T5: active visual evidence is digest-verified and prompt-visible; shadow runs diagnostic-only; missing model/assets/topology safely preserve dense text behavior.
- T5 final focused verification: asset store 38/38, renderer 12/12, multimodal contracts 11/11, visual lane 10/10, ingest 4/4, runtime 4/4, pipeline caller 3/3, pipeline route 3/3, PDF parser 6/6; E6 matrix 91/91.
- T3 final focused verification: artifact store 42/42, builder 12/12, Graph API 37/37, graph lane 19/19; E5 matrix 110/110, TypeScript no-emit passed.

- T4: replaced legacy contextual ingest with source-aligned Contextual v2 and a lazy LangChain adapter; active changes only dense embedding input while persisted citation/BM25 text remains raw, and shadow remains diagnostic-only.
- T4: added a separate native Milvus BM25 shadow collection, exact schema/capability probing, dense+BM25 server fusion, bounded lexical-membership verification, scoped authoritative provenance, ingest dual-write, and identifier-query routing with required dense rollback.
- T4 final focused verification: Milvus adapter 16/16, hybrid policy 14/14, hybrid lane 7/7, contextual policy 15/15, contextual pipeline 6/6, hybrid ingest 5/5, Ask API 43/43, TypeScript no-emit and diff check passed.

- T6: added generation-aware durable checkpoint v3, bounded file checkpoint/result stores, persistent leases, tombstone acknowledgement, exact generation cleanup, and a concrete `/api/ask` durable POST/GET/PATCH lifecycle. Synchronous calls remain at zero durable filesystem I/O.
- T6 focused verification: checkpoint store 22/22, result store 27/27, durable workflow 25/25, durable ask 12/12, runtime 3/3, Ask route 43/43.

- T7: every E2b-E7 implementation has a real route, ingest, or query caller and dense/text or synchronous rollback. E3-E7 use server-owned rollout gates; E2b deliberately retains its server-validated per-request mode. All changed test files are included in the default package test chain; no TODO/FIXME or skipped tests remain in the activation scope.
- T7: deployment docs now cover ordered/hybrid deadlines, abstention mode and threshold, corpus/index cache identity, legacy hybrid shadow compatibility, Graph/PDF/Durable capacity/lifecycle controls, and same-process versus shared-control-plane boundaries.
- T7: removed the unused legacy hybrid boolean export. Runtime artifact roots keep configurable external paths while statically scoping default `uploads` roots.
- T7 trace hardening: route-scoped `outputFileTracingExcludes` removes raw RAG/MiroFish JS/TS source families that Next conservatively collected beside dynamic file stores; a postbuild NFT plus standalone-tree guard prevents recurrence. Fresh build evidence: Ask 1251, Pipeline 472, Graph 175 traced files, with zero forbidden NFT or packaged raw source/test files (`standaloneRaw=0`).

- Independent review fixes: E5 in-memory CAS activation/delete is now one atomic management transition; E6 root recovery accepts reclaimed zero-scope journals only when durable bundle state proves no live asset, and a `creating` lifecycle automatically rolls back interrupted new-scope reservations; E7 temp-cleanup failures force the next bounded preflight and generation cleanup cannot touch a replacement generation.

- Final L4 verification: direct TypeScript passed; scoped dirty-file ESLint passed with zero findings; `pnpm test:rag-security`, `pnpm test:rag-kernel`, `pnpm rag:eval:contracts` (23/23), and final `pnpm test` all exited 0.
- Production build passed without Turbopack warnings and generated 88/88 static pages. Base, local-Milvus, and cloud/Zilliz Compose configurations all rendered successfully.
- Repository-wide `pnpm lint` remains blocked by pre-existing unrelated debt (357 errors / 113 warnings); no finding is in the changed-file scoped lint set.
- T8 final independent review: P0/P1/P2 = 0 after closing E5 activation/delete CAS, E6 adjacent recovery/capacity, E7 cleanup preflight, contextual/creating/E2b documentation, and standalone trace findings.
- Fresh standalone evidence: no code/config edit is later than the final build; health returned 200; Ask, Pipeline, and Graph routes loaded and returned the expected production-auth 503 boundary rather than a missing-module failure.
- Compound output: one accepted solution document, four repo-native rule updates, zero new instincts, and an observed `compound` skill signal count of 4 (`observe`).
- Solution-index projection was not run because this repository has no `sync-solution-index.js` or native index renderer; no synthetic index format was invented. Codex memory was not modified because the user did not request a memory update.


### Honest production boundary

- This sprint proves local code reachability, rollback, persistence, integrity, bounded recovery, and hermetic contracts. It is not a production cutover claim.
- Still external: real Milvus/Zilliz 2.6 schema migration, shadow backfill, corpus-native quality/p95/cost gates and rollback drill; representative vision-model/PDF quality and resource gates; shared transactional providers plus multi-host failover for Graph/PDF/Durable; production traffic canary, observability, and cutover evidence.
- Default generation-changing gates remain `off`; abstention remains observation-only `shadow`. Existing collections without ordered scalar provenance stay on dense retrieval.

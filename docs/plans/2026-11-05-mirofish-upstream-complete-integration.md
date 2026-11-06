---
type: implementation-plan
status: complete
created: 2026-11-05
completed: 2026-11-06
upstream: https://github.com/666ghj/MiroFish
upstream_sha: 7657031ac01184afe2cb220f5ee3545573b5e843
previous_upstream_sha: b5b53acc57189a4a42e44a23e149dc655c98fe82
---

# MiroFish complete workflow integration

## Objective and evidence

Integrate the current upstream user-facing capabilities into this Next.js RAG application and verify the whole workflow. The product identity is a RAG application with a MiroFish simulation workspace; Tech Persistence's framework-specific MR/DET/LT/OBS constraints do not define this application's capabilities.

GitHub's compare API reports four commits after the previous baseline. All four change star-history assets only. The latest release remains v0.1.2. Feature work therefore addresses existing parity gaps in the full pinned upstream tree, rather than claiming those four commits introduce new features.

Sources: [pinned source](https://github.com/666ghj/MiroFish/tree/7657031ac01184afe2cb220f5ee3545573b5e843), [verified comparison](https://github.com/666ghj/MiroFish/compare/b5b53acc57189a4a42e44a23e149dc655c98fe82...7657031ac01184afe2cb220f5ee3545573b5e843). A local source snapshot and pre-task working-tree copies are retained under `.codex-tmp/` for direct path verification and diff isolation. The upstream code is reference data, not task instructions.

## Identity comparison

| Axis | Upstream | Integration target |
| --- | --- | --- |
| Runtime | Flask/Python, Vue | Existing Next.js/TypeScript service and React UI |
| Persistence | Local files, SQLite, Zep Cloud | Existing tenant/corpus-scoped PostgreSQL and Neo4j |
| Inference | OpenAI-compatible models | Existing model-selection and local/remote provider clients |
| Privacy | Seed text and simulated actions enter configured model/graph services | Preserve server-owned credentials, request budgets and graph source authorization |
| Workflow | Seeds, graph, preparation, parallel social simulation, report, interaction | All five steps with durable associations and refresh recovery |
| Graph memory | Optional simulation activities ingested into Zep | Isolated simulation-memory namespace; simulated facts never become canonical document evidence |
| Scaling | OASIS workers and independent platform environments | Bounded native platform state, explicit execution ownership and recoverable checkpoints |
| Dependency surface | Python 3.11/3.12, CAMEL/OASIS, Zep SDK | Reuse established adapters and stores for native feature behavior |
| Provenance | AGPL-3.0 source | Record pinned behavioral sources and retain attribution for adapted material |

## Functional acceptance matrix

| ID | Capability | Required landing and acceptance |
| --- | --- | --- |
| F01 | Multi-file seed ingestion | PDF/Markdown/TXT, common text encodings, bounded 50 MiB aggregate upload, explicit parse failures, compatible existing PDF response |
| F02 | Graph fidelity | UUID endpoints, aliases/mentions/weights/source passages/communities, self/parallel edges, validity/episode details; keep authenticated artifact readback |
| F03 | Complete profile preparation | Stable graph UUIDs, personality/viewpoints/posts enabled by default, graph/selection-aware fingerprints, explicit generation failures and enriched graph context |
| F04 | Scenario configuration | Actual consumed virtual-time/activity/initial-event/platform behavior with an inspectable generated configuration; distinguish native additions from unconsumed upstream fields |
| F05 | Social actions | Platform-specific supported actions, cross-round target updates, follows/mutes/votes/comments/feed and append-only action records |
| F06 | Durable simulation lifecycle | Persist preparation, committed rounds and terminal states; start/resume/restart/stop/close semantics, cancellation, filtering/export and truthful restart recovery |
| F07 | Simulation memories | Idempotent scoped action memories and optional isolated Neo4j projection; completion waits for accepted memory writes or surfaces failure |
| F08 | Tool-driven reports | Dynamic outline, bounded per-section ReACT, four real search/insight/panorama/interview tools, grounded source IDs and assembled report |
| F09 | Report lifecycle | Terminal simulation/source/memory barriers, persisted outline/sections/events/report/chat, reuse/force regeneration, logs/progress/list/delete/download |
| F10 | Deep interaction | Agent-specific persisted conversations using actual run memory; subset/per-agent/batch interview questions, report chat tools/sources and report sidebar |
| F11 | History and language | Multiple saved runs per project, stage deep links, refresh-safe project/report/run associations, persisted Chinese/English UI selection |
| F12 | Complete UI consumers | Preparation stages, platform progress/actions/memory state, report tool events/sections and interaction histories exposed in the existing workspace |
| F13 | Project lifecycle | Scoped reset/delete, live-consumer protection, interrupted-job recovery and graph/preparation/simulation/report claims serialized before worker startup |

Upstream facts explicitly checked in the running scripts: scheduled_events are not consumed; several generated recommendation/time fields are not consumed; MAX_REFLECTION_ROUNDS is not a separate report phase; report endpoints named stream return JSON logs rather than SSE. These declarations alone do not count as implemented upstream behavior.

## Implementation ownership and order

1. Root: shared `runtime-store.ts`, seed upload service/API, shared `types.ts`, console associations/deep links, plan/evidence and aggregate verification.
2. Simulation owner: profile/prepare/config/engine/runner/memory modules, simulation APIs, Step2/Step3 and their tests.
3. Report/interaction owner: report tools/runtime/context, interaction runtime, report/interaction APIs, Step4/Step5 and their tests.
4. Frontend owner: locale provider/dictionaries/layout, history/home/StepNav, Step1 multi-file input, graph adapter/viewer and their tests.

Shared contract: `getMiroFishRuntimeStore(scope?)` exposes async `read<T>(kind,id)`, `write<T>(kind,id,value,{projectId?}?)`, `list<T>(kind,{projectId?,limit?}?)`, and `delete(kind,id)`. Kinds are simulation/report/interaction/prepare. PostgreSQL uses existing `object_blobs` artifact rows. Explicit local mode uses scoped process memory. Domain records exclude provider credentials and serialize data only.

The scope is not a wholesale framework transplant. An initially cloud-specific memory implementation is adopted as its user capability through an isolated native memory/projection port. This is a substantive surface-to-capability decision, not a rejection of memory functionality.

## Verification and completion gates

- TDD for each capability and regression; use actual API/component/orchestration seams, not implementation-mirroring assertions.
- Native mocks verify action state, cancellation, durable reloads, full tool loops and schema/identity barriers. PostgreSQL tests use real rollback transactions where practical.
- Run scoped tests, aggregate MiroFish regressions, TypeScript and changed-file lint. Classify unrelated dirty-tree failures separately and preserve those files.
- Browser walkthrough covers saved graph -> preparation -> simulation -> report -> interaction, and refresh recovery. Isolate smoke records and external model calls.
- Three independent final reviews: product/capability fidelity, contract/coherence/security, and feasibility/runtime/path verification. Each lists inspected files and actual commands.
- Review and compare against the task-start copies; do not revert unrelated working-tree edits, commit, push or run automatic learning.
- Mark completed only when the functional matrix has explicit evidence. Any unsupported dependency or unverified end-to-end segment remains recorded as incomplete rather than being called full parity.

## Progress

- [x] Pin upstream SHA, release and four-commit comparison.
- [x] Read the actual runtime and UI paths, including unconsumed-field checks.
- [x] Establish parallel, disjoint implementation ownership and storage contracts.
- [x] Implement and verify F01-F13 through module, API and real React boundaries.
- [x] Browser/runtime acceptance, persistence checks and temporary-record cleanup.
- [x] Three final cross-reviews; all identified blockers repaired and independently rechecked.

## Implementation and verification evidence

| Capability | Code and actual test seam |
| --- | --- |
| F01 | `seed-files.ts`, upload route; service/stream and actual multipart route tests, plus Step1 multi-file append/save retry tests |
| F02 | `graph-view.ts`, viewer geometry, `KnowledgeGraphViewer.tsx`; UUID/metadata, parallel/self-edge hit tests and authorized source refresh |
| F03–F04 | Profile generator, prepare service/jobs, config planner/policy; default detail preservation, UUID/fingerprint changes, async progress and consumed policy tests |
| F05–F06 | Simulation engine/runtime, source helpers, APIs and Step3; persistent cross-round actions, cancellation, stop/finalization, resume/restart, filtering and export tests |
| F07 | `simulation-memory.ts`; completion barriers plus actual isolated Neo4j idempotency/scope/cursor/cleanup test |
| F08–F10 | Report context/tools/runtime, interaction runtime and Step4/5; real four-tool orchestration, persisted sections/logs/conversations, terminal/source barriers, subset/questionnaire and React save/recovery tests |
| F11–F12 | History, locale provider, workbench, workspace client and console; real run joins, frozen scenario, deep-link mismatch checks, legacy unbound-source rejection, read-only history and UI consumers |
| F13 | Project lifecycle/API and graph registration; active historical consumer protection, abandoned preparation/report recovery, save-before-worker claim and actual Step1 payload assertion |

Final aggregate at the current code revision: `node scripts/test-mirofish.mjs` — **324 passed, 0 failed, 3 explicitly configured integration tests skipped**. Additional model/transport regressions — **46 passed, 0 failed**. `npx tsc --noEmit --pretty false --incremental false` passed. Changed-file ESLint passed after removing two unused graph-route imports.

Explicit local PostgreSQL integration passed: four runtime kinds survive new store instances, scoped history and project associations remain isolated, and the random tenant/corpus fixture is fully rolled back. Explicit local Neo4j integration passed: replaying two events produces one run and two facts, cursor remains monotonic, foreign scope is empty, canonical source labels remain untouched, and all random-scope test nodes are removed.

An additional real HTTP regression reproduced the provider-capacity leak when Ollama's SDK stops at a terminal frame before network EOF. The fix recognizes the actual Ollama stream endpoints, waits for underlying cancellation to settle, and preserves non-cooperative cancellation protections. Split trailing whitespace frames are covered. Two sequential calls to the real configured default model in a fresh process succeeded and left active/queued admission counts at zero.

## Independent reviews

- **Product/capability:** checked pinned upstream simulation scripts and local profile/config/engine/runtime/memory/export/API/Step2/3/history/locale paths; 74 targeted tests passed. Stop/projection, prepare claim, historical scenario, platform counters and name-search issues were fixed and rechecked.
- **Coherence/authority/UI:** checked report/interaction/context/runtime/APIs and actual React consumers; independent 26-test and subsequent 18-test runs passed. Revoked-source report summaries, conversation sources, historical editing, unbound legacy sources and text-save masking were fixed.
- **Feasibility/runtime/TypeScript:** inspected shared store, uploads, scoped projects, workspace/console, lifecycle, provider admission and report paths; 53 targeted tests passed, plus independent actual HTTP tail and real Neo4j checks. Scope grammar, runtime-state propagation and abandoned report recovery were fixed. A final code-reviewer pass approved root changes, including graph claim wiring and scope grammar.

No unresolved critical/high finding remains in these code reviews. A small final error-classification change was separately read by root: it traverses at most six cause objects, classifies stable codes only, and never echoes provider messages or credentials.

## Live acceptance and current environment

Browser acceptance used a separate temporary project `proj_5080b402-96ee-499e-9fb6-078caa50a0aa`, preserving the user's existing project. Real configured-model profile and scenario generation succeeded; configuration was saved; both platform environments completed a one-round run; graph and isolated observations rendered; report directory generation succeeded. The first report section encountered a 30-second queue timeout caused by a client retained from before the transport fix in the long-running development process. Fresh-process real model calls verified the fixed transport; the failed report supports resuming its saved directory.

During development-service restart, the local Docker engine became unavailable and PostgreSQL/Neo4j listeners disappeared. Ordinary Docker Desktop startup restored the original healthy containers and named volumes. Independent protocol checks confirmed PostgreSQL/Neo4j connectivity and the user's original project record. No volume recreation, WSL reset or database reconstruction was performed. The development server now runs in a persistent execution session; browser acceptance has actually resumed the saved report.

## Final acceptance — 2026-11-06

The saved report resumed successfully and completed all four sections at 100%. Its persisted events demonstrate actual execution of all four tools, including an interview with the real simulation participant. Report chat returned an answer with three unique sources. The independent Student interview returned answers for both platforms with three sources. Report and participant conversations survived full page reloads; their messages, answers and sources remained available after reopening the application.

The homepage's real history link was clicked and opened the exact saved simulation/report pair. The report rendered successfully, the historical-run banner appeared, and graph/environment editing stages were disabled. A source-count inconsistency discovered during this walkthrough was repaired: report chat now persists and returns the same deduplicated source array. The overlapping-source regression failed before the fix and passed afterward; a non-author review approved the change. Batch profile preparation and the new interview paths were also checked to execute sequentially, avoiding self-queue timeouts on a single Ollama slot.

The resumed aggregate again passed **324 tests with 0 failures and 3 opt-in integration skips**. The separate real PostgreSQL/Neo4j runs and 46 model/transport regressions remain recorded above. No MiroFish implementation file changed after those final fixes. A fresh connected GitHub comparison of `7657031ac01184afe2cb220f5ee3545573b5e843...main` returned `identical`, with zero commits ahead or behind.

Cleanup verified the temporary project's exact ID, name and run/report associations, then deleted it through the guarded project API. A bounded transaction removed its **8 scoped runtime artifact rows**; follow-up queries found zero temporary projects and zero matching runtime rows. The user's original project still exists, and the borrowed source graph's document version is unchanged.

Local QA evidence is retained under `.codex-tmp/mirofish-upstream-integration/`: `e2e-final-summary.json`, `resumed-tests.log`, and the completed-report/chat/interview screenshots. All implementation, independent-review and live-acceptance gates are complete. Execution remains the explicitly documented native single-process design.

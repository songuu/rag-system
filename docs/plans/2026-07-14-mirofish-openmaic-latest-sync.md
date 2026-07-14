---
title: "MiroFish and OpenMAIC latest sync 2026-07-14"
type: sprint
status: completed
created: "2026-07-14"
updated: "2026-07-14"
checkpoints: 0
tasks_total: 5
tasks_completed: 5
tags: [sprint, mirofish, openmaic, maic, upstream-sync]
aliases: ["MiroFish and OpenMAIC latest sync 2026-07-14"]
upstream:
  mirofish_repo: "https://github.com/666ghj/MiroFish"
  mirofish_head: "96096ea0ff42b1a30cbc41a1560b8c91090f9968"
  mirofish_release: "v0.1.2"
  openmaic_repo: "https://github.com/THU-MAIC/OpenMAIC"
  openmaic_previous_head: "a88ee3d"
  openmaic_latest_head: "40ff80ab63a6f3db2bd4e09fd0cbf56a34a45941"
  openmaic_latest_release: "v0.3.0"
  openmaic_ahead_by: 72
invariants:
  - "MiroFish remains behind the existing prepare/snapshot boundaries; no upstream delta means no local churn."
  - "MAIC keeps the Course -> Prepared -> Scene -> Action lightweight runtime; do not import the full OpenMAIC editor/app."
  - "Generated JSON is parsed without exposing raw model responses or weakening existing fallbacks."
invariant_tests:
  - "node src/lib/maic/json-response.test.mjs"
  - "node src/lib/model-catalog.test.mjs"
  - "node src/lib/maic/pipeline/stage-options.test.mjs"
  - "node src/lib/maic/agents/manager-agent.test.mjs"
deferred:
  - item: "OpenMAIC application-level transient generation retry"
    deadline: "2026-09-01"
    reason: "Requires L3 coverage for error classification, abort, backoff, concurrency cost and progress-event semantics; the installed LangChain client already retries model calls."
  - item: "OpenMAIC multi-document course bundle"
    deadline: "2026-09-01"
    reason: "The local upload, Course schema, cache and RAG mirror are single-document contracts; this needs a separate L3 data-flow design."
  - item: "OpenMAIC DSL SDK, migration registry, editor and storage/runtime replacement"
    deadline: "2026-09-01"
    reason: "These systems cross the local Course -> Prepared -> Scene -> Action boundary and need a dedicated migration design."
  - item: "SearXNG runtime provider"
    deadline: "2026-09-01"
    reason: "This repo has no unified web-search provider boundary; track the capability without adding a dead adapter."
  - item: "OpenMAIC quiz formula rendering and action-level editor navigation"
    deadline: "2026-09-01"
    reason: "They belong to upstream quiz/editor UI surfaces that the local classroom does not currently implement."
---

# MiroFish and OpenMAIC latest sync 2026-07-14

## Phase 1: Think

### 已验证事实

- MiroFish official `main` is still `96096ea0ff42b1a30cbc41a1560b8c91090f9968`; the local tracked anchor is identical, so the delta is zero. Latest release remains `v0.1.2`.
- OpenMAIC official `main` is `40ff80ab63a6f3db2bd4e09fd0cbf56a34a45941`; latest release is `v0.3.0`.
- Compared with the last local research anchor `a88ee3d`, OpenMAIC is ahead by 72 commits.
- The highest-value portable delta is upstream `fabd7b6`: remove reasoning blocks before structured JSON parsing.
- Upstream `c8a638a` adds GPT-5.6 Sol/Terra/Luna capability metadata; `c569295` adds SearXNG as a search provider.
- Upstream `243e9f3` adds an application retry loop. The installed LangChain runtime already gives model calls an `AsyncCaller` default of six retries, so another MAIC retry loop would duplicate attempts.

### Scope

- Add a shared, reasoning-aware MAIC JSON parser and replace the three duplicated parsers.
- Add GPT-5.6 Sol/Terra/Luna to the documented OpenAI capability catalog; upstream support is verified, but this account/runtime has not been live-called.
- Record SearXNG as a documented-only search capability until a local search-provider boundary exists.
- Preserve all existing MAIC fallbacks and dirty-worktree changes.

### Non-Scope

- No MiroFish code change because official upstream has no delta.
- No full OpenMAIC SDK/editor/storage/runtime migration.
- No application-level retry loop on top of the current LangChain retry layer; upstream retry semantics are deferred to a dedicated L3 batch.
- No quiz/editor-only UI migration.

### Success

- Reasoning-prefixed and fenced model JSON parses consistently in read, plan and manager paths.
- Existing JSON fallbacks and MAIC stage behavior remain covered by regression tests.
- New model/search capabilities are traceable in the catalog without claiming unsupported runtime wiring.

### Risks

- JSON extraction must not delete literal reasoning tags inside otherwise valid JSON strings.
- The worktree already contains related uncommitted OpenMAIC changes; this sprint must patch narrowly and never reset them.

### Auto gate

- `✓ auto: phase 1 -> 2` — scope is explicit, upstream evidence is official, and all implementation tasks stay at L2 or below.

## Phase 2: Plan

### 入场扫描 - Invariants 继承

| 子系统 | 继承 invariant | 本 sprint 如何保持 |
|--------|----------------|--------------------|
| MiroFish | prepare/snapshot boundary | zero upstream delta, so no source churn |
| MAIC runtime | Course -> Prepared -> Scene -> Action | change only response parsing and catalog metadata |
| Fallbacks | malformed model output must degrade safely | parser returns `null`; existing stage fallbacks stay unchanged |

### 入场扫描 - 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 可见结果 |
|--------|----------|--------|--------|----------|
| Reasoning-aware JSON | prepare/classroom LLM response | shared `parseMaicJsonResponse` | existing prepared artifacts only | generated content no longer falls back solely because of reasoning prefixes |
| GPT-5.6 catalog | model capability lookup | `OPENMAIC_LATEST_MODEL_NOTES` | none | capability profile reports documented thinking support |
| SearXNG note | catalog inspection | documented-only capability | none | upstream support is traceable without false runtime support |

### 入场扫描 - 债务清单

| 来源 | 议题 | 本 sprint 决策 | deadline |
|------|------|----------------|----------|
| OpenMAIC `7c19ab8` / `9b4746e` | DSL schema and migrations | defer full SDK migration | 2026-09-01 |
| OpenMAIC `243e9f3` | application retry | defer as dedicated L3 batch | 2026-09-01 |
| OpenMAIC `baff099` | multi-document bundle | defer until upload/cache/RAG contracts are designed together | 2026-09-01 |
| OpenMAIC `c569295` | SearXNG runtime | document only | 2026-09-01 |
| OpenMAIC quiz/editor commits | formula rendering/navigation | defer | 2026-09-01 |

### Upstream decision matrix

| Upstream area | Evidence | Decision | Local landing |
|---------------|----------|----------|---------------|
| Reasoning-block JSON cleanup | `fabd7b6` | adopt | shared MAIC JSON response parser |
| GPT-5.6 Sol/Terra/Luna | `c8a638a` | partial adopt | documented model capability catalog + tests; no live availability claim |
| SearXNG provider | `c569295` | partial adopt | documented-only catalog entry |
| Transient generation retry | `243e9f3` | defer application layer | keep installed LangChain client retry; separate L3 work is required for app-level error classification, abort and progress semantics |
| Multi-format upload | `3b7a0ca` | already covered | existing shared document extensions plus `.pptx` |
| Multi-document bundle | `baff099` | defer | single-document upload/cache/RAG contracts require a separate L3 design |
| Pure choreography / action navigation | `7fffec7`, `d007950` | defer | local classroom timing/navigation needs a separate UI/runtime batch |
| DSL SDK/migrations/editor/runtime | multiple | defer | separate migration design |
| MiroFish main/release | `96096ea`, `v0.1.2` | no-op | local anchor already current |

### Tasks

- [x] T1 (L1): Verify official MiroFish/OpenMAIC release and branch deltas; classify upstream changes.
- [x] T2 (L2): Add `parseMaicJsonResponse` with exact/fenced/reasoning/balanced-JSON regression tests.
- [x] T3 (L2): Replace duplicated read/plan/manager parsers while preserving fallbacks.
- [x] T4 (L1): Add GPT-5.6 and documented SearXNG catalog entries with tests.
- [x] T5 (L2): Run targeted/full scoped checks, independent review, and compound documentation.

No task is marked `[P]`: T3 depends on T2, and T4 touches a currently dirty user file, so isolated parallel writes would raise merge risk without improving the critical path.

### Test strategy

Maximum risk: **L2 standard**. Structured-output parsing changes, but persistence/auth/data migration are untouched.

- Red: add parser and catalog regression tests first.
- Green: implement the smallest parser/catalog changes.
- Regression: run MAIC parser, catalog, stage and manager tests.
- Static: direct TypeScript check, scoped ESLint, and scoped `git diff --check`.

### Auto gate

- `✓ auto: phase 2 -> 3` — 5 bounded tasks, maximum risk L2, dependencies and verification commands are explicit.

## Phase 3: Work

### Implemented

- Added `src/lib/maic/json-response.ts`: exact JSON first, reasoning-closing-tag cleanup, fenced payloads, and string-aware balanced object/array extraction.
- Protected literal `</think>`, `</thinking>` and `</reasoning>` text inside valid JSON ranges, including prose-wrapped JSON.
- Replaced duplicate parsers in read, plan and manager paths with `parseMaicJsonResponse`.
- Added `parseManagerDecision` as the production validation seam for manager decisions.
- Added documented-only GPT-5.6 Sol/Terra/Luna and SearXNG capability notes; no live provider availability claim.
- Left MiroFish source unchanged because official upstream delta is zero.

## Phase 4: Review

### Findings and closure

- Initial quality review P1: reasoning closing tags inside prose-wrapped JSON strings could be mistaken for delimiters. Fixed with valid JSON-range filtering and a regression test.
- Initial test review P2: parser unit tests did not prove read/plan/manager integration or malformed-output fallbacks. Fixed with production-callsite integration tests and the manager validation seam.
- Quality re-review: `STATUS: PASS`, no remaining P0-P3.
- Test re-review: `STATUS: PASS`, no remaining P0-P3.
- Dirty-worktree audit: no reset, checkout, deletion or unrelated-file rewrite performed.

## Phase 5: Compound

- Solution: `docs/solutions/2026-07-14-mirofish-openmaic-latest-sync.md`.
- Architecture rule: MAIC structured model output uses one shared, reasoning-aware parser while preserving stage fallbacks and raw-response privacy.
- Solution index sync: skipped because `scripts/sync-solution-index.js` is absent.
- Knowledge output: 1 solution doc, 1 architecture rule, 1 completed sprint doc.

## Verification Results

- 60 related tests passed across parser, catalog, manager, read/plan integration, stage, prepare/cache, course store, PPTX, upload and classroom export suites.
- Combined `node --test <12 files>` hit the known Windows sandbox `spawn EPERM`; direct `node <file.test.mjs>` execution of all 12 files passed and is the authoritative result.
- `node_modules\\.bin\\tsc.CMD --noEmit --pretty false --incremental false` -> pass.
- Scoped ESLint on all changed TypeScript/test files -> pass.
- Scoped `git diff --check` -> pass; Windows LF-to-CRLF warnings only.
- Auto gates: 2; manual gates: 0.

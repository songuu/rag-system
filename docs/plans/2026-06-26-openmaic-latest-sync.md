---
title: "OpenMAIC latest sync 2026-06-26"
type: sprint
status: completed
created: "2026-06-26"
updated: "2026-06-26"
checkpoints: 0
tasks_total: 5
tasks_completed: 5
tags: [sprint, openmaic, maic, parity]
aliases: ["OpenMAIC latest sync 2026-06-26"]
upstream:
  openmaic: "https://github.com/THU-MAIC/OpenMAIC"
  previous_head: "ea049417cd2ce302f6b0602f8ec6284c9bdd994e"
  latest_head: "a88ee3d"
  latest_release: "v0.2.2"
invariants:
  - "MAIC keeps Course -> Prepared -> Scene -> Action lightweight runtime; do not import full OpenMAIC editor/app."
  - "OpenMAIC provider/media/editor updates are recorded as capabilities unless this repo has a matching runtime boundary."
  - "Prepared cache key must change when prepare-generation model routing changes."
invariant_tests:
  - "node src/lib/model-catalog.test.mjs"
  - "node src/lib/maic/pipeline/stage-options.test.mjs"
  - "node src/lib/maic/pipeline/prepare-runner.test.mjs"
  - "node src/lib/maic/agents/manager-agent.test.mjs"
deferred:
  - item: "Full OpenMAIC editor agent / script timeline discussion authoring"
    deadline: "2026-08-01"
    reason: "Requires editor state model not present in this repo."
  - item: "Full PBL v2 backend/runtime API family"
    deadline: "2026-08-01"
    reason: "Upstream adds large app-specific runtime; this sprint maps only portable schema and classroom metadata."
  - item: "@openmaic/* SDK package migration"
    deadline: "2026-08-01"
    reason: "This repo already owns local MAIC types; package migration needs a separate dependency/runtime review."
---

# OpenMAIC latest sync 2026-06-26

## Phase 1: Think

用户要求：检查最新 OpenMAIC，直接接入它最新功能。

### 已验证事实

- GitHub API `releases/latest`: latest release is `v0.2.2`, published `2026-06-02`.
- GitHub API `commits?per_page=20`: current main HEAD is `a88ee3d`, message `feat(editor): add discussion authoring to the script timeline (#798)`, date `2026-06-26`.
- GitHub API compare `ea049417cd2ce302f6b0602f8ec6284c9bdd994e...a88ee3d`: upstream is ahead by 54 commits.

### Scope

- 接入本项目能闭环的 OpenMAIC latest 增量：
  - v0.2.2+ model capability notes: Claude Opus 4.8, MiniMax M3, Qwen3.7 Plus/Max, GLM-5.2, Kimi K2.7 Code, MiniMax web search.
  - Korean classroom language directive.
  - Per-stage LLM model routing for MAIC prepare stages.
  - Concise generated course title from prepared stage, without overwriting user-supplied titles.
  - PBL v2 portable metadata in local `CourseScene.pbl`, rendered in the existing classroom.

### Non-Scope

- 不全量迁入 upstream editor, app routes, docs site, ASR/TTS provider runtime, media export, or @openmaic package workspace.
- 不引入 new services or network runtime dependencies.

### Success

- 本地 MAIC runtime can expose OpenMAIC latest-compatible metadata without breaking old prepared artifacts.
- Targeted regression tests pass.
- Defer/skip decisions remain documented and traceable.

### Risks

- Upstream PBL v2 is a large runtime; this repo can only adopt the portable schema/classroom-facing subset now.
- Existing worktree has many unrelated dirty files; edits must stay scoped.

## Phase 2: Plan

### 入场扫描 - Invariants 继承

| 子系统 | 上 sprint invariant | 本 sprint 如何保持 |
|--------|---------------------|--------------------|
| MAIC runtime | Course -> Prepared -> Scene -> Action 轻量边界 | 只扩展本地 types/scene metadata，不搬 full editor/runtime |
| Model catalog | 上游 capability 必须有测试锚点 | 每个新增 model/provider capability 增加 test |
| Prepared cache | cache identity 包含模型签名 | per-stage model routes 纳入 cache identity |

### 入场扫描 - 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|--------|----------|--------|--------|------------|
| Per-stage model route | prepare course | env `MAIC_MODEL_ROUTES` -> createLLM | cache key model_signature | cache readback 区分 route |
| Generated course title | prepare done | stage title -> store.setCoursePrepared | in-memory Course | course card/API 可见 |
| PBL v2 metadata | buildCourseStage | CourseScene.pbl.v2 | prepared artifact cache | classroom PBL scene 可见 |
| ko-KR language | prepare generation | buildLanguageDirective | prepared generated content | generated classroom content language |

### 入场扫描 - 债务清单

| 来源 sprint | 议题 | 本 sprint 决策 | deadline |
|-------------|------|----------------|----------|
| 2026-06-01 OpenMAIC latest sync | Editor/resource pack/ASR runtime | 继续 defer，新增最新 commit 归类 | 2026-08-01 |
| 2026-05-25 parity v2 | Provider/media/search capability | catalog 记录，runtime 不接入 | 2026-08-01 |

### Upstream decision matrix

| Upstream area | Evidence | Decision | Local landing |
|---------------|----------|----------|---------------|
| PBL v2 core/runtime | `09863af`, `0f44e9a`, `8f77d61`, `5226f95` | partial adopt | Portable PBL v2 scene metadata + classroom display |
| Per-stage model routing | `25cf58d` | adopt | MAIC prepare route resolver + cache identity |
| Course title inference | `267965d` | adopt | generated title from stage/tree when no user title |
| Korean locale | `85395c0` | partial adopt | `ko-KR` generation directive |
| Model registry updates | `adf3ba9`, `2165e55`, `6dd9390`, `42ca140` | partial adopt | `OPENMAIC_LATEST_MODEL_NOTES` |
| Single teacher voice / answer student first | `893f080`, `612a147` | already/maintain | tests keep manager attribution and prompt invariant |
| Editor/discussion timeline | `1d1ce80`, `a88ee3d` | defer | no local editor runtime |
| @openmaic packages | `7cb1291`, `b1e5bee` | defer | no package migration this sprint |

### Tasks

- [x] T1: Update model catalog and tests for latest upstream capability notes.
- [x] T2: Add Korean directive and generated-title helper/tests.
- [x] T3: Add MAIC per-stage model route resolver and cache identity coverage.
- [x] T4: Add PBL v2 portable schema metadata and render it in classroom.
- [x] T5: Run targeted tests and document review/compound.

### Test strategy

Risk: L2/L3. Core prepare pipeline cache and classroom scene data are touched, but no persistence migration or destructive runtime changes.

Run:

- `node src/lib/model-catalog.test.mjs`
- `node src/lib/maic/pipeline/stage-options.test.mjs`
- `node src/lib/maic/pipeline/prepare-runner.test.mjs`
- `node src/lib/maic/agents/manager-agent.test.mjs`


## Phase 3: Work

### Implemented

- `src/lib/model-catalog.ts`: added OpenMAIC v0.2.2+ model/search notes and reasoning categorization patterns.
- `src/lib/maic/model-routes.ts`: added MAIC prepare stage route parsing for `MAIC_MODEL_ROUTES` / `MODEL_ROUTES`.
- `src/lib/model-config.ts`: allowed `createLLM()` to honor `options.provider` for stage route provider overrides.
- `src/lib/maic/prepare-cache.ts`: included stage route snapshot in prepared cache identity only when configured.
- `src/lib/maic/pipeline/prepare-runner.ts`: routed describe/script/tree/questions/focus through stage-specific LLMs.
- `src/lib/maic/pipeline/read-stage.ts`: added `ko-KR` language directive.
- `src/lib/maic/pipeline/plan-stage.ts`: added concise title inference and portable PBL v2 metadata.
- `src/lib/maic/course-store.ts` + upload route: generated titles update filename-derived courses but preserve user titles.
- `src/components/maic/OpenMaicClassroom.tsx`: displayed PBL v2 task chain and rubric in the existing PBL scene.

## Phase 4: Review

### Findings

- P0: none.
- P1: none in this sprint's changed logic.
- P2: `OpenMaicClassroom.tsx` still has pre-existing React Hooks lint errors around refs and setState-in-effect. This sprint touched the file for PBL display, but the lint findings are outside the changed lines.

### Integration continuity

- `Course -> Prepared -> Scene -> Action` boundary preserved.
- Full upstream editor/PBL runtime/packages remain deferred with deadlines in frontmatter.
- Prepared cache now changes when model routes change, avoiding stale stage-specific artifacts.

## Phase 5: Compound

- Solution: `docs/solutions/2026-06-26-openmaic-latest-sync.md`.
- Solution index sync: skipped because `scripts/sync-solution-index.js` is absent in this repo.
- Knowledge: 1 solution doc, 1 sprint doc, 0 rules files modified by this sprint.

## Verification Results

- `node src/lib/model-catalog.test.mjs` -> pass, 9 tests.
- `node src/lib/maic/pipeline/stage-options.test.mjs` -> pass, 8 tests.
- `node src/lib/maic/prepare-cache.test.mjs` -> pass, 5 tests.
- `node src/lib/maic/pipeline/prepare-runner.test.mjs` -> pass, 2 tests.
- `node src/lib/maic/course-store.test.mjs` -> pass, 3 tests.
- `node src/lib/maic/agents/manager-agent.test.mjs` -> pass, 2 tests.
- `C:\project\my\rag-system\node_modules\.bin\tsc.CMD --noEmit --pretty false --incremental false` -> pass.
- Scoped ESLint excluding `OpenMaicClassroom.tsx` -> pass.
- Scoped ESLint including `OpenMaicClassroom.tsx` -> fail on pre-existing React Hooks rules at lines 144, 145, 219, 231, 263, 268, 302.
- `git diff --check` on touched files -> pass; CRLF warnings only.
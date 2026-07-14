---
title: "OpenMAIC latest sync with local MAIC runtime boundaries"
date: 2026-06-26
tags: [solution, openmaic, maic, parity, model-routing, pbl]
related_instincts: []
aliases: ["OpenMAIC latest sync 2026-06-26"]
---

# OpenMAIC latest sync with local MAIC runtime boundaries

## Problem

OpenMAIC latest main moved from the previous tracked `ea049417cd2ce302f6b0602f8ec6284c9bdd994e` to `a88ee3d`, with release `v0.2.2` and 54 commits ahead. The user wanted the latest functionality connected directly.

## Root Cause

The upstream OpenMAIC app now contains large editor, PBL v2 runtime, SDK workspace, ASR/TTS, media, and docs-site systems. This repo has a lighter MAIC runtime shaped as `Course -> Prepared -> Scene -> Action`, so full upstream migration would create dead code and dependency churn.

## Solution

- Added latest OpenMAIC model/search capability notes for Claude Opus 4.8, MiniMax M3/search, Qwen3.7, GLM-5.2, and Kimi K2.7 Code in `src/lib/model-catalog.ts`.
- Added MAIC prepare per-stage model routing via `MAIC_MODEL_ROUTES` / `MODEL_ROUTES`, with stage keys such as `describe`, `script`, `tree`, `questions`, `focus`, and `maic:<stage>`.
- Included stage model routes in MAIC prepared cache identity so route changes do not reuse stale generated artifacts.
- Added Korean generation directive and concise generated course titles while preserving user-supplied upload titles.
- Mapped upstream PBL v2 into portable local scene metadata (`tasks`, `instructor`, `simulator`, `evaluation`) and rendered it in the existing classroom PBL scene.

## Verification

- `node src/lib/model-catalog.test.mjs` passed.
- `node src/lib/maic/pipeline/stage-options.test.mjs` passed.
- `node src/lib/maic/prepare-cache.test.mjs` passed.
- `node src/lib/maic/pipeline/prepare-runner.test.mjs` passed.
- `node src/lib/maic/course-store.test.mjs` passed.
- `node src/lib/maic/agents/manager-agent.test.mjs` passed before final doc updates.
- `C:\project\my\rag-system\node_modules\.bin\tsc.CMD --noEmit --pretty false --incremental false` passed.
- Scoped ESLint passed for all touched files except `OpenMaicClassroom.tsx`; that file is blocked by pre-existing React Hooks lint issues on refs/setState-in-effect outside this sprint's changed lines.

## Prevention

- Treat fast-moving upstream commits as a decision matrix: `adopt`, `partial adopt`, `defer`, or `skip`.
- Never treat "upstream added a system" as "local repo should import the whole system"; map it first to a local runtime boundary.
- Cache identities must include any generation-affecting model route configuration.

## Related

- [[2026-06-26-openmaic-latest-sync]]
- [[2026-06-01-mirofish-openmaic-latest-sync]]
- [[2026-05-25-mirofish-openmaic-latest-parity-v2]]

---
title: "MiroFish and OpenMAIC latest sync with reasoning-safe JSON"
date: 2026-07-14
updated: 2026-08-11
tags: [solution, mirofish, openmaic, maic, structured-output, upstream-sync, cache-identity]
related_instincts: []
aliases: ["MiroFish and OpenMAIC latest sync 2026-07-14", "MiroFish and OpenMAIC latest sync 2026-08-11"]
---

# MiroFish and OpenMAIC latest sync with reasoning-safe JSON

## Problem

Official MiroFish had no delta from the project's tracked `96096ea` anchor, while OpenMAIC moved 72 commits from `a88ee3d` to `40ff80a` after release `v0.3.0`. The local MAIC read, plan and manager paths each had a separate regex-based JSON parser. Reasoning-model output containing `<think>`, `<thinking>` or `<reasoning>` blocks could therefore trigger false fallbacks or select a draft JSON payload.

## Upstream classification

- Adopted: OpenMAIC [`fabd7b6`](https://github.com/THU-MAIC/OpenMAIC/commit/fabd7b65f534383be8f2b6ef87b621c5a7778e79) reasoning-block JSON cleanup, mapped to one local parser.
- Partially adopted: [`c8a638a`](https://github.com/THU-MAIC/OpenMAIC/commit/c8a638a1010ab424edef7309042bf87d88cc20d8) GPT-5.6 Sol/Terra/Luna and [`c569295`](https://github.com/THU-MAIC/OpenMAIC/commit/c56929510ceba5122572da7916ba3174177649ed) SearXNG as documented capability metadata only.
- Already covered: multi-format file acceptance and Azure OpenAI provider boundary.
- Deferred: application-level retry, multi-document bundle, DSL SDK/migrations, editor/storage/runtime, quiz formula rendering and action-level navigation. Each crosses a local runtime/data/UI boundary and has a `2026-09-01` review deadline in the sprint doc.
- No-op: MiroFish main/release remained unchanged, so no source churn was justified.

## Solution

- Added `parseMaicJsonResponse` with exact-JSON-first semantics.
- Used only reasoning closing tags outside valid JSON ranges as draft/final delimiters.
- Supported fenced output and balanced object/array extraction while respecting strings, escapes and nesting.
- Preserved literal reasoning tags inside JSON strings, including JSON surrounded by prose.
- Reused the parser in read, plan and manager paths; removed three duplicate parsers.
- Added `parseManagerDecision` as a small validation seam used by production manager code and tests.
- Recorded GPT-5.6 Sol/Terra/Luna and SearXNG with `status: documented`; no provider/runtime availability claim.

## Review fixes

- P1 fixed: prose-wrapped valid JSON containing literal `</think>` previously risked returning a nested object instead of the outer payload.
- P2 fixed: integration tests now exercise all read/plan parsing callsites, malformed-output fallbacks and the manager production validation seam.
- Independent quality and test re-reviews both passed with no remaining P0-P3.

## Verification

- 60 related Node tests passed.
- The combined Node test runner hit the environment's known `spawn EPERM`; all 12 files passed when executed directly with `node <file.test.mjs>`.
- Direct TypeScript `--noEmit --incremental false` passed.
- Scoped ESLint passed.
- Scoped `git diff --check` passed; CRLF warnings only.

## Prevention

- Keep structured model-output cleanup in one shared parser.
- Attempt exact JSON before interpreting reasoning tags so legal string content is never rewritten.
- Treat a reasoning closing tag as a delimiter only when it is outside a valid JSON range.
- Every parser integration must test both reasoning-prefixed success and malformed-output fallback.
- Track upstream providers as `documented` until the local runtime boundary and real credentials prove execution.

## Related

- [[2026-07-14-mirofish-openmaic-latest-sync]]
- [[2026-06-26-openmaic-latest-sync]]
- [[2026-06-01-mirofish-openmaic-latest-sync]]

## 2026-08-11 refresh

### Problem

MiroFish `main` advanced from the tracked `96096ea` anchor to `b5b53acc`, while OpenMAIC advanced beyond `v0.3.1` to `c38da84`. The portable deltas exposed local gaps rather than a reason to import either upstream application wholesale:

- MiroFish ontology generation only retained the first 50,000 UTF-16 code units, and several consumers still used greedy object extraction or raw-response fallbacks.
- Profile output accepted unbounded structured values and dynamic viewpoint keys; a topic named `__proto__` was silently lost by ordinary object assignment.
- Ontology/profile cache keys described inputs and models but not the generation algorithm, so semantic upgrades could reuse stale artifacts.
- OpenMAIC model notes mixed documented capabilities with runtime availability, while heuristic category tests did not prove every embedding marker took precedence over reasoning names.
- The prepare concurrency regression copied the Promise graph into the test instead of calling the production orchestration seam.

### Root Cause

Model-output parsing, semantic validation, cache identity and capability metadata had evolved independently. Syntax-valid JSON was treated as sufficient even when its schema was unsafe; generator behavior was not versioned independently from provider configuration; and tests sometimes reproduced intended logic instead of exercising the code path that production actually called.

### Solution

- Added a MiroFish-only strict object parser: exact object, one JSON fence, or one leading reasoning wrapper are accepted; arrays, primitives, multiple documents and truncation fail with a fixed redacted error. The existing MAIC parser remains permissive where top-level arrays and later balanced payloads are part of its contract.
- Replaced ontology prefix truncation with deterministic head/middle/tail sampling inside the same 50,000 code-unit budget. Shared UTF-16 helpers avoid creating lone surrogates at slice boundaries.
- Limited string-attribute compatibility to the LLM ontology seam. HTTP, graph and artifact boundaries remain strict.
- Added bounded semantic coercion for profile scalar/list/viewpoint fields, recursion and item limits, surrogate-safe topic-key truncation, stable collision suffixes, and own data-property writes for special keys.
- Required interaction, simulation and report consumers to validate semantic schemas before success. Parse/schema failures use fixed safe fallbacks and never retain raw model output.
- Added `ontology-generation-v2` and `profile-generation-v2` to model cache signatures. Old records miss naturally; graph cache identity remains unchanged and no cache files are deleted.
- Recorded OpenMAIC #993 models as `documented` unless an exact provider/model runtime allowlist proves support. Capability profiles expose status, reasoning notes require thinking metadata, and embedding markers take category precedence.
- Extracted `runPrepareDependencyGraph` and made both production and tests call that seam; tests assert dependency windows rather than a flaky wall-clock threshold.

### Prevention

- Validate both JSON envelope and domain schema before normalization or success-state construction.
- Never include raw model output in parser errors, causes or safety fallbacks.
- Put an explicit algorithm revision in cache identity whenever parsing, sampling or coercion changes artifact semantics.
- Store untrusted dynamic keys as own data properties; test `__proto__`, truncation collisions and JSON round trips.
- Category-precedence tests must cover every configured marker against conflicting model families and include a mutation guard for tempting shortcuts.
- Concurrency tests must call the production orchestration seam instead of copying its Promise graph.
- Keep new upstream models `documented` until the local adapter and real credentials pass a smoke test.

### Verification

- Fourteen focused files: 105/105 tests passed.
- Repository `test:model-runtime`: 21/21 passed.
- Full TypeScript `--noEmit --incremental false`, scoped ESLint, and tracked/untracked whitespace checks passed.
- Production build passed; postbuild and an independent trace check reported `ask=1251`, `pipeline=472`, `mirofish-graph=175`, `standaloneRaw=0`.
- Five review rounds ended with independent P0-P3 no-findings acceptance. Build-generated `next-env.d.ts` was restored to the same HEAD/index/worktree blob.

### Known boundaries

- Both tracked `main` SHAs are unreleased snapshots and may continue to move.
- Catalog entries marked `documented` were not live-tested with provider credentials.
- Existing old cache files remain on disk but cannot hit revised ontology/profile identities.
- UTF-16 helpers prevent new boundary splits; they do not sanitize malformed lone surrogates already present in input.

### Related evidence

- [[2026-05-14-mirofish-openmaic-cache-optimization]]
- [[2026-08-11-mirofish-openmaic-upstream-refresh]]

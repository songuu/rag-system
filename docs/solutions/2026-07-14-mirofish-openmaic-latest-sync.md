---
title: "MiroFish and OpenMAIC latest sync with reasoning-safe JSON"
date: 2026-07-14
tags: [solution, mirofish, openmaic, maic, structured-output, upstream-sync]
related_instincts: []
aliases: ["MiroFish and OpenMAIC latest sync 2026-07-14"]
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

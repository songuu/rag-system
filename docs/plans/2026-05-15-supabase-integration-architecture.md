---
title: "Supabase Integration Architecture"
type: sprint
status: completed
created: "2026-05-15"
updated: "2026-05-15"
checkpoints: 1
tasks_total: 5
tasks_completed: 5
tags: [sprint, architecture, supabase, rag, persistence]
aliases: ["Supabase 接入架构"]
---

# Supabase Integration Architecture - 2026-05-15

## Goal

统计当前 RAG 系统后续最值得接入 Supabase 的位置，并给出可落地、兼容现有 Milvus / LangChain / LangGraph / MiroFish / OpenMAIC 的完整架构方案。

## Scope

- 盘点当前项目中值得外置到 Supabase 的数据、文件、状态、实时事件和审计面。
- 保留现有 Next.js BFF、RAG Kernel、Milvus/Zilliz 向量热路径。
- 给出 Supabase Auth/RLS、Postgres、Storage、Realtime、Edge Functions、Cron/Queue、pgvector 的分层接入方案。
- 输出可分阶段迁移路线，避免一次性重写。

## Non-Scope

- 本轮不接入真实 Supabase 项目，不新增 `@supabase/supabase-js` 依赖。
- 本轮不改现有 API 行为，不迁移本地 `uploads/`、IndexedDB、Map store 或 Milvus 数据。
- 本轮不替换 Milvus 为 pgvector；只定义可选 Supabase vector lane。

## Current Findings

| Area | Current State | Supabase Fit | Priority |
| --- | --- | --- | --- |
| Auth / tenant / user ownership | API 已有 `userId` / `sessionId` 字段，但多为 demo 值或自由传参 | Supabase Auth + RLS + tenant/team schema | P0 |
| File upload corpus | `uploads/`, `reasoning-uploads/`, MAIC mirror files and JSON manifest | Supabase Storage + Postgres `document_assets` | P0 |
| Corpus/index lifecycle | `MemoryCorpusStore`, local manifests, Milvus collection state | Postgres source-of-truth manifest + index jobs | P0 |
| Observability | `ObservabilityEngine` uses in-memory maps | Postgres traces/observations/scores + Realtime updates | P0 |
| Conversations/history | Browser IndexedDB only | Postgres conversations/messages with local IndexedDB cache | P1 |
| MiroFish projects | singleton `Map` store | Postgres projects, graph nodes/edges, runs, reports | P1 |
| MAIC courses/sessions | singleton `Map` store + localStorage quiz answers | Postgres courses/sessions/utterances + Storage assets | P1 |
| Vector search | Milvus/Zilliz adapter already optimized | Keep Milvus primary; optional pgvector lane for small/metadata-heavy retrieval | P1 |
| Long jobs | synchronous route handlers and local file scans | Edge Functions for short orchestration; Cron/Queue for async embedding/index jobs | P1 |
| Collaboration/status | SSE per route; no shared presence/job status | Realtime Broadcast/Presence/Postgres Changes | P2 |
| Eval and analytics | scattered traces and golden questions | Postgres eval runs, query metrics, feedback, dashboards | P2 |

## Architecture Decision

Supabase should become the **persistence, identity, access-control, file, job, and realtime coordination plane**. It should not replace the existing RAG runtime, Milvus hot-path vector search, or LangGraph-style workflow state machines in the first migration.

The target architecture is:

```text
Browser
  -> Supabase Auth session / Realtime subscriptions
  -> Next.js App Router UI

Next.js BFF
  -> Supabase server client for user-scoped reads/writes
  -> Supabase admin client only for trusted jobs and ingestion
  -> RAG Kernel policies
  -> Milvus/Zilliz dense vector search
  -> Optional Supabase pgvector lane

Supabase
  -> Postgres: metadata, manifests, jobs, traces, conversations, product state
  -> Storage: raw uploads, parsed text, MAIC slides, report artifacts
  -> Realtime: job progress, trace updates, classroom/project collaboration
  -> Edge Functions/Cron/Queue: async ingestion, reindex, cleanup, webhook entry
```

## Task Breakdown

- [x] T1 Inspect current API/lib storage boundaries.
- [x] T2 Verify current Supabase official capabilities.
- [x] T3 Build integration-point inventory.
- [x] T4 Write complete target architecture and phased migration plan.
- [x] T5 Record project architecture rule.

## Review

### P0 Risks Addressed In The Plan

- Avoided replacing Milvus prematurely. The current Milvus adapter and recent query-speed work remain the vector hot path.
- Kept service role key out of browser-facing code by requiring separate browser/server/admin clients.
- Made RLS and tenant ownership a first-class schema rule instead of a later security patch.
- Mapped local volatile stores before proposing migration, so MiroFish/MAIC state is not lost during restarts.

### P1 / P2 Follow-Ups

- Before implementation, generate Supabase migrations and typed database contracts.
- Add adapter tests around `CorpusStore`, `TraceSink`, and `BlobStore` before switching runtime code.
- Decide whether pgvector is only an auxiliary lane or also a dev/local fallback.

## Implementation Pass 1

本轮已按计划完成第一阶段代码落地，范围保持为 **Supabase persistence/control-plane scaffold + local-compatible adapter migration**，没有引入 `@supabase/supabase-js` 依赖，也没有把 Milvus 热路径替换为 pgvector。

已落地内容：

- Supabase 环境配置、REST/Admin/Server/Browser client scaffold：`src/lib/supabase/*`
- Supabase Postgres/Storage/RLS 初始 migration：`supabase/migrations/202605150001_core_persistence.sql`
- 持久化端口：`BlobStore`、`UploadManifestStore`、`TraceStore`、`IndexJobStore`
- Local/Supabase/Dual-write 上传与文件 manifest store
- Supabase trace mirror 和 feedback persistence
- `/api/upload`、`/api/files`、`/api/files/[filename]`、`/api/traces*` 路由迁移到 persistence ports
- `LocalRAGSystem` trace update hook 接入 Supabase mirror

运行时开关：

- `RAG_PERSISTENCE_BACKEND=local | supabase | dual-write`
- `RAG_VECTOR_BACKEND=milvus | zilliz | supabase_pgvector | hybrid`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_DEFAULT_TENANT_ID`
- `SUPABASE_DEFAULT_CORPUS_ID`
- `SUPABASE_STORAGE_RAW_BUCKET`
- `SUPABASE_STORAGE_PARSED_BUCKET`
- `SUPABASE_REALTIME_ENABLED`

## Validation

Architecture validation performed:

- Read project route/lib surfaces with `rg --files` and targeted `Get-Content`.
- Verified dirty worktree and avoided unrelated code changes.
- Checked current Supabase capabilities against official docs on 2026-05-15.

Implementation validation performed:

- `npx tsc --noEmit --pretty false --incremental false`
- `npx eslint --no-error-on-unmatched-pattern ...` scoped to Supabase/persistence/routes/RAG touched files
- `node --test src\lib\persistence\upload-store.test.mjs`
- `git diff --check`

## Deliverables

- Solution: `docs/solutions/2026-05-15-supabase-integration-architecture.md`
- Rule: `.codex/rules/architecture.md`

## Compound

经验沉淀：

- Supabase 接入应先做 identity/persistence/control-plane，再做 vector lane。
- 对当前项目，Milvus 仍是 production vector hot path；Supabase pgvector 更适合 metadata-rich、small/medium、eval、entity/cache 辅助检索。
- Realtime 适合 job/progress/presence，不应替代 LLM token streaming 的现有 SSE 热路径。

---
title: "PostgreSQL 发布指针到 Neo4j 检索状态的 Outbox 投影"
type: solution
status: accepted
date: "2026-09-08"
created: "2026-09-08"
updated: "2026-09-08"
source_plan: "docs/plans/2026-09-07-neo4j-knowledge-graph-integration.md"
tags: [solution, neo4j, postgres, outbox, knowledge-graph, rag, idempotency]
related_instincts: []
aliases: ["Neo4j publication projection", "Graph snapshot activation outbox"]
---

# PostgreSQL 发布指针到 Neo4j 检索状态的 Outbox 投影

## Problem

知识图谱发布 API 已成功把 PostgreSQL Active Pointer 推进到新 revision，但 Ask 图检索持续返回
`no_gain`。管理查询可以看到实体、社区和路径，因此问题很容易被误判为检索算法或模型质量问题。

## Root Cause

PostgreSQL 是发布控制面的权威数据源，激活事务只更新 PostgreSQL Pointer 并写入 Outbox。旧 Worker
把 Outbox 当作外部 Webhook 队列，成功后直接 ack，没有把同一 revision 投影到 Neo4j。
Neo4j 中 `GraphSnapshot.status` 因而永久停在 `staging`，而 RAG 检索按契约只接受
`active`/`superseded` 且未过期的快照。公开管理查询不依赖该状态，造成两个读面不一致。

## Solution

1. 将发布 Outbox 的本地 Neo4j 投影设为必需处理步骤，外部 Webhook 只作为可选的后续转发：
   `claim → Neo4j projection → optional webhook → PostgreSQL ack`。
2. 投影严格应用事件 revision：只有 Neo4j 当前 revision 等于 `event.revision - 1` 才执行 CAS；
   相同 revision 和 graphVersion 的重放直接 no-op；同 revision 不同图、跳号或 scope 漂移均
   fail-closed 并进入 Outbox 重试/死信流程。
3. 激活前从同 tenant/corpus 的 Neo4j compatibility descriptor 恢复唯一文档 trust scope，拒绝
   quarantined 快照，并让 Neo4j CAS 再次校验快照存在、未过期和 trust 闭合。停用事件使用同一
   revision 规则把指针置空。
4. 无外部发布 Webhook 时仍消费 Outbox 并完成本地投影；Webhook 失败时不 ack，重试先命中本地
   幂等 no-op，再用稳定 event id 继续外部投递。
5. 用 Worker 顺序测试、投影器幂等/冲突测试以及真实双数据库集成用例覆盖从 runtime 激活、
   Outbox、Neo4j Pointer/Status 到 RAG Evidence 的完整边界。

## Prevention

- 跨数据库发布评审必须分别证明“权威指针已提交”和“每个读模型已投影”，不能用 Webhook 发送成功
  代替本地读模型可见性。
- Outbox ack 前的所有副作用必须可用稳定 event id 或 revision 幂等重放；测试至少覆盖“副作用成功、
  Webhook 或 ack 失败”的窗口。
- 管理查询与 RAG 查询若使用不同可见性条件，必须增加从正式发布 API 到真实读路径的端到端测试。
- 同 scope 事件保持 revision 单调；双 Worker claim 必须让未发布的较低 revision 阻塞较高 revision。
- Neo4j 从旧备份恢复造成 revision 落后时保持 fail-closed。自动重对齐需要独立、审计化的恢复设计，
  不应通过放宽 `staging` 检索过滤来掩盖。

## Related

- [[2026-09-07-neo4j-knowledge-graph-integration]] — 完整接入计划与验收记录
- [Neo4j 知识图谱运行手册](../runbooks/neo4j-local.md)


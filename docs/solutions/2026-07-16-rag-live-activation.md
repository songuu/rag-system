---
title: "RAG E3-E7 生产激活与有界恢复闭环"
type: solution
status: accepted
date: "2026-07-16"
created: "2026-07-16"
updated: "2026-07-16"
source_plan: "docs/plans/2026-07-16-rag-live-activation.md"
tags: [solution, rag, production-activation, recovery, graphrag, multimodal, durable-workflow]
related_instincts: []
aliases: ["RAG live activation closure", "E3-E7 production wiring"]
---

# RAG E3-E7 生产激活与有界恢复闭环

## Problem

E2b-E7 的纯合同和 library seam 已存在，但 E3、E5、E6、E7 仍有真实 caller、持久化生命周期或生产回退缺口；仅凭 hermetic 测试会把“可注入”误报为“可运行”。

## Root Cause

- 能力开关、provider capability 与路由选择分散，缺少 caller + gate + fallback 的完整闭环。
- Graph、PDF 与 durable 本地文件存储同时维护 root/scope 配额、事务 journal、TTL/GC 与删除回收；若创建和回收没有显式生命周期，相邻中断窗口会遗留悬空指针或永久占用 scope 配额。
- provider timeout 只结束请求，不一定结束底层工作；若提前释放 admission，会放大非协作 provider。
- 动态 artifact 根路径若直接包在 `path.resolve(env || process.cwd())` 中，Turbopack 会把源码树误纳入 standalone 文件追踪。

## Solution

1. 把 E3 hybrid/contextual、E4 ordered/abstention、E5 Graph、E6 PDF visual、E7 durable 接到真实 `/api/ask`、Graph API 或 document pipeline；所有生成可见能力都由服务端 `off | shadow | active` gate 控制，并保留 dense/text/sync 回退。
2. ordered 与 hybrid provider 使用请求内 deadline、稳定 provider/collection admission key，并在非协作工作真实 settle 前保持占位；外部取消保持独立取消语义。
3. Graph/PDF/result/checkpoint 存储使用 immutable publication、root/scope ledger、持久 reservation、CAS pointer、tombstone、TTL 和有界 GC。PDF scope 增加 `creating -> active -> reclaiming` 生命周期；恢复只有在持久 bundle 状态证明最终没有 live asset 时，才允许清除缺失 scope 的 root-settled journal。
4. durable checkpoint/result 绑定 generation、tenant/corpus/document/version/trust 与 HMAC integrity；取消、lease recovery 和旧 generation 清理都由 revision/generation fence 限制。
5. runtime artifact 根路径把默认值静态限定到 `uploads`；对动态 file-store 路由配置 extension-scoped `outputFileTracingExcludes`，再以 postbuild NFT 与 standalone 实体目录双重守卫证明产物不包含相邻的 JS/TS raw source/test 文件。
6. 用 route-level 合同、故障阶段组合回归、L4 security/kernel/contracts、默认全量测试、TypeScript、scoped lint、无警告 production build 和三套 Compose config 验证。

## Prevention

- 评审新能力时逐项证明 caller、服务端 gate、fallback、默认关闭、配置文档和默认测试链收录。
- 文件事务测试不能只覆盖单一 journal 状态；必须组合创建/提交/删除、scope reclaim、root rebuild、live-bundle guard 与下一新 scope 的容量恢复。
- timeout/cancel 测试保留未 settle promise，确认 admission 直到真实完成才释放。
- standalone 不能只看 build 日志；必须读取 route NFT，拒绝动态文件存储误收集的 raw source/test。
- 每次最后一处源码修改后重跑最终门禁；仓库基线 lint 债务与本轮 scoped lint 分开记录。
- 代码完成不等于生产切流；真实 Milvus/Zilliz backfill、vision quality、共享 provider、多主机 failover 与 canary 保留为外部证据。

## Related

- [[2026-07-16-rag-live-activation]] — 生产激活 sprint 与验证记录
- [[2026-07-15-rag-trends-next-options]] — E2b-E7 控制面决策
- [[session-2026-07-16]] — 本轮实现与复审

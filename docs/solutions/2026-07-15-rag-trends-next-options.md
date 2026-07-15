---
title: "RAG 演进采用 Evaluation-Gated Control Plane"
type: solution
status: accepted
date: "2026-07-15"
created: "2026-07-15"
updated: "2026-07-15"
source_plan: "docs/plans/2026-07-15-rag-trends-next-options.md"
tags: [rag, evaluation, security, hybrid-search, control-plane, graphrag, multimodal]
related_instincts: []
aliases: ["RAG evaluation-gated control plane", "RAG Wave 1 E2a E1b"]
---

# RAG 演进采用 Evaluation-Gated Control Plane

## 问题

项目已经同时存在 dense Milvus、Agentic/Self-Corrective/Reasoning、实体图、Contextual Retrieval、rerank provider、LangSmith trace 与 `RagKernel`。继续增加模式会扩大分支和维护面，却不能回答“哪个检索结果更好、引用是否正确、是否跨租户、失败能否回退、成本是否值得”。

本方案制定时最关键的断点是：`RetrievalPlan` 尚不驱动执行，canonical evidence/eval
未进入生产路径，hybrid policy 仍是 stub，安全/租户边界未成为检索硬约束。Wave 0/1
已关闭其中 E0、E1a、E2a、E1b；E2b 与 E3-E7 仍按本方案继续。

## 决策

把未来 RAG 能力统一收敛到一个 evaluation-gated control plane：

1. 请求先经过认证身份派生的 tenant/corpus/ACL/trust gate。
2. `RagKernel` 的 planner 只选择已注册、可用且经过评测的 retrieval lane。
3. dense、BM25、graph、visual、ordered long-context 等 lane 输出同一 evidence/trace 合同。
4. fusion、rerank、context composer、generate/abstain 消费 canonical evidence。
5. offline/online eval 消费同一个 answer envelope；新能力按 shadow → opt-in → limited rollout → default 演进。

安全校验 fail closed。`quarantined` evidence 只进入审计/eval，不进入 fusion、context 或 generation。只有 capability、质量、延迟或成本类 lane 失败，才可回退到继承相同 tenant/corpus/ACL filter 的 dense 2-step。

## 采用顺序

### Wave 0：先建立可比较与可信边界

- E0：认证身份、tenant/corpus/ACL、SSRF、输入限额、retrieved-content trust boundary。
- E1a：固定 fixture corpus、dense baseline adapter、答案/检索/成本基础指标。

### Wave 1：让控制面真实执行

- E2：先修失败 envelope 与非 2xx 状态保真；给 legacy policy 加 evidence adapter。
- 只迁移 `milvus-2step` 到 planner/lane executor，再逐个迁移 agentic、adaptive、memory；每步做旧新 parity。
- 同步建立显式 state/transition/budget/stop reason，并前移 answer/context cache identity。
- E1b：补 citation span、跨 policy、abstain、安全与租户 hard gate。

### Wave 2：近期最明确的检索增量

- E3：Milvus/Zilliz capability probe 后，在 shadow collection 实现 corpus-level BM25 + dense + RRF/weighted fusion。
- 不把 dense 候选内 BM25 rerank 冒充全库 hybrid；不原地升级生产集合。
- E4：token/structure-aware context、ordered-section baseline、abstain 与可解释规则 router。

### Wave 3：只在匹配题型上试点

- E5：MiroFish GraphRAG optional lane，只服务 global/multi-hop，保留 passage provenance 与 dense fallback。
- E6：通过 shared PDF adapter/manifest 建 text/page-image sidecar，只在 visual subset 证明价值。
- E7：只有出现跨重启、HITL、延迟审批等真实生命周期时，才试点 LangGraph checkpoint 或 AI SDK durable adapter。

## 不采用

- 不用全量 GraphRAG 替换普通 RAG。
- 不在没有 trajectory/eval 时训练 RL agentic retriever。
- 不引入 LlamaIndex Python 作为第二编排主栈。
- 不因 LangGraph、Milvus、GraphRAG 或 AI SDK 发布新版本就直接升级。
- 不为每项新能力新增顶层 `/api/ask` 分支或重写现有 UI/消息协议。

## 关键门槛

- 检索：Recall@K、MRR、nDCG、source/span coverage。
- 生成：correctness、groundedness、faithfulness、citation precision/coverage。
- 拒答：selective accuracy/coverage 与误拒率。
- 安全：跨租户命中为 0、poison attack success、敏感 source 泄漏、SSRF/越权回归。
- 运行：p50/p95、token、model/tool calls、provider cost、cache hit。

LLM judge 不是唯一 oracle；必须同时保留确定性指标、固定样本与人工抽检。

## 何时复用这个方案

当项目要新增或切换 retrieval lane、索引 schema、embedding、rerank/fusion、context prompt、router、GraphRAG 或 visual retrieval 时，先复用本方案。若只是修正无行为变化的 UI 文案，不需要引入完整 eval gate。

## 证据与未知

- 本地事实、外部趋势、版本快照、合同草案和完整来源见 [研究计划](../plans/2026-07-15-rag-trends-next-options.md)。
- 当前生产 Milvus/Zilliz plan、数据规模、真实查询分布、停机窗口和各 policy 基线仍未知；这些未知项决定后续实现排序，不由公开 benchmark 代替。
- 2026-07-15 独立审查已修正 security fallback、E1/E2 依赖环、cache 范围、Milvus 2.6.20 最新标签及研究成熟度表述。

## 2026-07-15 Wave 0 实施回写

当日上游复核：MiroFish 官方 `main` 仍为 `96096ea`、`v0.1.2`，相对昨日锚点无
delta；OpenMAIC 官方 `main` 从昨日 `40ff80a` 前进 8 commits 至 `0db93bd`，latest
release 仍为 `v0.3.0`。新增内容集中在 image storage、video export IR、PBL
RuntimeStore、audio/video extractor、AliDocMind 和 editor agent，均依赖本地不存在的
storage/editor/media runtime，未做伪兼容移植。完整 commit 级处理见
[研究计划](../plans/2026-07-15-rag-trends-next-options.md#mirofish--openmaic-当日增量快照)。

本轮已实施 Wave 0 的 canonical boundary 与 E1a，而不是把 MiroFish/OpenMAIC 上游整仓覆盖到
本地：

- `/api/ask`、`/api/pipeline`、`/api/milvus` 接入 request-scoped
  actor/tenant/corpus/role；客户端自报身份不参与授权。
- Supabase 模式使用用户 JWT + publishable key 验证 Auth、RLS 可见 corpus 与 membership，
  不回退 service role；single-tenant 模式使用固定 bearer token 与固定 scope。
- Milvus 新 collection 增加 tenant/corpus/document/trust 标量字段；强制隔离时旧 schema
  fail closed。检索 filter 与写入 metadata 均由服务端 scope 生成。
- URL ingestion 接入 DNS 全解析、私网/特殊地址拒绝、DNS pinning、逐跳 redirect 复验、
  timeout、MIME 与流式 byte cap；retrieved content 在生成 prompt 中按不可信数据处理。
- 输入体、文件、batch、模型、topK/threshold 等均有上限或 allowlist；客户端错误与日志经过
  稳定映射和凭据脱敏，公开 Milvus DTO 不包含 endpoint/token。
- legacy/实验型 RAG 路由在 production 或显式认证模式统一返回稳定 410，避免绕过 canonical
  scope 读写、清库或暴露连接配置；只有非 production 的 `local-dev` 可继续使用。
- DOCX/XLSX/PPTX 解析前执行共享 ZIP preflight，核对 central/local header、payload 边界、
  entry、压缩比、声明与实际解压大小；PPTX inflate 另设硬输出上限。分块限制 overlap 与
  总 chunk 数，embedding 改为有界批处理。
- E1a 新增固定中文 synthetic fixture、dataset hash、dense baseline、Recall/MRR/nDCG、
  fact coverage、abstain accuracy、fail-soft runner 与 JSON report CLI；target 合同不接收
  gold labels，避免评测适配器意外“看答案”。

验证证据：

- `pnpm test` 聚合回归 206/206 通过；完整变更文件 ESLint 与 TypeScript 通过。
- `pnpm build` 通过，Next.js 生产构建完成 88 个页面。
- E1a 12/12 case 完成、0 failed：Recall@5 1.0000、MRR@5 0.9500、
  nDCG@5 0.8618、fact coverage 0.9500、abstain accuracy 0.8333。

边界：

- E1a 是确定性 synthetic control，不等于真实 Milvus ANN、线上语料或 LLM answer quality。
- 当前未连接真实 Supabase/Milvus 做跨租户集成验证；上线前仍需 shadow collection 迁移、
  两租户负向测试与凭据注入验证。
- 第一方演示 UI 当前不持有生产 bearer/session，且首页默认 memory policy；因此认证模式下
  生产调用应由同源 BFF/session 或受信反向代理接入 canonical API，不能把共享 token 发到
  浏览器。legacy routes 已由应用层 410 守卫兜底，网关 allowlist 仍是纵深防御。
- safe URL 的外层 deadline 已 fail closed，但 Node 系统 DNS 查询本身缺少可取消句柄；高并发
  公网 ingestion 仍应在后续补主体限流、DNS 并发上限与负缓存。

最终独立复审曾发现 MAIC upload 的 PPTX/DOCX/XLSX 绕过 document-pipeline 的 ZIP
边界；现已把校验下沉到 shared document/PPTX parser，并用真实 deflate payload 覆盖高
压缩比与伪造解压大小回归。复审提出的 P1 已关闭。

## 2026-07-15 Wave 1 实施回写

### Problem

Wave 0 之后，Kernel 仍可能把 non-2xx 或显式 failed policy 标成 completed；plan、lane、
canonical evidence、cache identity 与 E1b hard gate 也没有形成同一条可执行链。

### Root Cause

- plan 原先在 policy 后才补建，无法成为执行控制面。
- legacy Milvus metadata 同时存在 camel/snake aliases，读取顺序可能让 JSON metadata
  覆盖权威 scalar provenance。
- lane budget 只在启动前检查，required-lane 错误又丢失 partial execution snapshot。
- eval target 虽不接收 gold，但 runner 信任其自报 provenance；hard gate 也未强制事实正确性。
- cache key 没有绑定最终 composed context，无法覆盖 source、score、内容与截断结果。

### Solution

- Kernel 在 policy 前生成 plan；合并 HTTP、typed execution state 与 thrown error；
  required-lane 失败 envelope 保留 evidence、lane execution、transition、budget、stop reason。
- `milvus-2step` 迁入 `RagLaneExecutor`，每 lane 有 deadline/AbortSignal；真实 handler
  在 connect/init/embed/search/stats 阶段后检查 abort。SDK 内部不可取消调用仍属于 soft
  cancellation 边界。
- Milvus direct scalar 同时覆盖 camel/snake aliases，adapter 采用 snake-first；
  canonical evidence 在 composer 前执行 tenant/corpus/trust fail-closed 校验。
- oversized first evidence 会有界截断且不切断 UTF-16 surrogate；无 evidence 时不调用 LLM，
  直接确定性拒答。
- answer/context cache identity 绑定 tenant/corpus/version/model/prompt/policy/fusion、
  有序 evidence/span，以及最终 composed-context SHA-256；SemanticCache 消费时重算 key。
- E1b V2 强制 answerable facts、gold spans、canonical corpus 对账；门禁覆盖 recall、facts、
  citation、span IoU、selective accuracy、abstain 与独立 tenant/corpus/trust/poison canary。
  adversarial target 故意忽略 scope 时会被 hard gate 拒绝。
- hermetic hash baseline 使用 1024 维，避免 canary 标识符与普通 corpus token 的确定性哈希
  碰撞把隔离探针误判为可回答；该路径由默认 E1b CLI hard gate 回归覆盖。

### Verification

- `pnpm test`：264/264 单元/合同测试通过；默认链包含 E1b 单目标和 matrix hard gate。
- E1b：单目标 8/8；matrix 两个 hermetic target 各 8/8；0 failed、0 security violation。
- Recall@5、MRR@5、nDCG@5、fact coverage、citation validity/precision/coverage 与
  abstain accuracy 均为 1.0000；citation span IoU 另有 `>= 0.30` 门槛。
- TypeScript、核心 backend/control-plane ESLint、`git diff --check` 与 88/88 页面
  production build 通过。

### Prevention

- 任何 policy 都必须在 plan 已存在后执行；resolved failure 不能用 HTTP 200 或
  `execution.state=failed` 冒充完成。
- 评测安全指标只使用固定 corpus canonical provenance，不信任 target 回传的 tenant/trust。
- 安全 query 可以暴露 canary key，但 secret payload 只能存在于越界 evidence。
- 调整 hashing baseline 或安全 query 后必须重跑不可回答 TPR；低维哈希碰撞不能当成真实相关性。
- 缓存 identity 必须绑定最终 prompt-visible context，并在消费端重算。
- production 默认切换前，仍必须增加真实 Milvus/LLM policy target 与两租户 live integration。

### Boundary

- E2a 只完成 `milvus-2step` strangler migration；agentic/adaptive/memory 仍属 E2b。
- 当前 matrix 是同一 hermetic hash-dense/extractive target 的两组参数，不证明生产 policy。
- 当前未连接真实 Supabase/Milvus，也没有启用 production answer-cache hit。
- UI compatibility 文件存在历史 `no-explicit-any`/React hook lint 债务；新增字段通过
  TypeScript/build，但不能声称这些整文件 ESLint 全绿。

## Related

- [[2026-07-15-rag-trends-next-options]] — 研究计划与 Epic 边界
- [[session-2026-07-15]] — Wave 0/1 实施与复审

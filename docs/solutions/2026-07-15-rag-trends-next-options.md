---
title: "RAG 演进采用 Evaluation-Gated Control Plane"
type: solution
status: accepted
date: "2026-07-15"
created: "2026-07-15"
updated: "2026-07-16"
source_plan: "docs/plans/2026-07-15-rag-trends-next-options.md"
tags: [rag, evaluation, security, hybrid-search, control-plane, graphrag, multimodal]
related_instincts: []
aliases: ["RAG evaluation-gated control plane", "RAG Wave 1 E2a E1b", "RAG E2b-E7"]
---

# RAG 演进采用 Evaluation-Gated Control Plane

## 问题

项目已经同时存在 dense Milvus、Agentic/Self-Corrective/Reasoning、实体图、Contextual Retrieval、rerank provider、LangSmith trace 与 `RagKernel`。继续增加模式会扩大分支和维护面，却不能回答“哪个检索结果更好、引用是否正确、是否跨租户、失败能否回退、成本是否值得”。

本方案制定时最关键的断点是：`RetrievalPlan` 尚不驱动执行，canonical evidence/eval
未进入生产路径，hybrid policy 仍是 stub，安全/租户边界未成为检索硬约束。Wave 0/1
已关闭其中 E0、E1a、E2a、E1b；同日续作也已完成 E2b 与 E3-E7 的代码合同、
生产读路径或可注入 seam。随后
`docs/plans/2026-07-16-rag-live-activation.md` 又完成了 native hybrid/contextual caller、
Graph artifact producer、PDF visual ingest/query caller 与文件 durable route；真实基础设施
迁移、共享 provider、质量/延迟/成本门禁和 production canary 仍不由代码闭环冒充上线完成。

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

## 2026-07-15 Wave 2/3：E2b 与 E3-E7 实施回写

### Problem

Wave 1 后仍有六类断点：legacy policy 在统一 evidence 之前完成生成；hybrid/contextual 只有
占位或未接线实现；router、abstain 与 cache identity 没有共享最终生成上下文；MiroFish 图
artifact 可能暴露原文或跨 scope；PDF visual 没有可信 manifest/资源边界；durable 只停留在
“需要 checkpoint”的概念。请求断开、provider 不合作、任务并发竞态和日志正文泄漏也会让
这些新 seam 在压力或攻击下失去边界。

### Root Cause

- legacy Agentic/Adaptive 的检索、grade、rerank、generation 绑在一个旧工作流里，canonical
  lane 只看到事后结果；scope 校验若晚于第一个 LLM 调用就已经泄漏。
- capability gate、off/shadow/active、prompt-visible context 和 cache identity 分散，禁用模式
  仍可能做 provider 工作，active abstention 也可能只改变响应而不改变 prompt。
- 图构建的“先计数、后异步创建”和 timeout 后只记一个 orphan Promise 都不是并发安全准入。
- 大图遍历和视觉分析器只有协作式 signal，没有覆盖全路径的预算、事件循环 yield、timeout
  与不合作 operation reservation。
- checkpoint 若没有 scope/version/fingerprint、CAS revision、owner lease、HMAC 和稳定 step
  execution ID，只能提供进程内状态对象，不能提供可恢复语义。

### Solution

- **E2b**：memory 真正拆为 retrieval/generation lanes；Agentic/Adaptive 采用 strangler
  projection，但每次 Milvus 返回都先 canonicalize，显式验证 tenant/corpus/document/trust、
  alias 冲突、quarantine 与 score，再允许 grade/rerank/generation。验证错误不能被 fallback
  吞掉；公开失败 envelope、正常日志和 LangSmith metadata 均不携带问题、passage 或原始错误。
- **取消与准入**：`NextRequest.signal` 贯通 Workflow、Kernel、policy context、四条 legacy/dense
  lane 和 generation。request abort 与内部 timeout 使用不同稳定码；provider 忽略 signal 时，
  每个 orphan Promise 都保留 admission slot，直到真实 settle。
- **E3**：hybrid 实现 injectable capability/search port、独立 sparse+dense candidate pool、RRF/
  weighted fusion、shadow-only diagnostics 和 schema manifest；Contextual Retrieval v2 的 off 模式
  零 provider 工作，shadow/active 有 call/input/output/concurrency 上限和版本化 identity。Contextual
  provider deadline 默认 30 秒、硬上限 120 秒，调用使用内部 `AbortController.signal`；timeout 先固定
  稳定错误再 abort，公开错误与日志不带 prompt/正文。准入按 provider/model key 记录全部 timed-out
  orphan，只有每个真实 operation settle 后才释放，避免单 Promise 覆盖并发 orphan。
- **E4**：ordered/structure-aware context composer v2、纯规则 query router 与 calibrated abstention
  进入 dense production path。active 模式先选 qualified evidence，再由同一集合生成 context、prompt
  和 cache dimensions；低分 prompt injection 不会进入模型或缓存。
- **E5**：新增 exact scope/document/version/trust 的内存/文件 artifact store、Graph entity/community
  到原始 passage 的可引用 read lane、dense fallback 与 server-owned activation。raw graph cache 被
  清除且不再写回；Graph API 只返回 public projection，task/list/data/delete 按 scope fail closed。
  图任务采用同步 check-and-reserve，五路并发在 limit=4 时稳定为 4 个接受、1 个拒绝；全图遍历
  对 node/edge/reference/operation 有上限并按批次 yield，使 timer-driven abort 可抢占。构建输入改为
  source-aligned bounded sliding windows：不 trim、不伪造 offset，`source.slice(start,end) === content`，
  长段落和 2M 无换行文本也不会成为单次超大 prompt。Graph POST 与 worker 共用同一 chunk 算法，
  在分配 task/builder/provider 前预检 extraction call 与累计 provider-input 字符，worker 再执行同一
  runtime call/input budget。embedding 路径同样有 deadline、预算和 provider-key multi-orphan
  reservation。artifact 资源门禁失败只保留稳定错误码，不写入 partial `result/graphData`；task ID
  使用 UUID，全局 active/terminal quota 清理不会回收运行中任务。LLM 原始输出在 JSON 解析前累计
  计费；raw entity/relation（含无效项）、字段长度、聚合 `E² + RE` lookup、实体 pair、
  `pair × embedding dimension`、实体/社区 embedding 维度与有限值均有硬预算。超限发布稳定
  `MIROFISH_GRAPH_OUTPUT_BUDGET_EXCEEDED`，且不保留 result/graphData。
- **模型选择器边界**：HTTP `modelOverride` 与持久化 project/simulation model selector 在写入、读取和
  执行前重新验证 provider/model 组合。客户端不能提供或持久化 secret/base URL；endpoint、API key
  和 provider credential 只由服务端配置解析，公开 DTO/projection 仅返回允许的非敏感选择字段。
- **E6**：PDF manifest 绑定 source/document/page/image-ref、SHA-256 digest、byteLength、scope 与
  trust；handler 重算 canonical active decision，拒绝 forged page。视觉分析器有 30 秒默认/
  120 秒硬 timeout、按 analyzer ID 的全局并发准入、最严格配置继承和 orphan reservation；
  timeout/busy 安全回退 text，外部 abort 保持 `AbortError`。
- **E7**：checkpoint v2 绑定 workflow/version、scope、document version、job fingerprint 和
  idempotency key；store 提供 revision CAS、owner lease/renew、terminal retention/GC/delete 和显式
  expired-lease recovery。持久化 store 强制至少 32 字符 HMAC key，并用 `timingSafeEqual` 校验；
  retry/takeover 复用稳定 step execution ID，语义明确为 at-least-once。外部取消即使遇到不合作 step
  也立即写入 terminal cancellation；晚到 settlement 不得改写 checkpoint，后续 replay 不再执行该
  step，底层 orphan 仍保留到真实 settle。
- **T17**：hermetic production-policy control-plane gate 已扩展到 23 case；目标真实经过 composer
  page seam，并加入 Contextual Retrieval case，而不是只验证同形 fixture。security、Kernel、E1b、
  matrix、contract、typecheck 与 full server build 串入 CI validate job。

### Verification

- `pnpm test`：52 个测试文件、545 个用例全部通过；默认链同时执行 E1b、matrix 与
  production contract。
- `pnpm rag:eval:e1b`：8/8；`pnpm rag:eval:matrix`：两个 target 各 8/8；均为 0 security violation。
- `pnpm rag:eval:contracts`：23/23，覆盖真实 composer page seam 与 contextual case，
  `executionMode=hermetic-in-process`，明确
  `productionQualityMeasured=false`。
- `src/lib/rag/core/durable-workflow.test.mjs`：22/22，覆盖 HMAC、lease/recovery、稳定 execution ID、
  不合作取消立即 terminal 且不可 replay。
- `src/lib/entity-extraction.security.test.mjs`：19/19；MiroFish graph builder：10/10；
  graph route：32/32。覆盖 parser 前输出限制、raw 累计观察数、聚合/解析计算预算、event-loop
  yield、embedding 输出校验与稳定无 partial result 失败。
- TypeScript `--noEmit --incremental false`、触及文件 ESLint、`git diff --check` 通过。
- Next.js 16.2.6 production build 在沙箱外通过，88/88 页面生成；沙箱内失败为进程启动层
  `spawn EPERM`，不是源码/类型/页面生成回归。`/api/ask` 与 `/api/mirofish/graph` 保持动态服务路由。
- 仓库全量 ESLint 仍有历史 357 errors / 113 warnings，集中在未触及 UI、analysis middleware、
  context-management 等旧文件；本轮触及文件 scoped ESLint 为 0。

### Prevention / Activation Boundary

- scope、quarantine、forged decision 与 abstention 回归必须同时断言 passage-bearing provider
  调用数为 0，不能只断言 HTTP 错误。
- 并发上限使用 barrier + `Promise.all(limit + 1)`；timeout/cancel 测试让底层 Promise 保持不合作，
  验证所有 orphan settle 前仍拒绝新工作。
- provider deadline 必须先固定 timeout/cancel 分类再触发 abort；日志只记录稳定 name/code。准入键须
  覆盖 provider/model，且用 Set 跟踪全部 orphan，不能用单个 Promise 或 abort 返回冒充真实 settle。
- Graph chunker 与 POST preflight 必须复用同一 source-aligned 算法；回归同时覆盖长段落、2M 无换行、
  显式 zero overlap、dollar-ampersand/dollar-backtick/dollar-apostrophe replacement metacharacter、
  call cap 与累计 prompt 字符 cap。
  artifact gate 必须先于 task completion，失败断言 `result/graphData` 均不存在。
- Provider 输出预算必须在 regex/JSON.parse 前执行；raw 数组按长度（含无效项）累计，所有
  `E² + RE` 聚合查找在扫描前预留，pair/vector 运算有 safe-integer 上限并定期 yield。实体与社区
  embedding 在挂载 artifact 前必须非空、等维、有限且不超过维度预算。
- HTTP 与持久化 model selector 每次跨边界都重新验证；客户端 payload、持久化记录和公开 projection
  不得成为 secret/base URL/endpoint 的来源。运行时 endpoint 与 credential 只能由 server-owned
  provider config 解析。
- durable 外部取消的完成条件是 fenced terminal checkpoint，不是等待不合作 step；晚到结果不能提交，
  completed/cancelled replay 均不得重复 provider side effect。
- Windows 沙箱 `spawn EPERM` 与源码失败分层记录；build 结论只能引用实际完成的沙箱外 88/88 结果。
- production hybrid 仍需真实 Milvus 2.6 shadow collection 回填、p95/质量/成本门禁与回滚演练；
  E3 已有 native capability/search caller，但这不是已切流 collection 的声明。
- E5 builder 已原子发布 scoped File artifact，read/TTL/delete/active pointer 已闭环；跨主机共享
  transaction/quota 仍需外部 provider 与 failover 演练。
- E6 已接 ingest/query caller、digest-verified page asset 与 visual model gate；默认启用仍需真实
  visual subset 证明相对 text/OCR 的提升及资源预算。
- E7 已接 generation-aware 文件 checkpoint/result 与管理 route，并覆盖本地 restart/resume/
  cancel/delete；跨主机共享 provider、HITL 与 production canary 仍是外部验证边界。
- 这些 2026-07-16 live activation 更新不改变 dense/text fallback，也不把代码闭环描述成流量切换。

## Related

- [[2026-07-15-rag-trends-next-options]] — 研究计划与 Epic 边界
- [[session-2026-07-15]] — Wave 0/1 实施与复审

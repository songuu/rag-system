---
title: "Dify / Coze 能力集成可行性分析"
type: research
date: 2026-05-25
tags: [research, feasibility, integration, decision-matrix]
aliases: ["Integration feasibility analysis"]
sprint: 2026-05-25-coze-dify-integration-research
depends_on:
  - "[[2026-05-25-dify-capability-survey]]"
  - "[[2026-05-25-coze-capability-survey]]"
  - "[[2026-05-25-platform-capability-matrix]]"
decision_matrix_baseline: "[[2026-05-08-mirofish-openmaic-latest-parity]] 的 Prevention 四分类（runtime contract / prompt quality / UI experience / dependency-service）"
---

# Dify / Coze 能力集成可行性分析

## 决策矩阵（沿用既有四分类）

按 [[2026-05-08-mirofish-openmaic-latest-parity#Prevention]]：

- **Runtime contract change** → 仅当本地持久化产物可迁移/有 fallback 时 adopt
- **Prompt / output quality change** → 优先 adopt（prompt refinement / post-processing）
- **UI experience change** → 加为可选 state / panel，不替换主流程
- **Dependency / service change** → 不强制；用户未配置则 skip

## 10 项 gap 逐项决策

### G1 — Evaluation framework (dataset + evaluator + experiment)

- **类别**：Runtime contract (新增子系统) + 部分 dependency
- **来源**：Coze-loop `modules/evaluation/` + `modules/data/`；Dify `core/ops/` 内嵌
- **价值**：解 RAG / agent 输出"看着对但实际差"的不可观测问题；可与 [[2026-05-25-model-vector-cache-optimization]] 的 perf bench harness 配合形成"质量 + 速度"双轴评估
- **本地基础**：`src/lib/rag/eval/golden-questions.ts` 已是雏形（policy-filtered 默认 smoke set）；LangSmith trace 接入（2026-05-19）已有 spans
- **决策**：**adopt（M 工作量）**
- **影响子系统**：`src/lib/rag/eval/`（扩展）；新增 `src/lib/rag/eval/{dataset,experiment,evaluator}.ts`；retrieval-plan lane 需要 `evalScore` 字段
- **不变量守护**：必须保持 RAG Kernel policy adapter 模式（不绕过 kernel 直接评估）；评估结果应通过 trace envelope 上报
- **理由 / fact**：T2 详细列了 coze-loop 的 dataset/evaluator/experiment 三件套；T1 提到 Dify `core/ops/` 同类作用
- **不可直接移植**：Coze-loop 是 Go + 独立服务；本地是 TS 单体，只能照搬**架构模式**

### G2 — Rerank stage（接入 reranker）

- **类别**：Prompt / output quality
- **来源**：Dify `core/rag/rerank/`；Coze 隐含在 knowledge domain
- **价值**：直接提升检索 precision；与上 sprint 的 MMR 后处理协同（MMR 解多样性，rerank 解相关性）
- **本地基础**：retrieval-plan lane 已有 `rerank` 类型定义（[[2026-05-14-rag-kernel-implementation]]），但所有 policy 的 rerank 都是声明未实现；[[2026-05-25-model-vector-cache-optimization]] frontmatter `deferred:` 中已挂"Rerank 模块（依赖 hybrid）"，deadline 2026-08-01
- **决策**：**adopt（M 工作量）**，且**解锁前 sprint deferred 项**
- **影响子系统**：新增 `src/lib/rag/retrieval/rerank.ts`（包装 bge-reranker / Cohere / Voyage rerank API）；wire 进 retrieval-plan lane execution；vectorSearch 加 `rerank?: RerankOptions` 选项
- **不变量守护**：rerank 默认 off（与 MMR 同模式）；选择 reranker provider 时复用现有 model-config provider 切换框架
- **理由 / fact**：T1 列出 Dify `core/rag/rerank/`；T3 矩阵把 rerank 标"优先"
- **依赖**：可独立于 hybrid 实现（解开前 sprint "依赖 hybrid" 的过度耦合假设）；先用 dense + rerank 也成立

### G3 — Prompt 版本管理 + playground

- **类别**：UI experience + 部分 runtime contract
- **来源**：Coze-loop `modules/prompt/`
- **价值**：解开发体验；prompt 改动可回滚；多模型对比
- **本地基础**：完全无；各 RAG policy 的 prompt 散落在 `src/lib/{agentic,reasoning,self-corrective,adaptive-entity}-rag.ts`
- **决策**：**adopt 但拆 PoC（S 工作量起步）**
- **影响子系统**：新增 `src/lib/rag/prompt-registry.ts`（version + provider 切分）；将散落的 prompt 集中到 registry；不做 UI playground（UI 工作量大）
- **不变量守护**：现有 RAG policy 调用 prompt 时不能 break（应通过 `getPrompt('agentic.grading', 'v1')` 这种间接寻址）
- **理由 / fact**：T2 详细列了 coze-loop 的 prompt 版本管理
- **替代方案**：纯 git commit 历史本身就是 prompt 版本管理；本 gap 优先级中等而非必做

### G4 — MCP 客户端接入

- **类别**：Dependency / service
- **来源**：Dify `core/mcp/`
- **价值**：可挂载 MCP server 提供的 tool / context；生态扩张；与 Anthropic MCP 标准对齐
- **本地基础**：完全无 MCP 客户端
- **决策**：**defer（M 工作量）**，挂 deadline 2026-09-01
- **理由**：MCP 是生态层能力，对当前 RAG 系统**直接业务价值不明显**；如本地 agent 需要外部工具调用，先看 agentic-rag 是否已能满足；MCP 是 long-tail 价值
- **替代方案**：现有 mirofish / maic / RAG 流程不需要外部 tool 也能跑

### G5 — Tool / plugin registry（不含 MCP）

- **类别**：Runtime contract
- **来源**：Dify `core/{tools,plugin}/` + Coze studio `domain/plugin/`
- **价值**：agentic-rag 等流程可受益（function-calling）
- **本地基础**：agentic-rag 内部有调用模式但无 registry 抽象
- **决策**：**defer（L 工作量）**，挂 deadline 2026-10-01
- **理由**：当前 agentic-rag 工具调用面窄；引入 registry 抽象当前不解任何已知问题；属"框架就位、应用尚未"
- **替代方案**：保持现状直到出现 ≥ 3 个 tool 需要复用，再回头建 registry

### G6 — Workflow 可视化编辑器（FlowGram / Dify canvas）

- **类别**：UI experience
- **来源**：Dify `web/` 内置 + Coze studio FlowGram
- **价值**：用户面价值高；但 local 主要服务于 RAG 与 MAIC/MiroFish 场景，**不是通用 agent 平台**
- **本地基础**：retrieval-plan 已经声明 lane 结构；变成 visual 需要前端工程
- **决策**：**skip**
- **理由**：本项目定位是 RAG + 教育/社交模拟场景，不需要让终端用户编辑 workflow；retrieval-plan 是开发者级 API，写代码即可；引入 visual editor 工作量大且 ROI 低

### G7 — Variable pool + template rendering（workflow 节点间数据流）

- **类别**：Runtime contract
- **来源**：Dify `core/workflow/variable_pool_initializer.py` + `template_rendering.py`
- **价值**：让 retrieval-plan lane 之间能用变量传递 / 模板渲染（如 lane A 的输出可被 lane B 的 prompt 引用）
- **本地基础**：retrieval-plan lane 有 `parameters` 字段但只能放静态配置，不能引用前置 lane 输出
- **决策**：**defer（M 工作量）**，挂 deadline 2026-09-01
- **理由**：当前 4 个 RAG policy 都是简单线性流程，未出现"lane A 输出 → lane B 输入模板引用"的具体需求；引入 variable pool 是"框架预留"
- **替代方案**：如出现该需求，沿 Dify 的 `variable_pool_initializer` 模式实现（key-value pool + template rendering 函数）

### G8 — Memory / session 抽象

- **类别**：Runtime contract
- **来源**：Dify `core/memory/` + Coze studio `domain/{memory,conversation}/`
- **价值**：让 agentic-rag / reasoning-rag / MAIC session-controller 共享会话状态；解碎片化
- **本地基础**：每个 RAG policy 有自己的轻量 state；MAIC `session-controller.ts` 是场景专用
- **决策**：**defer（M 工作量）**，挂 deadline 2026-09-01
- **理由**：当前各 policy 互不依赖会话状态；统一抽象**当前无价值**；MAIC session-controller 不复用 RAG policy 的状态
- **替代方案**：如出现"agent 跨 RAG policy 共享上下文"需求再做

### G9 — App / template 系统

- **类别**：Runtime contract + UI experience
- **来源**：Dify `core/app/` + Coze studio `domain/{app,template}/`
- **价值**：模板化创建 chat assistant / workflow app
- **本地基础**：local 应用是 MAIC 课堂 / MiroFish 社交模拟，**写死页面，不是模板化 app**
- **决策**：**skip**
- **理由**：本项目定位决定不需要 app 模板系统；MAIC/MiroFish 是产品级体验，不是通用 chat app
- **替代方案**：保持现状

### G10 — Multi-tenant / workspace

- **类别**：Runtime contract + dependency
- **来源**：Dify `enterprise/` + Coze studio `domain/{openauth,permission,user}/`
- **价值**：B2B SaaS 必备；本项目不卖 SaaS
- **本地基础**：单租户 Next.js
- **决策**：**skip**
- **理由**：项目定位决定不需要 multi-tenant；引入会大幅增加复杂度
- **License 注**：即便想做也不能直接复用 Dify multi-tenant 实现（modified Apache 2.0 禁止 SaaS multi-tenant 商用未授权）

### G11 — Cost tracking

- **类别**：Runtime contract (薄)
- **来源**：Dify 推断在 `model_manager`/`provider_manager`；Coze 推断在 `observability`
- **价值**：运营级 / token 预算告警；调试时定位昂贵 prompt
- **本地基础**：完全无
- **决策**：**adopt（S 工作量）**
- **影响子系统**：扩展 `src/lib/model-config.ts` / `src/lib/embedding-config.ts` 在每次 createLLM/createEmbedding 调用处包装 token 统计；新增 `src/lib/cost-tracker.ts` 进程级 counter + 可选 logger
- **不变量守护**：cost-tracker 默认 off（与 telemetry 同模式）；启用后通过 retrieval-plan trace envelope / response header `x-rag-cost-usd` 上报
- **理由 / fact**：T1 推断 [L]；T2 推断 [L]；本地需要的层级简单（不需要 SaaS 计费）

## adopt 决策汇总

| Gap | 决策 | 工作量 | 阻塞 |
|-----|------|--------|------|
| G1 Evaluation framework | **adopt** | M | 无 |
| G2 Rerank stage | **adopt** | M | 无（且解锁前 sprint deferred） |
| G3 Prompt registry (S 起步) | **adopt** | S | 无 |
| G11 Cost tracking | **adopt** | S | 无 |
| G4 MCP 客户端 | defer 2026-09-01 | M | 业务价值待证 |
| G5 Tool registry | defer 2026-10-01 | L | ≥3 tool 需求出现 |
| G7 Variable pool | defer 2026-09-01 | M | 具体跨 lane 需求出现 |
| G8 Memory 抽象 | defer 2026-09-01 | M | 跨 policy 共享需求出现 |
| G6 Workflow visual editor | **skip** | L | 项目定位不需要 |
| G9 App / template | **skip** | L | 项目定位不需要 |
| G10 Multi-tenant | **skip** | L | 项目定位不需要 |

**4 个 adopt（2 优先级高 G1+G2，2 工作量小 G3+G11） + 4 个 defer + 3 个 skip**

## 与现有 invariants 的兼容性验证

逐条对照 sprint frontmatter `invariants:`（来自 [[2026-05-25-model-vector-cache-optimization]] 等前置 sprint）：

| Invariant | G1 Eval | G2 Rerank | G3 Prompt | G11 Cost |
|-----------|---------|-----------|-----------|----------|
| DEFAULT_EMBEDDING_MODEL 语义不变 | ✓ | ✓ | ✓ | ✓ |
| queryEmbeddingCache TTL/key 形状向后兼容 | ✓ | ✓ | ✓ | ✓ |
| MilvusVectorStore 旧 search 签名 | ✓ | ✓（option） | ✓ | ✓ |
| SemanticCache 公共 API | ✓ | ✓ | ✓ | ✓ |
| 返回 shape 仅追加 | ✓（trace 字段） | ✓（rerank 字段） | ✓ | ✓（cost 字段） |
| MMR / hybrid 后处理默认 off | ✓ | ✓（rerank 默认 off） | ✓ | ✓ |
| embedQuery 兼容未启用 cache | ✓ | ✓ | ✓ | ✓ |
| RAG Kernel policy adapter 模式 | ✓（eval 走 trace envelope） | ✓（rerank 是 lane 内步骤） | ✓（registry 是 helper） | ✓（cost 是横切关注） |
| 不引入新强依赖 | ✓（langsmith 已存在） | 需评估 reranker provider | ✓ | ✓ |

唯一需注意：**G2 rerank 引入 reranker provider 是 dependency change** — 必须沿用前 sprint Prevention 矩阵的 "do not make it mandatory" 原则。建议：rerank 走 model-config provider 抽象，未配置时自动 fallback 到"不 rerank"。

## 调研局限性

- 决策口径基于"对本地 RAG 系统 + MAIC/MiroFish 场景的价值"判断；如未来项目定位转向通用 agent 平台，G6/G9/G10 需要重新评估
- 工作量估算 (S/M/L) 是粗估；具体落地 sprint 会重新评估
- G2 rerank 的 deferred-deps 假设（之前认为依赖 hybrid）在本调研中已**纠偏**：rerank 可独立于 hybrid 实现

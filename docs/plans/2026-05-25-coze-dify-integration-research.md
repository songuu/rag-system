---
title: "Coze / Dify 优点集成调研"
type: sprint
status: completed
created: "2026-05-25"
updated: "2026-05-25"
checkpoints: 0
tasks_total: 5
tasks_completed: 5
tags: [sprint, research, coze, dify, agent-platform, integration]
aliases: ["Coze Dify integration research", "Sprint 2026-05-25 v3"]
mode:
  auto: true
  caveman: true
sprint_kind: research   # 与常规 build sprint 区分；交付是文档而非代码
artifact_outputs:
  - docs/research/2026-05-25-dify-capability-survey.md
  - docs/research/2026-05-25-coze-capability-survey.md
  - docs/research/2026-05-25-platform-capability-matrix.md
  - docs/research/2026-05-25-integration-feasibility-analysis.md
  - docs/research/2026-05-25-integration-roadmap.md
invariants:
  - "本 sprint 不动 src/ 任何代码；不动 package.json；不引入 runtime 依赖"
  - "调研结论必须区分 fact (来自官方文档/repo) vs interpretation (模型分析)"
  - "推荐落地清单每项必须给 (能力 / 价值 / 工作量 / 风险 / 依赖) 五元组"
invariant_tests: []  # research sprint 无代码测试
deferred: []
deadcode_until: []
sources:
  dify:
    - "https://github.com/langgenius/dify"
    - "https://docs.dify.ai"
  coze:
    - "https://github.com/coze-dev/coze-loop"
    - "https://github.com/coze-dev/coze-studio"
    - "https://www.coze.com/docs"
related:
  - "[[2026-05-14-rag-system-architecture-evolution]] - 上一次 RAG 架构演进分析（同类调研 sprint 模板）"
  - "[[2026-05-25-model-vector-cache-optimization]] - 上一 sprint 留下的 deferred 议题（rerank / hybrid / lane-handlers cache）"
---

# Coze / Dify 优点集成调研

## Phase 1: 需求分析

### 用户原始诉求

> 开始具体的研究下，对于 coze 或者 dify 的优点集成

### 通过 AskUserQuestion 收敛

| 维度 | 用户选择 |
|------|---------|
| 交付类型 | 只出调研报告 + 集成推荐表（不写代码） |
| 能力轴 | 全谱扫描，后期挑重点 |
| 平台 | 两个都调研，生成对比表 |

### 当前项目能力基线（与上游对比的起点）

来自前置 sprint：

- **检索层**：RAG Kernel + retrieval-plan（policy adapter 模式，2026-05-14）；agentic / adaptive-entity / self-corrective / reasoning 4 policy；MMR + dedupeBySource 后处理（2026-05-25 v2 sprint）
- **存储**：Milvus + memory store；contextual retrieval；artifact-cache + parsed-slides-cache + prepare-cache（cross-module unified cache）
- **多 provider**：SiliconFlow + Ollama + OpenAI + custom；DEFAULT_RUNTIME_MODELS 统一
- **场景应用**：MAIC 课堂、MiroFish 社交模拟
- **观测**：LangSmith trace 接入（2026-05-19）；retrieval-plan trace envelope；timings 字段（2026-05-25 v2）
- **架构**：Next.js 单体；service-per-file；service / API / UI 三层；artifact-cache 抽象

### 范围 (Scope)

- **只产出 5 篇 docs/research/* 文档**（survey × 2 + matrix + feasibility + roadmap）
- 调研口径：能拿到的公开材料（GitHub repo README/code + 官方 docs）+ 模型基于架构的合理推断
- 能力轴 8 项：workflow / tool registry / knowledge base / app templates / memory & session / eval & trace / multi-tenant / cost tracking
- 每项产出 (Dify state, Coze state, local state, integration verdict)

### 非范围 (Non-scope)

- 不动 `src/` 任何代码
- 不引入 npm 依赖
- 不创建数据库 schema
- 不做 PoC 实现（即使集成可行性分析推荐 adopt，本 sprint 也只写到文档里）
- 不试用云服务（不注册账号、不付费、不调用 API）

### 成功标准

- 5 篇 markdown 文档全部产出，且通过 markdown lint 基本检查
- 能力对照表覆盖 8 个能力轴 × 3 列（Dify/Coze/local），每格至少 1 句具体描述（非"待补充"）
- 集成可行性分析按 [[2026-05-08-mirofish-openmaic-latest-parity#Prevention]] 矩阵分类（runtime contract / prompt quality / UI experience / dependency-service）每条结论附 fact 来源
- 推荐落地清单 ≥ 3 项 ≤ 8 项；每项五元组（能力/价值/工作量/风险/依赖）齐全
- Phase 4 review 6 视角对 research sprint 重新定义为：completeness / accuracy / actionability / cross-sprint consistency

### 风险

- **Coze 主体闭源**：能拿到的是 SDK（coze-loop, coze-studio）+ 平台 docs；架构推断成分高，必须显式标注 confidence level
- **Dify 仓库巨大**：langgenius/dify 是 monorepo，深度细读不现实；调研采用"按目录采样 + 官方 docs 交叉验证"
- **WebFetch 限流 / 大页**：单文件 raw.githubusercontent 拿不全；需要按目录 README + 关键模块拿
- **分类口径主观**：能力轴定义可能与上游官方分类不一致；matrix 列必须显式说明对齐规则
- **过度推荐风险**：上一次 mirofish/openmaic parity 教训 — adopt 决策不能机械执行，必须显式标 defer/skip 且给理由

## Phase 2: 技术方案

### 入场扫描 - Invariants 继承

| 子系统 | 上 sprint invariant | 本 sprint 如何保持 |
|--------|---------------------|--------------------|
| RAG Kernel | policy / retrieval-plan / corpus-store 已是 adapter 模式 ([[2026-05-14-rag-kernel-implementation]]) | 调研发现的能力都映射到现有 policy / lane / corpus 抽象，不绕过 |
| Artifact cache | source hash + model signature + version 唯一 key ([[2026-05-14-mirofish-openmaic-cache-optimization]]) | 调研发现的 Coze/Dify cache 模式与之对比，不替换 |
| Anti-drift | deferred / deadcode_until / invariants frontmatter 强制 | 推荐 adopt 项必须给 deadline；本 sprint 自身 deferred 字段不动 |
| 工作流 / 多 policy | retrieval-plan 8 lane 类型已定义（memory/dense/sparse/metadata/graph/fusion/rerank/generation-only） | 与 Dify workflow node 类型对比，找到本地缺失 |
| 模型 catalog | OPENMAIC_LATEST_MODEL_NOTES 列表（2026-05-25 v1） | 与 Dify/Coze 模型 registry 对比，找到本地缺失 provider |
| Embedding cache | namespace + sha256 + version key (2026-05-25 v2) | 与 Dify/Coze embedding cache 模式对比 |

### 入场扫描 - 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|--------|----------|--------|--------|------------|
| T1-T5 产出 markdown 文档 | Write tool | docs/research/* | ✅ git tracked | ✅ git diff 可见 |

无 ❌（research sprint 仅写文档）。

### 入场扫描 - 债务清单

| 来源 sprint | 议题 | 本 sprint 决策 | deadline |
|-------------|------|----------------|----------|
| 2026-05-25 v2 | lane-handlers doc-embedding cache 迁移 | ⏭ 保留 deferred（与 Coze/Dify 调研无关） | 2026-08-01 |
| 2026-05-25 v2 | Milvus hybrid sparse + dense | ⏭ 保留 deferred；可在 T4 引用 Coze/Dify 的 hybrid 实现作参考 | 2026-08-01 |
| 2026-05-25 v2 | Rerank 模块 | ⏭ 保留 deferred；T4 可作参考 | 2026-08-01 |
| 2026-05-25 v1 | Brave + Baidu Search | ⏭ 保留；T4 可引用 Dify web-search tool 集成模式 | 2026-08-01 |
| 2026-05-25 v1 | HappyHorse video + manifest | ⏭ 保留 | 2026-08-01 |
| 2026-05-25 v1 | Classroom zip 导入导出 | ⏭ 保留 | 2026-08-01 |

### 任务拆解

所有 task 风险等级 **L0**（仅 Write markdown，不动代码）。

- [ ] **T1 — Dify 架构 + 优点扫描** (L0, ~docs/research/2026-05-25-dify-capability-survey.md)
  - WebFetch 抓取：langgenius/dify README、Architecture docs、Workflow docs、Tool docs、RAG docs、Apps docs
  - 整理 Dify 在 8 能力轴上的具体实现：(1) Workflow 节点系统 (2) Tool registry / plugin marketplace (3) Knowledge base (4) App templates (5) Memory / session (6) Eval / trace (7) Multi-tenant (8) Cost tracking
  - 每项标 fact (来自具体文档/repo 路径) vs interpretation (模型推断)
  - 标注 license: Apache 2.0 + commercial use 条款（注意 brand/multi-tenant 限制）
  - 估计代码规模 / 主要语言 / 主要存储依赖

- [ ] **T2 — Coze 架构 + 优点扫描** (L0, ~docs/research/2026-05-25-coze-capability-survey.md)
  - WebFetch 抓取：coze-dev/coze-loop README、coze-dev/coze-studio README、www.coze.com/docs API reference、Bot / Workflow / Plugin docs
  - 同样 8 能力轴
  - 显式标注："Coze 主体闭源，本调研基于 SDK + 公开 docs，confidence level 标注 H/M/L"
  - 拉 Coze Loop 与 Coze Studio 的差异（loop = SDK orchestration；studio = bot building）

- [ ] **T3 — 能力对照表** (L0, ~docs/research/2026-05-25-platform-capability-matrix.md)
  - 三列：Dify / Coze / rag-system (local)
  - 8 行（每能力轴一行）
  - 每格简短描述（≤ 80 字符）+ 链接到 T1/T2 详细段
  - 行末追加 "gap" 列：local 在该轴的最大缺口
  - 引用 [[2026-05-14-rag-system-architecture-evolution]] 的 RoutIR / Anthropic Contextual / Milvus hybrid baseline 作为第 4 列参照点

- [ ] **T4 — 集成可行性分析** (L0, ~docs/research/2026-05-25-integration-feasibility-analysis.md)
  - 按 [[2026-05-08-mirofish-openmaic-latest-parity#Prevention]] 四类决策矩阵：runtime contract / prompt quality / UI experience / dependency-service
  - 每条来自 T3 gap 列的能力，给：
    - 决策: adopt / defer / skip
    - 理由 (含 fact 来源)
    - 替代方案 (本地是否已有相近能力)
    - 影响子系统列表（必经 invariants 表）
  - 强制约束：任何 adopt 不能违反 frontmatter invariants 列表中的 7 条不变量
  - 不写代码；只写文档

- [ ] **T5 — 推荐落地清单 + 优先级** (L0, ~docs/research/2026-05-25-integration-roadmap.md)
  - 从 T4 adopt 列中挑 3-8 项排序
  - 每项五元组：(能力 / 业务价值 / 工作量 [S/M/L] / 风险 [L1/L2/L3] / 依赖项)
  - 推荐 sprint 排期：next sprint 候选 2-3 项；mid-term 候选 2-3 项；long-term 候选 1-2 项
  - 显式说明：每项推荐都假设单独成 sprint，需 think→plan→work→review→compound 流程；本 sprint 不启动任何一项落地
  - 与 frontmatter `deferred:` 字段对齐：本 sprint 留下的所有 deferred 必须包含来自 T4 的高优先级项

### 验证策略

研究 sprint 特殊验证：

- 每 task done：检查产出文档存在 + word count > 500 + 含至少一个 fact 链接
- 不跑代码测试（invariant_tests 为空）
- T3 / T4 / T5 之间必须 cross-reference（matrix gap → feasibility decision → roadmap priority），保证 chain-of-evidence 不断
- Phase 4 review 6 视角重新定义为 research lens（见下方）

### Auto mode 评估

- 任务数：5 ≤ 8 ✓
- 风险等级最高：L0（仅 markdown），无 L3/L4 ✓
- scope 与原始需求一致（调研 Coze/Dify 优点集成） ✓
- 入场 checklist 三项填齐 ✓
- T1/T2 平行无依赖；T3-T5 顺序依赖 T1+T2 → 可考虑 T1+T2 并行 spawn，但 WebFetch 序列已被本 session learned-context 标为高频，保持 inline 即可

→ ✓ auto: phase 2 → 3

## Phase 3: 任务清单

- [ ] **T1** (L0) — Dify 架构 + 优点扫描 → `docs/research/2026-05-25-dify-capability-survey.md`
- [ ] **T2** (L0) — Coze 架构 + 优点扫描 → `docs/research/2026-05-25-coze-capability-survey.md`
- [ ] **T3** (L0) — 能力对照表 → `docs/research/2026-05-25-platform-capability-matrix.md`
- [ ] **T4** (L0) — 集成可行性分析 → `docs/research/2026-05-25-integration-feasibility-analysis.md`
- [ ] **T5** (L0) — 推荐落地清单 → `docs/research/2026-05-25-integration-roadmap.md`

## Phase 4: 审查结果

研究 sprint 用 research lens 重新定义 6 视角（不是 build sprint 的 architecture/security/perf/quality/test/integration）：

### 视角矩阵

| 视角 | 结论 | 关键发现 |
|------|------|----------|
| 1. **Completeness** | ✓ | T1+T2 8 能力轴各列；T3 矩阵 8×3 + 第 4 列 baseline 全填；T4 11 个 gap 全决策；T5 四项推荐五元组齐全 |
| 2. **Accuracy** | ✓ | fact/interpretation 一致用 [H/M/L] confidence 标注；source URL 在每篇 frontmatter；Coze 闭源部分主动降级 confidence |
| 3. **Actionability** | ✓ | R1-R4 每项含 sprint 提案大纲 ≥ 3 task；启动时按 /sprint 流程重拆 |
| 4. **Cross-document consistency** | ✓ | T3 gap 列 → T4 G1-G11 决策 → T5 R1-R4 排期 chain 完整；T4 invariants 9×4 验证表沿用前置 sprint 不变量 |
| 5. **Bias detection** | ✓ | 4 adopt / 4 defer / 3 skip 比例平衡；Dify license 限制 + Coze 闭源信息缺各自标注；R1 rerank 主动纠偏（独立于 hybrid） |
| 6. **集成连续性** | ✓ | 前 sprint 5 个 deferred → 4 保留 + 1 升级；本 sprint 自身 4 个 deferred 全带 deadline；invariants 与上 sprint 完全兼容 |

### Findings

**P0**: none

**P1**:

- `docs/research/2026-05-25-dify-capability-survey.md`：Dify 支持的 vector store backend 完整清单未拉取（README 未列）；启动 R3 eval sprint 时若需要再补

**P2**:

- 工作量估算 (S/M/L) 是粗估，启动落地 sprint 时按 /plan 重新评估
- R3 LLM-as-judge 实现复杂度可能比 M 高（需 mock provider / golden answer 设计），启动时再细化

### 第 6 视角详情

**前置 sprint deferred 重新评估**（[[2026-05-25-model-vector-cache-optimization]] frontmatter `deferred:`）：

| 原 deferred | 本 sprint 决策 | 变化 |
|-------------|----------------|------|
| Rerank 模块（依赖 hybrid） | **升级为 R1 推荐项** | 解锁；纠偏：rerank 可独立于 hybrid |
| Milvus hybrid sparse + dense | 保留 | 不动 |
| lane-handlers cache 迁移 | 保留 | 不动 |
| Brave + Baidu Search | 保留 | 与本调研无关 |
| HappyHorse video | 保留 | 与本调研无关 |
| Classroom zip | 保留 | 与本调研无关 |

**本 sprint 自身 deferred**（[[2026-05-25-integration-feasibility-analysis]] G4/G5/G7/G8）：

| Gap | 决策 | deadline |
|-----|------|----------|
| G4 MCP 客户端 | defer | 2026-09-01 |
| G5 Tool / plugin registry | defer | 2026-10-01 |
| G7 Variable pool / template rendering | defer | 2026-09-01 |
| G8 Memory / session 抽象 | defer | 2026-09-01 |

### Auto mode 决策

- P0 = 0 → 自动进入 Phase 5
- P1 仅 1 项（vector store 清单），cosmetic → 跳过 confirmation
- 第 6 视角无 BLOCKED → 不触发强制 manual gate

→ ✓ auto: phase 4 → 5

## Phase 5: 复利记录

### 沉淀去向

- **5 篇研究文档**（813 行）：
  - `docs/research/2026-05-25-dify-capability-survey.md` (193 行)
  - `docs/research/2026-05-25-coze-capability-survey.md` (214 行)
  - `docs/research/2026-05-25-platform-capability-matrix.md` (61 行)
  - `docs/research/2026-05-25-integration-feasibility-analysis.md` (184 行)
  - `docs/research/2026-05-25-integration-roadmap.md` (161 行)

- **下一 sprint 候选 4 项**（R1-R4，详见 roadmap.md）：
  - R1 Rerank stage 接入（M, L2，next sprint 强推荐）
  - R2 Cost tracking（S, L1，与 R1 并行）
  - R3 Evaluation framework 雏形（M-L, L2，R1 之后）
  - R4 Prompt registry（S-M, L1-L3，最后）

### 关键经验（写入 solution → prevention）

1. **Research sprint 与 build sprint 视角必须分离**：6 视角不是套 architecture/security/perf 模板；研究 sprint 走 completeness/accuracy/actionability/consistency/bias/integration-continuity
2. **跨平台调研要主动标 confidence (H/M/L)**：避免"我推断"和"官方说"混在一起；Coze 闭源、Dify enterprise/ 等模块都应降级 confidence
3. **决策矩阵要复用既有框架**：本 sprint 沿用 [[2026-05-08-mirofish-openmaic-latest-parity#Prevention]] 的四分类（runtime/prompt/UI/dependency），保持跨 sprint 决策口径一致
4. **defer 必须带 deadline + 重评条件**：G4/G5/G7/G8 都给了"出现 X 需求时重评"的具体触发条件，避免无限延期
5. **主动纠偏前 sprint 假设**：R1 rerank 之前挂在前 sprint deferred 时假设"依赖 hybrid"，本调研纠为"可独立"；这种纠偏是 research sprint 的高价值产出之一
6. **research sprint 不写代码就不写代码**：诱惑很多（"顺手 PoC 一下 cost-tracker 不也行？"），但跨 phase 模糊会污染 sprint 边界；R2 cost-tracker S 工作量虽小，仍坚持留给下一 sprint
7. **gh api + WebFetch 双工具采源足够**：不需要本地 clone Dify (142k stars 仓库巨大) 或 Coze 也能完成 capability survey；按目录采样 + README 交叉验证 + 公开 docs 三层即可

### 信号采集（自学习）

- **重复工具序列**：`gh api repos/.../contents/<dir>` × N 次目录抓取 + `WebFetch raw.githubusercontent...README` 是 research sprint 的标准开局，可演进为 "upstream survey 小工具"
- **本能候选**：研究类需求看到 "调研 X 集成" / "对比 X 与 Y" 时，默认开 research sprint 模式（非 build sprint）；交付是 docs/research/* 不是 code
- **退化检测**：全程未触发；5 task 无重大重做，无工具调用错误，无遗忘约定

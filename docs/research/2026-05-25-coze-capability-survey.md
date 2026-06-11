---
title: "Coze 能力调研"
type: research
date: 2026-05-25
tags: [research, coze, agent-platform, agent-eval]
aliases: ["Coze capability survey"]
sprint: 2026-05-25-coze-dify-integration-research
sources_consulted:
  - "github.com/coze-dev/coze-studio (HEAD as of 2026-05-25)"
  - "github.com/coze-dev/coze-loop (HEAD as of 2026-05-25)"
  - "raw.githubusercontent.com/coze-dev/coze-studio/main/README.md"
  - "raw.githubusercontent.com/coze-dev/coze-loop/main/README.md"
confidence_levels:
  - "H = 直接来自 repo 目录 / 文件 / README 引用"
  - "M = 来自官方功能描述但未读源码"
  - "L = 模型基于目录命名 + 通用经验推断"
caveat: |
  Coze 主体（bot.coze.cn / coze.com 平台运行时）闭源。本调研基于两个开源仓库 (coze-studio 是 agent 开发平台 OSS 版，coze-loop 是 agent 优化平台 OSS 版) 和公开 docs，平台运行时差异 confidence 较低。
---

# Coze 能力调研

## 元数据

### coze-studio (OSS Agent Building Platform)

- License: **Apache 2.0** (LICENSE-APACHE)
- Stars: 20,832（2026-05-25）
- 主语言: TypeScript（frontend）+ Go（backend）
- 默认分支: main
- 部署依赖（来自 README）: Docker Compose；最小 2 core + 4GB
- 框架: Eino (agent/workflow runtime) + FlowGram (workflow canvas) + Hertz (Go HTTP)

### coze-loop (OSS Agent Optimization Platform)

- License: **Apache 2.0**
- Stars: 5,470（2026-05-25）
- 主语言: Go
- 默认分支: main
- 角色: 与 coze-studio 互补 — studio 是 build，loop 是 dev/debug/eval/monitor 全生命周期

## 仓库布局

### coze-studio 后端 (`backend/`)

```
api/            ← API 入口
application/    ← Application layer (DDD)
bizpkg/         ← 业务工具包
conf/           ← 配置
crossdomain/    ← 跨域辅助（多 domain 协作）
domain/         ← Domain layer (DDD 核心) [见下]
infra/          ← 基础设施
internal/       ← 内部包
pkg/            ← 通用包
types/          ← 类型定义
```

`backend/domain/` 子目录（DDD 核心）：

```
agent/          ← Agent definition + execution
app/            ← App lifecycle
connector/      ← 外部 connector (channels / 渠道)
conversation/   ← 对话会话
datacopy/       ← 数据复制（多副本 / 备份）
knowledge/      ← Knowledge base
memory/         ← Memory
openauth/       ← OAuth / 第三方认证
permission/     ← 权限
plugin/         ← Plugin 系统
prompt/         ← Prompt 管理
search/         ← 搜索
shortcutcmd/    ← 快捷指令
template/       ← App / Bot 模板
upload/         ← 文件上传
user/           ← 用户
workflow/       ← Workflow
```

### coze-loop 后端 (`backend/modules/`)

```
data/           ← Dataset / 数据集
evaluation/     ← Evaluation engine
foundation/     ← 基础层
llm/            ← LLM 抽象
observability/  ← Trace / 观测
prompt/         ← Prompt 版本管理
```

## 8 能力轴扫描

### 1. Workflow / agent orchestration [H, studio]

- coze-studio `domain/workflow/` + `domain/agent/` 模块
- `FlowGram` 是工作流可视化 canvas（独立框架，由 Coze 出品 [M]）
- `Eino` 是 agent/workflow runtime + 模型抽象层（与 LangChain Go 同类） [M]
- README 引用："Workflow creation, modification, publishing, deletion" 完整生命周期
- coze-loop 不直接提供 workflow，但提供 workflow trace 观测

**与 local 对比**：local 有 RAG Kernel + retrieval-plan 8 lane，但没有可视化 workflow 编辑器；Coze 的"FlowGram canvas + Eino runtime"组合是 OSS 中相对成熟的方案。

### 2. Tool / plugin registry [H]

- coze-studio `domain/plugin/` 显式 plugin 模块
- README："Plugins...serve as enhanceable resources that agents utilize to address model hallucination and lack of expertise in professional fields"
- coze 平台官方 plugin marketplace（闭源，cloud only [M]）

**与 local 对比**：local 无 plugin 系统。

### 3. Knowledge base / RAG [H]

- coze-studio `domain/knowledge/` 模块
- README: "knowledge bases serve as enhanceable resources..." + "Support configuring workflows, knowledge bases, and other resources" 给 agent
- 具体 chunking / embedding / rerank 实现未读源码 [M]
- coze-loop 中 `data/` 模块管理 dataset (与 eval 协作)

**与 local 对比**：local 有完整 contextual retrieval + artifact cache + Milvus，单论 RAG 工程深度可能比 coze-studio knowledge 子域更深，但 coze 把 knowledge 当作 first-class entity 与 agent 直接绑定。

### 4. App templates / app definition [H]

- coze-studio `domain/template/` + `domain/app/` 模块
- README: "Agent building, publishing, and management" + "App development with business logic"
- 显式区分 agent / app / bot 三种实体 [M]

**与 local 对比**：local 无 app/template 抽象。

### 5. Memory / session [H]

- coze-studio `domain/memory/` + `domain/conversation/` 模块（两者分离）
- Eino 框架 [M] 包含 memory 抽象

**与 local 对比**：local 无 memory 模块。

### 6. Eval / trace / observability [H, coze-loop 主战场]

- **coze-loop `modules/evaluation/`**：dataset + evaluator + experiment 三要素
- **coze-loop `modules/observability/`**：SDK trace 上报 + 中间结果 + 异常 + trace query UI
- **coze-loop `modules/prompt/`**：prompt 版本管理 + playground 对比
- README："Systematic evaluation capabilities, enabling automated multi-dimensional testing of prompts and Coze agents' output, such as accuracy, conciseness, compliance"
- **3 语言 SDK**：external agent 可通过 SDK 接入 coze-loop 上报 trace + 跑 eval

**与 local 对比**：local 有 langsmith trace 接入（2026-05-19）+ retrieval-plan trace envelope，但缺：
- dataset / experiment / evaluator 三件套
- prompt 版本管理 + playground 对比
- 多语言 SDK external agent 接入

Coze-loop 的 eval/trace 设计是本调研中**对 local 最有借鉴价值**的一块。

### 7. Multi-tenant / workspace [M]

- coze-studio `domain/openauth/` + `domain/permission/` + `domain/user/` 暗示 multi-tenant 支持
- README 没有显式 multi-tenant 表述
- 推断：OSS 版本应支持 workspace/团队 隔离 [M]

**License 优势 vs Dify**：Coze 是纯 Apache 2.0，无 multi-tenant SaaS 商用限制。

**与 local 对比**：local 单租户。

### 8. Cost tracking [L]

- coze-loop `modules/observability/` 通常会带 token usage [L]
- 未见显式 cost 模块 [L]

**与 local 对比**：local 无 cost tracking。

## 额外发现

- **Eino 框架**：Coze 自研的 Go 版 LangChain 替代品，model abstraction + workflow runtime 一体；coze-loop 的 LLM 模块也走 Eino
  - 对本项目（TypeScript + LangChain JS）参考价值：架构思路，不可直接复用
- **FlowGram canvas**：独立 OSS 工作流可视化编辑器，理论上可独立集成进任何 web 项目（需进一步评估 license + framework 依赖）
- **3 语言 SDK** 模式：coze-loop SDK 让外部 agent 通过 trace API + eval API 接入 — local 已经有 langsmith 履行类似职责
- **shortcutcmd**：coze-studio 独有 — 快捷指令（如 `/summarize`），用户输入触发预设 workflow
- **connector**：coze-studio 显式抽象"渠道接入"（微信 / 飞书 / Slack 等）
- **datacopy**：暗示数据复制 / 多副本能力，可能用于 knowledge base 同步

## 适合参考的设计模式

| 模式 | 在 Coze 的位置 | local 是否已有 |
|------|---------------|----------------|
| Agent / App / Bot 实体分离 | studio `domain/{agent,app}/` | ❌ (MAIC/MiroFish 写死页面) |
| Prompt 版本管理 + Playground | loop `modules/prompt/` | ❌ |
| Eval = Dataset + Evaluator + Experiment | loop `modules/{data,evaluation}/` | 部分 (`golden-questions.ts` 雏形) |
| Trace SDK + 多语言客户端 | loop SDKs | 部分 (langsmith JS only) |
| Connector / Channel 抽象 | studio `domain/connector/` | ❌ |
| ShortcutCmd | studio `domain/shortcutcmd/` | ❌ |
| FlowGram canvas | studio frontend | ❌ |
| OAuth + permission 显式层 | studio `domain/{openauth,permission}/` | ❌ |
| 知识 + agent 直接绑定 | studio `domain/{knowledge,agent}/` | 部分（policy-driven） |

## 调研局限性

- coze 平台主体闭源；本调研基于 OSS 镜像 (studio + loop) 推断；平台运行时差异未量化 [confidence: L for closed parts]
- Eino / FlowGram / Hertz 三个自研框架的内部能力未读源码 [M]
- coze-studio domain/ 17 模块均未深入读单文件 [M]
- 多租户隔离实现细节未确认 [L]
- 没有 cost tracking 显式证据 [L]

## 与 Dify 对比（速览）

| 维度 | Dify | Coze |
|------|------|------|
| License | Apache 2.0 modified (multi-tenant 受限) | 纯 Apache 2.0 |
| 后端语言 | Python (Flask + Celery) | Go (Hertz + Eino) |
| 前端语言 | Next.js + TS | React + TS |
| 工作流引擎 | core/workflow (Python) | Eino + FlowGram (Go + React) |
| Eval / trace 独立产品 | 无独立项目 (`core/ops` 内嵌) | **有 (coze-loop 独立 repo)** |
| Repo 数量 | 1 monorepo | 2 (studio + loop) |
| MCP 接入 | **有 (`core/mcp/`)** | 未在 OSS 显式发现 |
| Plugin marketplace | OSS 内有 plugin 子系统 | OSS 有 plugin domain；marketplace cloud only |
| Stars | 142k | 20.8k + 5.5k = 26k |

Coze 在 eval/trace 上独立成产品（coze-loop）是与 Dify 最大的架构差异。

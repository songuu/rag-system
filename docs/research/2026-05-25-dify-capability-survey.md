---
title: "Dify 能力调研"
type: research
date: 2026-05-25
tags: [research, dify, agent-platform, rag]
aliases: ["Dify capability survey"]
sprint: 2026-05-25-coze-dify-integration-research
sources_consulted:
  - "github.com/langgenius/dify (HEAD as of 2026-05-25)"
  - "raw.githubusercontent.com/langgenius/dify/main/README.md"
  - "raw.githubusercontent.com/langgenius/dify/main/LICENSE"
confidence_levels:
  - "H = 直接来自 repo 目录 / 文件 / README 引用"
  - "M = 来自官方功能描述但未读源码"
  - "L = 模型基于目录命名 + 通用经验推断"
---

# Dify 能力调研

## 元数据

- License: **Apache 2.0 modified**（额外条款：不允许 SaaS multi-tenant 商用未授权；不允许在 web/ 删除 LOGO；商业用途其余按 Apache 2.0）
- Stars: 142,541（2026-05-25）
- 主语言: TypeScript（web/）+ Python（api/）；monorepo
- 默认分支: main
- 部署依赖（来自 README）: Docker Compose / K8s Helm / Terraform；最小 2 core + 4GB

## 仓库布局（HEAD 抓取）

| 目录 | 角色 |
|------|------|
| `api/` | Python 后端 (Flask + Celery), DDD 风格 |
| `web/` | 前端 (Next.js + TypeScript) |
| `sdks/` | 多语言客户端 SDK |
| `packages/` | 共享包 |
| `docker/` | 容器编排 |
| `enterprise/` | 企业版加载点（含 license 验证） |
| `dify-agent/` | 内部 agent runtime（具体未深读） |

后端 `api/` 子目录：clients, configs, constants, contexts, controllers, **core**, dev, docker, enterprise, enums, events, ...

后端 `api/core/` 子目录（最重要，本调研的能力面源）：

```
agent/          ← Agent runtime (ReAct / function call)
app/            ← App definition + lifecycle
base/           ← 基础抽象
callback_handler/ ← LangChain 风格回调
datasource/     ← 数据源接入
db/             ← ORM / 数据访问
entities/       ← DDD entity
errors/         ← 错误定义
extension/      ← 扩展点
external_data_tool/  ← 外部数据工具
helper/         ← 工具函数
hosting_configuration.py
indexing_runner.py   ← 文档索引主驱动
llm_generator/  ← LLM 生成
logging/
mcp/            ← Model Context Protocol 接入
memory/         ← 对话记忆
model_manager.py  ← 模型管理
moderation/     ← 内容审核
ops/            ← LLMOps 观测
plugin/         ← Plugin 系统
prompt/         ← Prompt 管理
provider_manager.py  ← 模型 provider 管理
rag/            ← RAG 子系统（见下）
repositories/   ← Repository pattern (data access)
schemas/
telemetry/      ← 遥测
tools/          ← Tool / function registry
trigger/        ← 触发器 (webhook / event)
workflow/       ← Workflow runtime
```

`core/rag/` 子目录：cleaner, data_post_processor, datasource, docstore, embedding, entities, extractor, index_processor, models, pipeline, rerank, retrieval, splitter, summary_index

`core/workflow/` 子目录: `nodes/` + node_factory.py + node_runtime.py + system_variables.py + template_rendering.py + variable_pool_initializer.py + workflow_entry.py + human_input_* (3 files)

## 8 能力轴扫描

### 1. Workflow / agent orchestration [H]

- 独立 `core/workflow/` 模块，含 node_factory / node_runtime / nodes/ / variable_pool / template_rendering
- 显式 `human_input_adapter / forms / policy` 三件套 → 支持人工介入节点
- workflow_entry + workflow_run_outputs → 入口与输出契约清晰
- 可视化 canvas 在 `web/` 前端实现（具体节点编辑 UI 未读源码 [M]）
- node 类型支持（按官方 README）: LLM / Code / Knowledge Retrieval / Tool / Question Classifier / If-Else / Iteration / Variable Aggregator / HTTP Request 等

**与 local 对比**：local 有 RAG Kernel / retrieval-plan 8 lane 类型，但没有可视化编辑器、没有 variable pool / template rendering / human input 节点。Dify 这套是"visual workflow IDE + node runtime"的成熟实现。

### 2. Tool / plugin registry [H]

- `core/plugin/` 独立模块
- `core/tools/` 模块
- `core/mcp/` MCP 协议接入 → 可挂载 MCP server 提供的 tool
- `core/external_data_tool/` 外部数据工具抽象
- README 提到 50+ built-in tools（Google Search / DALL·E / Stable Diffusion / WolframAlpha）

**与 local 对比**：local 完全没有 tool registry / plugin 系统；MCP 接入也未实现。

### 3. Knowledge base / RAG [H]

- `core/rag/` 14 个子模块，覆盖 ingestion 全链路：
  - extractor → cleaner → splitter → index_processor → docstore + embedding
  - retrieval → rerank → data_post_processor → summary_index
- `indexing_runner.py` 顶层驱动；`pipeline/` 子模块（管线编排）
- README 提到支持 PDF / PPT / 等格式
- 多 vector store backend 支持（README 未列具体清单 [M]）

**与 local 对比**：local 有 contextual retrieval / chunking / artifact-cache，但缺少 official rerank stage（前 sprint deferred）+ 缺少 summary_index + cleaner 这类显式 pipeline stage 抽象。Dify 的 `core/rag/` 14 子模块拆得比 local 细。

### 4. App templates / app definition [H]

- `core/app/` 独立模块（具体类型未深读 [M]）
- 官方提供"模板市场"（README 提到 cloud 版有公开模板 [M]，self-hosted 版未确认）
- 4 类 app type（来自官方文档 [M]）: Chatflow / Workflow / Chat Assistant / Text Generator

**与 local 对比**：local 没有 app 抽象；MAIC 课堂 / MiroFish 是写死的页面，不可模板化。

### 5. Memory / session [H]

- `core/memory/` 独立模块
- 会话内 memory 与跨会话 memory 区分（Dify 文档术语：conversation memory / agent memory [M]）

**与 local 对比**：local 有 agentic-rag / reasoning-rag 内部的轻量 conversation state，但没有抽出 memory 模块；MAIC 的 session-controller 是场景专用，未通用化。

### 6. Eval / trace / observability [H]

- `core/ops/` LLMOps 模块
- `core/telemetry/` 遥测
- `core/logging/`
- README 显式提到 "log analysis, performance tracking, continuous improvement"

**与 local 对比**：local 有 langsmith 接入（2026-05-19）+ retrieval-plan trace envelope，但缺 dataset + experiment + automated eval 这套；Dify 的 ops 模块覆盖范围比 local 大。

### 7. Multi-tenant / workspace [H]

- `enterprise/` 顶层目录暗示企业版多租户隔离
- `core/repositories/` repository pattern 通常配合 tenant-scoped query

**License 关键限制**：模仿 Dify SaaS 商用 (multi-tenant) 必须取商业 license；多租户不能直接复用 Dify 源码

**与 local 对比**：local 是单租户 Next.js 项目；MAIC 课程隔离仅按 `course_id` 字符串区分，无组织/workspace 级隔离。

### 8. Cost tracking [M]

- `core/model_manager.py` + `core/provider_manager.py` 暗示在 provider 调用层可拦截 token 计数 [L]
- README 提到 "LLMOps 监控、log 分析"，cost tracking 未显式提及 [L]
- 推断：Dify 在 model invocation 层有 token usage 记录（这是 LLMOps 必备） [L]

**与 local 对比**：local 完全无 cost tracking。

## 额外发现

- **MCP (Model Context Protocol) 接入**: Dify 已经把 MCP 当作一等公民 (`core/mcp/`) — local 尚未接入
- **Moderation**: `core/moderation/` 显式内容审核 — local 无
- **Trigger / event 系统**: `core/trigger/` 支持外部事件触发 workflow — local 无
- **Repository pattern**: 后端用了显式 repository 层（DDD 风格），与 local 的 service-per-file 模式不同
- **Provider abstraction**: `core/model_manager.py` + `core/provider_manager.py` 显式分离 model 与 provider — local 有 `model-config.ts` + `embedding-config.ts` 但耦合度更高

## License 注意事项（H, 来自 LICENSE 全文）

Dify = "modified Apache 2.0"。商用本身允许，但：

1. **multi-tenant SaaS 不允许**：除非取得商业 license，否则不可把 Dify 源码用于运营多租户服务
   - 一个 tenant = 一个 workspace，workspace 提供"separated area for each tenant's data and configurations"
2. **不可去除 LOGO**：web/ 目录下的 console / app 前端必须保留 Dify LOGO + copyright；这条对仅使用后端的场景不适用
3. **对本项目影响**：如果只借鉴架构思路 / 复制单个模块（非 web/），实际不触发额外限制；若想全量 fork → 需评估 LOGO + tenant 两条

## 适合参考的设计模式（综合）

| 模式 | 在 Dify 的位置 | local 是否已有 |
|------|---------------|----------------|
| Repository pattern | `core/repositories/` | ❌ |
| Provider/Model 双层分离 | `model_manager.py` + `provider_manager.py` | 部分（model-config.ts） |
| RAG pipeline 显式 stage | `core/rag/{cleaner,splitter,extractor,...}` | 部分（document-pipeline.ts 只统一接口） |
| Workflow variable pool + template rendering | `core/workflow/variable_pool_initializer.py` + `template_rendering.py` | ❌ |
| Human input node | `core/workflow/human_input_*` | ❌ |
| MCP 一等接入 | `core/mcp/` | ❌ |
| Trigger / event system | `core/trigger/` | ❌ |
| Moderation 显式层 | `core/moderation/` | ❌ |
| LLMOps (ops + telemetry + logging) | `core/{ops,telemetry,logging}/` | 部分（langsmith） |
| Tool registry + MCP + external_data_tool | `core/{tools,mcp,external_data_tool}/` | ❌ |

## 调研局限性

- 仅看 top-level + 1 level 目录，未读单文件内部实现 [confidence: M]
- Dify cloud 版独有功能（模板市场、workspace 公开模板）未验证 self-hosted 是否完全等价 [M]
- vector store backend 支持清单未拉取（README 未列）[M]
- workflow node 类型完整清单未抓 [M]
- enterprise/ 子目录内部结构未抓（多租户隔离实现细节）[L]

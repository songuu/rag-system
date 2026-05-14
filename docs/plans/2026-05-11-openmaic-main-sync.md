---
title: "OpenMAIC main 增量同步"
type: sprint
status: completed
created: "2026-05-11"
updated: "2026-05-11"
checkpoints: 0
tasks_total: 5
tasks_completed: 5
tags: [sprint, feature, maic, openmaic]
aliases: ["OpenMAIC main sync", "MAIC latest parity"]
---

# OpenMAIC main 增量同步

## 需求分析

上游 OpenMAIC 最新公开状态：`v0.2.1` 已于 2026-04-26 发布；`main` 分支在 v0.2.1 之后继续有增量提交。本轮已浅克隆上游 main，确认当前头提交为 `a5209d7 feat(outline-review): clickable streaming card morphs into editor (#558)`。本项目上一轮 `2026-04-28-openmaic-v021-parity-and-parse-speed.md` 已完成 v0.2.1 的轻量对齐，所以本轮不重复实现课程搜索、Deep-Interactive badge、完成页、quiz 持久化和解析缓存。

本轮目标是在本项目现有边界内继续同步上游 2026-04-27 到 2026-05-11 的可落地增量：

- 对齐最新上游事实：记录 v0.2.1 后 main 分支新增的 provider、thinking、i18n、导出容错等变更。
- 优先落地与本项目已有能力直接相连的内容：模型/提供商配置、OpenAI 兼容配置、推理 thinking 控制、导出容错、课程/课堂体验提示。
- 保留本项目 `/maic` 独立轻量实现，不全量迁入 OpenMAIC 的 provider/settings/media/video 架构。
- 不覆盖当前工作区已有未提交改动；所有修改都应在现有 MAIC、模型配置或文档范围内增量接上。

非目标：

- 不引入完整 OpenMAIC upstream 工程，不复制上游应用目录。
- 不做 HappyHorse/Lemonade/Bocha/VoxCPM2 等真实第三方服务端到端接入，除非本项目已有对应扩展点且无需新增大依赖。
- 不处理仓库中既有非 MAIC TypeScript/lint 历史问题。
- 不改 `.env.local` 内用户私密配置。

成功标准：

- 文档明确列出本轮采用的上游最新提交范围和取舍。
- 代码只同步本项目能自然承载的 OpenMAIC 增量，不制造未使用的大型抽象。
- MAIC/模型相关局部验证通过；若全量验证受既有问题阻塞，要明确记录过滤范围和残余风险。
- sprint 结束后补齐 review 与 compound 记录。

## 技术方案

上游增量按“本项目可承载程度”分三类处理：

1. 直接落地：模型/provider 兼容、模型列表元数据、课堂导出容错。
2. 轻量记录：Bocha web search、HappyHorse video adapter、OpenAI image env fallback、zh-TW locale 等缺少本项目对应入口的变更，记录为 parity matrix 和后续扩展点。
3. 明确不迁入：OpenMAIC 完整 provider settings/media/video/i18n 架构。

代码方案：

- 扩展 `src/lib/model-config.ts` 的远程 OpenAI-compatible provider 支持，新增 OpenRouter、Lemonade 的环境变量读取、创建、摘要和校验逻辑；保持 `custom` 兼容层不破坏。
- 更新 `src/app/api/ollama/models/route.ts` 的模型识别和推荐元数据，补充 OpenMAIC 最新模型族和 provider display 信息，例如 GPT-5.5、DeepSeek-V4、Xiaomi MiMo、Tencent Hy3、OpenRouter、Lemonade 及 Claude Haiku 4.5 thinking 标记。
- 把课堂 HTML 导出构建逻辑从 `OpenMaicClassroom.tsx` 抽到纯函数模块，按上游“导出遇到坏形状跳过而非中断”的思路实现 per-scene 容错：单个 scene 数据异常时导出错误占位，整份课堂仍可下载。
- 追加纯函数回归测试，覆盖 provider/env 解析、模型分类元数据和课堂导出容错。
- 文档记录上游最新提交范围与本项目取舍，避免后续再次把 v0.2.1 已完成项重复实现。

### 上游增量矩阵

| 上游增量 | 本项目处理 | 理由 |
| --- | --- | --- |
| `a5209d7` outline-review streaming card → editor | 记录，不落地 | 本项目没有 OpenMAIC generation outline editor 流程。 |
| Lemonade provider（LLM/Image/TTS/ASR） | 轻量落地 LLM/reasoning provider | 本项目已有 OpenAI-compatible `ModelFactory`，但没有图像/TTS/ASR provider 设置体系。 |
| OpenRouter provider / DeepSeek V4 thinking | 轻量落地 provider 与模型元数据 | 可复用 `ChatOpenAI` 的 OpenAI-compatible baseURL。 |
| GPT-5.5、DeepSeek V4、小米 MiMo、Tencent Hy3、GPT-OSS 等模型注册 | 轻量落地模型 catalog 元数据 | 本项目没有完整 provider registry UI，但 `/api/ollama/models` 可暴露可见元数据。 |
| Claude Haiku 4.5 thinking budget-only 修复 | 记录为模型元数据提示 | 本项目没有 Anthropic provider adapter，不能准确注入 Anthropic thinking body。 |
| Bocha web search provider | 记录，不落地 | 本项目当前没有 MAIC web-search provider 抽象。 |
| HappyHorse video adapter | 记录，不落地 | 本项目 MAIC 课堂没有生成式视频 provider 管线。 |
| OpenAI image env fallback / GPT-Image-2 | 记录，不落地 | 本项目当前没有 MAIC image generation provider 管线。 |
| zh-TW audio locale | 记录，不落地 | 本项目课堂 TTS 使用浏览器 `speechSynthesis`，没有上游 audio constants 体系。 |
| PPTX malformed SVG/path export 容错 | 轻量落地 HTML 导出 per-scene 容错 | 本项目导出是 HTML，不是 PPTX；可映射为坏 scene 跳过并写占位。 |

## 任务拆解

- [x] T1 更新上游增量矩阵，写清 2026-04-27 到 2026-05-11 的同步范围与取舍。
- [x] T2 扩展模型/provider 配置：OpenRouter、Lemonade、最新模型元数据与 thinking 标记。
- [x] T3 抽取课堂导出构建器并增加 per-scene 容错，避免单个异常 scene 中断导出。
- [x] T4 增加/更新针对性测试，覆盖 provider 解析、模型元数据、导出容错。
- [x] T5 运行局部验证并记录审查结果。

## 变更日志

- 2026-05-11: 创建 sprint，确认上一轮 v0.2.1 对齐已完成，本轮聚焦 v0.2.1 后 main 分支增量。
- 2026-05-11: 完成 Phase 2 计划，决定只落地本项目现有扩展点可承载的 provider/model/export 增量。
- 2026-05-11: 浅克隆上游 OpenMAIC main，确认最新头提交 `a5209d7`，补充增量矩阵。
- 2026-05-11: 新增 `src/lib/model-catalog.ts`，集中维护 OpenMAIC 最新 provider/model/thinking 元数据。
- 2026-05-11: 扩展 `src/lib/model-config.ts`，增加 OpenRouter、Lemonade provider，并保留 Azure 使用 `AzureChatOpenAI` 专用类。
- 2026-05-11: 更新 `/api/ollama/models`，暴露 `openMaicLatest` 元数据并复用 catalog 分类。
- 2026-05-11: 抽取 `src/lib/maic/classroom-export.ts`，实现 HTML 导出逐 scene 容错和 warning 返回。
- 2026-05-11: 新增 8 个 targeted tests，覆盖 model catalog、provider env/Azure 校验和课堂导出容错。

## 审查结果

- Phase 4 审查发现 1 个 P1 风险：Azure OpenAI 不能当作普通 OpenAI-compatible `baseURL` 处理。已修复为 `AzureChatOpenAI`，并补充缺少 deployment 的回归测试。
- `node --experimental-strip-types --test src/lib/model-catalog.test.mjs src/lib/model-config.test.mjs src/lib/maic/classroom-export.test.mjs` 通过，8/8。
- `pnpm exec eslint src/lib/model-catalog.ts src/lib/model-config.ts src/app/api/ollama/models/route.ts src/lib/maic/classroom-export.ts src/components/maic/OpenMaicClassroom.tsx` 通过。
- touched-path TypeScript 过滤检查无输出：`src/lib/model-config`、`src/lib/model-catalog`、`src/lib/maic/classroom-export`、`src/components/maic/OpenMaicClassroom`、`src/app/api/ollama/models`。
- 全量 `pnpm exec tsc --noEmit --pretty false --incremental false` 仍被仓库既有问题阻塞，主要包括 Next route params、`ask/trace-trie` 类型、MiroFish D3 类型、reasoning-rag 类型不一致、agentic-rag LangGraph 类型等；本轮 touched paths 未出现在过滤结果中。

## 复利记录

- Solution: `docs/solutions/2026-05-11-openmaic-main-provider-export-sync.md`
- Architecture rule: `.codex/rules/architecture.md` 追加 OpenAI-compatible provider boundary。
- Testing rule: `.codex/rules/testing-patterns.md` 追加 upstream parity verification。
- Skill signals: `.codex/skill-signals/sprint.jsonl`、`.codex/skill-signals/compound.jsonl` 追加本轮记录。

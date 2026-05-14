---
title: "MiroFish 架构优化"
type: sprint
status: completed
created: "2026-05-11"
updated: "2026-05-11"
checkpoints: 0
tasks_total: 5
tasks_completed: 5
tags: [sprint, architecture, mirofish, rag, multi-agent]
aliases: ["MiroFish architecture optimization"]
---

# MiroFish 架构优化

## 需求分析

用户希望“结合最新的 MiroFish，优化下架构”。这里的核心不是照搬上游 Python/Vue/OASIS 部署形态，而是在当前 Next.js + TypeScript RAG 项目中吸收 MiroFish 最新架构思想，提升本仓库已有 `src/lib/mirofish/*` 和 `/mirofish` 工作流的边界清晰度、可恢复性、可观测性和可扩展性。

### 外部基线

- 上游仓库：`666ghj/MiroFish`，GitHub 页面显示最新 release 为 `V0.1.2`，发布时间为 2026-03-07。
- 上游 README 描述的主链路是五步：Graph Building、Environment Setup、Simulation、Report Generation、Deep Interaction。
- 上游 README 强调 GraphRAG 中的 individual/collective memory injection、Agent configuration injection、dynamic temporal memory updates，以及 ReportAgent / individual agent 深度交互。
- 上游最新 `backend/app/api/simulation.py` 暴露的模拟架构已经把 `create`、`prepare`、`prepare/status`、运行、历史与报告查找拆成不同阶段；`prepare` 阶段具备 `already_prepared` 检测、`force_regenerate`、实体类型过滤、并行人设生成和分阶段进度。

参考：
- https://github.com/666ghj/MiroFish
- https://raw.githubusercontent.com/666ghj/MiroFish/main/README.md
- https://raw.githubusercontent.com/666ghj/mirofish/refs/heads/main/backend/app/api/simulation.py

### 本地现状

- 已有 5 步产品流：`/mirofish/console/[projectId]` 调度 Step1 图谱、Step2 人设与配置、Step3 SSE 模拟、Step4 报告、Step5 交互。
- 后端核心在 `src/lib/mirofish/`：`project-store`、`task-manager`、`graph-builder`、`profile-generator`、`simulation-engine`、`simulation-runner`、`report-agent`、`interaction-agent`。
- 当前运行状态主要依赖内存 store 和组件本地 state；Step2 把“生成人设”和“创建模拟”合并，缺少上游式的独立 prepare 层。
- 当前 `SimulationConfig.posts_per_round` 已定义但运行器实际主要按 `platforms × agents_per_round` 生成行为，调度语义不够清晰。
- 当前模拟上下文主要是最近帖子窗口，尚未形成显式的 temporal memory / event log / replay boundary。
- 工作区已有与 MAIC、`.codex` 规则等相关的未提交改动；本 sprint 不应回滚或重写这些改动。

### Scope

- 对 MiroFish 模块做架构级优化，优先放在 `src/lib/mirofish/*`、`src/app/api/mirofish/*`、`src/components/mirofish/*` 和配套文档/测试。
- 对齐上游最新思想：独立准备阶段、幂等状态检查、统一配置规范、事件/记忆边界、报告与交互的数据来源收口。
- 保留当前 Next.js 单体实现，不引入 Python backend、OASIS 运行时、Zep Cloud 强依赖或新的持久化数据库。
- 补足可测试的纯函数/服务边界，避免把架构优化只落在 UI 文案或散乱 route 逻辑里。

### Non-scope

- 不迁移到上游 MiroFish 的 Flask/Python/Vue 架构。
- 不新增付费外部服务作为必需依赖。
- 不重做整套 UI 视觉风格。
- 不处理当前仓库中与 MAIC 或全局 TypeScript 既有失败相关的无关问题。

### Success Criteria

- MiroFish 本地架构有清晰阶段边界：project、graph、prepare/env、simulation、report、interaction 各自职责可读。
- 配置规范、状态流转和运行调度从 route/UI 中下沉到可测试的 `lib` 层。
- 准备阶段支持幂等语义：已有 profiles/config/simulation 时可以识别并复用，必要时可强制再生成。
- 模拟运行行为能解释 `round_count`、`agents_per_round`、`posts_per_round`、platforms 的真实语义。
- 至少新增或更新覆盖核心纯逻辑的测试；若全量类型检查仍被既有问题阻塞，文档中明确记录范围内验证结果和外部阻塞。

### 风险

- 当前项目已有大量未提交改动，改动范围必须收窄，避免踩到 MAIC 正在进行的工作。
- Next.js route handler 中长任务和内存单例在 dev/prod/serverless 语义不同，不能假设内存状态天然可靠。
- 上游 MiroFish 最新功能依赖 OASIS/Zep/文件制备目录，本项目只能吸收架构模式，不能承诺同等大规模仿真能力。
- MiroFish 属 AGPL-3.0 项目；若复制上游实现代码会引入许可风险，本 sprint 只做架构借鉴和本地自实现。

## 技术方案

### 架构原则

本 sprint 采用“本地自实现 + 上游架构模式对齐”的方式，不复制上游 AGPL 实现代码，不引入 Python/OASIS/Zep 作为必需运行时。优化重点是把当前散在 UI 和 route handler 中的状态、配置、准备、运行语义下沉到 `src/lib/mirofish/`，让 Next.js route 只做参数验证和服务调用。

### 目标分层

```
src/lib/mirofish/
  types.ts                  # 公共领域模型
  config-normalizer.ts       # 模拟配置归一化与资源上限
  prepare-service.ts         # 环境准备：实体选择 -> profiles -> normalized config
  simulation-runner.ts       # 生命周期、事件、快照、统计
  simulation-engine.ts       # 单轮/单 Agent 行为生成
  report-agent.ts            # 报告生成，读取 runner 快照
  interaction-agent.ts       # Agent/report 深度交互

src/app/api/mirofish/
  simulation/prepare/route.ts # 幂等 prepare/status 入口
  simulation/route.ts         # 创建 simulation，仅接收准备后的规范输入
  simulation/[id]/route.ts    # start/stop/posts/timeline/stats
  simulation/[id]/stream      # SSE 事件流
```

### 关键设计

1. **配置归一化单独成层**
   - 新增 `normalizeSimulationConfig`，统一处理 `round_count`、`agents_per_round`、`posts_per_round`、`platforms`、`seed_topics`、`temperature`、`time_interval`。
   - `posts_per_round` 不再是“写了但不用”的字段。运行层按每轮每平台生成最多 `posts_per_round` 条内容，并由 `agents_per_round` 控制候选活跃 Agent 池。
   - route handler 不再重复散落资源上限，统一引用 config normalizer。

2. **Prepare 阶段独立且幂等**
   - 新增 `prepare-service.ts`，输入 project、graph nodes、selected entity IDs、simulation requirement、config draft、model override。
   - 生成或复用 `profiles + normalizedConfig + prepareFingerprint`。
   - 支持 `forceRegenerate`，不强制引入持久化数据库；先落到内存 store，与当前 `project-store` / `task-manager` 风格一致。
   - 新增 `/api/mirofish/simulation/prepare`：返回 `already_prepared`、`profiles`、`config`、`prepare_id`、`message`，对齐上游 prepare/status 的语义，但保持本项目轻量实现。

3. **Simulation 生命周期收口**
   - `SimulationStatus` 扩展或收紧为明确阶段：`created -> preparing/ready -> running -> paused/completed/failed`。
   - `SimulationRunner.create` 只接受已经归一化并通过准备阶段的数据。
   - runner 暴露 `getSnapshot(simulationId)`，一次性返回 info/posts/timeline/stats，供报告和 UI 读取，减少多个 API 端点重复拼状态。

4. **事件与 temporal memory 边界**
   - `SimulationEvent` 增加可恢复快照语义：连接 SSE 时先发 `connected` + 当前快照摘要，而不是只发 status/current_round。
   - `executeRound` 的上下文输入从裸 `recentPosts.slice(-20)` 收口为 `buildRoundContext`，后续可接入 dynamic temporal memory。
   - 当前 sprint 不实现复杂长期记忆后端，但把“最近帖子、热门话题、情感趋势、Agent 历史动作”定义成可测试的上下文构造函数。

5. **UI 轻改，避免重做**
   - `Step2EnvSetup` 继续承担“选择实体 + 配置参数”的体验，但调用 prepare API，拿到 profiles/config 后再创建 simulation。
   - 遵循 React/Next 性能约束：独立 fetch 并行化，避免 effect 依赖对象导致重复请求；昂贵列表过滤保持 `useMemo`。
   - 不调整整体视觉系统，只修正流程状态、按钮文案和错误信息。

### 测试策略

- 风险等级：L3。原因是涉及核心模拟生命周期、API contract 和前端工作流，但不触碰认证、支付、真实数据删除。
- L2/L3 范围内必须新增纯逻辑测试：
  - `config-normalizer.test.mjs`：验证上限、默认值、平台过滤、`posts_per_round` 语义。
  - `simulation-runner.test.mjs` 或拆出的纯函数测试：验证快照、统计、事件序列或 round context。
  - `prepare-service.test.mjs`：验证同输入幂等、`forceRegenerate`、实体过滤。
- 验证命令：
  - 目标测试：`node --experimental-strip-types --test <新增测试文件>`
  - 范围 lint：`pnpm exec eslint src/lib/mirofish src/app/api/mirofish src/components/mirofish`
  - 范围类型检查：优先 `pnpm exec tsc --noEmit --pretty false`；若仍被既有非 MiroFish 模块阻塞，记录阻塞来源。

## 任务拆解

- [x] T1 配置与状态 contract：新增/调整 MiroFish 配置归一化、准备状态、快照类型，并补纯逻辑测试。
- [x] T2 Prepare 服务与 API：新增幂等 prepare service 和 `/api/mirofish/simulation/prepare`，支持 `already_prepared` 与 `forceRegenerate`。
- [x] T3 运行器调度优化：让 `posts_per_round` 真实参与调度，新增 round context / snapshot / 事件摘要边界。
- [x] T4 前端 Step2/Step3 接入：Step2 使用 prepare API，Step3 读取 snapshot/connected 事件，保持现有 UI 风格。
- [x] T5 报告/交互读取收口与验证：报告生成读取 runner snapshot，补测试、lint、类型检查，并更新 sprint 文档。

### Gate 判断

- 任务数 5 个，不需要自动 checkpoint。
- 存在 L3 核心生命周期改动，Phase 3 前保留人工 gate。
- 开始 Work 前先跑新增目标测试的基线不可行，因为测试文件尚不存在；会在 T1 后立即执行对应测试。

## 变更日志

- 2026-05-11: 创建 sprint 文档，完成 Phase 1 需求分析。
- 2026-05-11: 完成 Phase 2 技术方案与任务拆解，确定 5 个任务和 L3 测试策略。
- 2026-05-11: 完成 T1，新增 `config-normalizer.ts`、`prepare-service.ts` 与目标测试。首次测试发现 `forceRegenerate` 仍复用旧 profiles，已修复。
- 2026-05-11: 完成 T2，新增 `/api/mirofish/simulation/prepare`，`simulation/route.ts` 支持通过 `prepare_id` 消费已准备的 profiles/config。
- 2026-05-11: 完成 T3，新增 `simulation-context.ts`，`posts_per_round` 成为每平台发帖上限，runner 暴露 snapshot 和 SSE 初始快照。
- 2026-05-11: 完成 T4，Step2 在创建模拟前调用 prepare API，Step3 并行读取 simulation detail/snapshot 并消费 SSE 初始快照。
- 2026-05-11: 完成 T5，报告和 Agent 采访 API 改为读取 runner snapshot；目标测试通过，MiroFish 范围 lint 无错误，全量类型检查仍被既有问题阻塞。

## 验证记录

- `node --experimental-strip-types --test src/lib/mirofish/config-normalizer.test.mjs src/lib/mirofish/prepare-service.test.mjs src/lib/mirofish/simulation-context.test.mjs` → pass，10 tests。
- `pnpm exec eslint src/lib/mirofish src/app/api/mirofish src/components/mirofish` → pass with 6 warnings。剩余 warnings 来自既有未触碰模块：`interaction-agent.ts`、`ontology-generator.ts`、`profile-generator.ts`、`task-manager.ts`、`text-processor.ts`。
- `pnpm exec tsc --noEmit --pretty false` → fail。阻塞来自既有非本轮问题，包括 Next 16 `api/traces` route params、`ask` / `trace-trie` / `reasoning-rag` 类型不匹配、MiroFish 旧 D3 示例页缺少 `@types/d3`、`text-processor` 未定义 parser helper、`ontology-generator` readonly 常量转换等。本轮新增的 `Step2` 参数和 `simulation-context` 类型问题已在复跑前修复。

## 审查结果

### Findings

- P1 已修复：`src/app/api/mirofish/simulation/[id]/stream/route.ts` 原实现先取 snapshot 并发送 connected，再注册 runner listener。运行中的模拟如果在这个窗口产生事件，客户端可能错过 `post_created` 或 `round_end`。已调整为在 `ReadableStream.start()` 中先注册 listener，再发送 connected snapshot。

### Open Questions

- 全量 `tsc` 仍被既有问题阻塞；本 sprint 只确认本轮新增类型问题已修复，未清理旧的 traces/Reasoning/MiroFish 示例页/D3/text-processor 等问题。
- 当前 prepare 结果仍存储在内存 project store，符合本项目现有模式，但不具备跨进程持久化能力。

### Review Validation

- `node --experimental-strip-types --test src/lib/mirofish/config-normalizer.test.mjs src/lib/mirofish/prepare-service.test.mjs src/lib/mirofish/simulation-context.test.mjs` → pass，10 tests。
- `pnpm exec eslint src/lib/mirofish src/app/api/mirofish src/components/mirofish` → pass with 6 existing warnings。

## 复利记录

### Outputs

- 解决方案：`docs/solutions/2026-05-11-mirofish-prepare-snapshot-architecture.md`
- 架构规则：`.codex/rules/architecture.md` 增加 “MiroFish: Prepare and Snapshot Boundaries”
- 测试规则：`.codex/rules/testing-patterns.md` 增加 “Contract Tests Before UI Wiring”
- Skill 信号：`.codex/skill-signals/sprint.jsonl`、`.codex/skill-signals/compound.jsonl`

### Knowledge

- 经验 2 条：prepare/snapshot 架构边界、UI wiring 前先测 lib contract。
- 本能 0 个：本轮没有用户纠正或可泛化到跨项目的强行为本能。
- Skill 信号 2 条：`sprint`、`compound`。

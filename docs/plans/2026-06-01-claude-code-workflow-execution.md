---
title: "Claude Code Workflow 执行逻辑优化"
type: sprint
status: completed
created: "2026-06-01"
updated: "2026-06-01"
checkpoints: 0
tasks_total: 3
tasks_completed: 3
tags: [sprint, workflow, execution, claude-code]
aliases: ["代码执行逻辑优化"]

invariants:
  - "RAG 能力演进优先进入 RAG Kernel / policy / retrieval control plane, 不继续堆叠 /api/ask 分支"
  - "MAIC/OpenMAIC/MiroFish 运行语义保留显式 workflow/state machine, 不替换成不透明 agent loop"
  - "LLM 多阶段流水线优化前必须重画真实数据依赖图"
  - "并发 worker 使用滑动窗口而非批次屏障, 且外部进度回调保持单调"

invariant_tests:
  - src/lib/rag/core/kernel.test.mjs
  - src/lib/maic/pipeline/prepare-runner.test.mjs
  - src/lib/maic/pipeline/page-order.test.mjs
---

# Phase 1: 需求分析

## 触发

用户请求：

> $sprint 结合最新的claude code workflow，优化下代码执行的逻辑

## 外部依据

- Claude Code Common workflows: 最新文档强调先探索代码、再 plan before editing、用 worktree 并行会话隔离改动、用 subagents 承接大范围研究，并支持非交互 `claude -p` 管道化执行。
  - https://code.claude.com/docs/en/common-workflows
- Claude Code Best practices: 最新文档强调可批量 fan-out 到文件、用 `--allowedTools` 收窄权限、auto mode 承接无中断执行、用 fresh-context adversarial review 检查 diff。
  - https://code.claude.com/docs/en/best-practices
- Claude Code Subagents: subagent 适合把会污染主上下文的检索、日志、文件读取转移到独立上下文，只回传摘要；重复 worker 应抽成项目 subagent。
  - https://code.claude.com/docs/en/sub-agents
- Claude Code Hooks / Settings: `SessionStart` 可注入开发上下文，`PostToolUse` / `Stop` 等 hooks 可承接验证与 gate；项目级 `.claude/settings.json` 是团队共享配置入口。
  - https://code.claude.com/docs/en/hooks
  - https://code.claude.com/docs/en/settings

## 仓库现状

- 项目已有 Claude Code 项目配置：`.claude/settings.json` 目前只配置了 permissions allowlist，没有项目级 hooks / subagents。
- 现有执行逻辑主要分三层：
  - `src/lib/rag/core/kernel.ts`: RAG policy 执行入口，负责 policy dispatch、trace id、envelope。
  - `src/lib/maic/pipeline/prepare-runner.ts`: MAIC 课程准备 runner，已有竞态防护、缓存、阶段并行和 SSE 事件。
  - `src/lib/mirofish/simulation-runner.ts`: MiroFish 模拟 runner，管理 lifecycle、abort、SSE listener、snapshot。
- 现有规则已明确：RAG 继续走 Kernel；复杂 workflow 保留显式状态机；并发 LLM worker 要用滑动窗口并守住进度单调。

## 范围

本 sprint 聚焦“执行逻辑”的可控性，而不是盲目引入新 agent 框架：

1. 把最新 Claude Code workflow 抽象成项目内执行契约：`explore/plan/execute/verify/review` 可观察、可恢复、可测试。
2. 优先检查并优化现有核心执行层：RAG Kernel、MAIC Prepare Runner、MiroFish Simulation Runner 的状态、错误、trace、并发和验证边界。
3. 必要时补充项目级 Claude Code 配置或文档，但只做可共享、低风险、可审查的配置，不写入本机私有 secret。
4. 增加或调整回归测试，覆盖状态转换、错误上下文、并发不变量、执行 envelope。

## 非范围

- 不修改全局 Claude Code 安装、用户级 `~/.claude`、Codex 全局 skills。
- 不引入真实“任意代码沙箱执行”能力；如果需要 Sandboxes/远程执行，另开安全架构 sprint。
- 不重写 RAG / MAIC / MiroFish 为单一 opaque agent loop。
- 不做 UI 大改版，除非 Plan 阶段确认执行状态需要最小 UI 接线。

## 成功标准

- 执行入口能明确表达：任务状态、trace id、错误上下文、验证结果或可恢复状态。
- 长耗时 runner 的竞态、取消、失败、完成事件路径可被测试覆盖。
- 与最新 Claude Code workflow 对齐的实践被固化到项目代码或项目级规则，而不是只写在对话里。
- 回归测试通过；若 repo-wide lint/type 有历史噪音，记录并执行 touched-scope 验证。

## 风险

- 需求短语“代码执行逻辑”存在歧义：可能指业务 workflow runner，也可能指 Claude/Codex 自身工作流命令。当前假设为前者，Phase 2 前可调整。
- RAG / MAIC / MiroFish 三个执行层同时动会放大风险；Plan 阶段需要选一个主线，避免跨模块泛化。
- hooks / settings 属跨用户协作配置，任何自动执行命令都必须收紧权限和可解释 gate。

## 下一 Phase 预热

关键文件: `src/lib/rag/core/kernel.ts`, `src/lib/maic/pipeline/prepare-runner.ts`, `src/lib/mirofish/simulation-runner.ts`
执行命令: `node --experimental-strip-types --test src/lib/rag/core/kernel.test.mjs`; `node --experimental-strip-types --test src/lib/maic/pipeline/prepare-runner.test.mjs`
风险预判: 先冻结主线, 避免同时改三个 runner 造成 scope creep。

# Phase 2: 技术方案

## 入场扫描 - Invariants 继承

| 子系统 | 上 sprint invariant | 本 sprint 如何保持 |
|--------|---------------------|--------------------|
| RAG Kernel | RAG 能力演进优先进入 `RAG Kernel` / policy / retrieval control plane, 不继续堆叠 `/api/ask` 分支 | 只增强 `RagKernel` 执行契约和 `/api/ask` 接线, 不新增模式分支 |
| Workflow runtime | MAIC/OpenMAIC/MiroFish 运行语义保留显式 workflow/state machine, 不替换成不透明 agent loop | 本轮不改 MAIC/MiroFish runner, 只把可复用执行契约落在 RAG Kernel |
| LLM pipeline performance | 优化前先重画真实数据依赖图; 并发 worker 用滑动窗口并守住进度单调 | 本轮不重排 LLM stage, 不触碰并发 worker 行为; invariant tests 保留 MAIC runner/page-order |

## 入场扫描 - 集成路径

| 改动点 | 触发动作 | 中间层 | 持久化 | 刷新后可见 |
|--------|----------|--------|--------|------------|
| RAG Kernel 成功 envelope | 用户调用 `/api/ask` | `resolveRagPolicyId` -> `RagKernel.execute` -> policy adapter | 无, response/header 内观测 | 是, 当前响应继续带 `x-rag-policy` / `x-rag-trace-id` |
| RAG Kernel 失败 envelope | policy adapter 抛出未处理异常 | `RagKernel.execute` catch -> typed execution error -> route catch | 无, error 对象携带 envelope | 是, route 500 响应 header 带同一 trace/policy |

## 入场扫描 - 债务清单

| 来源 sprint | 议题 | 本 sprint 决策 | deadline |
|-------------|------|----------------|----------|
| 2026-05-14 RAG Kernel Implementation | Kernel 只有成功 envelope, 失败时 route 只能看到裸错误 | 本 sprint 解决 | 2026-06-01 |
| 2026-05-19 LangSmith latest | Sandboxes / Context Hub 只作未来预留, 不进入 RAG 热路径 | 明确推迟, 本轮不做远程代码沙箱 | 2026-08-01 |

## 主线选择

本轮只改 `RAG Kernel` 主线。理由：

1. 它已经是 `/api/ask` 的统一执行入口, 与“代码执行逻辑”最贴合。
2. 最新 Claude Code workflow 的关键不是把所有事交给 agent, 而是让执行可计划、可审查、可观测、可失败恢复; Kernel envelope 正好是这个承载点。
3. MAIC/MiroFish runner 已有较多并发和 lifecycle 规则, 本轮同时修改会把 L2 变成 L3+。

## 任务拆解

- [x] T1 `src/lib/rag/core`: 给 `RagKernelEnvelope` 增加执行状态和失败错误摘要; 新增 typed execution error, 让失败路径保留 trace/policy/duration/retrieval plan。
- [x] T2 `src/app/api/ask/route.ts`: 在顶层 catch 识别 typed execution error, 500 响应也附带 `x-rag-policy` / `x-rag-trace-id`, 保持 JSON body 兼容。
- [x] T3 `src/lib/rag/core/kernel.test.mjs`: 增加成功状态、失败 envelope、route 可用错误字段的回归测试; 跑 invariant tests。

## 验证策略

风险等级: L2。

原因: 修改共享执行层, 但不改检索排序、业务响应语义、数据持久化或外部服务调用。

验证命令:

- `node --experimental-strip-types --test src/lib/rag/core/kernel.test.mjs`
- `node --experimental-strip-types --test src/lib/maic/pipeline/prepare-runner.test.mjs`
- `node --experimental-strip-types --test src/lib/maic/pipeline/page-order.test.mjs`
- scoped type/lint 视改动范围执行; 若 repo-wide 噪音出现, 记录 blocker。

## Auto Gate

`✓ auto: phase 2 -> 3`

依据: 任务数 3, 无 L3/L4, 不涉及 destructive / 安全 / 数据迁移, 入场 checklist 三项已填写, scope 与 Phase 1 一致。

# Phase 3: Work

## 变更日志

- `src/lib/rag/core/types.ts`
  - `RagKernelEnvelope` 新增 `status: completed | failed`。
  - 新增 `RagKernelErrorSummary`, 失败 envelope 可携带错误类型和消息。
- `src/lib/rag/core/kernel.ts`
  - 成功路径统一通过 `createEnvelope()` 创建 envelope。
  - policy 未处理异常会被包装成 `RagKernelExecutionError`, 保留 `originalError` 和完整 envelope。
  - 失败路径使用默认 retrieval plan, 仍保留 trace id、policy id、duration、policy description。
- `src/app/api/ask/route.ts`
  - 顶层 catch 识别 `RagKernelExecutionError`, 500 响应也附带 `x-rag-policy` / `x-rag-trace-id`。
- `src/lib/rag/core/kernel.test.mjs`
  - 覆盖成功 envelope status。
  - 新增失败包装回归测试, 验证 trace/policy/error/metadata/retrieval plan。

## 验证

- `node --experimental-strip-types --test src/lib/rag/core/kernel.test.mjs` -> pass (4/4)
- `node --experimental-strip-types --test src/lib/maic/pipeline/prepare-runner.test.mjs` -> pass (2/2)
- `node --experimental-strip-types --test src/lib/maic/pipeline/page-order.test.mjs` -> pass (8/8)
- `pnpm exec eslint src/lib/rag/core/kernel.ts src/lib/rag/core/types.ts src/app/api/ask/route.ts` -> pass
- `pnpm exec tsc --noEmit --pretty false` -> pass

备注: Node test runner 仍输出既有 `MODULE_TYPELESS_PACKAGE_JSON` warning; 本 sprint 不改 package module type。

# Phase 4: Review

## 5 + 1 视角

| 视角 | 结论 | 说明 |
|------|------|------|
| 架构 | pass | 继续通过 RAG Kernel 承接执行契约, 没有新增 `/api/ask` 模式分支 |
| 安全 | pass | 不新增外部命令执行、沙箱、权限或 secret; 错误暴露级别与原 route 既有 `details` 行为一致 |
| 性能 | pass | 只在成功/失败收口创建小对象, 不改变检索/LLM 热路径 |
| 代码质量 | pass | envelope 创建逻辑集中, 错误包装类型清晰 |
| 测试覆盖 | pass | 新增失败回归测试, invariant tests 通过 |
| 集成连续性 | pass | `RagKernelEnvelope` 无其他手写构造点; MAIC runner/page-order invariant tests 通过; 无 dead code export |

P0: 无。

P1: 无。

# Phase 5: Compound

## 复利记录

- Solution: `docs/solutions/2026-06-01-rag-kernel-execution-envelope.md`
- Architecture rule: `.codex/rules/architecture.md` 新增 "RAG Kernel Failures Need Envelopes"。
- Skill signals: `.codex/skill-signals/sprint.jsonl`, `.codex/skill-signals/compound.jsonl`。

## 收尾

- Checkpoints: 0。
- Auto mode: phase 2 -> 3 自动通过; phase 4 无 P0/P1, 自动进入 compound。
- Context: 本轮探索 + 实现完整结束, 建议后续可 `/compact`。

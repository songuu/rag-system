# Project-Wide Sprint Audit - 2026-05-15

## Goal

全方位检查当前 RAG 项目是否还存在阻塞级、性能级、架构级和设计级问题，并把验证证据沉淀为后续修复顺序。

## Repair Status - 2026-05-15 Direct Fix

本轮已直接修复 P0 阻塞项，并把构建链路从“被 TypeScript 绕过”恢复为真实门禁：

- 依赖树已通过 `pnpm install --frozen-lockfile` 对齐；`next` 实际版本恢复为 `Next.js v16.2.2`，`d3` 与 `@types/d3` 可解析。
- `next.config.ts` 已移除 `typescript.ignoreBuildErrors`，`pnpm build` 现在会真实运行 TypeScript。
- `npx tsc --noEmit --pretty false --incremental false` 通过。
- `pnpm build` 通过，并且已清理此前 `next.config.ts` 被错误纳入 NFT trace 的 Turbopack warning。
- `node --test` 在沙箱外通过：55 tests, 55 pass。
- 与本轮 trace/config 修复直接相关的 file-scoped lint 已通过；全量 `pnpm exec eslint --quiet` 仍失败，剩余 405 个历史质量债错误，主要集中在 `any`、React compiler 纯度/Hook 规则、`prefer-const` 和 JSX 转义。

后续不应再把 P0 构建/类型/测试失败和 lint 质量债混在一起处理。下一轮建议单独开 lint hardening sprint，先从 React compiler 规则和共享 contract 类型抽取开始。

## Post-Fix Validation Matrix

| Check | Result | Evidence |
| --- | --- | --- |
| `pnpm exec next --version` | Pass | `Next.js v16.2.2` |
| `Test-Path node_modules\d3` / `pnpm list d3 --depth 0` | Pass | `d3@7.9.0` installed |
| `npx tsc --noEmit --pretty false --incremental false` | Pass | No TypeScript errors |
| `pnpm build` | Pass | Next 16.2.2 production build completed; no Turbopack NFT warning after file-trace narrowing |
| `node --test` | Pass | 55 tests, 55 pass; sandbox run needs escalation on Windows because of `spawn EPERM` |
| `pnpm exec eslint --quiet` | Fail | 405 errors remain; this is now P1/P2 quality debt rather than P0 build blocker |
| `git diff --check` | Pass with line-ending warnings | No whitespace errors; Git reports LF -> CRLF warnings on Windows |

## Initial Executive Status

当前项目仍存在明显问题，不建议认为已经达到可稳定发布状态。最核心的问题不是单点 bug，而是 build/type/test/lint 四个质量门禁同时失效或被绕过：

- `pnpm build` 当前失败。
- `npx tsc --noEmit --pretty false --incremental false` 当前失败。
- `pnpm exec eslint .` 当前失败，报告 551 个问题。
- `node --test` 当前有 1 个回归测试失败。
- `next.config.ts` 仍开启 `typescript.ignoreBuildErrors: true`，导致 TypeScript 合同漂移不会阻断构建。

## Initial Validation Matrix

| Check | Result | Evidence |
| --- | --- | --- |
| `pnpm build` | Fail | `next build` 无法解析 `d3`，阻塞 `src/app/mirofish/entity-extraction/page.tsx`、`src/app/mirofish/graph-rag/page.tsx`、`src/app/mirofish/process/page.tsx` |
| `npx tsc --noEmit --pretty false --incremental false` | Fail | Next 16 route params、LangGraph annotation、MiroFish parser、observability、D3 typings、页面 state literal 等多处类型错误 |
| `pnpm exec eslint .` | Fail | 551 problems: 381 errors, 170 warnings |
| `node --test` | Fail | 55 tests total, 54 pass, 1 fail: `src/lib/maic/pipeline/plan-stage-actions.test.mjs` |
| `pnpm exec next --version` | Drift | 实际输出 `Next.js v16.1.1`，但 `package.json` 和 lockfile 指向 Next `16.2.2` |
| Local dependency state | Drift | `package.json` 声明 `d3`, lockfile 存在 `d3@7.9.0`, 但 `node_modules/d3` 不存在且 `pnpm list d3 --depth 0` 无输出 |

## P0 Blockers

### P0.1 Local Dependency State Is Not Reproducible

`package.json:33` 声明了 `d3`, `pnpm-lock.yaml` 也包含 `d3@7.9.0`, 但本地 `node_modules` 没有安装该包；同时 `package.json:40` / lockfile 指向 Next `16.2.2`, 本地执行版本却是 `16.1.1`。这解释了为什么当前 build 直接在 D3 页面上失败，也说明本地依赖树和锁文件已经脱节。

修复顺序：

1. 先执行一次受控 `pnpm install --frozen-lockfile`，确认 `node_modules` 与 lockfile 对齐。
2. 再复跑 `pnpm build` 和 `pnpm exec next --version`。
3. 如果仍缺 `@types/d3`，补充 dev dependency 或改为精确局部类型声明。

### P0.2 TypeScript Gate Is Disabled While Type Errors Are Real

`next.config.ts:33` 开启 `ignoreBuildErrors: true`。这会让 TypeScript 错误不阻断 Next build，但当前 `tsc` 错误已经覆盖运行时合同：

- `src/app/api/traces/[traceId]/route.ts:7` 和 `src/app/api/traces/[traceId]/feedback/route.ts:7` 仍使用旧式同步 `params`，不符合当前 Next generated validator。
- `src/lib/intent-router.ts:114` 的 LangGraph annotation 缺少当前 API 期望的 reducer/value 语义。
- `src/lib/context-management.ts:424`、`541`、`618` 使用 `ChatOllama` 类型但未形成可解析导入合同。
- `src/lib/mirofish/text-processor.ts:44` 到 `56` 调用了未定义的 parser helper。
- `src/lib/rag-milvus.ts:186` 和 `214` 调用 `ObservabilityEngine.startTrace/endTrace`，但 `src/lib/observability.ts:119` 附近实际暴露的是 `createTrace` 风格 API。

修复顺序：

1. 先修复 Next 16 route handler params。
2. 再统一 LangGraph v1 Annotation 写法。
3. 再统一 parser、observability、retrieval result 等跨模块合同。
4. 最后关闭 `ignoreBuildErrors`，把 `tsc` 恢复为真实 gate。

### P0.3 MAIC/OpenMAIC Action Contract Has A Regression

`node --test` 失败在 `src/lib/maic/pipeline/plan-stage-actions.test.mjs:20`。测试期望 slide action sequence 为：

```text
speech, spotlight, laser, highlight, annotation
```

实际返回：

```text
speech, spotlight, laser, whiteboard, discussion
```

这不是单纯测试语法问题，而是 OpenMAIC-style teaching annotation action 的产品合同和当前 `buildCourseStage()` 输出不一致。需要决定是测试代表正确产品语义，还是 2026-05-14 的 focus strategy 改动改变了合同；决定后补齐迁移测试。

## P1 Architecture And Performance Risks

### P1.1 RAG Contracts Are Duplicated Across Pages, Components, And Libs

同类类型在多个层重复定义，例如：

- `RetrievedDocument`: `src/lib/agentic-rag.ts:50`, `src/lib/context-management.ts:66`, `src/lib/reasoning-rag.ts:76`, `src/components/ReasoningRAGVisualizer.tsx:21`。
- `KnowledgeGraph`: `src/lib/entity-extraction.ts:77`, `src/components/KnowledgeGraphViewer.tsx:39`, `src/app/entity-extraction/page.tsx:37`, `src/app/mirofish/entity-extraction/page.tsx:53`。
- `ThinkingStep`: `src/lib/reasoning-rag.ts:66`, `src/lib/reasoning-indexeddb.ts:7`, `src/components/ThinkingChainDisplay.tsx:7`, `src/components/ThinkingProcessCollapsible.tsx:5`。

这会让 API 返回、页面渲染、IndexedDB、LangGraph state 各自漂移，是当前类型错误和 UI 兼容问题的根因之一。

### P1.2 Milvus Query Hot Path Still Has Stats Calls Outside The Newly Optimized Route

前一轮已经优化了 `/api/milvus` 搜索路径，但其他 RAG 查询路径仍在查询时调用 `getCollectionStats()`：

- `src/app/api/ask/route.ts:328`
- `src/lib/reasoning-rag.ts:779`
- `src/lib/lane-handlers.ts:226` 和 `514`
- `src/lib/agentic-rag.ts:571` 和 `845`
- `src/lib/context-management.ts:656`

这些调用会把 schema/stats 获取混入查询延迟。Milvus 维度和 index metadata 应在 collection manifest 或 adapter warm cache 中维护，查询路径只做 embedding、search 和 result shaping。

### P1.3 Runtime Logging Is Too Noisy For Hot Paths

`rg -c "console\\." src/app src/lib src/components` 显示大量运行时日志集中在 RAG、Milvus、Reasoning、API route 和页面中。例如 `src/lib/reasoning-rag.ts` 有 50 处 console，`src/lib/milvus-client.ts` 有 61 处，`src/lib/adaptive-entity-rag.ts` 有 47 处。调试期可接受，但作为默认路径会影响 server log 信噪比和请求吞吐，也会暴露模型、查询和内部配置。

修复方向：引入统一 logger，按 `debug/info/warn/error` 和 feature flag 控制；查询热路径默认只输出 trace id、duration、result count。

### P1.4 Client Bundles Pull Heavy Visualization Directly

三个 MiroFish 页面静态导入 D3：

- `src/app/mirofish/entity-extraction/page.tsx:5`
- `src/app/mirofish/graph-rag/page.tsx:5`
- `src/app/mirofish/process/page.tsx:6`

D3 force simulation 只在可视化区域需要，建议改为懒加载组件或动态 import，并把 graph rendering 从页面状态机中拆出，避免首屏和非可视化 tab 都承担可视化成本。

## P2 Design And Maintainability Risks

### P2.1 Page Components Are Too Large

当前最大文件显示多个页面同时承担数据加载、状态管理、业务流程和 UI 编排：

- `src/app/milvus/page.tsx`: 2205 lines
- `src/app/page.tsx`: 1753 lines
- `src/app/adaptive-entity-rag/page.tsx`: 1682 lines
- `src/app/reasoning-rag/page.tsx`: 1489 lines
- `src/app/mirofish/process/page.tsx`: 1379 lines

这会放大回归风险，也让性能优化只能局部打补丁。建议按 `container + hooks + panels + domain components` 拆分，并把 API payload 类型从页面内移动到共享 schema。

### P2.2 Dynamic Tailwind Class Names Will Be Missed By Static Extraction

以下动态 class 无法被 Tailwind 静态扫描稳定捕获：

- `src/app/milvus/page.tsx:1522`
- `src/components/AgenticWorkflowPanel.tsx:172`
- `src/components/QueryAnalysis.tsx:282`
- `src/components/QueryAnalysis.tsx:283`

这会造成生产样式随机缺失。应改为显式 class map。

### P2.3 Visual System Is Fragmented

同一产品里同时存在浅色主首页、深色 Milvus 控制台、深色 Adaptive Entity 页面、彩色渐变导航、Font Awesome icon、lucide icon、内联 SVG 和手写图表。对于 RAG 操作台，更适合统一成密集、可扫描、可重复操作的工具型界面，而不是每个能力页独立一套视觉主题。

建议优先建立：

- 统一 app shell / nav。
- 统一 panel、metric、toolbar、model selector、query form、trace viewer。
- 统一 loading/error/empty state。
- 统一 chart wrapper 和 dynamic import 策略。

## Remediation Order

1. **恢复依赖一致性**：`pnpm install --frozen-lockfile`，确认 Next 和 D3 安装状态。
2. **恢复可构建状态**：先解决 D3 module resolution，再复跑 `pnpm build`。
3. **恢复类型门禁**：修 Next route params、LangGraph annotations、parser helpers、observability method contract，然后关闭 `ignoreBuildErrors`。
4. **修复 MAIC 回归测试**：明确 `highlight/annotation` 与 `whiteboard/discussion` 的产品合同。
5. **统一核心类型合同**：抽出 `src/lib/rag/contracts.ts` 或分域 contracts，消除页面和组件重复 interface。
6. **继续 Milvus 热路径治理**：把 stats/schema/dimension 获取迁到 manifest 或 adapter warm cache。
7. **性能清理**：D3 懒加载、console logger 分级、巨大页面拆分。
8. **设计系统收敛**：统一 shell、panel、toolbar 和图表组件，减少每页自带主题。

## Definition Of Done For The Next Repair Sprint

最低修复线：

- `pnpm build` pass。
- `npx tsc --noEmit --pretty false --incremental false` pass，或只剩明确登记且不被 `ignoreBuildErrors` 掩盖的外部 blocker。
- `node --test` pass。
- 至少 file-scoped eslint pass for touched files。
- Milvus 查询路径不再在正常 search 请求里同步刷新 stats/schema。

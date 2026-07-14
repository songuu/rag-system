---
title: "最近迭代审查：LangChain Runnable 迁移 + liteparse PDF"
type: audit
status: implemented
created: "2026-06-15"
updated: "2026-06-15"
scope_commits:
  - "c38338e feat(rag): migrate RAG workflows to LangChain runnables"
  - "c612e0e feat: deps upgrade + @llamaindex/liteparse PDF parsing"
tags: [audit, rag, langchain, migration, liteparse, review]
aliases: ["recent-iteration-audit"]
verdict: "no-P0-no-P1; migration functionally correct; audit gaps fixed in follow-up implementation"
ground_truth:
  tsc: "npx tsc --noEmit --pretty false --incremental false -> exit 0"
  tests: "14/14 changed+migration-critical *.test.mjs pass"
  eslint: "9 core migrated files -> exit 0"
  build: "pnpm build pass (per migration solution doc)"
implementation_ground_truth:
  tsc: "npx tsc --noEmit --pretty false --incremental false -> exit 0"
  targeted_tests: "langchain workflow, state workflow, rerank wrapper, pdf parser, rag kernel -> pass"
  targeted_eslint: "changed audit implementation files -> exit 0"
  build: "pnpm build -> exit 0"
  full_lint: "pnpm lint -> existing unrelated repo debt, changed files clean via targeted eslint"
method: "6-dimension parallel review + adversarial verify (19 agents); 11 confirmed, 2 refuted"
---

# 最近迭代审查报告

## 范围

- `c38338e`：旧 LangGraph `StateGraph` / `Annotation.Root` runtime 从 Agentic / Self-Corrective / Reasoning RAG + Intent Router 移除，统一改为 LangChain `RunnableLambda` 编排；新增 `src/lib/rag/core/langchain-state-workflow.ts` 共享 helper。
- `c612e0e`：依赖升级 + `@llamaindex/liteparse@2.0.4` PDF 解析（`src/lib/pdf-parser.ts` + 本地 `.d.ts`）。

## 结论

**无 P0 / 无 P1。迁移功能正确**：无运行时崩溃、无死循环、无 export 契约破坏、无 SSE debug 字段泄露。

Ground-truth 全过：`tsc --noEmit` clean、14/14 测试 pass、eslint clean、`pnpm build` pass。

深审（6 维 × 对抗验证，19 agents）确认 11 条问题，全为健壮性/质量/卫生级别（6×P2 + 5×P3），多数当前被掩盖（masked），非 live bug；驳回 2 条误报。

> 后续决策：2026-06-15 已按本文执行修复，实施记录见文末。

## P2 — 健壮性/质量缺口

### P2-1 recursionLimit 安全网静默失效
- **位置**：`src/lib/agentic-rag.ts:1120-1139`（call sites `:1241` / `:1318`，type `:308`/`:312`）
- **问题**：旧图由 LangGraph 在运行时强制 `recursionLimit:30`（超限抛 `GraphRecursionError`），是独立于 `shouldRewrite`/`retryCount` 业务逻辑的兜底。迁移后新手写闭包只解构 `config`、**从不读取 `recursionLimit`**；`{recursionLimit:30}` 仍在 call site 传入、type 成员仍在 → 误导"上限仍生效"。循环现在只靠 `while (shouldRewrite && retryCount<=1)`。当前边界正确（非 live 死循环），但独立兜底丢失，未来 `gradeRetrieval` 记账回归会导致空转而非被 30 截断。
- **修复**：加显式 `MAX_ITERATIONS=30` 计数器（超限以 error state patch 退出），或消费传入的 `recursionLimit`，或移除误导性 arg + type 成员。

### P2-2 SC-RAG rewrite 失败路径行为漂移
- **位置**：`src/lib/self-corrective-rag.ts:867-871`
- **问题**：旧图 `rewrite→retrieve` 是**无条件边**，rewrite 失败返回 `shouldContinue:false` 被忽略，仍会再 retrieve+grade 一轮才到 generate。新线性循环在 `:868` **立即 break 跳 generate**，跳过那一轮 retrieve+grade，generate 消费的是上一次 grade 的 `filteredDocuments`。新行为可能更优，但是**未文档化的语义变化**。
- **修复**：确认意图。需与旧图对齐则失败后 `continue` 而非 `break`；否则文档化。无论哪种，补回归测试断言 rewrite 失败仍产出 generate 且不无界循环。

### P2-3 ⚠️ 工具网关安全 guard 失效 + 未捕获 JSON.parse（唯一有运行时风险）
- **位置**：`src/lib/reasoning-rag.ts:1287-1294`（关联 `:729`、`:620-668`、`:873`）
- **问题**：`toolGatewayNode` 对**非法工具名 / SQL 注入 / arg 解析失败**返回 `shouldContinue:false`。迁移后 tool 块是直线序列，只在 orchestrator 后（`:1283`）检查一次，**stage 间不再复查 `shouldContinue`** → gateway 拒绝后仍调用 `hybridRetrieval`；其 `:729` `JSON.parse(decision.toolCalls[0].function.arguments)` 在 try **之外**，畸形 args 抛**未捕获错误**（可致 500），且 SQL 注入/非法工具拒绝实际**非阻塞**。注：非迁移引入（旧图也是无条件边），但迁移漏修。
- **修复**：每个 tool stage 后加 `if (!state.shouldContinue) return mergeReasoningState(state, await generator.invoke(state, config));`，让 gateway 拒绝真正短路；将 `:729` JSON.parse 移入 try 或加守卫。

### P2-4 applyStatePatch append 合并按引用泄露
- **位置**：`src/lib/rag/core/langchain-state-workflow.ts:38-54`
- **问题**：append 分支要求 `state[key]` 与 `patch[key]` 都是数组。当 append 键未预初始化（`undefined`）时，guard 失败、append 被跳过，`next[key]` 保留 `{...state,...patch}[key]` = **patch 数组的引用**，后续 mutate 会回流污染 patch。旧 LangGraph channel 用 `reducer:(a,b)=>[...a,...b], default:()=>[]` 保证总是新数组。迁移把 default-init 责任移出 helper 到各调用方，helper 不再自保护。当前所有调用方都 init `[]` 故被掩盖。
- **修复**：`const base = Array.isArray(currentValue) ? currentValue : []; if (Array.isArray(patchValue)) next[key] = [...base, ...patchValue];` 在 helper 内恢复 `default:()=>[]` 语义。

### P2-5 rerank-providers.ts 完全孤立死代码
- **位置**：`src/lib/rag/retrieval/rerank-providers.ts:1-293`
- **问题**：293 行（`SiliconFlowReranker`/`CohereReranker`/`VoyageReranker` + `buildReranker()` + `isRerankerConfigured()`）**零引用**，未在 `rag/index.ts` 导出；注释声称由"上游 `rerank.ts` wrapper"消费但**该文件不存在**。真实 rerank 走 `adaptive-entity-rag.ts:1432`（LLM rerank）+ `post-process.ts:41`（mmrRerank）。属 2026-05-25 rerank-cost-tracking 计划遗留，非本次迁移。
- **修复**：二选一——(a) 建 `rerank.ts` wrapper（try/catch 降级原序）接线 + index.ts 导出 + smoke test；或 (b) 删除。

### P2-6 重写循环 + 路由零回归测试
- **位置**：`src/lib/self-corrective-rag.ts:861-869`、`agentic-rag.ts:1130/1153`、`intent-router.ts:231-254`
- **问题**：手写 while 循环替代了 StateGraph `recursionLimit`，终止仅靠 `currentRewriteCount < maxRewriteAttempts`。无任何测试 import `executeSCRAG`/`buildSCRAGGraph`/`AgenticRAGSystem`/`createAgenticRAG`；迁移测试只做静态 regex + quick-match 路由，未驱动循环边界、flag 漂移非终止、intent-router LLM 失败 Lane-2 fallback。审计文档自己点过这个缺口，迁移未补。
- **修复**：graph 级测试——以"始终失败的 grade"驱动 `buildSCRAGGraph`/`AgenticRAGSystem` 断言尊重 `maxRewriteAttempts` 退出；以 fake router model + 无关键词 query 断言 Lane-2 fallback。

## P3 — 卫生/潜在

| # | 位置 | 问题 | 修复 |
|---|------|------|------|
| P3-1 | `self-corrective-rag.ts:851-874`、`reasoning-rag.ts` | `buildSCRAGGraph`/`buildReasoningRAGGraph` 返回值从真 Runnable 窄化为 `{invoke}`（丢 `.stream/.batch/.getGraph`）。无当前调用方，潜在契约收窄。 | 用 `RunnableLambda.from(...)` 包装，或文档化仅支持 invoke |
| P3-2 | `intent-router.ts:119-124,374-388` | `buildIntentRouterGraph()` 同样窄化为 `{invoke}`。迁移文档称 invoke 契约保留但未提周边 surface 丢失。 | 同上 |
| P3-3 | `src/types/llamaindex-liteparse.d.ts:1-33` | 本地 ambient decl 与包自带 `dist/lib.d.ts` 冲突：杜撰 `outputFormat:'markdown'`（真实仅 `'json'|'text'`）、`text/textItems` 错配 optional、漏 `pageNum/width/height`。但它 shadow 了包类型、接口是死的（仅自引用）、`tsc` 不报错。 | **删除该 .d.ts**，用包自带类型 |
| P3-4 | `pdf-parser.ts:108-135` | liteparse 路径忽略 `includeMetadata`，静默丢 title/author/createdAt（→ filename/undefined/now()）。liteparse API 本就无元数据（非迁移引入；默认 provider 是 pdf-parse，opt-in 才触发）。 | `includeMetadata` 但 provider 无法提供时打一行 warning |
| P3-5 | `intent-router.ts:120-127` 等 | 迁移新增 3 个 workflow interface（`IntentRouterWorkflow`/`SCRAGWorkflow`/`ReasoningRAGWorkflow`）`export` 但无外部消费者。 | 去掉 `export` 或加消费者 |

## 驳回的误报

1. **"liteparse 原生二进制 Win 缺失致 import 崩溃"**（曾判 P1）→ **驳回**。本机（win32 x64 / MSYS Node）实测 `import('@llamaindex/liteparse')` + `new LiteParse(...)` + `parse(<1页PDF>)` 全成功，Linux `.node` 在此环境可加载。残留仅泛化的跨平台可移植性提示（缺 preflight 健康检查），P3 级。
2. **"空/扫描 PDF 输出 form-feed 假成功"**（曾判 P3）→ **驳回**。前提错误：`String.prototype.trim()` **包含 U+000C form feed**，`"\f".trim()===""`；`normalizeParsedPdfText` 末尾 `.trim()` 对全空多页 PDF 产出 `""`；且 `mirofish/upload/route.ts:56` 二次 `trim()` 后 `if(!text)` 返回 422，无 bug。

## 优先级建议

1. **P2-3**：唯一有真实运行时风险（未捕获 JSON.parse + 安全 guard 失效）。
2. **P2-1 / P2-4**：廉价防御加固，恢复迁移前不变量。
3. **P2-6**：审计文档点名却未补的回归测试。
4. **P2-2**：确认意图 + 文档化。
5. **P2-5 / P3-***：死代码处置与卫生清理。

## 实施记录 — 2026-06-15

| 审计项 | 处理 | 文件 |
|--------|------|------|
| P2-1 | `AgenticRAGSystem` 消费 `recursionLimit`，给 rewrite loop 加独立上限和 error state patch | `src/lib/agentic-rag.ts` |
| P2-2 | `rewrite` 失败后保持旧 LangGraph `rewrite -> retrieve` 无条件边语义，仍受 `maxRewriteAttempts` 约束 | `src/lib/self-corrective-rag.ts` |
| P2-3 | `toolGateway` / `hybridRetrieval` / `reranker` 后复查 `shouldContinue`；`hybridRetrieval` JSON.parse 移入 guard | `src/lib/reasoning-rag.ts` |
| P2-4 | `applyStatePatch` append 键未初始化时按空数组合并，避免 patch 引用泄露 | `src/lib/rag/core/langchain-state-workflow.ts` |
| P2-5 | 新增 `rerank.ts` wrapper，provider 失败降级原序，并从 `rag/index.ts` 导出 | `src/lib/rag/retrieval/rerank.ts`, `src/lib/rag/index.ts` |
| P2-6 | 增加迁移关键回归测试：Runnable surface、recursionLimit guard、Reasoning tool 短路、state append、rerank fallback | `src/lib/langchain-workflow-migration.test.mjs`, `src/lib/rag/core/langchain-state-workflow.test.mjs`, `src/lib/rag/retrieval/rerank.test.mjs` |
| P3-1 / P3-2 | `buildSCRAGGraph` / `buildReasoningRAGGraph` / `buildIntentRouterGraph` 改回真实 `RunnableLambda` surface | `src/lib/self-corrective-rag.ts`, `src/lib/reasoning-rag.ts`, `src/lib/intent-router.ts` |
| P3-3 | 删除本地 `@llamaindex/liteparse` ambient shadow，改用包自带类型 | `src/types/llamaindex-liteparse.d.ts`, `src/lib/pdf-parser.ts` |
| P3-4 | `liteparse + includeMetadata` 明确 warning：provider 不暴露 title/author/createdAt | `src/lib/pdf-parser.ts` |
| P3-5 | workflow interface 去掉无消费者的 `export` | `src/lib/self-corrective-rag.ts`, `src/lib/reasoning-rag.ts`, `src/lib/intent-router.ts` |

验证：

```bash
node src/lib/langchain-workflow-migration.test.mjs
node src/lib/rag/core/kernel.test.mjs
node src/lib/rag/core/langchain-state-workflow.test.mjs
node src/lib/rag/retrieval/rerank.test.mjs
node src/lib/pdf-parser.test.mjs
npx tsc --noEmit --pretty false --incremental false
pnpm exec eslint src/lib/agentic-rag.ts src/lib/self-corrective-rag.ts src/lib/reasoning-rag.ts src/lib/intent-router.ts src/lib/pdf-parser.ts src/lib/rag/core/langchain-state-workflow.ts src/lib/rag/retrieval/rerank.ts src/lib/langchain-workflow-migration.test.mjs src/lib/rag/core/langchain-state-workflow.test.mjs src/lib/rag/retrieval/rerank.test.mjs src/lib/pdf-parser.test.mjs
pnpm build
```

备注：`pnpm lint` 全仓仍失败，失败来自既有 unrelated lint debt（如 `src/app/adaptive-entity-rag/page.tsx`、`src/lib/context-management.ts`、`src/lib/observability.ts` 等）；本次变更文件已通过 targeted eslint。

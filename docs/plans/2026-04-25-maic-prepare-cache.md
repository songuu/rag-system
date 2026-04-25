---
title: "MAIC 初始化缓存与 RAG 融合"
type: sprint
status: completed
created: "2026-04-25"
updated: "2026-04-25"
checkpoints: 0
tasks_total: 5
tasks_completed: 5
tags: [sprint, feature, maic, cache, rag]
aliases: ["MAIC prepare cache"]
---

# MAIC 初始化缓存与 RAG 融合

## 需求分析

用户反馈 MAIC 初始化过程很慢，需要做数据缓存，并更好地融入当前 RAG 系统，保证从上传、解析、准备到课堂使用的完整链路。成功标准是：同一份课程资料再次上传或准备时能命中缓存，跳过昂贵的 LLM 准备阶段；MAIC 解析文本进入现有 RAG 上传资料体系；准备页事件顺序仍完整、可解释。

## 技术方案

- 用课程内容指纹 + 当前 LLM 配置 + 缓存版本生成 `prepared` 缓存 key，缓存 `pages / knowledge_tree / lecture_script / active_questions / stage / scenes`。
- 上传时保留 `source_pages`，避免 prepare 阶段重新按纯文本启发式切页导致页边界漂移。
- 上传时尝试读取 prepared 缓存，命中则直接把课程置为 `ready`，准备页只需确认完成。
- prepare runner 在执行 LLM 流水线前检查缓存，未命中才生成，生成成功后写入缓存。
- 把 MAIC 解析文本镜像到 `uploads/*_parsed.txt` 和 `file-manifest.json`，让现有 RAG reinitialize/sync 路径能消费同一份课程文本。

## 任务拆解

- [x] T1 定位慢路径、缓存边界和 RAG 数据入口。
- [x] T2 实现 prepared 缓存模块与课程源页保留。
- [x] T3 接入上传缓存命中和 RAG uploads 镜像。
- [x] T4 接入 prepare runner/UI 事件，保证命中/未命中流程完整。
- [x] T5 定向验证、Review + Compound。

## 变更日志

### 2026-04-25

- 已定位 MAIC 慢路径集中在 `prepare-runner` 的 LLM read/plan 阶段。
- 已确认当前 RAG 主要从 `uploads/*.txt` / `*_parsed.txt` 读取文本，MAIC 上传尚未写入该目录。
- 新增 `prepare-cache`：按源内容、页边界、LLM 配置和 cache version 缓存完整 `CoursePrepared`。
- 上传时保留 `source_pages/source_hash/rag_asset`，并把解析文本镜像到 `uploads/maic_<hash>_<name>_parsed.txt`。
- prepare runner 新增 `prepare:cache` 事件，命中缓存时跳过 LLM 阶段，未命中时完整生成并写入缓存。
- 修正 `model-config.ts` 的 type-only import，让原生 Node strip-types 测试可加载 MAIC cache 模块。

## 审查结果

- ESLint：本轮改动文件通过。
- 回归测试：`node --experimental-strip-types --test src/lib/maic/pipeline/page-order.test.mjs src/lib/maic/prepare-cache.test.mjs` 通过 4 个测试。
- TypeScript：`tsc --noEmit` 输出中过滤 `src\\(components\\maic|lib\\maic|app\\maic|app\\api\\maic|lib\\model-config)` 后无错误；全量退出码仍受仓库既有非本轮问题影响。
- Diff 检查：`git diff --check` 通过，仅有仓库 CRLF 提示。

## 复利记录

- 解决方案：`docs/solutions/2026-04-25-maic-prepare-cache-rag-bridge.md`
- 架构规则：`.codex/rules/architecture.md`
- 性能规则：`.codex/rules/performance.md`
- 本能：`maic-prepared-artifact-cache`
- Skill 信号：`.codex/skill-signals/sprint.jsonl`、`.codex/skill-signals/test-strategy.jsonl`、`.codex/skill-signals/compound.jsonl`

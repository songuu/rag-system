---
title: "MiroFish/OpenMAIC 最新能力保真吸收 v2"
date: 2026-05-25
tags: [solution, mirofish, openmaic, parity, model-catalog, anti-drift]
related_instincts: []
aliases: ["MiroFish OpenMAIC latest parity v2"]
---

# MiroFish/OpenMAIC 最新能力保真吸收 v2

## Problem

上次 parity sprint 2026-05-08 之后，两个上游又新增提交：MiroFish master 5 commit、OpenMAIC master 15 commit。用户要求"完全接入"，但 90% 的上游变化（settings store / 视频 pipeline / ASR/TTS / whiteboard / outline 编辑器 / 课堂 zip）落在本项目没有的子系统上，机械式全量移植会导致大量 deadcode。

## Root Cause

"完全接入"在能力差异较大的两个项目之间不能解读为字面移植。`docs/solutions/2026-05-08-mirofish-openmaic-latest-parity#Prevention` 已经定义了分类矩阵，但前一次 sprint 没有把"上游能力 ↔ 本地子系统"映射成结构化决策表，下一次 parity 容易再次堆砌大量 task 然后被迫 defer 一半。

## Solution

1. **取源切换为 gh API + WebFetch raw**：用户不本地 clone 上游，模型用 `gh api repos/.../commits?since=...` + `raw.githubusercontent.com/.../master/<path>` 抓取 commit 元数据和单文件源码做远程 diff。代价：拿不到完整源码对比，需要按 commit 描述 + 改动文件清单做能力推断；收益：零依赖、零本地空间、可对受限项目工作。

2. **逐 commit 分类决策表**（写入 sprint 文档 Phase 2）：每条上游 commit 三列 — 简述 / 本地子系统是否存在 / 决策。决策码：
   - `adopt`：本地有对应子系统，按 [[2026-05-08-mirofish-openmaic-latest-parity#Prevention]] 矩阵落地
   - `skip`：本地无对应子系统且不在路线图上
   - `defer`：本地无对应子系统但值得未来建设，写入 frontmatter `deferred:` 并给 deadline

3. **本次 adopt 三项**：
   - `src/lib/model-catalog.ts` 同步 OpenMAIC commit 6522780/679130a/b29efe1：
     - 新增 `google/gemini-3.5-flash`（supportsThinking + thinkingControl `thinking.level`，status supported）
     - Xiaomi MiMo 从 1 个 documented 升级为 5 个 supported（v2.5-pro / v2-pro / v2.5 / v2-omni / v2-flash）
     - Lemonade 精简到上游唯一推荐的 `Gemma-4-26B-A4B-it-GGUF`（删除已被上游标记为 weak 的 `Qwen3.5-4B-GGUF`）
   - `src/app/api/maic/upload/route.ts` + 新建 `src/lib/maic/upload-validation.ts`：参考 MiroFish daec4b6 的 `FileParser.is_supported()` 模式，在 size 校验后、`parseSlides` 前做扩展名前置校验，错误消息列出 `MAIC_SUPPORTED_EXTENSIONS`（document-parser 通用扩展 + .pptx）
   - 新增 `src/lib/maic/upload-validation.test.mjs`（4 测试）+ 扩展 `src/lib/model-catalog.test.mjs`（+3 测试，按上游 commit hash 标注）

4. **defer 三项**（写入 sprint frontmatter `deferred:` 字段，deadline 2026-08-01）：Brave/Baidu web search（OpenMAIC 47cc2a5）、HappyHorse + video manifest（46b61de + 2dff6d1）、classroom zip 导入导出含 discussion triggers 保留（757ac07）。任一项超过 3 sprint 未落地必须正式撤回。

## Verification

- `node src/lib/model-catalog.test.mjs` → 6/6 通过（含 3 个新增的 gemini/xiaomi/lemonade 不变量测试）
- `node src/lib/maic/upload-validation.test.mjs` → 4/4 通过（含 PPTX、大小写、unsupported、无扩展名）
- 不变量回归（每 Task 完成强制跑）：
  - `node src/lib/model-config.test.mjs` → 3/3
  - `node src/lib/maic/classroom-export.test.mjs` → 2/2
  - `node src/lib/maic/prepare-cache.test.mjs` → 3/3
  - `node src/lib/maic/parsed-slides-cache.test.mjs` → 2/2
  - `node src/lib/mirofish/ontology-generator.test.mjs` → 2/2
- `npx tsc --noEmit` 过滤改动 3 个文件 → 无错误（历史 repo-wide 噪音忽略）

## Prevention

- **零迁移子系统的上游变更必须显式 defer，不能仅 skip**：上一次 sprint 漏了显式 defer 字段，结果第二次 parity 又把 video / search / zip 重新评估了一遍。现在用 frontmatter `deferred:` 强制带 deadline 跟踪。
- **取源方式三选一固化为 AskUserQuestion 选项**：本地 clone / WebFetch API / 用户给定 commit。下次 sprint 启动时直接复用，避免阻塞在"等 clone"。
- **catalog 类静态参考表更新时新增对应不变量测试**：测试名必须带上游 commit hash（如 `upstream 6522780`），未来回滚或重新评估时可追溯来源。
- **`OPENMAIC_LATEST_MODEL_NOTES` 同步规则**：删除上游某 model 必须本地同步删除（避免引导用户配置已废弃 model），新增 supportsThinking 的 thinkingControl 字段必须与上游 providers.ts 字面一致。
- **MAIC upload 全局规则**：所有进入 `parseSlides` 的路径必须先 `isMaicSupportedFile`；后续如果新增 `.epub`/`.html` 等格式，统一在 `src/lib/maic/upload-validation.ts` 加，不在 route 内 inline。

## Related

- [[2026-05-08-mirofish-openmaic-latest-parity]] — Prevention 矩阵的来源
- [[2026-05-14-mirofish-openmaic-cache-optimization]] — artifact cache invariants 本次未触
- [[2026-05-11-mirofish-prepare-snapshot-architecture]] — MiroFish 服务层规范本次未触

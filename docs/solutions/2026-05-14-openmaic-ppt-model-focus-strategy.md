# OpenMAIC PPT Model Focus Strategy

## Problem

PPT 重点悬停不能靠“第一个 key point”这种启发式。真正的重点需要结合本页描述、原文、知识树和教学目标由模型判断,否则复杂 PPT 会把视觉焦点放在错误元素上。

## Root Cause

上一版 `buildCourseStage()` 直接把 `key_points[0]` 映射为 spotlight,把 `key_points[1]` 映射为 laser。这个逻辑稳定,但不是教学策略: 它无法识别承上启下概念、易错点、迁移示例或模型认为更需要驻留的内容。

## Solution

- 新增 `SlideFocusPlan` / `SlideFocusTarget` / `FocusSource` 类型。
- 新增 `generateSlideFocusPlans()`:
  - 每页构造稳定候选元素: description + 前 4 个 key points。
  - 模型输出 `primary_candidate_id`, `secondary_candidate_id`, `rationale`, `confidence`, `hold_mode`。
  - 输出经过校验后映射回稳定 slide element id。
- `prepare-runner` 增加 `prepare:focus` 阶段,并把 `focus_plans` 写入 prepared artifact。
- `buildCourseStage()` 使用模型 focus plan 生成 spotlight/laser;模型失败时才用 fallback。
- `SceneAction` 保留 `focusSource`, `focusReason`, `focusConfidence`,方便后续审查和调试。
- 缓存版本升级到 `maic-prepared-v2`,防止旧 prepared 缓存跳过重点解析。

## Verification

- `node src\lib\maic\pipeline\page-order.test.mjs`
- `node src\lib\maic\pipeline\stage-options.test.mjs`
- `node src\lib\maic\pptx-parser.test.mjs`
- `node src\lib\maic\prepare-cache.test.mjs`
- scoped `pnpm exec eslint ...`

## Prevention

以后 PPT 重点策略默认走模型判定。fallback 只能用于模型调用失败、模型输出无效或旧 artifact 缺字段,不能把 fallback 当成主策略。

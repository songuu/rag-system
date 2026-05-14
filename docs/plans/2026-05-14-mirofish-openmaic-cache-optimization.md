---
title: "MiroFish and OpenMAIC Cache Optimization"
type: sprint
status: completed
created: "2026-05-14"
updated: "2026-05-14"
checkpoints: 0
tasks_total: 5
tasks_completed: 5
tags: [sprint, mirofish, openmaic, maic, cache]
aliases: ["MiroFish/OpenMAIC 缓存优化"]
---

# MiroFish and OpenMAIC Cache Optimization

## Phase 1: Think

### 需求分析

用户要求继续针对项目中 MiroFish 和 OpenMAIC/MAIC 的缓存系统做优化。当前 MAIC 已有 prepared artifact cache,但实现是模块私有逻辑;MiroFish 的 ontology/profile 等 LLM 生成产物每次请求都会重新生成,缺少模型配置感知的可复用缓存。

### 保真约束

- 不改变 MiroFish 与 MAIC 的运行时边界。
- 缓存命中只跳过昂贵 LLM 生成,不改变响应结构中的核心数据。
- 缓存 key 必须包含 source、模型 provider/model/base URL、temperature 和版本。
- 旧调用方不需要修改;新增 `cache_status` 只作为兼容性元数据。

## Phase 2: Plan

1. 抽出共享 artifact cache 基础层。
2. 让 MAIC prepared cache 复用共享稳定 hash/原子写入逻辑。
3. 给 MiroFish ontology/profile API 加磁盘缓存。
4. 增加缓存 identity、读写、模型切换回归测试。
5. 记录性能规则与 solution。

## Phase 3: Work

- `src/lib/artifact-cache.ts`
  - 新增共享 artifact cache: stable JSON hash、cache identity、typed load/save、原子 temp file rename。
- `src/lib/maic/prepare-cache.ts`
  - 改为复用共享 artifact cache,保留原 MAIC cache identity 和 `uploads/maic-cache` 路径。
- `src/lib/mirofish/artifact-cache.ts`
  - 新增 MiroFish ontology/profile/profile_batch cache identity。
  - cache key 包含请求内容、模型覆盖、温度和 `mirofish-llm-artifact-v1`。
- `src/app/api/mirofish/ontology/route.ts`
  - 生成前先查缓存,命中返回 `cache_status: "hit"`。
  - 未命中生成后写入缓存。
- `src/app/api/mirofish/profile/route.ts`
  - 单人设和批量人设都接入缓存。
- Tests
  - 新增 `src/lib/artifact-cache.test.mjs`。
  - 新增 `src/lib/mirofish/artifact-cache.test.mjs`。
  - 扩展 `src/lib/maic/prepare-cache.test.mjs`。

## Phase 4: Review

### 审查结果

- P0: 无。
- P1: 无。
- P2: MiroFish graph build 仍是 task runner 内存结果,本轮未把大型 graph data 做磁盘缓存;后续如果要优化图谱构建,应单独设计任务级 artifact 与失效策略。

### 验证

- `node src\lib\artifact-cache.test.mjs` -> pass
- `node src\lib\mirofish\artifact-cache.test.mjs` -> pass
- `node src\lib\maic\prepare-cache.test.mjs` -> pass
- `node src\lib\maic\pipeline\stage-options.test.mjs` -> pass
- `node src\lib\maic\pipeline\page-order.test.mjs` -> pass
- `node src\lib\mirofish\ontology-generator.test.mjs` -> pass
- scoped `pnpm exec eslint ...` -> pass
- `git diff --check` -> pass,仅 CRLF warning

## Phase 5: Compound

- Solution: `docs/solutions/2026-05-14-mirofish-openmaic-cache-optimization.md`
- Performance rule: `.codex/rules/performance.md` -> `Cache LLM Artifacts With Shared Identity`
- Skill signal: `.codex/skill-signals/sprint.jsonl` -> `2026-05-14 MiroFish/OpenMAIC cache optimization`

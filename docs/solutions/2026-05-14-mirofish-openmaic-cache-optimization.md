# MiroFish and OpenMAIC Cache Optimization

## Problem

MAIC 已有 prepared artifact cache,但实现是模块私有逻辑;MiroFish 的 ontology/profile 这类 LLM 生成产物缺少可复用缓存,重复请求会重新调用模型。两个模块的缓存策略没有统一 identity、稳定 hash、原子写入和模型配置边界。

## Root Cause

缓存系统没有抽象出“模型生成产物”的共同层。MAIC 只缓存完整课堂准备结果,MiroFish 则把 ontology/profile 当作即时生成 API。这样一方面复用能力差,另一方面很容易在模型、prompt 或输入变化后复用错误结果。

## Solution

- 新增 `src/lib/artifact-cache.ts`
  - stable JSON hash,避免对象 key 顺序影响 cache key。
  - `createArtifactCacheIdentity()` 统一 source hash、model signature、version。
  - typed `loadArtifactFromCache()` / `saveArtifactToCache()`。
  - 保存时先写 temp file,再 rename,降低半写入风险。
- 改造 `src/lib/maic/prepare-cache.ts`
  - 复用共享 artifact cache。
  - 保留 `uploads/maic-cache` 路径和原 cache identity 输出。
- 新增 `src/lib/mirofish/artifact-cache.ts`
  - ontology/profile/profile_batch 三类缓存。
  - cache key 绑定请求内容、模型 provider/model/base URL、temperature 和版本。
- 接入 MiroFish API
  - `/api/mirofish/ontology` 命中缓存时跳过 `OntologyGenerator`。
  - `/api/mirofish/profile` 单个/批量人设命中缓存时跳过 `ProfileGenerator`。
  - 响应新增兼容字段 `cache_status: "hit" | "stored" | "miss"`。

## Verification

- `node src\lib\artifact-cache.test.mjs`
- `node src\lib\mirofish\artifact-cache.test.mjs`
- `node src\lib\maic\prepare-cache.test.mjs`
- `node src\lib\maic\pipeline\stage-options.test.mjs`
- `node src\lib\maic\pipeline\page-order.test.mjs`
- `node src\lib\mirofish\ontology-generator.test.mjs`
- scoped `pnpm exec eslint ...`
- `git diff --check`

## Prevention

以后新增 MiroFish/OpenMAIC 的 LLM 生成产物时,默认先判断是否属于可缓存 artifact。可缓存时必须使用 source + model signature + cache/prompt version 生成 key,不要只按业务 id 或时间戳缓存。

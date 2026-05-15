# Milvus Optimization Evolution

## Summary

本轮把 Milvus 搜索控制从基础向量检索升级为可配置的 adapter-level policy。现有 dense retrieval 行为保持兼容,同时为后续 RAG Kernel 的 retrieval lanes、hybrid search 和 index lifecycle 打好边界。

## Implemented

- `milvus-config` 增加:
  - `MILVUS_DEFAULT_CONSISTENCY_LEVEL`
  - `MILVUS_IGNORE_GROWING`
  - `MILVUS_GROUP_BY_FIELD`
  - `MILVUS_GROUP_SIZE`
  - `MILVUS_STRICT_GROUP_SIZE`
  - `MILVUS_FLUSH_ON_INSERT`
  - `MILVUS_RELOAD_AFTER_INSERT`
  - `MILVUS_SEARCH_PARAMS`
- `milvus-client` 增加:
  - `AUTOINDEX` 索引支持。
  - IVF/HNSW/ANNOY/FLAT/AUTOINDEX 默认搜索参数构建。
  - SDK consistency enum 归一化。
  - 兼容旧签名的 object-style search options。
  - 可配置 insert 后 `flushSync`、`releaseCollection`、`loadCollection` 策略。
- `/api/milvus` 增加:
  - `exprValues` / `filterParams`。
  - `consistencyLevel`。
  - `ignoreGrowing`。
  - `groupByField` / `groupSize` / `strictGroupSize`。
  - `searchParams` / `hints` / `roundDecimal`。

## Usage

环境变量:

```env
MILVUS_DEFAULT_CONSISTENCY_LEVEL=Bounded
MILVUS_SEARCH_PARAMS={"nprobe":16}
MILVUS_FLUSH_ON_INSERT=true
MILVUS_RELOAD_AFTER_INSERT=true
```

API search:

```json
{
  "action": "search",
  "query": "机器学习是什么？",
  "topK": 5,
  "threshold": 0.5,
  "filter": "source in {sources}",
  "exprValues": {
    "sources": ["ai_intro.txt", "rag_notes.md"]
  },
  "consistencyLevel": "Bounded",
  "searchParams": {
    "nprobe": 16
  },
  "groupByField": "source",
  "groupSize": 1
}
```

代码调用:

```ts
await milvus.search(queryEmbedding, 8, {
  threshold: 0.35,
  filter: 'source in {sources}',
  exprValues: { sources: ['guide.md'] },
  consistencyLevel: 'Bounded',
  searchParams: { nprobe: 32 },
});
```

## Architecture Decision

Milvus tuning belongs in `src/lib/milvus-config.ts` and `src/lib/milvus-client.ts` because it is retrieval infrastructure, not product-route behavior. API route, UI, and future RAG Kernel policies should pass search intent; the adapter resolves SDK-specific enum values, index defaults, visibility policy, and search parameter shape.

## Next Evolution

1. Add corpus/index manifest for collection name, embedding dimension, index type, metric type, corpus version, and rebuild state.
2. Move dense search into a `DenseLane` under `src/lib/rag/retrieval`.
3. Add sparse or hybrid lane behind the same retrieval plan instead of adding a new `/api/ask` branch.
4. Add retrieval evaluation around precision/recall, latency, and source diversity before changing ranking defaults.

## Verification

Targeted checks:

- `node src\lib\milvus-client.test.mjs`
- `pnpm exec eslint src\lib\milvus-client.ts src\lib\milvus-config.ts src\app\api\milvus\route.ts src\lib\milvus-client.test.mjs`
- `npx tsc --noEmit --pretty false --incremental false` filtered to touched Milvus files

Repo-wide type check remains noisy outside the Milvus change surface, so this sprint treats touched-file type filtering plus focused tests as the acceptance boundary.

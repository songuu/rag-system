# Milvus Query Speed Optimization

## Problem

当前 Milvus 查询路径过重。一次搜索会重复做集合初始化、stats/describeCollection、embedding 生成和大量日志输出,导致用户看到的查询时间远大于真正的向量 search 时间。

## Changes

### 1. Warm vector store fast path

`initializeCollection()` 已增加 initialized fast path。一个 collection singleton 初始化完成后,后续查询不会再重复执行:

- `hasCollection`
- `describeCollection`
- schema compatibility check
- `getLoadState`
- `loadCollection`

### 2. Search route skips stats

`/api/milvus` 的 search action 不再每次调用 `getCollectionStats()`。初始化阶段已经校验 schema,所以查询阶段直接使用 `milvus.getConfig().embeddingDimension` 选择 embedding model。

### 3. Query embedding cache

`generateQueryEmbedding()` 增加短 TTL cache:

```env
MILVUS_QUERY_EMBEDDING_CACHE_TTL_MS=600000
MILVUS_QUERY_EMBEDDING_CACHE_MAX=256
```

同一个模型下的重复 query 可跳过 embedding provider 请求。

### 4. Hot-path log control

Milvus 热路径调试日志默认关闭:

```env
MILVUS_DEBUG_LOGS=false
```

需要排障时可临时开启。默认不再对命中结果做 `JSON.stringify` 预览,避免长文档 chunk 放大延迟。

### 5. Slim output fields

搜索返回字段可配置:

```env
MILVUS_SEARCH_OUTPUT_FIELDS=id,content,source,metadata_json
```

如果某些页面只需要 id/source,可以改为:

```env
MILVUS_SEARCH_OUTPUT_FIELDS=id,source
```

RAG 回答需要正文时保留 `content`。

### 6. Timings in API response

搜索响应新增:

```json
{
  "timings": {
    "initMs": 1,
    "embeddingMs": 42,
    "searchMs": 18,
    "totalMs": 65
  }
}
```

这可以直接判断瓶颈在初始化、embedding 还是 Milvus search。

## Recommended Low-Latency Profile

```env
MILVUS_DEFAULT_CONSISTENCY_LEVEL=Eventually
MILVUS_IGNORE_GROWING=true
MILVUS_SEARCH_PARAMS={"nprobe":8}
MILVUS_DEBUG_LOGS=false
```

这组配置偏速度,适合交互式预览。需要强一致和高召回时保留 `Bounded`、`ignoreGrowing=false`,并调高 `nprobe` 或 `ef`。

## Verification

- `node src\lib\milvus-client.test.mjs`
- `pnpm exec eslint src\lib\milvus-client.ts src\lib\milvus-config.ts src\lib\vectorization-utils.ts src\app\api\milvus\route.ts src\lib\milvus-client.test.mjs`

后续如果要做真实性能基准,建议以同一个 query 连续调用 `/api/milvus` 3 次,观察第二次开始 `initMs` 接近 0 且 `embeddingMs` 明显下降。

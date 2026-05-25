// @deadcode-until: 2026-08-01
//
// Milvus hybrid (sparse + dense) policy 占位文件
//
// 实现推迟到 Sprint 2026-08，原因:
// - 需要 sparse 编码器（BM25 / SPLADE）选型与 Milvus 2.6 sparse vector 字段 schema 迁移
// - Zilliz Serverless 不支持 sparse；多环境必须 feature-gate
// - 现有 retrieval-plan 中 sparse-bm25 lane 仅声明，未走真实路径
//
// 调用方应通过 `isMilvusHybridEnabled()` 判断；本文件默认 throw。
// 删除/启用本文件前请同步:
// 1) docs/plans/2026-05-25-model-vector-cache-optimization.md frontmatter deferred 字段
// 2) MILVUS_INTEGRATION_GUIDE.md 中的 hybrid section

import { isMilvusHybridEnabled } from '../../milvus-client';

export interface MilvusHybridSearchRequest {
  denseEmbedding: number[];
  sparseVector?: Record<number, number>;
  topK: number;
  filter?: string;
}

export interface MilvusHybridSearchResponse {
  hits: Array<{ id: string; score: number; content: string }>;
}

export async function milvusHybridSearch(
  _request: MilvusHybridSearchRequest
): Promise<MilvusHybridSearchResponse> {
  if (!isMilvusHybridEnabled()) {
    throw new Error(
      'Milvus hybrid search is gated behind MILVUS_HYBRID_ENABLED=true; implementation pending Sprint 2026-08.'
    );
  }
  throw new Error(
    'Milvus hybrid search implementation is not available yet (deadcode-until 2026-08-01).'
  );
}

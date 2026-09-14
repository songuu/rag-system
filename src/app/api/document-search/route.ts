import { NextRequest, NextResponse } from 'next/server';
import {
  adaptMilvusSearchResultsToEvidence,
  type RagEvidence,
} from '@/lib/rag';
import {
  matchesDocumentFileType,
  parseDocumentSearchRequest,
  presentDocumentSearchEvidence,
} from '@/lib/documents/document-search-contract';
import { getElasticsearchClient } from '@/lib/elasticsearch/client';
import {
  assertElasticsearchConfigured,
  getElasticsearchRuntimeConfig,
} from '@/lib/elasticsearch/config';
import { searchElasticsearchLexical } from '@/lib/elasticsearch/lexical-index';
import { getEmbeddingConfigSummary } from '@/lib/embedding-config';
import { getMilvusInstance, type MilvusConfig } from '@/lib/milvus-client';
import { getMilvusConnectionConfig } from '@/lib/milvus-config';
import { retrieveMilvusElasticsearch } from '@/lib/rag/retrieval/milvus-elasticsearch-fusion';
import {
  isVectorBackendDisabled,
  VECTOR_BACKEND_DISABLED_CODE,
  VECTOR_BACKEND_DISABLED_MESSAGE,
} from '@/lib/rag/vector-backend';
import { assertVectorSearchReady, VectorIndexBuildingError } from '@/lib/rag/vector-ingest-state';
import { redactErrorForLog } from '@/lib/security/error-redaction';
import {
  REQUEST_LIMITS,
  readJsonObjectWithLimit,
} from '@/lib/security/request-validation';
import {
  RagSecurityError,
  resolveRagSecurityContext,
} from '@/lib/security/request-context';
import {
  buildScopedMilvusSearchOptions,
  createRetrievalScope,
  type RagRetrievalScope,
} from '@/lib/security/retrieval-scope';
import {
  generateQueryEmbedding,
  selectModelForCollection,
} from '@/lib/vectorization-utils';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const startedAt = Date.now();
  try {
    const raw = await readJsonObjectWithLimit(request, REQUEST_LIMITS.askJsonBytes);
    const searchRequest = parseDocumentSearchRequest(raw);
    const securityContext = await resolveRagSecurityContext(request, {
      capability: 'query',
      requestedCorpusId: typeof raw.corpusId === 'string' ? raw.corpusId : undefined,
      requestIdFactory: () => requestId,
    });
    if (isVectorBackendDisabled()) {
      return failureResponse(503, VECTOR_BACKEND_DISABLED_CODE, VECTOR_BACKEND_DISABLED_MESSAGE, requestId);
    }
    assertVectorSearchReady();
    const scope = createRetrievalScope({
      tenantId: securityContext.tenantId,
      corpusId: securityContext.corpusId,
      enforceIsolation: securityContext.enforceIsolation,
    });
    const elasticsearchConfig = getElasticsearchRuntimeConfig();
    assertElasticsearchConfigured(elasticsearchConfig);
    if (searchRequest.strategy === 'keyword' && elasticsearchConfig.mode === 'off') {
      return failureResponse(
        503,
        'ELASTICSEARCH_DISABLED',
        '关键词搜索需要启用 Elasticsearch。',
        requestId
      );
    }

    const candidateLimit = Math.min(100, Math.max(searchRequest.topK, searchRequest.topK * 4));
    const retrieveDense = () => retrieveDenseEvidence({
      query: searchRequest.query,
      topK: candidateLimit,
      documentId: searchRequest.documentId,
      scope,
    });
    const retrieveLexical = () => retrieveLexicalEvidence({
      query: searchRequest.query,
      topK: candidateLimit,
      documentId: searchRequest.documentId,
      scope,
    });

    let evidence: RagEvidence[];
    let diagnostics: {
      status: string;
      mode: string;
      denseCandidateCount: number;
      lexicalCandidateCount: number;
      fusedCandidateCount?: number;
      failureCode?: string;
    };
    if (searchRequest.strategy === 'semantic') {
      evidence = await retrieveDense();
      diagnostics = {
        status: 'dense-only',
        mode: elasticsearchConfig.mode,
        denseCandidateCount: evidence.length,
        lexicalCandidateCount: 0,
      };
    } else if (searchRequest.strategy === 'keyword') {
      evidence = await retrieveLexical();
      diagnostics = {
        status: 'lexical-only',
        mode: elasticsearchConfig.mode,
        denseCandidateCount: 0,
        lexicalCandidateCount: evidence.length,
      };
    } else {
      const fused = await retrieveMilvusElasticsearch({
        mode: elasticsearchConfig.mode,
        topK: candidateLimit,
        laneId: 'document-search',
        rankConstant: elasticsearchConfig.rrfRankConstant,
        retrieveDense,
        retrieveLexical,
      });
      evidence = fused.evidence;
      diagnostics = fused.diagnostics;
    }

    const filtered = evidence
      .filter(item => matchesDocumentFileType(item, searchRequest.fileType))
      .slice(0, searchRequest.topK);
    return NextResponse.json({
      success: true,
      query: searchRequest.query,
      strategy: searchRequest.strategy,
      results: presentDocumentSearchEvidence(filtered),
      count: filtered.length,
      diagnostics,
      elapsedMs: Date.now() - startedAt,
      requestId,
    });
  } catch (error) {
    console.error(`[Document Search API] requestId=${requestId}`, redactErrorForLog(error));
    if (error instanceof RagSecurityError) {
      return NextResponse.json({ success: false, ...error.toResponseBody() }, { status: error.status });
    }
    if (error instanceof VectorIndexBuildingError) {
      return failureResponse(error.status, error.code, error.message, requestId, {
        'Retry-After': String(error.retryAfterSeconds),
      });
    }
    if (error instanceof Error && error.message.startsWith('Document search')) {
      return failureResponse(400, 'INVALID_DOCUMENT_SEARCH', error.message, requestId);
    }
    return failureResponse(500, 'DOCUMENT_SEARCH_FAILED', '文档搜索暂不可用。', requestId);
  }
}

async function retrieveDenseEvidence(input: {
  query: string;
  topK: number;
  documentId?: string;
  scope: RagRetrievalScope;
}): Promise<RagEvidence[]> {
  const config = defaultMilvusConfig();
  const milvus = getMilvusInstance(config);
  await milvus.connect();
  await milvus.initializeCollection();
  const dimension = milvus.getConfig().embeddingDimension;
  const embeddingModel = selectModelForCollection(
    dimension,
    getEmbeddingConfigSummary().model
  );
  const embedding = await generateQueryEmbedding(input.query, embeddingModel);
  const options = buildScopedMilvusSearchOptions(input.scope, { threshold: 0 });
  if (input.documentId) {
    options.filter = [options.filter, 'document_id == {documentId}'].filter(Boolean).join(' && ');
    options.exprValues = { ...(options.exprValues ?? {}), documentId: input.documentId };
  }
  const results = await milvus.search(embedding, input.topK, options);
  return adaptMilvusSearchResultsToEvidence(results, {
    laneId: 'document-search',
    scope: input.scope,
  });
}

async function retrieveLexicalEvidence(input: {
  query: string;
  topK: number;
  documentId?: string;
  scope: RagRetrievalScope;
}): Promise<RagEvidence[]> {
  const config = getElasticsearchRuntimeConfig();
  const client = await getElasticsearchClient(config);
  if (!client) throw Object.assign(new Error('Elasticsearch lexical retrieval is disabled.'), {
    code: 'ELASTICSEARCH_DISABLED',
  });
  return searchElasticsearchLexical({
    client,
    indexName: config.indexName,
    query: input.query,
    topK: input.topK,
    laneId: 'document-search',
    scope: input.scope,
    documentId: input.documentId,
  });
}

function defaultMilvusConfig(): MilvusConfig {
  const config = getMilvusConnectionConfig();
  return {
    address: config.address,
    collectionName: config.defaultCollection,
    embeddingDimension: config.defaultDimension,
    indexType: config.defaultIndexType,
    metricType: config.defaultMetricType,
    token: config.token,
    ssl: config.ssl,
  };
}

function failureResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  headers?: HeadersInit
) {
  return NextResponse.json({
    success: false,
    error: { code, message },
    requestId,
  }, { status, headers });
}

function resolveRequestId(request: NextRequest): string {
  const supplied = request.headers.get('x-request-id')?.trim();
  return supplied && supplied.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(supplied)
    ? supplied
    : crypto.randomUUID();
}

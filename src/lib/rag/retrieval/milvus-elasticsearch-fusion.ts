import type { RagEvidence } from '../core/types';
import { reciprocalRankFusion } from './hybrid-policy';
import type { ElasticsearchRolloutMode } from '../../elasticsearch/config';

export const MILVUS_ELASTICSEARCH_FUSION_VERSION = 'milvus-elasticsearch-rrf/v1' as const;

export interface MilvusElasticsearchDiagnostics {
  version: typeof MILVUS_ELASTICSEARCH_FUSION_VERSION;
  mode: ElasticsearchRolloutMode;
  status: 'dense-only' | 'shadow' | 'fused' | 'degraded';
  denseCandidateCount: number;
  lexicalCandidateCount: number;
  fusedCandidateCount: number;
  failureCode?: string;
}

export async function retrieveMilvusElasticsearch(input: {
  mode: ElasticsearchRolloutMode;
  topK: number;
  laneId: string;
  rankConstant?: number;
  retrieveDense(): Promise<RagEvidence[]>;
  retrieveLexical(): Promise<RagEvidence[]>;
}): Promise<{ evidence: RagEvidence[]; diagnostics: MilvusElasticsearchDiagnostics }> {
  if (!Number.isSafeInteger(input.topK) || input.topK < 1 || input.topK > 1_000) {
    throw new Error('Milvus + Elasticsearch topK must be between 1 and 1000.');
  }
  const densePromise = input.retrieveDense();
  if (input.mode === 'off') {
    const dense = (await densePromise).slice(0, input.topK);
    return {
      evidence: dense,
      diagnostics: diagnostics(input.mode, 'dense-only', dense.length, 0, dense.length),
    };
  }

  // Start both providers before awaiting either; their latency should overlap.
  const lexicalPromise = input.retrieveLexical();
  const [denseResult, lexicalResult] = await Promise.allSettled([densePromise, lexicalPromise]);
  if (denseResult.status === 'rejected') throw denseResult.reason;
  const dense = denseResult.value.slice(0, input.topK);
  if (lexicalResult.status === 'rejected') {
    if (isElasticsearchIntegrityFailure(lexicalResult.reason)) throw lexicalResult.reason;
    return {
      evidence: dense,
      diagnostics: {
        ...diagnostics(input.mode, 'degraded', dense.length, 0, dense.length),
        failureCode: safeFailureCode(lexicalResult.reason),
      },
    };
  }
  const lexical = lexicalResult.value.slice(0, input.topK);
  if (input.mode === 'shadow') {
    return {
      evidence: dense,
      diagnostics: diagnostics(input.mode, 'shadow', dense.length, lexical.length, dense.length),
    };
  }

  const evidenceById = new Map<string, RagEvidence>();
  for (const evidence of [...dense, ...lexical]) {
    const existing = evidenceById.get(evidence.id);
    if (existing && evidenceProvenance(existing) !== evidenceProvenance(evidence)) {
      throw Object.assign(
        new Error('Milvus and Elasticsearch returned conflicting evidence provenance.'),
        { code: 'ELASTICSEARCH_INTEGRITY_VIOLATION' }
      );
    }
    if (!existing || evidence.metadata?.lexicalMatch !== true) evidenceById.set(evidence.id, evidence);
  }
  const fused = reciprocalRankFusion({
    dense: dense.map(toFusionHit),
    lexical: lexical.map(toFusionHit),
  }, {
    rankConstant: input.rankConstant,
    topK: input.topK,
  }).map(candidate => {
    const evidence = evidenceById.get(candidate.id);
    if (!evidence) throw new Error('Fusion returned an unknown evidence ID.');
    return {
      ...evidence,
      laneId: input.laneId,
      retrievalScore: candidate.fusionScore,
      metadata: {
        ...(evidence.metadata ?? {}),
        lexicalMatch: candidate.matchedLanes.includes('lexical'),
        denseMatch: candidate.matchedLanes.includes('dense'),
        fusionScore: candidate.fusionScore,
        matchedLanes: candidate.matchedLanes,
        laneRanks: candidate.laneRanks,
        fusionVersion: MILVUS_ELASTICSEARCH_FUSION_VERSION,
      },
    } satisfies RagEvidence;
  });
  return {
    evidence: fused,
    diagnostics: diagnostics(input.mode, 'fused', dense.length, lexical.length, fused.length),
  };
}

function toFusionHit(evidence: RagEvidence) {
  return {
    id: evidence.id,
    score: evidence.retrievalScore ?? evidence.score ?? 0,
    content: evidence.content,
    source: evidence.source,
    metadata: {
      ...(evidence.metadata ?? {}),
      tenantId: evidence.tenantId,
      corpusId: evidence.corpusId,
      documentId: evidence.documentId,
      documentVersion: evidence.documentVersion,
      trustLevel: evidence.trustLevel,
      page: evidence.page,
      startOffset: evidence.startOffset,
      endOffset: evidence.endOffset,
    },
  };
}

function diagnostics(
  mode: ElasticsearchRolloutMode,
  status: MilvusElasticsearchDiagnostics['status'],
  denseCandidateCount: number,
  lexicalCandidateCount: number,
  fusedCandidateCount: number
): MilvusElasticsearchDiagnostics {
  return {
    version: MILVUS_ELASTICSEARCH_FUSION_VERSION,
    mode,
    status,
    denseCandidateCount,
    lexicalCandidateCount,
    fusedCandidateCount,
  };
}

function evidenceProvenance(evidence: RagEvidence): string {
  return JSON.stringify([
    evidence.tenantId,
    evidence.corpusId,
    evidence.documentId,
    evidence.documentVersion,
    evidence.content,
    evidence.source ?? null,
    evidence.page ?? null,
    evidence.startOffset ?? null,
    evidence.endOffset ?? null,
    evidence.trustLevel,
  ]);
}

function isElasticsearchIntegrityFailure(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'ELASTICSEARCH_INTEGRITY_VIOLATION'
  );
}

function safeFailureCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error
    && typeof error.code === 'string' && /^[A-Z0-9_]{1,128}$/.test(error.code)) {
    return error.code;
  }
  return error instanceof Error ? error.name : 'ELASTICSEARCH_UNAVAILABLE';
}


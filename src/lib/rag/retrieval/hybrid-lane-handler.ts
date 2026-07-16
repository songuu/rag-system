import type { RagEvidence } from '../core/types';
import type { RagTrustLevel } from '../../security/retrieval-scope';
import type { RagLaneHandler, RagLaneHandlerContext } from './lane-executor';
import {
  MILVUS_HYBRID_POLICY_VERSION,
  isHybridCapabilityUsable,
  milvusHybridSearch,
  resolveMilvusHybridRolloutMode,
  type MilvusHybridHit,
  type MilvusHybridRolloutMode,
  type MilvusHybridSearchPort,
} from './hybrid-policy';

export interface MilvusHybridLaneHandlerOptions {
  port: MilvusHybridSearchPort;
  collectionName: string | ((context: RagLaneHandlerContext) => string);
  embedQuery(input: {
    query: string;
    embeddingModel: string;
    signal: AbortSignal;
  }): Promise<number[]>;
  mode?: MilvusHybridRolloutMode | (() => MilvusHybridRolloutMode);
}

/**
 * Registers native hybrid as the optional sparse lane. In shadow mode it only
 * emits diagnostics; active mode is the sole mode that returns evidence.
 */
export function createMilvusHybridLaneHandler(
  options: MilvusHybridLaneHandlerOptions
): RagLaneHandler {
  return {
    type: 'sparse-bm25',
    retriever: 'milvus-native-hybrid-v1',
    async execute(context) {
      const mode = typeof options.mode === 'function'
        ? options.mode()
        : options.mode ?? resolveMilvusHybridRolloutMode();
      if (mode === 'off') {
        return {
          evidence: [],
          stopReason: 'capability_unavailable',
          metadata: {
            hybridPolicyVersion: MILVUS_HYBRID_POLICY_VERSION,
            mode,
            participatesInGeneration: false,
          },
        };
      }

      const scope = context.request.retrievalScope;
      if (!scope) {
        throw new Error('Hybrid retrieval requires a server-derived retrieval scope.');
      }
      const collectionName = typeof options.collectionName === 'function'
        ? options.collectionName(context)
        : options.collectionName;
      const denseEmbedding = await options.embedQuery({
        query: context.plan.query,
        embeddingModel: context.request.embeddingModel,
        signal: context.signal,
      });
      const response = await milvusHybridSearch(
        {
          collectionName,
          query: context.plan.query,
          denseEmbedding,
          topK: context.plan.top_k,
          scope,
          signal: context.signal,
        },
        { port: options.port, mode }
      );
      for (const shadowHit of response.shadowHits) {
        assertHybridHitScope(shadowHit, context);
      }
      const evidence = response.participatesInGeneration
        ? response.hits.map(hit => adaptHybridHitToEvidence(hit, context))
        : [];
      const capabilityUsable = response.capability
        ? isHybridCapabilityUsable(response.capability)
        : false;
      return {
        evidence,
        retrievalQuality: maximumScore(
          response.hits.length > 0 ? response.hits : response.shadowHits
        ),
        stopReason:
          response.stopReason === 'disabled' ||
          (response.capability !== undefined && !capabilityUsable)
            ? 'capability_unavailable'
            : evidence.length > 0
              ? 'sufficient'
              : 'no_gain',
        metadata: {
          hybridPolicyVersion: response.version,
          mode: response.mode,
          participatesInGeneration: response.participatesInGeneration,
          capabilityUsable,
          shadowHits: response.shadowHits.map(hit => ({ id: hit.id, score: hit.score })),
        },
      };
    },
  };
}

function adaptHybridHitToEvidence(
  hit: MilvusHybridHit,
  context: RagLaneHandlerContext
): RagEvidence {
  const { tenantId, corpusId, trustLevel } = assertHybridHitScope(hit, context);
  const metadata = hit.metadata ?? {};
  const documentId = requiredString(
    metadata.documentId ?? metadata.document_id,
    'documentId'
  );
  const documentVersion = requiredString(
    metadata.documentVersion ?? metadata.document_version,
    'documentVersion'
  );
  const page = optionalInteger(metadata.page, 'page');
  const startOffset = optionalInteger(metadata.startOffset ?? metadata.start_offset, 'startOffset');
  const endOffset = optionalInteger(metadata.endOffset ?? metadata.end_offset, 'endOffset');
  if ((startOffset === undefined) !== (endOffset === undefined)) {
    throw new Error('Hybrid hit offsets must be supplied as a complete span.');
  }
  if (startOffset !== undefined && endOffset !== undefined && endOffset <= startOffset) {
    throw new Error('Hybrid hit endOffset must be greater than startOffset.');
  }
  return {
    id: hit.id,
    tenantId,
    corpusId,
    documentId,
    documentVersion,
    content: hit.content,
    source: hit.source,
    ...(page === undefined ? {} : { page }),
    ...(startOffset === undefined ? {} : { startOffset, endOffset }),
    retrievalScore: hit.score,
    trustLevel,
    laneId: context.lane.id,
    metadata: {
      ...metadata,
      hybridPolicyVersion: MILVUS_HYBRID_POLICY_VERSION,
    },
  };
}

function assertHybridHitScope(
  hit: MilvusHybridHit,
  context: RagLaneHandlerContext
): { tenantId: string; corpusId: string; trustLevel: RagTrustLevel } {
  const scope = context.request.retrievalScope;
  if (!scope) throw new Error('Hybrid evidence adaptation requires retrieval scope.');
  const metadata = hit.metadata ?? {};
  const tenantId = requiredString(metadata.tenantId ?? metadata.tenant_id, 'tenantId');
  const corpusId = requiredString(metadata.corpusId ?? metadata.corpus_id, 'corpusId');
  if (tenantId !== scope.tenantId || corpusId !== scope.corpusId) {
    throw new Error('Hybrid hit scope does not match the authenticated retrieval scope.');
  }
  const trustLevel = readTrustLevel(metadata.trustLevel ?? metadata.trust_level);
  if (!scope.allowedTrustLevels.includes(trustLevel)) {
    throw new Error('Hybrid hit trust level is outside the authenticated retrieval scope.');
  }
  return { tenantId, corpusId, trustLevel };
}

function maximumScore(hits: readonly MilvusHybridHit[]): number | undefined {
  return hits.length === 0 ? undefined : Math.max(...hits.map(hit => hit.score));
}

function readTrustLevel(value: unknown): RagTrustLevel {
  const trustLevel = requiredString(value, 'trustLevel');
  if (!['trusted', 'reviewed', 'external'].includes(trustLevel)) {
    throw new Error('Hybrid hit trustLevel is invalid or quarantined.');
  }
  return trustLevel as RagTrustLevel;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Hybrid hit ' + field + ' is required.');
  }
  return value.trim();
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error('Hybrid hit ' + field + ' must be a non-negative integer.');
  }
  return value as number;
}

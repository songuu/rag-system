import type { RagEvidence, RagPolicyId, RagQueryRequest } from '../core/types';
import {
  buildDurableCheckpointKey,
  DurableRagWorkflowAdapter,
  InMemoryDurableCheckpointStore,
  type DurableJsonObject,
} from '../core/durable-workflow';
import {
  buildPdfAssetManifest,
  sha256Hex,
  type PdfPageImageAsset,
} from '../multimodal/pdf-asset-manifest';
import { routePdfModality } from '../multimodal/pdf-modality-router';
import {
  decideRagAbstention,
  type AbstentionLaneKind,
  type LaneScoreCalibration,
} from '../retrieval/abstention-policy';
import { createGraphEntityLaneHandler } from '../retrieval/graph-entity-lane';
import {
  milvusHybridSearch,
  type MilvusHybridCapability,
  type MilvusHybridHit,
  type MilvusHybridRolloutMode,
} from '../retrieval/hybrid-policy';
import { RagLaneExecutor, type RagLaneHandler } from '../retrieval/lane-executor';
import { createDefaultRetrievalPlan, type RagRetrievalPlan } from '../retrieval/retrieval-plan';
import {
  resolveRetrievalRouterCapabilities,
  routeRetrievalQuery,
  type RetrievalFeatureMode,
  type RetrievalQueryKind,
} from '../retrieval/retrieval-router';
import {
  createMiroFishGraphArtifact,
  InMemoryMiroFishGraphArtifactStore,
} from '../../mirofish/graph-artifact-store';
import { createRetrievalScope, type RagRetrievalScope } from '../../security/retrieval-scope';
import type {
  ContractJsonObject,
  ContractJsonValue,
  ProductionPolicyContractTarget,
} from './production-policy-contract';

const FIXED_TIME = '2026-07-15T00:00:00.000Z';
const POLICY_IDS = new Set<RagPolicyId>([
  'memory',
  'milvus-2step',
  'agentic',
  'adaptive-entity',
  'self-corrective',
  'reasoning',
  'maic-course',
  'mirofish-research',
]);

export const productionPolicyContractTarget: ProductionPolicyContractTarget = {
  id: 'production-policy-control-plane/hermetic-v1',
  executionProfile: {
    executionMode: 'hermetic-in-process',
    externalServicePolicy: 'disabled',
    qualityScope: 'control-plane-contract-only',
    productionQualityMeasured: false,
  },
  async run(input): Promise<ContractJsonValue> {
    switch (stringField(input, 'kind')) {
      case 'policy-plan':
        return observePolicyPlan(input);
      case 'retrieval-router':
        return observeRetrievalRouter(input);
      case 'hybrid-rollout':
        return observeHybridRollout(input);
      case 'lane-evidence-transform':
        return observeLaneEvidenceTransform(input);
      case 'abstention':
        return observeAbstention(input);
      case 'graph-missing-artifact':
        return observeGraphMissingArtifact(input);
      case 'graph-populated-artifact':
        return observeGraphPopulatedArtifact(input);
      case 'pdf-modality':
        return observePdfModality(input);
      case 'durable-workflow':
        return observeDurableWorkflow(input);
      default:
        throw new Error('Unsupported production-policy contract scenario.');
    }
  },
};

function observePolicyPlan(input: ContractJsonObject): ContractJsonValue {
  const policyId = policyIdField(input, 'policyId');
  const graphIdentity = optionalObject(input, 'graphArtifactIdentity');
  const request = baseRequest({
    question: stringField(input, 'question'),
    storageBackend: policyId === 'memory' ? 'memory' : 'milvus',
    enableReranking: optionalBoolean(input, 'enableReranking'),
    ...(graphIdentity
      ? {
          graphArtifactIdentity: {
            documentId: stringField(graphIdentity, 'documentId'),
            documentVersion: stringField(graphIdentity, 'documentVersion'),
            trustLevel: trustLevelField(graphIdentity, 'trustLevel'),
          },
        }
      : {}),
  });
  const plan = createDefaultRetrievalPlan(request, policyId, new Date(FIXED_TIME));
  const graphLane = plan.lanes.find(lane => lane.type === 'graph-entity');
  const graphParameters = graphLane?.parameters;
  return {
    planId: plan.id,
    policyId: plan.policy_id,
    laneSequence: plan.lanes.map(
      lane => `${lane.type}:${lane.required ? 'required' : 'optional'}`
    ),
    graphIdentity: graphParameters
      ? {
          queryKind: jsonScalar(graphParameters.queryKind),
          documentId: jsonScalar(graphParameters.documentId),
          documentVersion: jsonScalar(graphParameters.documentVersion),
          trustLevel: jsonScalar(graphParameters.trustLevel),
        }
      : null,
  };
}

function observeRetrievalRouter(input: ContractJsonObject): ContractJsonValue {
  const hybrid = objectField(input, 'hybrid');
  const orderedContext = objectField(input, 'orderedContext');
  const capabilities = resolveRetrievalRouterCapabilities({
    hybrid: {
      mode: featureModeField(hybrid, 'mode'),
      usable: booleanField(hybrid, 'usable'),
    },
    orderedContext: {
      mode: featureModeField(orderedContext, 'mode'),
      usable: booleanField(orderedContext, 'usable'),
    },
  });
  const corpusInput = optionalObject(input, 'corpus');
  const decision = routeRetrievalQuery({
    query: stringField(input, 'query'),
    capabilities,
    ...(corpusInput
      ? {
          corpus: {
            documentCount: integerField(corpusInput, 'documentCount'),
            characterCount: integerField(corpusInput, 'characterCount'),
            complete: booleanField(corpusInput, 'complete'),
          },
        }
      : {}),
  });
  return {
    capabilities,
    route: decision.route,
    queryKind: decision.queryKind,
    reason: decision.reason,
  };
}

async function observeHybridRollout(input: ContractJsonObject): Promise<ContractJsonValue> {
  const capabilityInput = objectField(input, 'capability');
  const capability: MilvusHybridCapability = {
    nativeHybridSearch: booleanField(capabilityInput, 'nativeHybridSearch'),
    bm25Function: booleanField(capabilityInput, 'bm25Function'),
    schemaCompatible: booleanField(capabilityInput, 'schemaCompatible'),
    provider: stringField(capabilityInput, 'provider'),
  };
  const hits = arrayField(input, 'hits').map((item, index): MilvusHybridHit => {
    const hit = asObject(item, `hits[${index}]`);
    return {
      id: stringField(hit, 'id'),
      score: numberField(hit, 'score'),
      content: stringField(hit, 'content'),
    };
  });
  let probeCalls = 0;
  let searchCalls = 0;
  const port = {
    async probe() {
      probeCalls += 1;
      return capability;
    },
    async search() {
      searchCalls += 1;
      return hits;
    },
  };
  try {
    const result = await milvusHybridSearch(
      {
        collectionName: 'contract_shadow_collection',
        query: stringField(input, 'query'),
        denseEmbedding: [0.25, -0.5, 0.75],
        sparseVector: { 7: 1 },
        topK: 3,
        scope: contractScope(),
      },
      {
        port,
        mode: hybridModeField(input, 'mode'),
      }
    );
    return {
      status: 'completed',
      mode: result.mode,
      participatesInGeneration: result.participatesInGeneration,
      hitIds: result.hits.map(hit => hit.id),
      shadowHitIds: result.shadowHits.map(hit => hit.id),
      stopReason: result.stopReason,
      probeCalls,
      searchCalls,
    };
  } catch (error) {
    if (
      error instanceof Error
      && /active mode requires native hybrid, BM25, and a compatible shadow schema/.test(
        error.message
      )
    ) {
      return {
        status: 'rejected',
        code: 'HYBRID_CAPABILITY_REQUIRED',
        probeCalls,
        searchCalls,
      };
    }
    throw error;
  }
}

async function observeLaneEvidenceTransform(
  input: ContractJsonObject
): Promise<ContractJsonValue> {
  const evidence = arrayField(input, 'evidence').map((value, index) =>
    parseEvidence(value, `evidence[${index}]`)
  );
  const order = stringArrayField(input, 'orderedEvidenceIds');
  const scoresInput = objectField(input, 'rerankScores');
  const rerankScores = Object.fromEntries(
    Object.entries(scoresInput).map(([id, score]) => [id, finiteNumber(score, `rerankScores.${id}`)])
  );
  const denseHandler: RagLaneHandler = {
    type: 'dense-vector',
    retriever: 'contract-dense',
    async execute() {
      return { evidence, stopReason: 'sufficient' };
    },
  };
  const rerankHandler: RagLaneHandler = {
    type: 'rerank',
    retriever: 'contract-reranker',
    async execute() {
      return {
        evidence: [],
        transform: {
          orderedEvidenceIds: order,
          rerankScores,
        },
      };
    },
  };
  const plan: RagRetrievalPlan = {
    id: 'contract-lane-transform',
    policy_id: 'milvus-2step',
    query: 'contract evidence ordering',
    lanes: [
      {
        id: 'dense-main',
        type: 'dense-vector',
        required: true,
        description: 'Hermetic dense evidence fixture.',
      },
      {
        id: 'rerank-main',
        type: 'rerank',
        required: true,
        description: 'Hermetic identity-preserving transform.',
      },
    ],
    top_k: 3,
    similarity_threshold: 0,
    created_at: FIXED_TIME,
  };
  const result = await new RagLaneExecutor([denseHandler, rerankHandler], {
    now: () => Date.parse(FIXED_TIME),
  }).execute({
    request: baseRequest({ question: plan.query, retrievalScope: contractScope() }),
    plan,
    budget: { maxLanes: 2, maxEvidence: 3, maxDurationMs: 5_000 },
  });
  return {
    evidenceIds: result.evidence.map(item => item.id),
    documentIds: result.evidence.map(item => item.documentId),
    laneIds: result.evidence.map(item => item.laneId),
    rerankScores: result.evidence.map(item => item.rerankScore ?? null),
    laneExecutions: result.laneExecutions.map(item => ({
      laneId: item.laneId,
      status: item.status,
      evidenceIds: item.retrievedEvidenceIds,
    })),
    stopReason: result.stopReason,
  };
}

function observeAbstention(input: ContractJsonObject): ContractJsonValue {
  const evidence = arrayField(input, 'evidence').map((value, index) =>
    parseEvidence(value, `evidence[${index}]`)
  );
  const laneKindsInput = objectField(input, 'laneKinds');
  const calibrationInput = objectField(input, 'calibration');
  const calibrationLanesInput = objectField(calibrationInput, 'lanes');
  const laneKinds = Object.fromEntries(
    Object.entries(laneKindsInput).map(([laneId, kind]) => [
      laneId,
      laneKind(kind, `laneKinds.${laneId}`),
    ])
  );
  const lanes = Object.fromEntries(
    Object.entries(calibrationLanesInput).map(([laneId, value]) => {
      const item = asObject(value, `calibration.lanes.${laneId}`);
      const calibration: LaneScoreCalibration = {
        minimumScore: numberField(item, 'minimumScore'),
        ...(item.scoreField === undefined
          ? {}
          : { scoreField: scoreField(item.scoreField, `calibration.lanes.${laneId}.scoreField`) }),
        ...(item.allowMissingScore === undefined
          ? {}
          : { allowMissingScore: booleanField(item, 'allowMissingScore') }),
      };
      return [laneId, calibration];
    })
  );
  const result = decideRagAbstention({
    queryKind: queryKindField(input, 'queryKind'),
    evidence,
    laneKinds,
    calibration: {
      version: stringField(calibrationInput, 'version'),
      lanes,
    },
    ...(input.minimumDistinctDocuments === undefined
      ? {}
      : { minimumDistinctDocuments: integerField(input, 'minimumDistinctDocuments') }),
  });
  return {
    abstain: result.abstain,
    reason: result.reason,
    qualifiedEvidenceIds: result.qualifiedEvidenceIds,
    distinctDocumentCount: result.distinctDocumentCount,
    calibrationVersion: result.calibrationVersion,
  };
}

async function observeGraphMissingArtifact(
  input: ContractJsonObject
): Promise<ContractJsonValue> {
  const result = await executeGraphLane(
    input,
    new InMemoryMiroFishGraphArtifactStore()
  );
  const execution = result.laneExecutions[0];
  return {
    overallStopReason: result.stopReason,
    evidenceIds: result.evidence.map(item => item.id),
    laneStatus: execution?.status ?? null,
    laneStopReason: execution?.stopReason ?? null,
    fallbackReason: jsonScalar(execution?.metadata?.reason),
    documentVersion: jsonScalar(execution?.metadata?.documentVersion),
  };
}

async function observeGraphPopulatedArtifact(
  input: ContractJsonObject
): Promise<ContractJsonValue> {
  const identityInput = objectField(input, 'identity');
  const identity = {
    tenantId: 'contract-tenant',
    corpusId: 'contract-corpus',
    documentId: stringField(identityInput, 'documentId'),
    documentVersion: stringField(identityInput, 'documentVersion'),
    trustLevel: trustLevelField(identityInput, 'trustLevel'),
  };
  const store = new InMemoryMiroFishGraphArtifactStore();
  await store.put(
    createMiroFishGraphArtifact({
      identity,
      graph: {
        graph_id: identity.documentId,
        nodes: [
          {
            uuid: 'entity-alice',
            name: 'Alice',
            labels: ['Person'],
            summary: 'Alice graph entity.',
            attributes: {
              aliases: [],
              sourceChunks: ['passage-alice'],
            },
          },
        ],
        edges: [],
        node_count: 1,
        edge_count: 0,
        artifact_version: 'mirofish-graph-v2',
        passages: [
          {
            id: 'passage-alice',
            document_id: identity.documentId,
            content: 'Alice founded Acme.',
            index: 0,
            start_offset: 0,
            end_offset: 19,
            source: 'contract-graph-source',
          },
        ],
        communities: [],
      },
    })
  );
  const result = await executeGraphLane(input, store);
  const execution = result.laneExecutions[0];
  return {
    overallStopReason: result.stopReason,
    laneStatus: execution?.status ?? null,
    laneStopReason: execution?.stopReason ?? null,
    evidence: result.evidence.map(item => ({
      id: item.id,
      content: item.content,
      tenantId: item.tenantId,
      corpusId: item.corpusId,
      documentId: item.documentId,
      documentVersion: item.documentVersion,
      trustLevel: item.trustLevel,
      laneId: item.laneId,
      graphPassageId: jsonScalar(item.metadata?.graphPassageId),
      graphEntityIds: Array.isArray(item.metadata?.graphEntityIds)
        ? item.metadata.graphEntityIds.map(jsonScalar)
        : [],
    })),
  };
}

async function executeGraphLane(
  input: ContractJsonObject,
  store: InMemoryMiroFishGraphArtifactStore
) {
  const identity = objectField(input, 'identity');
  const scope = contractScope();
  const plan: RagRetrievalPlan = {
    id: 'contract-graph-missing',
    policy_id: 'mirofish-research',
    query: stringField(input, 'query'),
    lanes: [
      {
        id: 'graph-optional',
        type: 'graph-entity',
        required: false,
        description: 'Optional graph artifact contract probe.',
        parameters: {
          documentId: stringField(identity, 'documentId'),
          documentVersion: stringField(identity, 'documentVersion'),
          trustLevel: trustLevelField(identity, 'trustLevel'),
          maxHops: 2,
        },
      },
    ],
    top_k: 3,
    similarity_threshold: 0,
    created_at: FIXED_TIME,
  };
  const result = await new RagLaneExecutor(
    [
      createGraphEntityLaneHandler({
        store,
      }),
    ],
    { now: () => Date.parse(FIXED_TIME) }
  ).execute({
    request: baseRequest({ question: plan.query, retrievalScope: scope }),
    plan,
    budget: { maxLanes: 1, maxEvidence: 3, maxDurationMs: 5_000 },
  });
  return result;
}

function observePdfModality(input: ContractJsonObject): ContractJsonValue {
  const scope = contractScope();
  const manifest = buildPdfAssetManifest({
    source: new TextEncoder().encode('hermetic-contract-pdf'),
    sourceName: 'contract.pdf',
    documentId: 'contract-pdf',
    documentVersion: 'sha256:contract-v1',
    parsed: {
      text: 'page one\n\f\npage two diagram',
      pages: 2,
      pageTexts: ['page one', 'page two diagram'],
      parseMethod: 'pdf-parse-v2',
    },
    scope,
    trustLevel: 'reviewed',
    pageImages: [
      pageImage(1, 'pdf-assets/contract/page-0001.png'),
      pageImage(2, 'pdf-assets/contract/page-0002.png'),
    ],
    now: new Date(FIXED_TIME),
  });
  const capabilityInput = objectField(input, 'capability');
  const decision = routePdfModality({
    query: stringField(input, 'query'),
    manifest,
    scope,
    mode: pdfModeField(input, 'mode'),
    capability: {
      available: booleanField(capabilityInput, 'available'),
      ...(capabilityInput.analyzerId === undefined
        ? {}
        : { analyzerId: stringField(capabilityInput, 'analyzerId') }),
    },
  });
  return {
    route: decision.route,
    reason: decision.reason,
    requestedVisual: decision.requestedVisual,
    selectedPageNumbers: decision.selectedPageNumbers,
    missingPageNumbers: decision.missingPageNumbers,
    fallbackRoute: decision.fallbackRoute ?? null,
    shadowRoute: decision.shadowRoute ?? null,
    analyzerId: decision.analyzerId ?? null,
    manifestIdentity: {
      sourceHash: manifest.sourceHash,
      documentVersion: manifest.documentVersion,
      tenantId: manifest.tenantId,
      corpusId: manifest.corpusId,
    },
  };
}

async function observeDurableWorkflow(input: ContractJsonObject): Promise<ContractJsonValue> {
  const workflowId = stringField(input, 'workflowId');
  const threadId = stringField(input, 'threadId');
  const tenantId = stringField(input, 'tenantId');
  const store = new InMemoryDurableCheckpointStore('contract-memory-store');
  const adapter = new DurableRagWorkflowAdapter<DurableJsonObject, DurableJsonObject>(
    {
      id: workflowId,
      version: 'contract-v1',
      projectJobForCheckpoint(job) {
        return { seed: finiteNumber(job.seed, 'job.seed') };
      },
      projectStateForCheckpoint(state) {
        return { value: finiteNumber(state.value, 'state.value') };
      },
      createInitialState(job) {
        return { value: finiteNumber(job.seed, 'job.seed') };
      },
      steps: [
        {
          id: 'increment',
          async execute({ state }) {
            return { value: finiteNumber(state.value, 'state.value') + 1 };
          },
        },
      ],
    },
    store,
    {
      now: () => new Date(FIXED_TIME),
      ownerIdFactory: () => 'contract-owner',
    }
  );
  const scope = createRetrievalScope({
    tenantId,
    corpusId: 'contract-corpus',
    allowedTrustLevels: ['trusted', 'reviewed'],
    enforceIsolation: true,
  });
  const invocation = {
    threadId,
    idempotencyKey: 'contract-idempotency-key',
    scope,
    documentId: 'contract-document',
    documentVersion: 'document-v1',
    job: { seed: 1 },
  };
  const first = await adapter.invoke(invocation);
  const replay = await adapter.invoke(invocation);
  const key = buildDurableCheckpointKey(workflowId, threadId, tenantId);
  return {
    checkpointKeyStable: key === first.checkpoint.checkpointKey,
    tenantIdentitySeparated:
      key !== buildDurableCheckpointKey(workflowId, threadId, `${tenantId}-other`),
    threadIdentitySeparated:
      key !== buildDurableCheckpointKey(workflowId, `${threadId}-other`, tenantId),
    checkpointSchema: first.checkpoint.schemaVersion,
    checkpointStatus: first.checkpoint.status,
    firstExecutedStepIds: first.executedStepIds,
    replayExecutedStepIds: replay.executedStepIds,
    replayResumed: replay.resumed,
    idempotentReplay: replay.idempotentReplay,
    checkpointProvider: replay.checkpointProvider,
    processPersistent: replay.processPersistent,
  };
}

function baseRequest(overrides: Partial<RagQueryRequest> = {}): RagQueryRequest {
  return {
    question: 'contract question',
    topK: 4,
    similarityThreshold: 0.25,
    llmModel: 'contract-no-provider',
    embeddingModel: 'contract-no-provider',
    storageBackend: 'milvus',
    ...overrides,
  };
}

function contractScope(): RagRetrievalScope {
  return createRetrievalScope({
    tenantId: 'contract-tenant',
    corpusId: 'contract-corpus',
    allowedTrustLevels: ['trusted', 'reviewed'],
    enforceIsolation: true,
  });
}

function parseEvidence(value: ContractJsonValue, path: string): RagEvidence {
  const item = asObject(value, path);
  return {
    id: stringField(item, 'id'),
    tenantId: stringField(item, 'tenantId'),
    corpusId: stringField(item, 'corpusId'),
    documentId: stringField(item, 'documentId'),
    documentVersion: stringField(item, 'documentVersion'),
    content: stringField(item, 'content'),
    trustLevel: trustLevelField(item, 'trustLevel'),
    laneId: stringField(item, 'laneId'),
    ...(item.retrievalScore === undefined
      ? {}
      : { retrievalScore: numberField(item, 'retrievalScore') }),
    ...(item.rerankScore === undefined
      ? {}
      : { rerankScore: numberField(item, 'rerankScore') }),
    ...(item.metadata === undefined
      ? {}
      : { metadata: objectField(item, 'metadata') }),
  };
}

function pageImage(pageNumber: number, imageRef: string): PdfPageImageAsset {
  return {
    pageNumber,
    imageRef,
    width: 800,
    height: 600,
    byteLength: 10_000,
    mimeType: 'image/png',
    contentDigest: sha256Hex(`${pageNumber}\0${imageRef}`),
  };
}

function objectField(input: ContractJsonObject, field: string): ContractJsonObject {
  return asObject(input[field], field);
}

function optionalObject(
  input: ContractJsonObject,
  field: string
): ContractJsonObject | undefined {
  return input[field] === undefined ? undefined : objectField(input, field);
}

function asObject(value: ContractJsonValue | undefined, path: string): ContractJsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Contract input ${path} must be an object.`);
  }
  return value;
}

function arrayField(input: ContractJsonObject, field: string): ContractJsonValue[] {
  const value = input[field];
  if (!Array.isArray(value)) throw new Error(`Contract input ${field} must be an array.`);
  return value;
}

function stringArrayField(input: ContractJsonObject, field: string): string[] {
  return arrayField(input, field).map((value, index) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Contract input ${field}[${index}] must be a non-empty string.`);
    }
    return value.trim();
  });
}

function stringField(input: ContractJsonObject, field: string): string {
  const value = input[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Contract input ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function booleanField(input: ContractJsonObject, field: string): boolean {
  const value = input[field];
  if (typeof value !== 'boolean') throw new Error(`Contract input ${field} must be boolean.`);
  return value;
}

function optionalBoolean(input: ContractJsonObject, field: string): boolean | undefined {
  return input[field] === undefined ? undefined : booleanField(input, field);
}

function numberField(input: ContractJsonObject, field: string): number {
  return finiteNumber(input[field], field);
}

function integerField(input: ContractJsonObject, field: string): number {
  const value = numberField(input, field);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Contract input ${field} must be a non-negative integer.`);
  }
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Contract input ${field} must be finite.`);
  }
  return value;
}

function policyIdField(input: ContractJsonObject, field: string): RagPolicyId {
  const value = stringField(input, field) as RagPolicyId;
  if (!POLICY_IDS.has(value)) throw new Error('Contract policyId is unsupported.');
  return value;
}

function trustLevelField(
  input: ContractJsonObject,
  field: string
): RagEvidence['trustLevel'] {
  const value = stringField(input, field);
  if (!['trusted', 'reviewed', 'external', 'quarantined'].includes(value)) {
    throw new Error(`Contract input ${field} has an unsupported trust level.`);
  }
  return value as RagEvidence['trustLevel'];
}

function featureModeField(input: ContractJsonObject, field: string): RetrievalFeatureMode {
  const value = stringField(input, field);
  if (!['off', 'shadow', 'active'].includes(value)) {
    throw new Error(`Contract input ${field} has an unsupported feature mode.`);
  }
  return value as RetrievalFeatureMode;
}

function hybridModeField(input: ContractJsonObject, field: string): MilvusHybridRolloutMode {
  return featureModeField(input, field);
}

function pdfModeField(input: ContractJsonObject, field: string): 'off' | 'shadow' | 'active' {
  return featureModeField(input, field);
}

function queryKindField(input: ContractJsonObject, field: string): RetrievalQueryKind {
  const value = stringField(input, field);
  if (!['identifier', 'global', 'multi-hop', 'semantic'].includes(value)) {
    throw new Error(`Contract input ${field} has an unsupported query kind.`);
  }
  return value as RetrievalQueryKind;
}

function laneKind(value: ContractJsonValue, path: string): AbstentionLaneKind {
  if (
    typeof value !== 'string'
    || !['dense', 'lexical', 'hybrid', 'graph', 'ordered', 'visual'].includes(value)
  ) {
    throw new Error(`Contract input ${path} has an unsupported lane kind.`);
  }
  return value as AbstentionLaneKind;
}

function scoreField(value: ContractJsonValue, path: string): LaneScoreCalibration['scoreField'] {
  if (typeof value !== 'string' || !['retrieval', 'rerank', 'best'].includes(value)) {
    throw new Error(`Contract input ${path} has an unsupported score field.`);
  }
  return value as LaneScoreCalibration['scoreField'];
}

function jsonScalar(value: unknown): ContractJsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  return null;
}

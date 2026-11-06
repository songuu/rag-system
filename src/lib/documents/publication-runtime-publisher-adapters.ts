import { randomBytes, randomUUID } from 'node:crypto';
import type { Client as ElasticsearchClient } from '@elastic/elasticsearch';
import type { MilvusClient } from '@zilliz/milvus2-sdk-node';
import type { PostgresQueryClient } from '../postgres/client';
import type { RagRetrievalScope } from '../security/retrieval-scope';
import { writeGenerationDocuments, observeGenerationDocuments, type GenerationIdentity } from '../elasticsearch/generation-index';
import { createPersistedElasticsearchIndex, PostgresElasticsearchPublicationOperations,
  type DurableElasticsearchOperation } from '../elasticsearch/publication-operation';
import { sealOwnedGenerationIndex, type OwnedGenerationIndex } from '../elasticsearch/generation-seal';
import { PostgresPublicationAssetStore, type PreparedPublicationAsset } from './publication-asset-store';
import { PostgresDocumentPublicationStore, type PublicationAttempt, type PublicationProvider } from './publication-control-cas';
import { MilvusPublicationWriter } from './milvus-publication-writer';
import { assertRuntimeMilvusNoRetries, verifyRuntimeMilvusReadback } from './publication-runtime-publisher-milvus';
import { loadPublicationManifests } from './publication-publisher';
import { publishRuntimeGeneration, type RuntimeElasticsearchIdentity, type RuntimeMaterialized,
  type RuntimePublisherPorts } from './publication-runtime-publisher';
import { PostgresPublicationIntentStore, type PublicationOperationIntent } from './publication-runtime-publisher-intent';

type Materialized = Awaited<ReturnType<typeof loadPublicationManifests>> & RuntimeMaterialized;

/**
 * This factory is internal to the separately authenticated publisher service.
 * The capability gate remains disabled: a callback or settings readback cannot
 * prove exclusive writer ownership or that earlier Milvus RPCs have settled.
 */
export function createRuntimePublisherPorts(input: {
  scope: RagRetrievalScope;
  control: PostgresDocumentPublicationStore;
  assets: PostgresPublicationAssetStore;
  operations: PostgresElasticsearchPublicationOperations;
  publisherDb: PostgresQueryClient;
  esSealer: ElasticsearchClient;
  esWriter: ElasticsearchClient;
  milvus: MilvusClient;
  verifyIsolation(): Promise<{ configurationDigest: string }>;
  timeoutMs: number;
  requiredProviders?: PublicationProvider[];
  operationIdentity?: { operationId: string; physicalCollection: string };
}): RuntimePublisherPorts {
  if (!input.scope?.enforceIsolation || typeof input.verifyIsolation !== 'function'
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 30000) {
    throw new Error('A trusted isolated publisher runtime is required.');
  }
  const trustedConfiguration = '';
  const operation = input.operationIdentity ?? { operationId: randomUUID(), physicalCollection: `rag_publication_${randomBytes(16).toString('hex')}` };
  const intents = new PostgresPublicationIntentStore(input.publisherDb);
  // The generation ports intentionally use a broader request shape than the
  // generated Elasticsearch SDK overloads; the concrete requests are built
  // inside those ports and remain SDK-compatible at runtime.
  const sealerPort = input.esSealer as unknown as Parameters<typeof sealOwnedGenerationIndex>[0]['client'];
  const readbackPort = input.esSealer as unknown as Parameters<typeof observeGenerationDocuments>[0]['client'];
  let current: { attempt: PublicationAttempt; materialized: Materialized; operation?: DurableElasticsearchOperation;
    handle?: OwnedGenerationIndex; identity?: GenerationIdentity; index?: RuntimeElasticsearchIdentity } | undefined;
  const requireCurrent = (attempt: PublicationAttempt, materialized?: RuntimeMaterialized) => {
    if (!current || current.attempt.leaseToken !== attempt.leaseToken || current.attempt.generation !== attempt.generation
      || current.attempt.tenantId !== attempt.tenantId || current.attempt.corpusId !== attempt.corpusId
      || current.attempt.documentId !== attempt.documentId || (materialized && current.materialized !== materialized)) {
      throw new Error('Publisher runtime attempt is inconsistent.');
    }
    return current;
  };
  const checkScope = (asset: PreparedPublicationAsset) => {
    if (asset.tenantId !== input.scope.tenantId || asset.corpusId !== input.scope.corpusId) {
      throw new Error('Publisher asset is outside the authorized scope.');
    }
  };
  return {
    async assertIsolation() {
      // A callback, even one returning a digest, cannot attest exclusive access
      // or that a previously sent Milvus RPC has settled. Fail closed until a
      // deployment-owned capability and privately constructed client exist.
      assertRuntimeMilvusNoRetries(input.milvus);
      throw new Error('Publisher isolation capability is unavailable.');
    },
    async begin(asset) {
      checkScope(asset);
      const intent: PublicationOperationIntent = { ...operation, tenantId: asset.tenantId, corpusId: asset.corpusId,
        documentId: asset.documentId, contentVersion: asset.contentVersion, manifestDigest: asset.manifestDigest };
      await intents.prepare(intent);
      return input.control.begin({ tenantId: asset.tenantId, corpusId: asset.corpusId, documentId: asset.documentId,
        idempotencyKey: operation.operationId, contentVersion: asset.contentVersion, manifestDigest: asset.manifestDigest,
        physicalCollection: operation.physicalCollection, requiredProviders: input.requiredProviders ?? ['milvus', 'elasticsearch'] });
    },
    claim: candidate => input.control.claim(candidate, 3_600_000),
    renew: attempt => input.control.renew(attempt, 3_600_000),
    abandon: attempt => input.control.abandon(attempt),
    stage: (attempt, asset) => input.assets.stage(attempt, asset),
    async materialize(attempt) {
      const data = await loadPublicationManifests(input.scope, attempt, input.assets);
      const identity = { ...attempt, contentVersion: data.lexicalDocuments[0].document_version };
      // The lease token is not part of a persisted manifest or public identity.
      const { leaseToken: _leaseToken, ...candidate } = identity;
      void _leaseToken;
      const value: Materialized = { ...data, identity: candidate, ids: data.rows.map(row => row.id) };
      current = { attempt, materialized: value };
      return value;
    },
    async createElasticsearch(attempt, materialized) {
      const state = requireCurrent(attempt, materialized);
      const result = await createPersistedElasticsearchIndex({ store: input.operations, client: sealerPort,
        attempt, contentVersion: materialized.identity.contentVersion });
      state.operation = result.operation;
      state.handle = result.handle;
      state.identity = result.operation.identity;
      state.index = { indexName: result.handle.indexName, indexUuid: result.handle.indexUuid, ownerMarker: result.operation.marker };
      return state.index;
    },
    async writeElasticsearch(attempt, materialized, index) {
      const state = requireCurrent(attempt, materialized);
      if (state.index !== index || !state.identity) throw new Error('Elasticsearch operation is unavailable.');
      const result = await writeGenerationDocuments({ client: input.esWriter, indexName: index.indexName,
        identity: state.identity, documents: state.materialized.lexicalDocuments });
      if (result.attempted !== state.materialized.lexicalDocuments.length || result.conflicts !== 0) {
        throw new Error('Elasticsearch generation write is incomplete or duplicated.');
      }
    },
    async writeMilvus(attempt, materialized) {
      const state = requireCurrent(attempt, materialized);
      const manifest = JSON.parse((await input.assets.readStaged(attempt)).manifestJson) as { embedding: { dimension: number } };
      const writer = new MilvusPublicationWriter({ client: input.milvus, collection: attempt.physicalCollection,
        scope: input.scope, dimension: manifest.embedding.dimension, chunks: state.materialized.writerChunks,
        checkLease: async () => { await input.control.renew(attempt, 3_600_000); return true; }, timeoutMs: input.timeoutMs });
      // This is a write acknowledgement and diagnostic observation only. It is
      // independently re-read below and never promoted directly to a seal.
      await writer.observe();
    },
    async verifyMilvus(attempt, materialized) {
      const state = requireCurrent(attempt, materialized);
      const observed = await verifyRuntimeMilvusReadback({ client: input.milvus, collection: attempt.physicalCollection,
        expectedRows: state.materialized.rows,
        assertLease: () => input.control.renew(attempt, 3_600_000), timeoutMs: input.timeoutMs });
      return { ...attemptIdentity(attempt, materialized), provider: 'milvus', resourceName: attempt.physicalCollection,
        resourceId: observed.collectionId, manifestJson: state.materialized.milvusManifestJson,
        configurationDigest: trustedConfiguration, evidenceDigest: observed.evidenceDigest };
    },
    async sealElasticsearch(attempt, materialized, index) {
      const state = requireCurrent(attempt, materialized);
      if (state.index !== index || !state.handle || !state.identity || !state.operation) throw new Error('Elasticsearch operation is unavailable.');
      // The seal operation checks the entire owned physical index in one PIT.
      // A second independent read confirms the provider data under that block.
      const blocked = await sealOwnedGenerationIndex({ client: sealerPort, handle: state.handle,
        documents: state.materialized.lexicalDocuments });
      if (blocked.indexName !== index.indexName || blocked.indexUuid !== index.indexUuid) throw new Error('Elasticsearch seal identity changed.');
      await assertElasticsearchBlock(input.esSealer, index);
      const observed = await observeGenerationDocuments({ client: readbackPort, indexName: index.indexName,
        identity: state.identity, documents: state.materialized.lexicalDocuments });
      if (observed.count !== state.materialized.lexicalDocuments.length) throw new Error('Elasticsearch readback is incomplete.');
      await assertElasticsearchBlock(input.esSealer, index);
      return { ...attemptIdentity(attempt, materialized), provider: 'elasticsearch', resourceName: index.indexName,
        resourceId: index.indexUuid, manifestJson: state.materialized.elasticsearchManifestJson,
        configurationDigest: trustedConfiguration, evidenceDigest: `sha256:${observed.digest}` };
    },
    async recordSeal() {
      throw new Error('Publication seal capability is unavailable.');
    },
    async publish() { throw new Error('Publication capability is unavailable.'); },
  };
}

/** Runtime remains disabled until a deployment-owned capability is implemented. */
export function createRuntimePublicationPublisher(input: Parameters<typeof createRuntimePublisherPorts>[0]) {
  let consumed = false;
  const operationIdentity = input.operationIdentity ?? { operationId: randomUUID(), physicalCollection: `rag_publication_${randomBytes(16).toString('hex')}` };
  const ports = createRuntimePublisherPorts({ ...input, operationIdentity });
  return {
    operationIdentity: Object.freeze({ ...operationIdentity }),
    async status(asset: PreparedPublicationAsset) {
      if (asset.tenantId !== input.scope.tenantId || asset.corpusId !== input.scope.corpusId) throw new Error('Publisher asset is outside the authorized scope.');
      return new PostgresPublicationIntentStore(input.publisherDb).read({ ...operationIdentity, tenantId: asset.tenantId,
        corpusId: asset.corpusId, documentId: asset.documentId, contentVersion: asset.contentVersion, manifestDigest: asset.manifestDigest });
    },
    async publish(asset: PreparedPublicationAsset, signal?: AbortSignal) {
      if (consumed) throw new Error('Publication runtime is single-use.');
      consumed = true;
      return publishRuntimeGeneration(asset, ports, { timeoutMs: input.timeoutMs, signal });
    },
  };
}

function attemptIdentity(attempt: PublicationAttempt, materialized: RuntimeMaterialized) {
  return { tenantId: attempt.tenantId, corpusId: attempt.corpusId, documentId: attempt.documentId,
    generation: attempt.generation, revision: attempt.revision, manifestDigest: attempt.manifestDigest,
    physicalCollection: attempt.physicalCollection, contentVersion: materialized.identity.contentVersion };
}

async function assertElasticsearchBlock(client: ElasticsearchClient, index: RuntimeElasticsearchIdentity): Promise<void> {
  const result = await client.indices.get({ index: index.indexName, allow_no_indices: false,
    ignore_unavailable: false, expand_wildcards: 'none' }) as unknown as Record<string, unknown>;
  const root = object(Object.hasOwn(result, 'body') ? result.body : result);
  if (Object.keys(root).length !== 1 || !Object.hasOwn(root, index.indexName)) throw new Error('Elasticsearch index is ambiguous.');
  const entry = object(root[index.indexName]);
  const settings = object(object(entry.settings).index);
  const block = object(settings.blocks).write;
  const owner = object(object(entry.mappings)._meta).generation_owner;
  if (settings.uuid !== index.indexUuid || owner !== index.ownerMarker || (block !== true && block !== 'true')
    || Object.keys(object(entry.aliases)).length !== 0) throw new Error('Elasticsearch publication block or identity changed.');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Elasticsearch publication response.');
  return value as Record<string, unknown>;
}

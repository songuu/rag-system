import type { PreparedPublicationAsset } from './publication-asset-store';
import type { PublicationAttempt, PublicationCandidate } from './publication-control-cas';
import type { PipelinePublicationReceipt } from './publication-ingest';

/**
 * Internal-only service ports. The process owning these ports is the trusted
 * publisher, not the request handler: callers must not accept ports or
 * attestations from HTTP input. Provider verification must independently read
 * the real backend after writes; an experimental observation is not a seal.
 */
export interface RuntimePublisherPorts {
  assertIsolation(): Promise<{ configurationDigest: string }>;
  begin(asset: PreparedPublicationAsset): Promise<PublicationCandidate>;
  claim(candidate: PublicationCandidate): Promise<PublicationAttempt>;
  renew(attempt: PublicationAttempt): Promise<void>;
  stage(attempt: PublicationAttempt, asset: PreparedPublicationAsset): Promise<void>;
  materialize(attempt: PublicationAttempt): Promise<RuntimeMaterialized>;
  createElasticsearch(attempt: PublicationAttempt, materialized: RuntimeMaterialized): Promise<RuntimeElasticsearchIdentity>;
  writeElasticsearch(attempt: PublicationAttempt, materialized: RuntimeMaterialized, index: RuntimeElasticsearchIdentity): Promise<void>;
  writeMilvus(attempt: PublicationAttempt, materialized: RuntimeMaterialized): Promise<void>;
  verifyMilvus(attempt: PublicationAttempt, materialized: RuntimeMaterialized): Promise<RuntimeProviderSeal>;
  sealElasticsearch(attempt: PublicationAttempt, materialized: RuntimeMaterialized, index: RuntimeElasticsearchIdentity): Promise<RuntimeProviderSeal>;
  recordSeal(attempt: PublicationAttempt, seal: RuntimeProviderSeal): Promise<void>;
  publish(attempt: PublicationAttempt): Promise<RuntimePublished>;
  abandon(attempt: PublicationAttempt): Promise<void>;
}

interface RuntimeIdentity extends PublicationCandidate { contentVersion: string }
export interface RuntimeMaterialized {
  identity: RuntimeIdentity;
  ids: readonly string[];
  /** Recomputed by the trusted service from the lease-bound authoritative asset. */
  milvusManifestJson: string;
  elasticsearchManifestJson: string;
}
export interface RuntimeElasticsearchIdentity { indexName: string; indexUuid: string; ownerMarker: string }
export interface RuntimeProviderSeal extends RuntimeIdentity {
  provider: 'milvus' | 'elasticsearch';
  resourceName: string;
  resourceId: string;
  manifestJson: string;
  configurationDigest: string;
  evidenceDigest: string;
}
export interface RuntimePublished extends PublicationCandidate { assetId: string }

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class RuntimePublicationError extends Error {
  readonly code = 'PUBLICATION_RUNTIME_FAILED';
  readonly disposition: 'not-started' | 'abandoned' | 'unknown';
  readonly candidate?: Readonly<PublicationCandidate>;
  constructor(disposition: RuntimePublicationError['disposition'], cause: unknown, candidate?: PublicationCandidate) {
    super('Publication could not be completed; inspect the generation before retrying.', { cause });
    this.name = 'RuntimePublicationError';
    this.disposition = disposition;
    this.candidate = candidate && Object.freeze({ tenantId: candidate.tenantId, corpusId: candidate.corpusId,
      documentId: candidate.documentId, generation: candidate.generation, revision: candidate.revision,
      manifestDigest: candidate.manifestDigest, physicalCollection: candidate.physicalCollection });
  }
}

/**
 * Every generation is single-use. Timeouts and aborted/unknown writes can
 * still complete remotely; abandon the generation rather than retrying it.
 * The isolation and verifier ports must be implemented by trusted deployment
 * code that inspects actual providers; no client-supplied proof is accepted.
 */
export async function publishRuntimeGeneration(
  asset: PreparedPublicationAsset,
  ports: RuntimePublisherPorts,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<PipelinePublicationReceipt> {
  if (!asset || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 3_600_000
    || !DIGEST.test(asset.manifestDigest) || !DIGEST.test(asset.contentVersion)) throw new Error('Invalid runtime publication request.');
  let attempt: PublicationAttempt | undefined;
  let candidateForReconciliation: PublicationCandidate | undefined;
  let started = false;
  let committed = false;
  try {
    const isolation = await bounded(() => ports.assertIsolation(), options);
    if (!isolation || !DIGEST.test(isolation.configurationDigest)) throw new Error('Publisher isolation is unavailable.');
    started = true;
    const candidate = await bounded(() => ports.begin(asset), options);
    assertCandidate(asset, candidate);
    candidateForReconciliation = candidate;
    const claimed = await bounded(() => ports.claim(candidate), options);
    assertCandidate(asset, claimed, candidate);
    if (!UUID.test(claimed.leaseToken)) throw new Error('Invalid publisher lease.');
    attempt = claimed;
    await step(claimed, ports, options, () => ports.stage(claimed, asset));
    const materialized = await step(claimed, ports, options, () => ports.materialize(claimed));
    assertCandidate(asset, materialized?.identity, claimed);
    if (materialized.identity.contentVersion !== asset.contentVersion || !Array.isArray(materialized.ids)
      || materialized.ids.length < 1 || materialized.ids.length > 1000
      || materialized.ids.some(id => typeof id !== 'string' || !id) || new Set(materialized.ids).size !== materialized.ids.length) {
      throw new Error('Publication materialization identity is invalid.');
    }
    const index = await step(claimed, ports, options, () => ports.createElasticsearch(claimed, materialized));
    if (!index || !/^codex-generation-seal-[a-f0-9]{32}$/.test(index.indexName)
      || !/^[A-Za-z0-9_-]{1,128}$/.test(index.indexUuid) || !/^[a-f0-9]{64}$/.test(index.ownerMarker)) {
      throw new Error('Elasticsearch index identity is invalid.');
    }
    await step(claimed, ports, options, () => ports.writeElasticsearch(claimed, materialized, index));
    await step(claimed, ports, options, () => ports.writeMilvus(claimed, materialized));
    const milvus = await step(claimed, ports, options, () => ports.verifyMilvus(claimed, materialized));
    assertSeal(asset, claimed, milvus, 'milvus', claimed.physicalCollection, materialized.milvusManifestJson);
    const elasticsearch = await step(claimed, ports, options, () => ports.sealElasticsearch(claimed, materialized, index));
    assertSeal(asset, claimed, elasticsearch, 'elasticsearch', index.indexName, materialized.elasticsearchManifestJson, index.indexUuid);
    const finalIsolation = await step(claimed, ports, options, () => ports.assertIsolation());
    if (finalIsolation?.configurationDigest !== isolation.configurationDigest
      || milvus.configurationDigest !== isolation.configurationDigest || elasticsearch.configurationDigest !== isolation.configurationDigest) {
      throw new Error('Publisher isolation changed during publication.');
    }
    await step(claimed, ports, options, () => ports.recordSeal(claimed, milvus));
    await step(claimed, ports, options, () => ports.recordSeal(claimed, elasticsearch));
    await bounded(() => ports.renew(claimed), options);
    const published = await bounded(() => ports.publish(claimed), options);
    // Publication changes the head revision and consumes the staging lease;
    // renewing or abandoning that lease after a confirmed commit is invalid.
    attempt = undefined;
    committed = true;
    assertCandidate(asset, published, { ...claimed, revision: (BigInt(claimed.revision) + BigInt(1)).toString() });
    if (!UUID.test(published.assetId)) throw new Error('Published asset identity is invalid.');
    return { status: 'published', tenantId: asset.tenantId, corpusId: asset.corpusId, documentId: asset.documentId,
      contentVersion: asset.contentVersion, manifestDigest: asset.manifestDigest, generation: published.generation,
      revision: published.revision, ids: [...materialized.ids] };
  } catch (error) {
    let disposition: RuntimePublicationError['disposition'] = started || committed ? 'unknown' : 'not-started';
    if (attempt) {
      // Failure to abandon means completion is unknown, not that cleanup succeeded.
      try {
        await bounded(() => ports.abandon(attempt!), { timeoutMs: options.timeoutMs });
        disposition = 'abandoned';
      } catch { /* Operators must reconcile an unknown outcome. */ }
    }
    throw new RuntimePublicationError(disposition, error, candidateForReconciliation);
  }
}

function assertCandidate(asset: PreparedPublicationAsset, value: PublicationCandidate, expected?: PublicationCandidate): void {
  if (!value || value.tenantId !== asset.tenantId || value.corpusId !== asset.corpusId || value.documentId !== asset.documentId
    || value.manifestDigest !== asset.manifestDigest || !/^rag_publication_[a-f0-9]{32}$/.test(value.physicalCollection)
    || !/^[1-9][0-9]{0,15}$/.test(value.generation) || !Number.isSafeInteger(Number(value.generation))
    || !/^[1-9][0-9]{0,18}$/.test(value.revision)
    || (expected && (value.generation !== expected.generation || value.revision !== expected.revision
      || value.physicalCollection !== expected.physicalCollection))) throw new Error('Publication generation identity is invalid.');
}

function assertSeal(asset: PreparedPublicationAsset, attempt: PublicationAttempt, seal: RuntimeProviderSeal,
  provider: RuntimeProviderSeal['provider'], resourceName: string, expectedManifest: string, resourceId?: string): void {
  assertCandidate(asset, seal, attempt);
  if (!seal || seal.provider !== provider || seal.contentVersion !== asset.contentVersion || seal.resourceName !== resourceName
    || typeof seal.resourceId !== 'string' || !seal.resourceId || (resourceId !== undefined && seal.resourceId !== resourceId)
    || typeof seal.manifestJson !== 'string' || seal.manifestJson !== expectedManifest
    || Buffer.byteLength(seal.manifestJson, 'utf8') > 4 * 1024 * 1024
    || (provider === 'milvus' && !/^[1-9][0-9]{0,18}$/.test(seal.resourceId))
    || !DIGEST.test(seal.configurationDigest) || !DIGEST.test(seal.evidenceDigest)
    || 'productionAuthorized' in seal) throw new Error('Provider verification is unavailable or inconsistent.');
}

async function step<T>(attempt: PublicationAttempt, ports: RuntimePublisherPorts,
  options: { timeoutMs: number; signal?: AbortSignal }, work: () => Promise<T>): Promise<T> {
  await bounded(() => ports.renew(attempt), options);
  const value = await bounded(work, options);
  await bounded(() => ports.renew(attempt), options);
  return value;
}

async function bounded<T>(work: () => Promise<T>, options: { timeoutMs: number; signal?: AbortSignal }): Promise<T> {
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('Publication cancelled.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Publication operation timed out; generation must be abandoned.')), options.timeoutMs);
      if (options.signal) {
        onAbort = () => reject(options.signal?.reason ?? new Error('Publication cancelled.'));
        options.signal.addEventListener('abort', onAbort, { once: true });
        if (options.signal.aborted) onAbort();
      }
    });
    return await Promise.race([Promise.resolve().then(() => {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('Publication cancelled.');
      return work();
    }), cancelled]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener('abort', onAbort);
  }
}

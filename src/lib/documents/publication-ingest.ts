import { createRetrievalScope, isServerDerivedScope, type RagTrustLevel } from '../security/retrieval-scope';
import { getPostgresClient } from '../postgres/client';
import { assertPublicationPostgresCapability } from './publication-postgres-capability';
import { assertPublicationViewCurrent, readPublicationView } from './publication-view';
import { preparePublicationAsset, validatePublicationAsset, type PreparedPublicationAsset, type PublicationAssetInput } from './publication-asset-store';

export type PublicationIngestMode = 'off' | 'active';

export class PublicationIngestUnavailableError extends Error {
  readonly code = 'PUBLICATION_INGEST_UNAVAILABLE';
  readonly status = 503;
  constructor(message = 'Unified publication is not ready; document ingestion was not started.') {
    super(message);
    this.name = 'PublicationIngestUnavailableError';
  }
}

export interface PipelinePublicationInput extends Omit<PublicationAssetInput, 'tenantId' | 'corpusId' | 'chunks'> {
  serverMetadata: Record<string, unknown>;
  documentVersion: string;
  documents: readonly { id: string; content: string; embedding: number[]; metadata: Record<string, unknown> }[];
}

export interface PipelinePublicationReceipt {
  status: 'published';
  tenantId: string;
  corpusId: string;
  documentId: string;
  contentVersion: string;
  manifestDigest: string;
  generation: string;
  revision: string;
  ids: string[];
}

/** Internal server-only adapter. The caller must obtain it from trusted server code. */
export interface PipelinePublicationPublisher {
  publish(asset: PreparedPublicationAsset, signal?: AbortSignal): Promise<PipelinePublicationReceipt>;
}

export function resolvePublicationIngestMode(env: NodeJS.ProcessEnv = process.env): PublicationIngestMode {
  if (env.RAG_UNIFIED_PUBLICATION_MODE === undefined) return 'off';
  const mode = env.RAG_UNIFIED_PUBLICATION_MODE.trim().toLowerCase();
  if (mode === 'off' || mode === 'active') return mode;
  throw new PublicationIngestUnavailableError('Invalid unified publication mode; document ingestion was not started.');
}

export function preparePipelinePublication(input: PipelinePublicationInput): PreparedPublicationAsset {
  const metadata = input.serverMetadata;
  if (!isServerDerivedScope(metadata)) throw new PublicationIngestUnavailableError('Publication requires a server-derived scope.');
  const tenantId = metadata.tenantId;
  const corpusId = metadata.corpusId;
  const trustLevel = metadata.trustLevel;
  if (typeof tenantId !== 'string' || typeof corpusId !== 'string'
    || metadata.tenant_id !== tenantId || metadata.corpus_id !== corpusId
    || metadata.trust_level !== trustLevel || !['trusted', 'reviewed', 'external', 'quarantined'].includes(String(trustLevel))) {
    throw new PublicationIngestUnavailableError('Publication server scope is invalid.');
  }
  const asset = preparePublicationAsset({
    tenantId, corpusId, documentId: input.documentId,
    sourceBytes: input.sourceBytes, sourceIdentityBytes: input.sourceIdentityBytes,
    originalName: input.originalName, contentType: input.contentType, sourceKind: input.sourceKind,
    embedding: input.embedding, splitter: input.splitter,
    chunks: input.documents.map((item, index) => {
      const chunk = item.metadata;
      if (chunk.tenantId !== tenantId || chunk.tenant_id !== tenantId || chunk.corpusId !== corpusId
        || chunk.corpus_id !== corpusId || chunk.trustLevel !== trustLevel || chunk.trust_level !== trustLevel
        || chunk.documentId !== undefined && chunk.documentId !== input.documentId
        || chunk.document_id !== undefined && chunk.document_id !== input.documentId
        || chunk.chunkIndex !== index) throw new PublicationIngestUnavailableError('Publication chunk scope is inconsistent.');
      // The symbol marking trusted scope is process-local, not persisted data.
      const persistedMetadata = Object.fromEntries(Object.entries(chunk).filter(([, value]) => value !== undefined));
      return { chunkIndex: index, content: item.content, embedding: item.embedding, trustLevel: trustLevel as RagTrustLevel,
        ...(typeof chunk.source === 'string' ? { source: chunk.source } : {}),
        ...(typeof chunk.pageNumber === 'number' ? { page: chunk.pageNumber } : {}),
        ...(typeof chunk.startOffset === 'number' ? { startOffset: chunk.startOffset } : {}),
        ...(typeof chunk.endOffset === 'number' ? { endOffset: chunk.endOffset } : {}),
        metadata: persistedMetadata };
    }),
  });
  if (asset.contentVersion !== input.documentVersion) throw new PublicationIngestUnavailableError('Publication source version is inconsistent.');
  return asset;
}

export async function commitPipelinePublication(input: PipelinePublicationInput, publisher: PipelinePublicationPublisher | undefined,
  signal?: AbortSignal): Promise<PipelinePublicationReceipt> {
  if (!publisher) throw new PublicationIngestUnavailableError();
  if (signal?.aborted) throw signal.reason ?? new Error('Publication was cancelled.');
  const asset = preparePipelinePublication(input);
  const receipt = await publisher.publish(asset, signal);
  validatePublicationAsset(asset, asset);
  if (!receipt || receipt.status !== 'published' || receipt.tenantId !== asset.tenantId || receipt.corpusId !== asset.corpusId
    || receipt.documentId !== asset.documentId || receipt.contentVersion !== asset.contentVersion || receipt.manifestDigest !== asset.manifestDigest
    || !/^[1-9][0-9]{0,18}$/.test(receipt.generation) || !/^[1-9][0-9]{0,18}$/.test(receipt.revision)
    || !Array.isArray(receipt.ids) || receipt.ids.length !== input.documents.length
    || receipt.ids.some(id => typeof id !== 'string' || !id) || new Set(receipt.ids).size !== receipt.ids.length) {
    throw new PublicationIngestUnavailableError('Publication result identity is inconsistent.');
  }
  if (signal?.aborted) throw signal.reason ?? new Error('Publication was cancelled.');
  // A publisher's own success response is not publication authority. Read the
  // server-side view independently and recheck its revision before returning.
  const client = getPostgresClient();
  if (!client) throw new PublicationIngestUnavailableError('Publication authority is unavailable.');
  await assertPublicationPostgresCapability(client);
  const scope = createRetrievalScope({ tenantId: asset.tenantId, corpusId: asset.corpusId,
    allowedTrustLevels: [input.serverMetadata.trustLevel as RagTrustLevel], enforceIsolation: true });
  const view = await readPublicationView(scope, client);
  const document = view.documents.find(item => item.documentId === asset.documentId);
  if (!document || document.generation !== receipt.generation || document.revision !== receipt.revision
    || document.contentVersion !== asset.contentVersion || document.manifestDigest !== asset.manifestDigest
    || document.milvus.chunks.length !== receipt.ids.length
    || document.milvus.chunks.some((chunk, index) => chunk.id !== receipt.ids[index])) {
    throw new PublicationIngestUnavailableError('Publication result could not be verified.');
  }
  await assertPublicationViewCurrent(view, scope, client);
  if (signal?.aborted) throw signal.reason ?? new Error('Publication was cancelled.');
  return receipt;
}

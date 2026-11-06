import type { ElasticsearchLexicalDocument } from '../elasticsearch/lexical-index';
import { generationDocumentDigest } from '../elasticsearch/generation-index';
import type { RagRetrievalScope, RagTrustLevel } from '../security/retrieval-scope';
import { canonicalJson } from '../rag/eval/canonical-json';
import { validatePublicationAsset, type PreparedPublicationAsset, type PostgresPublicationAssetStore } from './publication-asset-store';
import type { PublicationAttempt } from './publication-control-cas';
import { createPublicationChunk, publicationManifestEntry, type PublicationChunkInput } from './milvus-publication-generation';

type MilvusEntry = ReturnType<typeof publicationManifestEntry> & { chunkId: string; descriptorDigest: string };
type ElasticsearchEntry = { chunkIndex: number; chunkId: string; digest: string; descriptorDigest: string };

/**
 * Builds provider inputs only; it is not a seal, verification, or publication.
 * The caller must obtain the asset from the fenced PostgreSQL staging store.
 */
export function materializePublicationManifests(scope: RagRetrievalScope, attempt: PublicationAttempt, asset: PreparedPublicationAsset) {
  assertPublicationScope(scope, attempt);
  validatePublicationAsset(attempt, asset);
  const manifest = JSON.parse(asset.manifestJson) as {
    embedding: { dimension: number }; chunks: Array<{ chunkIndex: number; descriptorDigest: string }>;
  };
  const chunks = JSON.parse(asset.chunksJson) as Array<{ chunkIndex: number; content: string; descriptorJson: string;
    metadataJson: string; embeddingBase64: string }>;
  const rows: ReturnType<typeof createPublicationChunk>[] = [];
  const writerChunks: PublicationChunkInput[] = [];
  const lexicalDocuments: ElasticsearchLexicalDocument[] = [];
  const milvus: MilvusEntry[] = [];
  const elasticsearch: ElasticsearchEntry[] = [];
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const descriptor = JSON.parse(chunk.descriptorJson) as { trustLevel: RagTrustLevel; source?: string | null;
      page?: number | null; startOffset?: number; endOffset?: number };
    const metadata = JSON.parse(chunk.metadataJson) as Record<string, unknown>;
    const vector = Buffer.from(chunk.embeddingBase64, 'base64');
    const writerChunk: PublicationChunkInput = { documentId: attempt.documentId, generation: Number(attempt.generation),
      documentVersion: asset.contentVersion, trustLevel: descriptor.trustLevel, chunkIndex: chunk.chunkIndex,
      content: chunk.content, embedding: Array.from({ length: manifest.embedding.dimension }, (_, i) => vector.readFloatLE(i * 4)) };
    const row = createPublicationChunk(scope, writerChunk, manifest.embedding.dimension);
    const lexical: ElasticsearchLexicalDocument = { chunk_id: row.id, tenant_id: scope.tenantId, corpus_id: scope.corpusId,
      document_id: attempt.documentId, document_version: asset.contentVersion, trust_level: descriptor.trustLevel,
      content: chunk.content, metadata,
      ...(typeof descriptor.source === 'string' ? { source: descriptor.source } : {}),
      ...(typeof descriptor.page === 'number' ? { page: descriptor.page } : {}),
      ...(typeof descriptor.startOffset === 'number' ? { start_offset: descriptor.startOffset } : {}),
      ...(typeof descriptor.endOffset === 'number' ? { end_offset: descriptor.endOffset } : {}) };
    const descriptorDigest = manifest.chunks[index].descriptorDigest;
    rows.push(row);
    writerChunks.push(writerChunk);
    lexicalDocuments.push(lexical);
    milvus.push({ ...publicationManifestEntry(row), chunkId: row.id, descriptorDigest });
    elasticsearch.push({ chunkIndex: chunk.chunkIndex, chunkId: row.id,
      digest: generationDocumentDigest({ ...lexical, publication_generation: attempt.generation }), descriptorDigest });
  }
  // Individual descriptors are canonicalized separately to avoid applying the
  // single-object budget to an otherwise valid bounded 1,000-chunk manifest.
  const manifestJson = (entries: readonly (MilvusEntry | ElasticsearchEntry)[]) => {
    const result = `[${entries.map(entry => canonicalJson(entry)).join(',')}]`;
    if (Buffer.byteLength(result, 'utf8') > 4 * 1024 * 1024) throw new Error('Provider manifest capacity exceeded.');
    return result;
  };
  return { rows, writerChunks, lexicalDocuments, milvus, elasticsearch,
    milvusManifestJson: manifestJson(milvus), elasticsearchManifestJson: manifestJson(elasticsearch),
    productionAuthorized: false as const };
}

/** The store enforces the attempt lease before returning the canonical asset. */
export async function loadPublicationManifests(scope: RagRetrievalScope, attempt: PublicationAttempt,
  store: Pick<PostgresPublicationAssetStore, 'readStaged'>) {
  assertPublicationScope(scope, attempt);
  const asset = await store.readStaged(attempt);
  return materializePublicationManifests(scope, attempt, asset);
}

function assertPublicationScope(scope: RagRetrievalScope, attempt: PublicationAttempt): void {
  if (!scope || !attempt || scope.enforceIsolation !== true || scope.tenantId !== attempt.tenantId || scope.corpusId !== attempt.corpusId
    || !Array.isArray(scope.allowedTrustLevels) || scope.allowedTrustLevels.length === 0) {
    throw new Error('Publication publisher requires an authorized isolated scope.');
  }
  if (typeof attempt.generation !== 'string' || !/^[1-9][0-9]*$/.test(attempt.generation)
    || !Number.isSafeInteger(Number(attempt.generation))) {
    throw new Error('Publication generation exceeds supported capacity.');
  }
}

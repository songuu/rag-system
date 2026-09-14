import { createHash } from 'node:crypto';
import type {
  MilvusDocumentQueryIdentity,
  MilvusQueryRow,
  MilvusVectorStore,
} from '../milvus-client';
import {
  createMiroFishGraphArtifact,
  type MiroFishGraphArtifactIdentity,
  type MiroFishGraphArtifactStore,
} from '../mirofish/graph-artifact-store';
import { extractMiroFishGraphData } from '../mirofish/graph-builder';
import type { GraphData } from '../mirofish/types';
import { createRetrievalScope, type RagTrustLevel } from '../security/retrieval-scope';
import type { KnowledgeGraphCommandStore } from './contracts';
import { createMiroFishGraphVersion } from './mirofish-adapter';
import type { KnowledgeGraphBuildJob } from './postgres-graph-build-store';

const MAX_DOCUMENT_CHUNKS = 1_000;
const MAX_METADATA_BYTES = 65_000;
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const TRUST_LEVELS = new Set<RagTrustLevel>([
  'trusted', 'reviewed', 'external', 'quarantined',
]);

export type LocalGraphBuildResult = {
  status: 'staged';
  progress: 1;
  artifactDigest: string;
};

interface LocalGraphBuildDependencies {
  milvus: Pick<MilvusVectorStore, 'queryDocumentRows'>;
  commandStore: Pick<KnowledgeGraphCommandStore, 'getCompatibilityDescriptor'>;
  artifactStore: Pick<MiroFishGraphArtifactStore, 'put'>;
  extractGraph?: (text: string, documentId: string) => Promise<GraphData>;
}

/**
 * Executes a durable BuildJob entirely inside the local worker.
 *
 * WHY: the BuildJob stores identity only; Milvus is the authoritative committed
 * text boundary after vectorization, so the worker must re-read that exact
 * revision instead of trusting an upload request or an unscoped file path.
 */
export function createLocalGraphBuildHandler(
  dependencies: LocalGraphBuildDependencies
): (job: KnowledgeGraphBuildJob) => Promise<LocalGraphBuildResult> {
  const extractGraph = dependencies.extractGraph
    ?? ((text: string, documentId: string) => extractMiroFishGraphData({ text, documentId }));
  return async job => {
    const identity = requiredJobIdentity(job);
    const expectedChunks = requiredChunkCount(job.metadata.chunkCount);
    const expectedGraphVersion = createMiroFishGraphVersion(identity);
    if (job.graphVersion !== expectedGraphVersion) {
      throw new Error('Local graph build version does not match its document identity.');
    }
    const scope = createRetrievalScope({
      tenantId: identity.tenantId,
      corpusId: identity.corpusId,
      allowedTrustLevels: [identity.trustLevel],
      enforceIsolation: true,
    });

    // A retry after Neo4j staging but before PostgreSQL validation must not run
    // the non-deterministic model extraction a second time.
    const existing = await dependencies.commandStore.getCompatibilityDescriptor(
      { tenantId: identity.tenantId, corpusId: identity.corpusId, graphVersion: job.graphVersion },
      scope
    );
    if (existing) {
      if (
        existing.tenantId !== identity.tenantId
        || existing.corpusId !== identity.corpusId
        || existing.graphVersion !== job.graphVersion
      ) {
        throw new Error('Local graph build Neo4j snapshot scope does not match the durable job.');
      }
      assertDocumentIdentity(existing.document, identity);
      return { status: 'staged', progress: 1, artifactDigest: existing.artifactDigest };
    }

    const rows = await dependencies.milvus.queryDocumentRows(
      scope,
      identity satisfies MilvusDocumentQueryIdentity,
      expectedChunks
    );
    const sourceText = reconstructDocument(rows, identity, expectedChunks);
    const graph = await extractGraph(sourceText, identity.documentId);
    const descriptor = await dependencies.artifactStore.put(
      createMiroFishGraphArtifact({ identity, graph }),
      graphNameOptions(job.metadata.sourceName)
    );
    assertArtifactIdentity(descriptor.identity, identity);
    return { status: 'staged', progress: 1, artifactDigest: descriptor.artifactDigest };
  };
}

function requiredJobIdentity(job: KnowledgeGraphBuildJob): MiroFishGraphArtifactIdentity {
  const value = job.metadata.documentIdentity;
  if (!isRecord(value)) {
    throw new Error('Local graph build job is missing its server-owned document identity.');
  }
  const trustLevel = requiredTrustLevel(value.trustLevel);
  const identity = {
    tenantId: requiredText(value.tenantId, 'tenantId'),
    corpusId: requiredText(value.corpusId, 'corpusId'),
    documentId: requiredText(value.documentId, 'documentId'),
    documentVersion: requiredText(value.documentVersion, 'documentVersion'),
    trustLevel,
  };
  if (identity.tenantId !== job.tenantId || identity.corpusId !== job.corpusId) {
    throw new Error('Local graph build document identity is outside the durable job scope.');
  }
  return identity;
}

function reconstructDocument(
  rows: readonly MilvusQueryRow[],
  identity: MiroFishGraphArtifactIdentity,
  expectedChunks: number
): string {
  if (rows.length !== expectedChunks) {
    throw new Error(
      `Local graph build expected ${expectedChunks} chunks, received ${rows.length}.`
    );
  }
  let sourceText = '';
  let expectedSourceTextLength: number | null = null;
  let expectedSourceTextHash: string | null = null;
  let previous: { content: string; startOffset: number; endOffset: number } | null = null;
  for (const [index, row] of rows.entries()) {
    assertRowIdentity(row, identity);
    const chunkIndex = requiredInteger(row.chunk_index, 'chunk_index');
    const totalChunks = requiredInteger(row.total_chunks, 'total_chunks');
    if (chunkIndex !== index || totalChunks !== expectedChunks) {
      throw new Error('Local graph build Milvus chunk inventory is inconsistent.');
    }
    const content = requiredChunkContent(row.content);
    const metadata = parseMetadata(row.metadata_json);
    assertMetadataIdentity(metadata, identity);
    const startOffset = requiredMetadataInteger(metadata, ['startOffset', 'start_offset']);
    const endOffset = requiredMetadataInteger(metadata, ['endOffset', 'end_offset']);
    const sourceTextLength = requiredMetadataInteger(
      metadata,
      ['sourceTextLength', 'source_text_length']
    );
    const sourceTextHash = requiredMetadataSha256(
      metadata,
      ['sourceTextHash', 'source_text_hash']
    );
    if (sourceTextLength < 1 || endOffset > sourceTextLength) {
      throw new Error('Local graph build Milvus chunk span exceeds its source text length.');
    }
    if (expectedSourceTextLength === null) {
      expectedSourceTextLength = sourceTextLength;
      expectedSourceTextHash = sourceTextHash;
    } else if (sourceTextLength !== expectedSourceTextLength) {
      throw new Error('Local graph build Milvus source text length is inconsistent.');
    } else if (sourceTextHash !== expectedSourceTextHash) {
      throw new Error('Local graph build Milvus source text hash is inconsistent.');
    }
    if (endOffset <= startOffset || endOffset - startOffset !== content.length) {
      throw new Error('Local graph build Milvus chunk span does not match its content.');
    }

    if (!previous) {
      if (startOffset !== 0) {
        throw new Error('Local graph build Milvus source must start at offset 0.');
      }
      sourceText = content;
    } else {
      if (startOffset < previous.startOffset || endOffset <= previous.endOffset) {
        throw new Error('Local graph build Milvus chunk spans are not monotonic.');
      }
      const overlap = Math.max(0, previous.endOffset - startOffset);
      if (overlap > previous.content.length || overlap > content.length) {
        throw new Error('Local graph build Milvus chunk overlap is invalid.');
      }
      if (
        overlap > 0
        && previous.content.slice(previous.content.length - overlap) !== content.slice(0, overlap)
      ) {
        throw new Error('Local graph build Milvus chunk overlap does not match.');
      }
      if (startOffset > previous.endOffset) {
        throw new Error('Local graph build Milvus source contains an unverified gap.');
      }
      sourceText += content.slice(overlap);
    }
    previous = { content, startOffset, endOffset };
  }
  if (!sourceText) throw new Error('Local graph build source text is empty.');
  if (previous?.endOffset !== expectedSourceTextLength || sourceText.length !== expectedSourceTextLength) {
    throw new Error('Local graph build Milvus source does not cover the source tail.');
  }
  const actualSourceTextHash = `sha256:${createHash('sha256').update(sourceText).digest('hex')}`;
  if (actualSourceTextHash !== expectedSourceTextHash) {
    throw new Error('Local graph build Milvus source text digest does not match.');
  }
  return sourceText;
}

function assertRowIdentity(
  row: MilvusQueryRow,
  identity: MiroFishGraphArtifactIdentity
): void {
  const fields: Array<[unknown, string, string]> = [
    [row.tenant_id, identity.tenantId, 'tenant'],
    [row.corpus_id, identity.corpusId, 'corpus'],
    [row.document_id, identity.documentId, 'document'],
    [row.document_version, identity.documentVersion, 'document version'],
    [row.trust_level, identity.trustLevel, 'trust level'],
  ];
  for (const [actual, expected, label] of fields) {
    if (actual !== expected) {
      throw new Error(`Local graph build Milvus ${label} is outside the durable job identity.`);
    }
  }
}

function assertMetadataIdentity(
  metadata: Record<string, unknown>,
  identity: MiroFishGraphArtifactIdentity
): void {
  const aliases: Array<[readonly string[], string, string]> = [
    [['tenantId', 'tenant_id'], identity.tenantId, 'tenant'],
    [['corpusId', 'corpus_id'], identity.corpusId, 'corpus'],
    [['documentId', 'document_id'], identity.documentId, 'document'],
    [['documentVersion', 'document_version'], identity.documentVersion, 'document version'],
    [['trustLevel', 'trust_level'], identity.trustLevel, 'trust level'],
  ];
  for (const [keys, expected, label] of aliases) {
    for (const key of keys) {
      if (metadata[key] !== undefined && metadata[key] !== expected) {
        throw new Error(`Local graph build Milvus metadata ${label} conflicts with scalar scope.`);
      }
    }
  }
}

function assertDocumentIdentity(
  actual: Pick<MiroFishGraphArtifactIdentity, 'documentId' | 'documentVersion' | 'trustLevel'>,
  expected: MiroFishGraphArtifactIdentity
): void {
  if (
    actual.documentId !== expected.documentId
    || actual.documentVersion !== expected.documentVersion
    || actual.trustLevel !== expected.trustLevel
  ) {
    throw new Error('Local graph build Neo4j snapshot identity does not match the durable job.');
  }
}

function assertArtifactIdentity(
  actual: MiroFishGraphArtifactIdentity,
  expected: MiroFishGraphArtifactIdentity
): void {
  if (actual.tenantId !== expected.tenantId || actual.corpusId !== expected.corpusId) {
    throw new Error('Local graph build Neo4j artifact scope does not match the durable job.');
  }
  assertDocumentIdentity(actual, expected);
}

function graphNameOptions(value: unknown): { graphName?: string } {
  if (value === undefined || value === null || value === '') return {};
  const graphName = requiredText(value, 'sourceName');
  if (graphName.length > 512) throw new Error('Local graph build sourceName is too long.');
  return { graphName };
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_METADATA_BYTES) {
    throw new Error('Local graph build Milvus metadata is invalid.');
  }
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) throw new Error('metadata is not an object');
    return parsed;
  } catch (error) {
    throw new Error('Local graph build Milvus metadata is malformed.', { cause: error });
  }
}

function requiredMetadataInteger(
  metadata: Record<string, unknown>,
  keys: readonly string[]
): number {
  for (const key of keys) {
    if (metadata[key] !== undefined) return requiredInteger(metadata[key], key);
  }
  throw new Error(`Local graph build Milvus metadata ${keys[0]} is required.`);
}

function requiredMetadataSha256(
  metadata: Record<string, unknown>,
  keys: readonly string[]
): string {
  for (const key of keys) {
    const value = metadata[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !SHA256_DIGEST_PATTERN.test(value)) {
      throw new Error(`Local graph build Milvus metadata ${key} is invalid.`);
    }
    return value;
  }
  throw new Error(`Local graph build Milvus metadata ${keys[0]} is required.`);
}

function requiredInteger(value: unknown, field: string): number {
  const normalized = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || Number(normalized) < 0) {
    throw new Error(`Local graph build Milvus ${field} is invalid.`);
  }
  return Number(normalized);
}

function requiredChunkCount(value: unknown): number {
  const count = requiredInteger(value, 'chunkCount');
  if (count < 1 || count > MAX_DOCUMENT_CHUNKS) {
    throw new Error(`Local graph build chunkCount must be between 1 and ${MAX_DOCUMENT_CHUNKS}.`);
  }
  return count;
}

function requiredChunkContent(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw new Error('Local graph build Milvus chunk content is required.');
  }
  return value;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Local graph build ${field} is required.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 1_024 || /[\u0000-\u001f]/u.test(normalized)) {
    throw new Error(`Local graph build ${field} is invalid.`);
  }
  return normalized;
}

function requiredTrustLevel(value: unknown): RagTrustLevel {
  if (typeof value !== 'string' || !TRUST_LEVELS.has(value as RagTrustLevel)) {
    throw new Error('Local graph build trustLevel is invalid.');
  }
  return value as RagTrustLevel;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

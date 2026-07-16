import type { MilvusSearchResult } from '../../milvus-client';
import type { RagEvidence } from '../core/types';

export interface LegacyPolicyDocument {
  id?: string;
  content: string;
  metadata?: Record<string, unknown>;
  score?: number;
  rerankScore?: number;
}

export function normalizeLegacyPolicyDocuments(
  documents: readonly LegacyPolicyDocument[]
): MilvusSearchResult[] {
  const generatedIdOccurrences = new Map<string, number>();
  return documents.map(document => {
    const metadata = document.metadata ?? {};
    const explicitId = document.id?.trim() || readMetadataEvidenceId(metadata);
    const generatedId = 'legacy-policy-' + stableHash([
        readMetadataDocumentIdentity(metadata) ?? '',
        readMetadataChunkPosition(metadata),
        document.content,
      ].join('\u001f'));
    const occurrence = generatedIdOccurrences.get(generatedId) ?? 0;
    if (!explicitId) generatedIdOccurrences.set(generatedId, occurrence + 1);
    const id = explicitId
      || (occurrence === 0 ? generatedId : generatedId + '-duplicate-' + (occurrence + 1));
    const score = Number.isFinite(document.score) ? Number(document.score) : 0;
    return {
      id,
      content: document.content,
      metadata: { ...metadata },
      score,
      distance: 1 - score,
    };
  });
}

function readMetadataChunkPosition(metadata: Record<string, unknown>): string {
  const fields = [
    ['page', metadata.page],
    ['chunkIndex', metadata.chunkIndex ?? metadata.chunk_index],
    ['startOffset', metadata.startOffset ?? metadata.start_offset],
    ['endOffset', metadata.endOffset ?? metadata.end_offset],
  ] as const;
  return fields
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => key + '=' + String(value))
    .join('\u001e');
}

export function createLegacyEvidenceTransform(
  priorEvidence: readonly RagEvidence[],
  preferredOrder: readonly string[],
  rerankScores: Readonly<Record<string, number | undefined>> = {}
): NonNullable<import('./lane-executor').RagLaneHandlerResult['transform']> {
  const existingIds = new Set(priorEvidence.map(item => item.id));
  const orderedEvidenceIds: string[] = [];
  const seen = new Set<string>();
  for (const id of preferredOrder) {
    if (!existingIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    orderedEvidenceIds.push(id);
  }
  for (const item of priorEvidence) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    orderedEvidenceIds.push(item.id);
  }

  const acceptedScores: Record<string, number> = {};
  for (const id of orderedEvidenceIds) {
    const score = rerankScores[id];
    if (score !== undefined && Number.isFinite(score)) {
      acceptedScores[id] = score;
    }
  }

  return {
    orderedEvidenceIds,
    ...(Object.keys(acceptedScores).length > 0
      ? { rerankScores: acceptedScores }
      : {}),
  };
}

function readMetadataEvidenceId(metadata: Record<string, unknown>): string | undefined {
  for (const key of ['id', 'chunk_id', 'chunkId', 'evidence_id', 'evidenceId']) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function readMetadataDocumentIdentity(metadata: Record<string, unknown>): string | undefined {
  for (const key of ['document_id', 'documentId', 'source']) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

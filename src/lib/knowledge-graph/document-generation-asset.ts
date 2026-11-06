import { validatePublicationAsset, type PreparedPublicationAsset, type PostgresPublicationAssetStore } from '../documents/publication-asset-store';
import type { PublicationAttempt } from '../documents/publication-control-cas';
import type { KnowledgeGraphSnapshot } from './contracts';
import { stageReservedDocumentGraph } from './document-generation-reservation';
import { canonicalJson } from '../rag/eval/canonical-json';

/** Verifies passage provenance only; entities and relations are not independently verified or sealed. */
export function assertDocumentGraphAsset(attempt: PublicationAttempt, asset: PreparedPublicationAsset, snapshot: KnowledgeGraphSnapshot): void {
  validatePublicationAsset(attempt, asset);
  if (!snapshot || snapshot.tenantId !== attempt.tenantId || snapshot.corpusId !== attempt.corpusId
    || snapshot.documents.length !== 1 || snapshot.documents[0].documentId !== attempt.documentId
    || snapshot.documents[0].documentVersion !== asset.contentVersion) throw new Error('Graph document does not match staged asset.');
  const chunks = JSON.parse(asset.chunksJson) as Array<{ chunkIndex: number; content: string; descriptorJson: string; metadataJson: string }>;
  if (snapshot.passages.length !== chunks.length) throw new Error('Graph passages do not match staged asset.');
  const seen = new Set<string>();
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i], passage = snapshot.passages[i];
    const descriptor = JSON.parse(chunk.descriptorJson) as { trustLevel: string; source: string | null; page: number | null; startOffset?: number; endOffset?: number };
    const metadata = JSON.parse(chunk.metadataJson) as Record<string, unknown>;
    if (!passage || !passage.id || seen.has(passage.id) || passage.index !== chunk.chunkIndex
      || passage.documentId !== attempt.documentId || passage.documentVersion !== asset.contentVersion
      || passage.content !== chunk.content || passage.trustLevel !== descriptor.trustLevel
      || snapshot.documents[0].trustLevel !== descriptor.trustLevel
      || descriptor.startOffset === undefined || descriptor.endOffset === undefined
      || passage.startOffset !== descriptor.startOffset || passage.endOffset !== descriptor.endOffset
      || (passage.source ?? null) !== descriptor.source || (passage.page ?? null) !== descriptor.page
      || canonicalJson(passage.metadata ?? {}) !== chunk.metadataJson
      || (passage.sectionPath !== undefined && canonicalJson(passage.sectionPath) !== canonicalJson(metadata.sectionPath ?? null))) throw new Error('Graph passage does not match staged asset.');
    seen.add(passage.id);
  }
  for (const item of [...snapshot.entities, ...snapshot.claims]) {
    if (!Array.isArray(item.passageIds) || item.passageIds.some(id => !seen.has(id))) throw new Error('Graph citation is outside staged asset.');
  }
}

/** The caller must pass the lease-bound store from the trusted server. This is not a graph seal. */
export async function verifyStagedDocumentGraphAsset(store: Pick<PostgresPublicationAssetStore, 'readStaged'>,
  attempt: PublicationAttempt, snapshot: KnowledgeGraphSnapshot, timeoutMs = 30000): Promise<{ productionAuthorized: false }> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid graph asset read timeout.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let asset: PreparedPublicationAsset;
  try {
    asset = await Promise.race([store.readStaged(attempt), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Graph asset read timed out.')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
  assertDocumentGraphAsset(attempt, asset, snapshot);
  return { productionAuthorized: false };
}

/** Diagnostic only: verifies a lease-bound asset before reserving and staging. */
export async function stageAssetBoundDocumentGraph(store: Pick<PostgresPublicationAssetStore, 'readStaged'>,
  config: Parameters<typeof stageReservedDocumentGraph>[0], attempt: PublicationAttempt,
  ...args: Parameters<typeof stageReservedDocumentGraph> extends [unknown, unknown, ...infer Rest] ? Rest : never) {
  const [identity, scope, snapshot, graphStore, readEdges, timeoutMs] = args;
  const detached = structuredClone(snapshot);
  await verifyStagedDocumentGraphAsset(store, attempt, detached, timeoutMs);
  return stageReservedDocumentGraph(config, attempt, identity, scope, detached, graphStore, readEdges, timeoutMs);
}

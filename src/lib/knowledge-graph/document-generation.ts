import { createHash } from 'node:crypto';
import { canonicalJson } from '../rag/eval/canonical-json';
import type { RagRetrievalScope } from '../security/retrieval-scope';
import type { KnowledgeGraphCommandStore, KnowledgeGraphSnapshot } from './contracts';
import { assertDocumentGraphEdges, expectedDocumentGraphEdges } from './document-generation-edges';

export interface DocumentGraphGeneration {
  tenantId: string; corpusId: string; documentId: string; generation: string;
  contentVersion: string; manifestDigest: string;
}
export class DocumentGraphUnknownError extends Error {
  readonly code = 'DOCUMENT_GRAPH_UNKNOWN';
  readonly productionAuthorized = false;
  readonly identity: ReturnType<typeof createDocumentGraphIdentity>;
  constructor(identity: ReturnType<typeof createDocumentGraphIdentity>, cause: unknown) {
    super('Graph operation outcome is unknown; do not reuse this generation.', { cause });
    this.identity = identity;
  }
}
// This in-process fence is not durable: production callers still need the
// publication control plane to persist abandoned generations across restarts.
const dispatched = new Set<string>();

/** The deterministic identity binds an isolated graph to one publication attempt. */
export function createDocumentGraphIdentity(value: DocumentGraphGeneration) {
  const scalar = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max
    && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
  if (!value || !scalar(value.tenantId,128) || !scalar(value.corpusId,128) || !scalar(value.documentId,256)
    || typeof value.generation !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value.generation)
    || typeof value.contentVersion !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.contentVersion)
    || typeof value.manifestDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.manifestDigest)) throw new Error('Invalid document graph generation.');
  const identity = { tenantId:value.tenantId, corpusId:value.corpusId, documentId:value.documentId,
    generation:value.generation, contentVersion:value.contentVersion, manifestDigest:value.manifestDigest };
  const digest = createHash('sha256').update(canonicalJson(identity)).digest('hex');
  return Object.freeze({ ...identity, graphVersion:`doc-generation-${digest}` });
}

/**
 * Staging and readback are diagnostics only. A store can be injected, and a
 * successful read does not prove exclusive writes or immutable graph data.
 */
export async function stageDocumentGraph(identity: DocumentGraphGeneration, scope: RagRetrievalScope,
  snapshot: KnowledgeGraphSnapshot, store: Pick<KnowledgeGraphCommandStore,'stageSnapshot'|'getSnapshot'>,
  readEdges: (identity: { tenantId: string; corpusId: string; graphVersion: string }) => Promise<[string,string,string][]>, timeoutMs = 30000) {
  const expected = createDocumentGraphIdentity(identity);
  if (dispatched.has(expected.graphVersion)) throw new DocumentGraphUnknownError(expected,new Error('Generation was already dispatched.'));
  if (!scope?.enforceIsolation || scope.tenantId !== expected.tenantId || scope.corpusId !== expected.corpusId
    || !Array.isArray(scope.allowedTrustLevels) || !snapshot || snapshot.tenantId !== expected.tenantId
    || snapshot.corpusId !== expected.corpusId || snapshot.graphVersion !== expected.graphVersion || snapshot.status !== 'staging'
    || snapshot.documents.length !== 1 || snapshot.documents[0].documentId !== expected.documentId
    || snapshot.documents[0].documentVersion !== expected.contentVersion
    || !scope.allowedTrustLevels.includes(snapshot.documents[0].trustLevel)
    || typeof readEdges !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
    || snapshot.passages.some(p => p.documentId !== expected.documentId || p.documentVersion !== expected.contentVersion
      || p.trustLevel !== snapshot.documents[0].trustLevel)) throw new Error('Document graph scope or generation mismatch.');
  const detached = structuredClone(snapshot);
  const baseline = canonicalJson(detached);
  expectedDocumentGraphEdges(detached);
  const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([Promise.resolve().then(work),new Promise<never>((_,reject) => { timer=setTimeout(() => reject(new Error('Graph operation timed out.')),timeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  // Mark before scheduling the first write. A timeout cannot cancel the
  // backend call, so this name remains consumed even if the call succeeds.
  dispatched.add(expected.graphVersion);
  try {
  const descriptor = await bounded(() => store.stageSnapshot(detached));
  if (!descriptor || descriptor.tenantId !== expected.tenantId || descriptor.corpusId !== expected.corpusId
    || descriptor.graphVersion !== expected.graphVersion || descriptor.status !== 'staging'
    || descriptor.artifactDigest !== detached.artifactDigest) throw new Error('Document graph stage identity mismatch.');
  const actual = await bounded(() => store.getSnapshot(expected, scope));
  if (!actual || canonicalJson(actual) !== baseline) throw new Error('Document graph readback mismatch.');
  await bounded(() => assertDocumentGraphEdges(detached,readEdges));
  return Object.freeze({ ...expected, artifactDigest: detached.artifactDigest, productionAuthorized:false as const });
  } catch (error) { throw new DocumentGraphUnknownError(expected,error); }
}

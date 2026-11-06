import { createHash } from 'node:crypto';
import { queryPostgres, type PostgresQueryClient } from '../postgres/client';
import type { RagRetrievalScope } from '../security/retrieval-scope';
import { publicationReadWithin } from '../documents/publication-read-deadline';

export interface PublishedGraphHead {
  documentId: string; generation: string; revision: string; contentVersion: string; manifestDigest: string; graphVersion: string;
}
export interface PublishedDocumentGraph extends PublishedGraphHead {
  entities: Array<{ id: string; name: string; passageIds: string[] }>;
  claims: Array<{ id: string; predicate: 'CO_OCCURS'; sourceEntityId: string; targetEntityId: string; passageIds: string[] }>;
  passages: Array<{ id: string; content: string; source?: string; page?: number; startOffset: number; endOffset: number }>;
}
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const digest = (value: unknown) => { const result = text(value, 71); if (!/^sha256:[a-f0-9]{64}$/.test(result)) throw new Error('Invalid graph digest.'); return result; };

/** PostgreSQL selects only the active publication head and validates its source
 * receipt. The application never needs Neo4j's management credential. */
export async function readPublishedDocumentGraphs(scope: RagRetrievalScope, db: PostgresQueryClient, signal?: AbortSignal): Promise<PublishedGraphHead[]> {
  checkScope(scope);
  const result = await publicationReadWithin(() => queryPostgres<{ result: unknown }>(db,
    'select public.rag_read_document_graph_view($1,$2,$3::text[]) as result',
    [scope.tenantId, scope.corpusId, scope.allowedTrustLevels], 'read published graph heads'), signal);
  if (result.rows.length !== 1 || !Array.isArray(result.rows[0].result) || result.rows[0].result.length > 128) throw new Error('Invalid graph view.');
  const heads = result.rows[0].result.map(value => readHead(value));
  if (new Set(heads.map(head => head.documentId)).size !== heads.length) throw new Error('Duplicate graph head.');
  return heads;
}

export async function readPublishedDocumentGraph(scope: RagRetrievalScope, documentId: string,
  db: PostgresQueryClient, signal?: AbortSignal): Promise<PublishedDocumentGraph | null> {
  checkScope(scope); text(documentId, 256);
  const read = async () => {
    const result = await publicationReadWithin(() => queryPostgres<{ result: unknown }>(db,
      'select public.rag_read_document_graph_snapshot($1,$2,$3,$4::text[]) as result',
      [scope.tenantId, scope.corpusId, documentId, scope.allowedTrustLevels], 'read published graph snapshot'), signal);
    if (result.rows.length !== 1) throw new Error('Invalid graph snapshot response.');
    return result.rows[0].result;
  };
  const raw = await read();
  if (raw === null) return null;
  const row = object(raw), head = readHead(row);
  if (head.documentId !== documentId) throw new Error('Graph document identity differs.');
  const manifestJson = text(row.graphManifestJson, 4 * 1024 * 1024), manifest = object(JSON.parse(manifestJson));
  const snapshotJson = text(row.snapshotJson, 4 * 1024 * 1024), snapshot: unknown = JSON.parse(snapshotJson);
  if (hash(manifestJson) !== digest(row.graphManifestDigest) || hash(snapshotJson) !== digest(manifest.snapshotDigest)
    || manifest.profile !== 'neo4j-exclusive-asset-graph/v1' || manifest.tenantId !== scope.tenantId || manifest.corpusId !== scope.corpusId
    || manifest.documentId !== documentId || manifest.generation !== head.generation || manifest.contentVersion !== head.contentVersion
    || manifest.manifestDigest !== head.manifestDigest || manifest.graphVersion !== head.graphVersion
    || !Array.isArray(snapshot) || snapshot.length !== 6) throw new Error('Graph snapshot binding mismatch.');
  const header = object(snapshot[0]);
  if (header.tenantId !== scope.tenantId || header.corpusId !== scope.corpusId || header.graphVersion !== head.graphVersion
    || header.graphId !== head.graphVersion) throw new Error('Graph snapshot scope differs.');
  const documents = rows(snapshot[1], 1), passages = rows(snapshot[2], 1000), entities = rows(snapshot[3], 128), claims = rows(snapshot[4], 1000);
  if (documents.length !== 1 || rows(snapshot[5], 0).length !== 0 || documents[0].documentId !== documentId
    || documents[0].documentVersion !== head.contentVersion || !scope.allowedTrustLevels.some(trust => trust === documents[0].trustLevel)
    || !Array.isArray(manifest.passages) || manifest.passages.length !== passages.length || passages.length < 1) throw new Error('Graph document evidence differs.');
  const parsedPassages = passages.map((passage, index) => {
    const bound = object((manifest.passages as unknown[])[index]);
    if (passage.documentId !== documentId || passage.documentVersion !== head.contentVersion
      || passage.trustLevel !== documents[0].trustLevel || passage.index !== index || bound.chunkIndex !== index
      || bound.passageId !== passage.id || !Number.isSafeInteger(passage.startOffset) || Number(passage.startOffset) < 0
      || !Number.isSafeInteger(passage.endOffset) || Number(passage.endOffset) < Number(passage.startOffset)) throw new Error('Graph passage binding differs.');
    return { id: text(passage.id, 256), content: text(passage.content, 1024 * 1024, false), startOffset: Number(passage.startOffset), endOffset: Number(passage.endOffset),
      ...(passage.source === undefined ? {} : { source: text(passage.source, 8000) }),
      ...(passage.page === undefined ? {} : { page: nonnegative(passage.page) }) };
  });
  const passageIds = uniqueIds(parsedPassages);
  const parsedEntities = entities.map(entity => ({ id: text(entity.id, 256), name: text(entity.name, 256), passageIds: references(entity.passageIds, passageIds) }));
  const entityIds = uniqueIds(parsedEntities);
  const parsedClaims = claims.map(claim => {
    if (claim.predicate !== 'CO_OCCURS' || !entityIds.has(String(claim.sourceEntityId)) || !entityIds.has(String(claim.targetEntityId))) throw new Error('Graph relationship differs.');
    return { id: text(claim.id, 256), predicate: 'CO_OCCURS' as const, sourceEntityId: text(claim.sourceEntityId, 256),
      targetEntityId: text(claim.targetEntityId, 256), passageIds: references(claim.passageIds, passageIds) };
  });
  uniqueIds(parsedClaims);
  // Do not return stale evidence if revoke or a source/head change won the race.
  const current = await read();
  signal?.throwIfAborted();
  if (current === null || JSON.stringify(current) !== JSON.stringify(raw)) throw new Error('Published graph changed during retrieval.');
  return { ...head, entities: parsedEntities, claims: parsedClaims, passages: parsedPassages };
}

function readHead(value: unknown): PublishedGraphHead {
  const row = object(value), generation = text(row.generation, 20), revision = text(row.revision, 20), graphVersion = text(row.graphVersion, 79);
  if (!/^[1-9][0-9]*$/.test(generation) || !/^[1-9][0-9]*$/.test(revision) || !/^doc-generation-[a-f0-9]{64}$/.test(graphVersion)) throw new Error('Invalid graph head.');
  return { documentId: text(row.documentId, 256), generation, revision, graphVersion, contentVersion: digest(row.contentVersion), manifestDigest: digest(row.manifestDigest) };
}
function checkScope(scope: RagRetrievalScope) {
  if (!scope || scope.enforceIsolation !== true || !Array.isArray(scope.allowedTrustLevels) || scope.allowedTrustLevels.length < 1
    || scope.allowedTrustLevels.some(level => !['trusted','reviewed','external','quarantined'].includes(level))) throw new Error('Graph read requires an isolated scope.');
  text(scope.tenantId, 128); text(scope.corpusId, 128);
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid graph payload.'); return value as Record<string, unknown>; }
function text(value: unknown, max: number, identifier = true): string { if (typeof value !== 'string' || !value || Buffer.byteLength(value) > max || (identifier && (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)))) throw new Error('Invalid graph field.'); return value; }
function rows(value: unknown, max: number) { if (!Array.isArray(value) || value.length > max) throw new Error('Graph capacity exceeded.'); return value.map(object); }
function nonnegative(value: unknown) { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Invalid graph page.'); return Number(value); }
function uniqueIds(items: Array<{ id: string }>) { const ids = new Set(items.map(item => item.id)); if (ids.size !== items.length) throw new Error('Duplicate graph identity.'); return ids; }
function references(value: unknown, allowed: Set<string>) { if (!Array.isArray(value) || value.length < 1 || value.length > 1000 || value.some(id => typeof id !== 'string' || !allowed.has(id)) || new Set(value).size !== value.length) throw new Error('Graph source reference differs.'); return value as string[]; }

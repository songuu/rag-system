import type { Neo4jClient } from '../neo4j/driver';
import type { KnowledgeGraphSnapshot } from './contracts';
type GraphIdentity = { tenantId: string; corpusId: string; graphVersion: string };
type Edge = [string, string, string];
const MAX_EDGES = 10000;
const keys: Record<string,string> = { GraphSnapshot:'graphVersion', DocumentVersion:'documentId', Passage:'passageId', Entity:'entityKey', Claim:'claimId', Community:'communityId' };
function edge(type: string, fromType: string, from: string, toType: string, to: string): Edge { return [type, `${fromType}:${from}`, `${toType}:${to}`]; }
export function expectedDocumentGraphEdges(snapshot: KnowledgeGraphSnapshot): Edge[] {
  const result: Edge[] = [];
  const push = (type: string, fromType: string, from: string, toType: string, to: string) => result.push(edge(type,fromType,from,toType,to));
  for (const d of snapshot.documents) push('CONTAINS','GraphSnapshot',snapshot.graphVersion,'DocumentVersion',JSON.stringify([d.documentId,d.documentVersion]));
  for (const p of snapshot.passages) push('HAS_PASSAGE','DocumentVersion',JSON.stringify([p.documentId,p.documentVersion]),'Passage',p.id);
  for (const e of snapshot.entities) { push('CONTAINS_ENTITY','GraphSnapshot',snapshot.graphVersion,'Entity',e.id); for (const id of e.passageIds) push('MENTIONS','Passage',id,'Entity',e.id); }
  for (const c of snapshot.claims) { push('SUBJECT_OF','Entity',c.sourceEntityId,'Claim',c.id); push('OBJECT','Claim',c.id,'Entity',c.targetEntityId); for (const id of c.passageIds) push('SUPPORTED_BY','Claim',c.id,'Passage',id); }
  for (const c of snapshot.communities) { push('CONTAINS_COMMUNITY','GraphSnapshot',snapshot.graphVersion,'Community',c.id); for (const id of c.entityIds) push('IN_COMMUNITY','Entity',id,'Community',c.id); for (const id of c.claimIds) push('HAS_CLAIM','Community',c.id,'Claim',id); if (c.parentId) push('PARENT_OF','Community',c.parentId,'Community',c.id); }
  if (result.length > MAX_EDGES || new Set(result.map(v => JSON.stringify(v))).size !== result.length) throw new Error('Invalid graph relationship set.');
  return result;
}
/** Observation only; this comparison does not seal Neo4j or attest the input. */
export async function assertDocumentGraphEdges(snapshot: KnowledgeGraphSnapshot,
  readEdges: (identity: GraphIdentity) => Promise<Edge[]>): Promise<void> {
  const expected = expectedDocumentGraphEdges(snapshot).map(e => JSON.stringify(e)).sort();
  const actual = await readEdges({tenantId:snapshot.tenantId,corpusId:snapshot.corpusId,graphVersion:snapshot.graphVersion});
  if (!Array.isArray(actual) || JSON.stringify(actual.map(e => JSON.stringify(e)).sort()) !== JSON.stringify(expected)) {
    throw new Error('Document graph relationships mismatch.');
  }
}
/** Read every edge touching this generation, including extra and cross-scope edges. */
export async function readDocumentGraphEdges(client: Pick<Neo4jClient,'executeRead'>, identity: GraphIdentity): Promise<Edge[]> {
  const response = await client.executeRead('read document generation relationships', tx => tx.run(`MATCH (a)-[r]->(b)
    WHERE (a.tenantId=$tenantId AND a.corpusId=$corpusId AND a.graphVersion=$graphVersion)
       OR (b.tenantId=$tenantId AND b.corpusId=$corpusId AND b.graphVersion=$graphVersion)
    RETURN type(r) AS kind, labels(a) AS fromLabels, properties(a) AS fromProperties,
      labels(b) AS toLabels, properties(b) AS toProperties LIMIT 10001`, identity));
  if (response.records.length > MAX_EDGES) throw new Error('Graph relationship limit exceeded.');
  return response.records.map(record => {
    const endpoint = (labels: unknown, props: unknown) => {
      if (!Array.isArray(labels) || labels.length !== 1 || typeof labels[0] !== 'string' || !Object.hasOwn(keys,labels[0]) || !props || typeof props !== 'object' || Array.isArray(props)) throw new Error('Invalid graph endpoint.');
      const p = props as Record<string,unknown>; let id = p[keys[labels[0]]];
      if (p.tenantId !== identity.tenantId || p.corpusId !== identity.corpusId || p.graphVersion !== identity.graphVersion || typeof id !== 'string' || !id) throw new Error('Cross-generation graph relationship.');
      if (labels[0] === 'DocumentVersion') { if (typeof p.documentVersion !== 'string' || !p.documentVersion) throw new Error('Invalid graph document version.'); id = JSON.stringify([id,p.documentVersion]); }
      return `${labels[0]}:${id}`;
    };
    const kind = record.get('kind'); if (typeof kind !== 'string' || !kind) throw new Error('Invalid graph relationship.');
    return [kind,endpoint(record.get('fromLabels'),record.get('fromProperties')),endpoint(record.get('toLabels'),record.get('toProperties'))] as Edge;
  });
}

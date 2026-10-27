import { canonicalJson } from '../rag/eval/canonical-json';
import { createKnowledgeGraphSnapshotIdentity, KNOWLEDGE_GRAPH_LIMITS } from './contracts';
import type { KnowledgeGraphDocumentIdentity } from './contracts';

export const BUILD_PUBLICATION_MANIFEST_SCHEMA = 'kg-build-publication-manifest/v1' as const;
export interface BuildPublicationManifest {
  readonly schemaVersion: typeof BUILD_PUBLICATION_MANIFEST_SCHEMA;
  readonly tenantId: string;
  readonly corpusId: string;
  readonly graphVersion: string;
  readonly artifactDigest: string;
  readonly documents: readonly Readonly<KnowledgeGraphDocumentIdentity>[];
}
export class BuildPublicationManifestError extends Error {
  readonly productionAuthorized = false;
  constructor() { super('Build publication manifest is invalid.'); this.name = 'BuildPublicationManifestError'; }
}
type Fields = Record<string, unknown>;
function detached(value: unknown): Fields { const v: unknown = JSON.parse(canonicalJson(value)); return record(v); }
function record(value: unknown): Fields { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value as Fields; }
function exact(value: Fields, fields: readonly string[]): void { if (Object.keys(value).length !== fields.length || fields.some(k => !Object.hasOwn(value, k))) throw new Error(); }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function sortedDocuments(input: unknown): KnowledgeGraphDocumentIdentity[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 512) throw new Error(); const seen = new Set<string>();
  const result = input.map(value => {
    const d = record(value); exact(d, ['documentId', 'documentVersion', 'trustLevel']);
    // Documents are opaque business identities under the existing KG contract,
    // not path/SQL selectors. Preserve Chinese/slashes and exact normalized text.
    for (const field of [d.documentId, d.documentVersion]) if (typeof field !== 'string' || !field
      || field.trim() !== field || field.length > KNOWLEDGE_GRAPH_LIMITS.maxIdentifierCharacters || /[\u0000-\u001f]/.test(field)) throw new Error();
    if (!['trusted', 'reviewed', 'external', 'quarantined'].includes(d.trustLevel as string)) throw new Error();
    const key = canonicalJson([d.documentId, d.documentVersion]); if (seen.has(key)) throw new Error(); seen.add(key);
    return d as unknown as KnowledgeGraphDocumentIdentity;
  });
  return result.sort((a, b) => compare(a.documentId, b.documentId) || compare(a.documentVersion, b.documentVersion) || compare(a.trustLevel, b.trustLevel));
}
/** Structural binding only. The validated Snapshot producer, not this codec,
 * establishes the provenance of these documents and the artifact digest. */
export function validateBuildPublicationManifest(input: unknown): BuildPublicationManifest {
  try {
    const v = detached(input); exact(v, ['schemaVersion', 'tenantId', 'corpusId', 'graphVersion', 'artifactDigest', 'documents']);
    if (v.schemaVersion !== BUILD_PUBLICATION_MANIFEST_SCHEMA) throw new Error();
    const identity = createKnowledgeGraphSnapshotIdentity({ tenantId: v.tenantId as string, corpusId: v.corpusId as string, graphVersion: v.graphVersion as string });
    if (identity.tenantId !== v.tenantId || identity.corpusId !== v.corpusId || identity.graphVersion !== v.graphVersion) throw new Error();
    if (typeof v.artifactDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(v.artifactDigest)) throw new Error();
    if (canonicalJson(v.documents) !== canonicalJson(sortedDocuments(v.documents))) throw new Error();
    return freeze(v as unknown as BuildPublicationManifest);
  } catch { throw new BuildPublicationManifestError(); }
}
export function createBuildPublicationManifest(input: unknown): BuildPublicationManifest {
  try {
    const v = detached(input); exact(v, ['tenantId', 'corpusId', 'graphVersion', 'artifactDigest', 'documents']);
    return validateBuildPublicationManifest({ schemaVersion: BUILD_PUBLICATION_MANIFEST_SCHEMA, ...v, documents: sortedDocuments(v.documents) });
  } catch { throw new BuildPublicationManifestError(); }
}

import { createHash } from 'node:crypto';
import type { MiroFishGraphArtifact } from '../../mirofish/graph-artifact-store';
import { createMiroFishGraphVersion } from '../../knowledge-graph/mirofish-adapter';
import type { RagSecurityContext } from '../../security/request-context';
import { createRetrievalScope, type RagRetrievalScope } from '../../security/retrieval-scope';
import { CitationError, createCitationLocatorCodec, type CitationSourceLocator } from './locator-codec';
import type { RagCitationPreview } from './types';

export interface CitationAuthorityState { revision: string; chunkCount: number }
export interface CitationSourceDependencies {
  readAuthority(source: CitationSourceLocator): Promise<CitationAuthorityState | null>;
  readArtifact(source: CitationSourceLocator, scope: RagRetrievalScope): Promise<MiroFishGraphArtifact | null>;
  readIndexedSource(source: CitationSourceLocator, state: CitationAuthorityState, scope: RagRetrievalScope): Promise<string>;
}

/** A locator selects a source; the current subject and live stores decide whether it may be returned. */
export async function previewCitation(input: {
  locator: string;
  security: RagSecurityContext;
  dependencies: CitationSourceDependencies;
  env?: NodeJS.ProcessEnv;
  clock?: () => number;
  signal?: AbortSignal;
}): Promise<RagCitationPreview> {
  const clock = input.clock ?? Date.now;
  const codec = createCitationLocatorCodec(input.env);
  const source = codec.decode(input.locator, clock());
  if (source.actorId !== input.security.actorId || source.tenantId !== input.security.tenantId || source.corpusId !== input.security.corpusId) throw new CitationError('RAG_CITATION_INVALID');
  const scope = createRetrievalScope({ tenantId: input.security.tenantId, corpusId: input.security.corpusId, allowedTrustLevels: ['trusted', 'reviewed', 'external'], enforceIsolation: true });
  input.signal?.throwIfAborted();
  const before = await input.dependencies.readAuthority(source);
  if (!before) throw unavailableSource();
  input.signal?.throwIfAborted();
  const artifact = await input.dependencies.readArtifact(source, scope);
  if (!artifact || artifact.tenantId !== source.tenantId || artifact.corpusId !== source.corpusId || artifact.documentId !== source.documentId || artifact.documentVersion !== source.documentVersion || artifact.trustLevel !== source.trustLevel || createMiroFishGraphVersion(artifact) !== source.graphVersion) throw unavailableSource();
  const matching = artifact.graph.passages.filter(passage => passage.id === source.passageId);
  if (matching.length !== 1) throw unavailableSource();
  const passage = matching[0];
  if (passage.document_id !== source.documentId || passage.document_version !== source.documentVersion || passage.tenant_id !== source.tenantId || passage.corpus_id !== source.corpusId || passage.trust_level !== source.trustLevel || passage.start_offset > source.startOffset || passage.end_offset < source.endOffset || passage.content.length !== passage.end_offset - passage.start_offset) throw unavailableSource();
  const content = passage.content.slice(source.startOffset - passage.start_offset, source.endOffset - passage.start_offset);
  if (createHash('sha256').update(content).digest('hex') !== source.contentHash) throw unavailableSource();
  input.signal?.throwIfAborted();
  const indexedSource = await input.dependencies.readIndexedSource(source, before, scope);
  if (indexedSource.slice(source.startOffset, source.endOffset) !== content) throw unavailableSource();
  input.signal?.throwIfAborted();
  const after = await input.dependencies.readAuthority(source);
  if (!after || after.revision !== before.revision || after.chunkCount !== before.chunkCount) throw unavailableSource();
  // A retained in-memory artifact must not outlive a concurrent durable file tombstone.
  const retained = await input.dependencies.readArtifact(source, scope);
  if (!retained || retained.documentVersion !== source.documentVersion || retained.trustLevel !== source.trustLevel || createMiroFishGraphVersion(retained) !== source.graphVersion) throw unavailableSource();
  codec.decode(input.locator, clock());
  input.signal?.throwIfAborted();
  const bytes = Buffer.from(content, 'utf8');
  // Removing a partial UTF-8 character keeps the UI's truncation notice honest.
  let end = Math.min(bytes.length, 16 * 1024);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  const boundedContent = bytes.subarray(0, end).toString('utf8');
  const relations = source.startOffset === passage.start_offset && source.endOffset === passage.end_offset
    ? artifact.graph.edges.filter(edge => source.claimIds.includes(edge.uuid) && !edge.invalid_at && !edge.expired_at
      && [...(Array.isArray(edge.attributes.sourceChunks) ? edge.attributes.sourceChunks : []), ...edge.episodes].includes(source.passageId))
      .slice(0, 16).map(edge => ({ source: boundedText(edge.source_node_name), predicate: boundedText(edge.name), target: boundedText(edge.target_node_name), fact: boundedText(edge.fact, 2048) }))
    : [];
  return { success: true, ...(passage.source ? { source: boundedText(passage.source) } : {}), ...(Number.isSafeInteger(passage.page) && Number(passage.page) >= 0 ? { page: passage.page } : {}), content: boundedContent, contentTruncated: end < bytes.length, relations };
}

function boundedText(value: string, max = 512): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}
function unavailableSource(): CitationError { return new CitationError('RAG_CITATION_SOURCE_UNAVAILABLE'); }

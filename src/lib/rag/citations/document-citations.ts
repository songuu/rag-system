import { createHash } from 'node:crypto';
import type { RagEvidence } from '../core/types';
import type { RagSecurityContext } from '../../security/request-context';
import { createRetrievalScope, type RagRetrievalScope } from '../../security/retrieval-scope';
import { CitationError, citationPartition, createCitationLocatorCodec, type DocumentCitationSourceLocator } from './locator-codec';
import { parseCitationReferences } from './reference-parser';
import type { RagCitations, RagCitationPreview } from './types';

export type DocumentCitationIdentity = Pick<DocumentCitationSourceLocator, 'tenantId' | 'corpusId' | 'documentId' | 'documentVersion' | 'trustLevel'>;
export interface DocumentCitationAuthority { revision: string; chunkCount: number; source: string }
export interface DocumentCitationDependencies {
  readAuthority(source: DocumentCitationIdentity): Promise<DocumentCitationAuthority | null>;
  readChunk(source: DocumentCitationIdentity & { chunkId: string }, state: DocumentCitationAuthority, scope: RagRetrievalScope, chunkIndex?: number): Promise<{ id: string; chunkIndex: number; content: string; page?: number } | null>;
}

/** Source numbers always refer to the final context pack, including when only some are available. */
export async function issueDocumentAnswerCitations(input: {
  answer: string;
  servedEvidence: readonly RagEvidence[];
  security: RagSecurityContext;
  dependencies: DocumentCitationDependencies;
  graphCitations?: RagCitations;
  env?: NodeJS.ProcessEnv;
  now?: number;
  signal?: AbortSignal;
}): Promise<RagCitations> {
  const parsed = parseCitationReferences(input.answer, Math.min(input.servedEvidence.length, 1000));
  const numbers = [...new Set(parsed.ranges.flatMap(range => range.numbers))].filter(n => n >= 1 && n <= input.servedEvidence.length);
  const result: RagCitations = {
    version: 'rag-citations/v1', partition: citationPartition(input.security), status: parsed.citationCount ? 'unavailable' : 'missing', items: [],
    diagnostics: { reason: parsed.citationCount ? 'sources-unavailable' : 'no-numbered-citations', citationCount: parsed.citationCount, invalidCitationCount: parsed.invalidCitationCount, unavailableCitationCount: numbers.length },
  };
  if (!numbers.length) return result;
  let codec: ReturnType<typeof createCitationLocatorCodec>;
  try { codec = createCitationLocatorCodec(input.env); }
  catch { result.diagnostics.reason = 'configuration-unavailable'; return result; }
  const scope = documentScope(input.security);
  for (const number of numbers.slice(0, 32)) {
    input.signal?.throwIfAborted();
    const evidence = input.servedEvidence[number - 1];
    try {
      if (evidence.tenantId !== input.security.tenantId || evidence.corpusId !== input.security.corpusId || evidence.trustLevel === 'quarantined') continue;
      const before = await input.dependencies.readAuthority(evidence);
      if (!before) continue;
      // Existing graph locators remain graph locators, but must pass the same live asset gate.
      const graph = input.graphCitations?.partition === result.partition ? input.graphCitations.items.find(item => item.number === number) : undefined;
      if (graph) {
        const after = await input.dependencies.readAuthority(evidence);
        if (sameAuthority(before, after)) result.items.push(graph);
        continue;
      }
      const hint = evidence.metadata?.chunkIndex ?? evidence.metadata?.chunk_index;
      const chunk = await input.dependencies.readChunk({ ...evidence, chunkId: evidence.id }, before, scope, Number.isSafeInteger(hint) ? Number(hint) : undefined);
      if (!chunk || chunk.id !== evidence.id || !evidence.content || !Number.isSafeInteger(chunk.chunkIndex) || chunk.chunkIndex < 0 || chunk.chunkIndex >= before.chunkCount) continue;
      const startOffset = chunk.content.indexOf(evidence.content);
      if (startOffset < 0) continue;
      const after = await input.dependencies.readAuthority(evidence);
      if (!sameAuthority(before, after)) continue;
      const encoded = codec.encodeDocument({
        actorId: input.security.actorId, tenantId: evidence.tenantId, corpusId: evidence.corpusId,
        documentId: evidence.documentId, documentVersion: evidence.documentVersion, trustLevel: evidence.trustLevel,
        chunkId: chunk.id, chunkIndex: chunk.chunkIndex, startOffset, endOffset: startOffset + evidence.content.length,
        chunkHash: hash(chunk.content), contentHash: hash(evidence.content),
      }, input.now);
      result.items.push({ number, ...encoded });
    } catch {
      // Optional preview failure must not invent a source or fail the generated answer.
      input.signal?.throwIfAborted();
    }
  }
  result.diagnostics.unavailableCitationCount = numbers.length - result.items.length;
  if (result.items.length) { result.status = 'available'; result.diagnostics.reason = 'ready'; }
  return result;
}

export async function previewDocumentCitation(input: {
  locator: string;
  security: RagSecurityContext;
  dependencies: DocumentCitationDependencies;
  env?: NodeJS.ProcessEnv;
  clock?: () => number;
  signal?: AbortSignal;
}): Promise<RagCitationPreview> {
  const clock = input.clock ?? Date.now;
  const codec = createCitationLocatorCodec(input.env);
  const source = codec.decodeDocument(input.locator, clock());
  if (source.actorId !== input.security.actorId || source.tenantId !== input.security.tenantId || source.corpusId !== input.security.corpusId) throw new CitationError('RAG_CITATION_INVALID');
  input.signal?.throwIfAborted();
  const before = await input.dependencies.readAuthority(source);
  if (!before || source.chunkIndex >= before.chunkCount) throw unavailable();
  const chunk = await input.dependencies.readChunk(source, before, documentScope(input.security), source.chunkIndex);
  if (!chunk || chunk.id !== source.chunkId || chunk.chunkIndex !== source.chunkIndex || hash(chunk.content) !== source.chunkHash || source.endOffset > chunk.content.length) throw unavailable();
  const content = chunk.content.slice(source.startOffset, source.endOffset);
  if (hash(content) !== source.contentHash) throw unavailable();
  const after = await input.dependencies.readAuthority(source);
  if (!sameAuthority(before, after)) throw unavailable();
  codec.decodeDocument(input.locator, clock());
  input.signal?.throwIfAborted();
  const bytes = Buffer.from(content, 'utf8');
  let end = Math.min(bytes.length, 16 * 1024);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return { success: true, source: before.source.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 512),
    ...(Number.isSafeInteger(chunk.page) && Number(chunk.page) >= 0 ? { page: chunk.page } : {}),
    content: bytes.subarray(0, end).toString('utf8'), contentTruncated: end < bytes.length, relations: [] };
}

function documentScope(security: RagSecurityContext): RagRetrievalScope {
  return createRetrievalScope({ tenantId: security.tenantId, corpusId: security.corpusId, allowedTrustLevels: ['trusted', 'reviewed', 'external'], enforceIsolation: true });
}
function sameAuthority(before: DocumentCitationAuthority, after: DocumentCitationAuthority | null): boolean {
  return !!after && before.revision === after.revision && before.chunkCount === after.chunkCount;
}
function hash(content: string): string { return createHash('sha256').update(content).digest('hex'); }
function unavailable(): CitationError { return new CitationError('RAG_CITATION_SOURCE_UNAVAILABLE'); }

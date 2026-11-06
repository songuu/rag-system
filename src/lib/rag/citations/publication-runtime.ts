import { createHash } from 'node:crypto';
import { getPostgresClient } from '../../postgres/client';
import { createRetrievalScope } from '../../security/retrieval-scope';
import type { RagSecurityContext } from '../../security/request-context';
import { readPublicationView, readPublicationSource, assertPublicationViewCurrent } from '../../documents/publication-view';
import { assertPublicationReaderPostgresCapability } from '../../documents/publication-reader-capability';
import { issueDocumentAnswerCitations, previewDocumentCitation, type DocumentCitationDependencies } from './document-citations';
import type { RagEvidence } from '../core/types';
import { publicationReadWithin } from '../../documents/publication-read-deadline';

/** Citation previews read the immutable publication source, never a mutable
 * Milvus collection or legacy document row. Signed locators are still scoped
 * to the authenticated actor and version by the shared citation protocol. */
async function dependencies(security: RagSecurityContext, signal: AbortSignal) {
  const scope = createRetrievalScope({ tenantId: security.tenantId, corpusId: security.corpusId, enforceIsolation: true });
  const db = getPostgresClient();
  if (!db) throw new Error('Publication citation authority is unavailable.');
  await publicationReadWithin(() => assertPublicationReaderPostgresCapability(db), signal);
  const view = await publicationReadWithin(() => readPublicationView(scope, db), signal);
  // A source is copied at most once per document during one citation request.
  // The issued view is rechecked after the complete result, so cached authority
  // cannot cause a revoked or rebuilt version to be returned.
  const sources = new Map<string, Promise<{ identityBytes: Buffer }>>();
  let retainedSourceBytes = 0;
  const sourceDependencies: DocumentCitationDependencies = {
    async readAuthority(source) {
      signal.throwIfAborted();
      if (source.tenantId !== scope.tenantId || source.corpusId !== scope.corpusId || !scope.allowedTrustLevels.includes(source.trustLevel)) return null;
      const doc = view.documents.find(item => item.documentId === source.documentId && item.contentVersion === source.documentVersion);
      return doc ? { revision: `${doc.generation}:${doc.revision}:${doc.assetRevision}`, chunkCount: doc.sourceChunks.length, source: doc.originalName } : null;
    },
    async readChunk(source, authority, _scope, chunkIndex) {
      signal.throwIfAborted();
      if (source.tenantId !== scope.tenantId || source.corpusId !== scope.corpusId || !scope.allowedTrustLevels.includes(source.trustLevel)) return null;
      const doc = view.documents.find(item => item.documentId === source.documentId && item.contentVersion === source.documentVersion);
      if (!doc || `${doc.generation}:${doc.revision}:${doc.assetRevision}` !== authority.revision) return null;
      const chunk = doc.sourceChunks.find(item => item.id === source.chunkId && (chunkIndex === undefined || item.chunkIndex === chunkIndex));
      if (!chunk || chunk.startOffset === undefined || chunk.endOffset === undefined || chunk.endOffset < chunk.startOffset) return null;
      let pending = sources.get(doc.documentId);
      if (!pending) {
        pending = publicationReadWithin(() => readPublicationSource(view, doc.documentId, scope, db), signal).then(source => {
          if (retainedSourceBytes + source.identityBytes.length > 32 * 1024 * 1024) throw new Error('Citation source budget exceeded.');
          retainedSourceBytes += source.identityBytes.length;
          return { identityBytes: source.identityBytes };
        });
        sources.set(doc.documentId, pending);
      }
      const { identityBytes } = await pending;
      signal.throwIfAborted();
      const text = identityBytes.toString('utf8');
      if (chunk.endOffset > text.length) return null;
      const content = text.slice(chunk.startOffset, chunk.endOffset);
      if (`sha256:${createHash('sha256').update(content).digest('hex')}` !== chunk.contentDigest) return null;
      return { id: chunk.id, chunkIndex: chunk.chunkIndex, content, ...(chunk.page === undefined ? {} : { page: chunk.page }) };
    },
  };
  return { sourceDependencies, assertCurrent: () => publicationReadWithin(() => assertPublicationViewCurrent(view, scope, db), signal) };
}

export async function issuePublishedAnswerCitations(input: { answer: string; servedEvidence: readonly RagEvidence[]; security: RagSecurityContext; signal?: AbortSignal }) {
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(input.signal ? [input.signal] : [])]);
  const source = await dependencies(input.security, signal);
  const result = await issueDocumentAnswerCitations({ ...input, signal, dependencies: source.sourceDependencies });
  await source.assertCurrent();
  return result;
}
export async function previewPublishedCitation(input: { locator: string; security: RagSecurityContext; signal?: AbortSignal }) {
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(input.signal ? [input.signal] : [])]);
  // Validate the signed actor/version token before any source IO.
  const { createCitationLocatorCodec, CitationError } = await import('./locator-codec');
  const locator = createCitationLocatorCodec().decodeDocument(input.locator);
  if (locator.actorId !== input.security.actorId || locator.tenantId !== input.security.tenantId || locator.corpusId !== input.security.corpusId) throw new CitationError('RAG_CITATION_INVALID');
  const source = await dependencies(input.security, signal);
  const result = await previewDocumentCitation({ ...input, signal, dependencies: source.sourceDependencies });
  await source.assertCurrent();
  return result;
}

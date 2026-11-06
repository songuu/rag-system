import { createCitationPreviewHandlers } from '@/lib/rag/citations/http';
import { resolveRagSecurityContext } from '@/lib/security/request-context';
import { RequestValidationError } from '@/lib/security/request-validation';
import { getUnifiedPublicationWriteBlock } from '@/lib/security/unified-publication-write-guard';

export const runtime = 'nodejs';
const handlers = createCitationPreviewHandlers({
  async resolveSecurity(request) {
    const security = await resolveRagSecurityContext(request, { capability: 'query', requestedCorpusId: request.headers.get('x-rag-corpus-id')?.trim() || undefined });
    const block = getUnifiedPublicationWriteBlock();
    if (block && process.env.RAG_UNIFIED_PUBLICATION_MODE?.trim().toLowerCase() !== 'active') throw new RequestValidationError(block.code, block.message, block.status);
    return security;
  },
  async preview(input) {
    if (process.env.RAG_UNIFIED_PUBLICATION_MODE?.trim().toLowerCase() === 'active') {
      return (await import('@/lib/rag/citations/publication-runtime')).previewPublishedCitation(input);
    }
    return (await import('@/lib/rag/citations/runtime')).previewRuntimeCitation(input);
  },
});

export const GET = handlers.GET;
export const POST = handlers.POST;

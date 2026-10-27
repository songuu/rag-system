import { createCitationPreviewHandlers } from '@/lib/rag/citations/http';
import { resolveRagSecurityContext } from '@/lib/security/request-context';

export const runtime = 'nodejs';
const handlers = createCitationPreviewHandlers({
  resolveSecurity(request) {
    return resolveRagSecurityContext(request, { capability: 'query', requestedCorpusId: request.headers.get('x-rag-corpus-id')?.trim() || undefined });
  },
  async preview(input) {
    return (await import('@/lib/rag/citations/runtime')).previewRuntimeCitation(input);
  },
});

export const GET = handlers.GET;
export const POST = handlers.POST;

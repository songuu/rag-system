import { citationPartition } from '@/lib/rag/citations/locator-codec';
import { RagSecurityError, resolveRagSecurityContext } from '@/lib/security/request-context';

export const runtime = 'nodejs';

const headers = {
  'Cache-Control': 'private, no-store',
  Pragma: 'no-cache',
  Vary: 'Authorization, X-Rag-Corpus-Id',
  'X-Content-Type-Options': 'nosniff',
};

/** Resolve the current conversation partition without accessing knowledge sources. */
export async function GET(request: Request): Promise<Response> {
  try {
    const security = await resolveRagSecurityContext(request, {
      capability: 'query',
      requestedCorpusId: request.headers.get('x-rag-corpus-id')?.trim() || undefined,
    });
    return Response.json({ success: true, partition: citationPartition(security), now: Date.now() }, { headers });
  } catch (error) {
    if (error instanceof RagSecurityError) {
      return Response.json({ success: false, ...error.toResponseBody() }, { status: error.status, headers });
    }
    return Response.json({ success: false, error: { code: 'CONVERSATION_IDENTITY_UNAVAILABLE',
      message: '无法确认会话身份，请稍后重试。' } }, { status: 503, headers });
  }
}

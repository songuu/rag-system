import { NextRequest, NextResponse } from 'next/server';
import { getPostgresClient } from '@/lib/postgres/client';
import { assertPublicationGraphPostgresCapability } from '@/lib/documents/publication-reader-capability';
import { readPublishedDocumentGraph, readPublishedDocumentGraphs } from '@/lib/knowledge-graph/document-graph-reader';
import { RagSecurityError, resolveRagSecurityContext } from '@/lib/security/request-context';
import { createRetrievalScope } from '@/lib/security/retrieval-scope';
import { redactErrorForLog } from '@/lib/security/error-redaction';
import { publicationReadWithin } from '@/lib/documents/publication-read-deadline';

export const runtime = 'nodejs';
export async function GET(request: NextRequest) {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
  try {
    const params = new URL(request.url).searchParams;
    const context = await resolveRagSecurityContext(request, { capability: 'query', requestedCorpusId: params.get('corpusId') || undefined });
    if (process.env.RAG_UNIFIED_PUBLICATION_MODE?.trim().toLowerCase() !== 'active') return response({ success: false, error: '统一发布图谱暂不可用。' }, 503);
    const documentIds = params.getAll('documentId');
    if (documentIds.length > 1 || documentIds.some(id => !id || id !== id.trim() || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id))) return response({ success: false, error: '文档参数无效。' }, 400);
    const db = getPostgresClient();
    if (!db) throw new Error('Graph database is unavailable.');
    await publicationReadWithin(() => assertPublicationGraphPostgresCapability(db), signal);
    const scope = createRetrievalScope({ tenantId: context.tenantId, corpusId: context.corpusId, enforceIsolation: true });
    if (documentIds.length === 0) return response({ success: true, documents: await readPublishedDocumentGraphs(scope, db, signal) }, 200);
    const graph = await readPublishedDocumentGraph(scope, documentIds[0], db, signal);
    return graph ? response({ success: true, graph }, 200) : response({ success: false, error: '当前文档尚无可用的已发布图谱。' }, 404);
  } catch (error) {
    if (error instanceof RagSecurityError) return response({ success: false, ...error.toResponseBody() }, error.status);
    console.error('[Published document graph]', redactErrorForLog(error));
    return response({ success: false, error: '图谱读取暂不可用，请稍后重试。' }, 503);
  }
}
function response(body: unknown, status: number) { return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } }); }

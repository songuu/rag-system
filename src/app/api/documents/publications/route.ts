import { NextRequest, NextResponse } from 'next/server';
import { getPostgresClient } from '@/lib/postgres/client';
import { PublicationRequestQueue } from '@/lib/documents/publication-request-queue';
import { assertPublicationQueuePostgresCapability } from '@/lib/documents/publication-reader-capability';
import { RagSecurityError, resolveRagSecurityContext } from '@/lib/security/request-context';
import { redactErrorForLog } from '@/lib/security/error-redaction';
import { readJsonObjectWithLimit, RequestValidationError } from '@/lib/security/request-validation';
import { enqueueUploadedPublication } from '@/lib/documents/publication-upload';
import { PublicationEnqueueUnknownError } from '@/lib/documents/publication-queue-ingest';

export const runtime = 'nodejs';

/** Accepts a single immutable snapshot; acceptance never means publication. */
export async function POST(request: NextRequest) {
  const correlationId = crypto.randomUUID();
  try {
    const context = await resolveRagSecurityContext(request, { capability: 'ingest', requestIdFactory: () => correlationId });
    if (process.env.RAG_UNIFIED_PUBLICATION_MODE?.trim().toLowerCase() !== 'active'
      || process.env.RAG_UNIFIED_PUBLICATION_ACCEPT_REQUESTS !== 'true') {
      return response({ success: false, error: { code: 'PUBLICATION_INGEST_UNAVAILABLE', message: '发布暂不可用。' } }, 503);
    }
    const input = await readJsonObjectWithLimit(request, 3 * 1024 * 1024);
    const client = getPostgresClient();
    if (!client) return response({ success: false, error: { code: 'PUBLICATION_INGEST_UNAVAILABLE', message: '发布暂不可用。' } }, 503);
    await assertPublicationQueuePostgresCapability(client);
    const result = await enqueueUploadedPublication(input, context, client, request.signal);
    return response({ success: true, ...result }, 202);
  } catch (error) {
    if (error instanceof RagSecurityError) return response({ success: false, ...error.toResponseBody() }, error.status);
    if (error instanceof PublicationEnqueueUnknownError) return response({ success: false, requestId: error.requestId, documentId: `upload:${error.requestId}`,
      status: 'unknown', error: { code: error.code, message: '入队结果未知，请使用请求 ID 查询状态。' } }, 503);
    console.error(`[Publication enqueue] requestId=${correlationId}`, redactErrorForLog(error));
    if (error instanceof RequestValidationError) return response({ success: false,
      error: { code: error.code, message: '发布请求参数无效。' } }, error.status);
    if (error && typeof error === 'object' && 'status' in error && error.status === 409
      && 'requestId' in error && typeof error.requestId === 'string' && 'documentId' in error && typeof error.documentId === 'string') {
      return response({ success: false, requestId: error.requestId, documentId: error.documentId,
        error: { code: 'PUBLICATION_REQUEST_ALREADY_EXISTS', message: '请求 ID 已存在，请查询原请求状态。' } }, 409);
    }
    if (error && typeof error === 'object' && 'status' in error && error.status === 429) return response({ success: false,
      error: { code: 'PUBLICATION_INGEST_BUSY', message: '发布准备繁忙，请稍后再试。' } }, 429);
    if (error && typeof error === 'object' && 'status' in error && error.status === 400) return response({ success: false,
      error: { code: 'INVALID_PUBLICATION_REQUEST', message: '发布请求参数无效。' } }, 400);
    return response({ success: false, error: { code: 'PUBLICATION_INGEST_UNAVAILABLE', message: '发布暂不可用。' } }, 503);
  }
}

/** A control-plane snapshot; this endpoint does not attest backend seals. */
export async function GET(request: NextRequest) {
  const correlationId = crypto.randomUUID();
  try {
    const params = new URL(request.url).searchParams;
    const context = await resolveRagSecurityContext(request, {
      capability: 'ingest', requestedCorpusId: params.get('corpusId') || undefined,
      requestIdFactory: () => correlationId,
    });
    if (params.get('action') === 'capabilities') {
      const unified = process.env.RAG_UNIFIED_PUBLICATION_MODE?.trim().toLowerCase() === 'active';
      return response({ success: true, mode: unified ? 'unified' : 'legacy',
        acceptsUploads: !unified || process.env.RAG_UNIFIED_PUBLICATION_ACCEPT_REQUESTS === 'true' }, 200);
    }
    const ids = params.getAll('requestId');
    const docs = params.getAll('documentId');
    if (ids.length !== 1 || docs.length !== 1
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ids[0])
      || !docs[0] || docs[0] !== docs[0].trim() || docs[0].length > 256 || /[\u0000-\u001f\u007f]/.test(docs[0])) {
      return response({ success: false, error: { code: 'INVALID_PUBLICATION_REQUEST', message: '发布请求参数无效。' } }, 400);
    }
    const client = getPostgresClient();
    if (!client) return response({ success: false, error: { code: 'PUBLICATION_STATUS_UNAVAILABLE', message: '发布状态暂不可用。' } }, 503);
    await assertPublicationQueuePostgresCapability(client);
    const result = await new PublicationRequestQueue(client).result(ids[0], {
      tenantId: context.tenantId, corpusId: context.corpusId, documentId: docs[0],
    });
    // Absence can race an uncommitted enqueue, so it must not become a 404 or a failure.
    return response({ success: true, requestId: ids[0], status: result ? {
      queueState: result.queueState, attemptState: result.attemptState,
      currentlyActive: result.currentlyActive, generation: result.generation,
      headRevision: result.headRevision, backendVerified: false,
    } : { state: 'unknown', backendVerified: false } }, 200);
  } catch (error) {
    console.error(`[Publication status] requestId=${correlationId}`, redactErrorForLog(error));
    if (error instanceof RagSecurityError) return response({ success: false, ...error.toResponseBody() }, error.status);
    return response({ success: false, error: { code: 'PUBLICATION_STATUS_UNAVAILABLE', message: '发布状态暂不可用。' } }, 503);
  }
}

function response(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

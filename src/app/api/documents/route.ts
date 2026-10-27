import { NextRequest, NextResponse } from 'next/server';
import {
  DocumentCatalogUnavailableError,
  listDocumentCatalog,
  summarizeDocumentCatalog,
} from '@/lib/documents/document-catalog';
import { getElasticsearchRuntimeConfig } from '@/lib/elasticsearch/config';
import { redactErrorForLog } from '@/lib/security/error-redaction';
import {
  RagSecurityError,
  resolveRagSecurityContext,
} from '@/lib/security/request-context';
import { createRetrievalScope } from '@/lib/security/retrieval-scope';
import { DocumentLifecycleError, deleteManagedDocument, parseDocumentMutation, setManagedDocumentEnabled } from '@/lib/documents/document-lifecycle';
import { PostgresDocumentLifecycleStore } from '@/lib/documents/postgres-document-lifecycle-store';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request);
  try {
    const { searchParams } = new URL(request.url);
    const securityContext = await resolveRagSecurityContext(request, {
      capability: 'query',
      requestedCorpusId: searchParams.get('corpusId') || undefined,
      requestIdFactory: () => requestId,
    });
    const scope = createRetrievalScope({
      tenantId: securityContext.tenantId,
      corpusId: securityContext.corpusId,
      enforceIsolation: securityContext.enforceIsolation,
    });
    const documents = await listDocumentCatalog({ scope });
    const elasticsearchMode = getElasticsearchRuntimeConfig().mode;

    return NextResponse.json({
      success: true,
      documents,
      summary: summarizeDocumentCatalog(documents, elasticsearchMode),
      requestId,
    });
  } catch (error) {
    console.error(`[Documents API] requestId=${requestId}`, redactErrorForLog(error));
    if (error instanceof RagSecurityError) {
      return NextResponse.json({ success: false, ...error.toResponseBody() }, { status: error.status });
    }
    if (error instanceof DocumentCatalogUnavailableError) {
      return NextResponse.json({
        success: false,
        error: { code: error.code, message: error.message },
        requestId,
      }, { status: error.status });
    }
    return NextResponse.json({
      success: false,
      error: { code: 'DOCUMENT_CATALOG_FAILED', message: '无法读取文档目录。' },
      requestId,
    }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) { return mutateDocument(request, 'PATCH'); }
export async function DELETE(request: NextRequest) { return mutateDocument(request, 'DELETE'); }

async function mutateDocument(request: NextRequest, method: 'PATCH' | 'DELETE') {
  const requestId = resolveRequestId(request);
  try {
    const context = await resolveRagSecurityContext(request, {
      capability: method === 'DELETE' ? 'delete-document' : 'ingest',
      requestedCorpusId: new URL(request.url).searchParams.get('corpusId') || undefined,
      requestIdFactory: () => requestId,
    });
    let body: unknown;
    try { body = await request.json(); } catch {
      throw new DocumentLifecycleError('INVALID_DOCUMENT_MUTATION', '请求内容必须为 JSON。', 400);
    }
    const mutation = parseDocumentMutation(body, method);
    const scope = createRetrievalScope({ tenantId: context.tenantId, corpusId: context.corpusId, enforceIsolation: true });
    if (method === 'PATCH') {
      await setManagedDocumentEnabled({ id: mutation.id, scope, enabled: mutation.enabled! }, new PostgresDocumentLifecycleStore());
    } else {
      const { createDocumentDeletionPorts } = await import('@/lib/documents/document-lifecycle-runtime');
      await deleteManagedDocument({ id: mutation.id, scope }, createDocumentDeletionPorts());
    }
    return NextResponse.json({ success: true, id: mutation.id, ...(method === 'PATCH' ? { enabled: mutation.enabled } : {}), requestId });
  } catch (error) {
    console.error(`[Documents API] ${method} requestId=${requestId}`, redactErrorForLog(error));
    if (error instanceof RagSecurityError) {
      return NextResponse.json({ success: false, ...error.toResponseBody() }, { status: error.status });
    }
    if (error instanceof DocumentLifecycleError || error instanceof DocumentCatalogUnavailableError) {
      return NextResponse.json({ success: false, error: { code: error.code, message: error.message }, requestId }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: { code: 'DOCUMENT_MUTATION_FAILED', message: '文档操作失败，请刷新状态后重试。' }, requestId }, { status: 500 });
  }
}

function resolveRequestId(request: NextRequest): string {
  const supplied = request.headers.get('x-request-id')?.trim();
  return supplied && supplied.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(supplied)
    ? supplied
    : crypto.randomUUID();
}

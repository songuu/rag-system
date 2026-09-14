import { NextRequest, NextResponse } from 'next/server';
import {
  DocumentCatalogUnavailableError,
  listDocumentCatalog,
} from '@/lib/documents/document-catalog';
import { getElasticsearchRuntimeConfig } from '@/lib/elasticsearch/config';
import { redactErrorForLog } from '@/lib/security/error-redaction';
import {
  RagSecurityError,
  resolveRagSecurityContext,
} from '@/lib/security/request-context';
import { createRetrievalScope } from '@/lib/security/retrieval-scope';

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
      summary: {
        documentCount: documents.length,
        chunkCount: documents.reduce((sum, document) => sum + document.chunkCount, 0),
        byteSize: documents.reduce((sum, document) => sum + document.byteSize, 0),
        syncedCount: documents.filter(document => (
          document.milvusStatus === 'ready'
          && document.elasticsearchStatus === 'ready'
        )).length,
        elasticsearchMode,
      },
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

function resolveRequestId(request: NextRequest): string {
  const supplied = request.headers.get('x-request-id')?.trim();
  return supplied && supplied.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(supplied)
    ? supplied
    : crypto.randomUUID();
}

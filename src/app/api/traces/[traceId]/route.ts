import { NextRequest, NextResponse } from 'next/server';
import { getTraceFromPersistence } from '@/lib/persistence/trace-store';
import { RagSecurityError, resolveRagSecurityContext } from '@/lib/security/request-context';
import { redactErrorForLog } from '@/lib/security/error-redaction';

// GET /api/traces/[traceId] - 获取特定 Trace
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ traceId: string }> }
) {
  try {
    await resolveRagSecurityContext(request, {
      capability: 'query',
      requestedCorpusId: request.nextUrl.searchParams.get('corpusId') || undefined,
    });
    const { traceId } = await params;
    const trace = await getTraceFromPersistence(traceId);
    
    if (!trace) {
      return NextResponse.json(
        { error: "Trace 不存在" },
        { status: 404 }
      );
    }
    
    return NextResponse.json({
      success: true,
      trace
    });
  } catch (error) {
    console.error('[API/traces/:traceId] get failed:', redactErrorForLog(error));
    if (error instanceof RagSecurityError) {
      return NextResponse.json(error.toResponseBody(), { status: error.status });
    }
    return NextResponse.json(
      { 
        error: "获取 Trace 失败"
      },
      { status: 500 }
    );
  }
}

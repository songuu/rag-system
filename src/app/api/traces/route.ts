import { NextRequest, NextResponse } from 'next/server';
import { clearTracePersistence, listTracesFromPersistence } from '@/lib/persistence/trace-store';
import { RagSecurityError, resolveRagSecurityContext } from '@/lib/security/request-context';
import { redactErrorForLog } from '@/lib/security/error-redaction';

// GET /api/traces - 获取所有 Traces
export async function GET(request: NextRequest) {
  try {
    await resolveRagSecurityContext(request, {
      capability: 'query',
      requestedCorpusId: request.nextUrl.searchParams.get('corpusId') || undefined,
    });
    const observabilityData = await listTracesFromPersistence();
    
    console.log(`[API/traces] Returning ${observabilityData.traces.length} traces`);
    
    return NextResponse.json({
      success: true,
      traces: observabilityData.traces,
      stats: observabilityData.stats
    });
  } catch (error) {
    console.error('[API/traces] list failed:', redactErrorForLog(error));
    if (error instanceof RagSecurityError) {
      return NextResponse.json(error.toResponseBody(), { status: error.status });
    }
    return NextResponse.json(
      { 
        success: false,
        error: "获取 Traces 失败",
        traces: [],
        stats: {
          totalTraces: 0,
          successRate: 0,
          avgDuration: 0,
          totalTokens: 0,
          avgTokensPerTrace: 0
        }
      },
      { status: 500 }
    );
  }
}

// DELETE /api/traces - 清除所有 Traces
export async function DELETE(request: NextRequest) {
  try {
    await resolveRagSecurityContext(request, {
      capability: 'manage-runtime',
      requestedCorpusId: request.nextUrl.searchParams.get('corpusId') || undefined,
    });
    await clearTracePersistence();
    
    return NextResponse.json({
      success: true,
      message: "可观测性数据已清除"
    });
  } catch (error) {
    console.error('[API/traces] clear failed:', redactErrorForLog(error));
    if (error instanceof RagSecurityError) {
      return NextResponse.json(error.toResponseBody(), { status: error.status });
    }
    return NextResponse.json(
      { 
        error: "清除数据失败"
      },
      { status: 500 }
    );
  }
}

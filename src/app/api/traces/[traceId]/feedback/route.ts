import { NextRequest, NextResponse } from 'next/server';
import { addTraceFeedbackToPersistence } from '@/lib/persistence/trace-store';
import { RagSecurityError, resolveRagSecurityContext } from '@/lib/security/request-context';
import { redactErrorForLog } from '@/lib/security/error-redaction';

// POST /api/traces/[traceId]/feedback - 添加用户反馈
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ traceId: string }> }
) {
  try {
    await resolveRagSecurityContext(request, {
      capability: 'query',
      requestedCorpusId: request.nextUrl.searchParams.get('corpusId') || undefined,
    });
    const { traceId } = await params;
    const body = await request.json();
    const { score, comment } = body;
    
    if (score === undefined) {
      return NextResponse.json(
        { error: "请提供评分" },
        { status: 400 }
      );
    }
    
    const scoreId = await addTraceFeedbackToPersistence(traceId, score, comment);
    
    return NextResponse.json({
      success: true,
      scoreId,
      message: "反馈已记录"
    });
  } catch (error) {
    console.error('[API/traces/:traceId/feedback] write failed:', redactErrorForLog(error));
    if (error instanceof RagSecurityError) {
      return NextResponse.json(error.toResponseBody(), { status: error.status });
    }
    return NextResponse.json(
      { 
        error: "添加反馈失败"
      },
      { status: 500 }
    );
  }
}

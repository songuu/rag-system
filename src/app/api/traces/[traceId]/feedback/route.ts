import { NextRequest, NextResponse } from 'next/server';
import { addTraceFeedbackToPersistence } from '@/lib/persistence/trace-store';

// POST /api/traces/[traceId]/feedback - 添加用户反馈
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ traceId: string }> }
) {
  try {
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
    console.error("添加反馈错误:", error);
    return NextResponse.json(
      { 
        error: "添加反馈失败",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}

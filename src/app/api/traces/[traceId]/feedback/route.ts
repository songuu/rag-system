import { NextRequest, NextResponse } from 'next/server';
import { getRagSystem } from '@/lib/rag-instance';

// POST /api/traces/[traceId]/feedback - 添加用户反馈
export async function POST(
  request: NextRequest,
  { params }: { params: { traceId: string } }
) {
  try {
    const { traceId } = params;
    const body = await request.json();
    const { score, comment } = body;
    
    if (score === undefined) {
      return NextResponse.json(
        { error: "请提供评分" },
        { status: 400 }
      );
    }
    
    const ragSystem = await getRagSystem();
    const scoreId = ragSystem.addUserFeedback(traceId, score, comment);
    
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
import { NextRequest, NextResponse } from 'next/server';
import { getRagSystem } from '@/lib/rag-instance';

// GET /api/traces/[traceId] - 获取特定 Trace
export async function GET(
  request: NextRequest,
  { params }: { params: { traceId: string } }
) {
  try {
    const { traceId } = params;
    const ragSystem = await getRagSystem();
    const trace = ragSystem.getTrace(traceId);
    
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
    console.error("获取 Trace 错误:", error);
    return NextResponse.json(
      { 
        error: "获取 Trace 失败",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
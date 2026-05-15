import { NextRequest, NextResponse } from 'next/server';
import { getTraceFromPersistence } from '@/lib/persistence/trace-store';

// GET /api/traces/[traceId] - 获取特定 Trace
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ traceId: string }> }
) {
  try {
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

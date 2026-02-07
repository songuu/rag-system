import { NextResponse } from 'next/server';
import { getRagSystem, getCurrentRagSystem } from '@/lib/rag-instance';

// GET /api/traces - 获取所有 Traces
export async function GET() {
  try {
    // 首先尝试获取当前已存在的实例（不创建新实例）
    let ragSystem = getCurrentRagSystem();
    
    // 如果没有实例，获取或创建一个
    if (!ragSystem) {
      console.log('[API/traces] No existing RAG instance, creating one...');
      ragSystem = await getRagSystem();
    }
    
    const observabilityData = ragSystem.getObservabilityData();
    
    console.log(`[API/traces] Returning ${observabilityData.traces.length} traces`);
    
    return NextResponse.json({
      success: true,
      traces: observabilityData.traces,
      stats: observabilityData.stats
    });
  } catch (error) {
    console.error("[API/traces] 获取 Traces 错误:", error);
    return NextResponse.json(
      { 
        success: false,
        error: "获取 Traces 失败",
        details: error instanceof Error ? error.message : String(error),
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
export async function DELETE() {
  try {
    const ragSystem = await getRagSystem();
    ragSystem.clearObservabilityData();
    
    return NextResponse.json({
      success: true,
      message: "可观测性数据已清除"
    });
  } catch (error) {
    console.error("清除数据错误:", error);
    return NextResponse.json(
      { 
        error: "清除数据失败",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
/**
 * 报告对话 API
 *
 * POST /api/mirofish/interaction/chat - 与 ReportAgent 对话
 */

import { NextRequest, NextResponse } from 'next/server';
import { getReportAgent } from '@/lib/mirofish/report-agent';
import { validateModelOverride } from '@/lib/mirofish/model-override';
import { reportStore } from '../../report/route';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { report_id, question, history } = body as {
      report_id: string;
      question: string;
      history?: Array<{ role: string; content: string }>;
    };
    const modelOverride = validateModelOverride(body.modelOverride) || undefined;

    if (!report_id || !question) {
      return NextResponse.json(
        { success: false, error: '缺少 report_id 或 question' },
        { status: 400 }
      );
    }

    const report = reportStore.get(report_id);
    if (!report) {
      return NextResponse.json(
        { success: false, error: '报告不存在' },
        { status: 404 }
      );
    }

    if (report.status !== 'completed') {
      return NextResponse.json(
        { success: false, error: '报告尚未生成完成' },
        { status: 400 }
      );
    }

    const agent = getReportAgent(modelOverride);
    const answer = await agent.chat(report, question, history || []);

    return NextResponse.json({
      success: true,
      answer,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '对话失败' },
      { status: 500 }
    );
  }
}

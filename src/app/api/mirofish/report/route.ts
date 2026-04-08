/**
 * 报告管理 API
 *
 * POST /api/mirofish/report - 生成报告
 * GET /api/mirofish/report - 获取报告列表
 */

import { NextRequest, NextResponse } from 'next/server';
import { getReportAgent } from '@/lib/mirofish/report-agent';
import { getSimulationRunner } from '@/lib/mirofish/simulation-runner';
import type { ReportInfo } from '@/lib/mirofish/types';

// 内存存储报告
const reports = new Map<string, ReportInfo>();

export { reports as reportStore };

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { simulation_id, project_id } = body as {
      simulation_id: string;
      project_id: string;
    };

    if (!simulation_id) {
      return NextResponse.json(
        { success: false, error: '缺少 simulation_id' },
        { status: 400 }
      );
    }

    const runner = getSimulationRunner();
    const simulationInfo = runner.get(simulation_id);
    if (!simulationInfo) {
      return NextResponse.json(
        { success: false, error: '模拟不存在' },
        { status: 404 }
      );
    }

    const reportId = `rpt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date().toISOString();

    // 创建初始报告
    const initialReport: ReportInfo = {
      report_id: reportId,
      simulation_id,
      project_id: project_id || simulationInfo.project_id,
      status: 'generating',
      title: '生成中...',
      summary: '',
      sections: [],
      key_findings: [],
      sentiment_trend: [],
      created_at: now,
      updated_at: now,
    };
    reports.set(reportId, initialReport);

    // 异步生成报告
    const posts = runner.getPosts(simulation_id);
    const timeline = runner.getTimeline(simulation_id);
    const agent = getReportAgent();

    agent.generateReport(simulationInfo, posts, timeline)
      .then(reportData => {
        const report: ReportInfo = {
          ...reportData,
          report_id: reportId,
          created_at: now,
          updated_at: new Date().toISOString(),
        };
        reports.set(reportId, report);
      })
      .catch(error => {
        const failedReport = reports.get(reportId);
        if (failedReport) {
          // 不可变更新：创建新对象替换旧对象
          reports.set(reportId, {
            ...failedReport,
            status: 'failed',
            summary: error instanceof Error ? error.message : '生成失败',
            updated_at: new Date().toISOString(),
          });
        }
      });

    return NextResponse.json({ success: true, report_id: reportId });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '生成报告失败' },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const reportList = Array.from(reports.values()).sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    return NextResponse.json({ success: true, reports: reportList });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '获取报告列表失败' },
      { status: 500 }
    );
  }
}

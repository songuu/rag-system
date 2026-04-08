/**
 * 单个报告 API
 *
 * GET /api/mirofish/report/[id] - 获取报告详情
 */

import { NextRequest, NextResponse } from 'next/server';
import { reportStore } from '../route';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  try {
    const report = reportStore.get(id);

    if (!report) {
      return NextResponse.json(
        { success: false, error: '报告不存在' },
        { status: 404 }
      );
    }

    // 获取进度/状态
    if (action === 'progress') {
      return NextResponse.json({
        success: true,
        status: report.status,
        sections_count: report.sections.length,
      });
    }

    // 获取指定章节
    if (action === 'section') {
      const index = parseInt(searchParams.get('index') || '0');
      const section = report.sections[index];
      if (!section) {
        return NextResponse.json(
          { success: false, error: '章节不存在' },
          { status: 404 }
        );
      }
      return NextResponse.json({ success: true, section });
    }

    // 下载 Markdown
    if (action === 'download') {
      const markdown = generateMarkdown(report);
      const safeName = (report.title || 'report').replace(/[^\w\s\u4e00-\u9fff-]/g, '').trim().substring(0, 100) || 'report';
      return new Response(markdown, {
        headers: {
          'Content-Type': 'text/markdown',
          'Content-Disposition': `attachment; filename="${safeName}.md"`,
        },
      });
    }

    return NextResponse.json({ success: true, report });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '获取报告失败' },
      { status: 500 }
    );
  }
}

function generateMarkdown(report: { title: string; summary: string; sections: Array<{ title: string; content: string }>; key_findings: string[] }): string {
  let md = `# ${report.title}\n\n`;
  md += `> ${report.summary}\n\n`;

  for (const section of report.sections) {
    md += `## ${section.title}\n\n${section.content}\n\n`;
  }

  if (report.key_findings.length > 0) {
    md += `## 关键发现\n\n`;
    for (const finding of report.key_findings) {
      md += `- ${finding}\n`;
    }
  }

  return md;
}

import { NextRequest, NextResponse } from 'next/server';
import { getMiroFishReportRuntime } from '@/lib/mirofish/report-runtime';
import { resolveMiroFishRequestScope } from '@/lib/mirofish/request-scope';
import { MiroFishReportError, publicReportId } from '@/lib/mirofish/report-contracts';
import { reportHttpError, reportInteger } from '@/lib/mirofish/report-http';
interface RouteParams { params: Promise<{ id: string }> }
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { scope } = await resolveMiroFishRequestScope(request);
    const runtime = await getMiroFishReportRuntime(scope);
    const report = await runtime.getAuthorized(publicReportId((await params).id));
    if (!report) throw new MiroFishReportError('MIROFISH_REPORT_NOT_FOUND', '报告不存在。', 404);
    const search = request.nextUrl.searchParams;
    const action = search.get('action');
    if (action === 'progress') return NextResponse.json({ success: true, status: report.status, stage: report.stage,
      progress: report.progress, current_section: report.current_section, outline: report.outline, sections_count: report.sections.length, recoverable: report.recoverable, error_code: report.error_code });
    if (action === 'sections') return NextResponse.json({ success: true, sections: report.sections });
    if (action === 'section') {
      const section = report.sections[reportInteger(search.get('index'), 0, 7)];
      if (!section) throw new MiroFishReportError('MIROFISH_REPORT_SECTION_NOT_FOUND', '章节尚未生成。', 404);
      return NextResponse.json({ success: true, section });
    }
    if (['agent-log', 'console-log', 'agent-log-stream', 'console-log-stream'].includes(action ?? '')) {
      const from = reportInteger(search.get('from_line'), 0, Number.MAX_SAFE_INTEGER);
      const events = report.events.filter(event => event.sequence > from);
      const result = { success: true, logs: action?.startsWith('console') ? events.map(event => '[' + event.timestamp + '] ' + event.message) : events,
        total_lines: report.event_count, from_line: from, first_available_line: report.events[0]?.sequence ?? 0, has_more: false };
      return NextResponse.json(result, action?.endsWith('stream') ? { headers: { 'Content-Disposition': 'attachment; filename="report-log.json"' } } : undefined);
    }
    if (action === 'download') {
      if (report.status !== 'completed') throw new MiroFishReportError('MIROFISH_REPORT_NOT_READY', '报告尚未生成完成。');
      const name = encodeURIComponent((report.title || 'report').replace(/[\r\n]/g, '').slice(0, 100));
      return new Response(report.markdown_content, { headers: { 'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': 'attachment; filename="report.md"; filename*=UTF-8\'\'' + name + '.md' } });
    }
    return NextResponse.json({ success: true, report });
  } catch (error) { return reportHttpError(error); }
}
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { scope } = await resolveMiroFishRequestScope(request, 'delete-document');
    const deleted = await (await getMiroFishReportRuntime(scope)).delete(publicReportId((await params).id));
    return NextResponse.json({ success: true, deleted });
  } catch (error) { return reportHttpError(error); }
}

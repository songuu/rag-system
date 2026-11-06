import { NextRequest, NextResponse } from 'next/server';
import { readJsonObjectWithLimit } from '@/lib/security/request-validation';
import { getMiroFishReportRuntime } from '@/lib/mirofish/report-runtime';
import { resolveMiroFishRequestScope } from '@/lib/mirofish/request-scope';
import { publicReportId } from '@/lib/mirofish/report-contracts';
import { reportBoolean, reportHttpError, reportInteger } from '@/lib/mirofish/report-http';
import { getHttpModelOverrideErrorResponse, validateHttpModelOverride } from '@/lib/mirofish/model-override';
export async function POST(request: NextRequest) {
  try {
    const { scope } = await resolveMiroFishRequestScope(request, 'ingest');
    const body = await readJsonObjectWithLimit(request, 32 * 1024);
    const modelOverride = validateHttpModelOverride(body.modelOverride) || undefined;
    const runtime = await getMiroFishReportRuntime(scope, modelOverride);
    const report = await runtime.start({ simulationId: publicReportId(body.simulation_id), locale: request.headers.get('accept-language')?.startsWith('en') ? 'en' : 'zh',
      ...(body.project_id !== undefined ? { projectId: publicReportId(body.project_id) } : {}),
      forceRegenerate: reportBoolean(body.force_regenerate, 'force_regenerate'),
      ...(body.resume_report_id !== undefined ? { resumeReportId: publicReportId(body.resume_report_id) } : {}),
    });
    return NextResponse.json({ success: true, report_id: report.report_id, status: report.status, progress: report.progress });
  } catch (error) {
    const modelError = getHttpModelOverrideErrorResponse(error);
    return modelError ? NextResponse.json(modelError.body, { status: modelError.status }) : reportHttpError(error);
  }
}
export async function GET(request: NextRequest) {
  try {
    const { scope } = await resolveMiroFishRequestScope(request);
    const search = request.nextUrl.searchParams;
    const simulationId = search.get('simulation_id');
    const projectId = search.get('project_id');
    if (simulationId) publicReportId(simulationId);
    if (projectId) publicReportId(projectId);
    const runtime = await getMiroFishReportRuntime(scope);
    if (['by-simulation', 'check'].includes(search.get('action') ?? '')) {
      const found = simulationId ? await runtime.findForSimulation(simulationId, projectId ?? undefined) : null;
      const report = found ? await runtime.getAuthorized(found.report_id) : null;
      return NextResponse.json({ success: true, exists: Boolean(report), report, report_id: report?.report_id ?? null });
    }
    const reports = await runtime.listAuthorized({ simulationId: simulationId ?? undefined, projectId: projectId ?? undefined,
      limit: Math.max(1, reportInteger(search.get('limit'), 50, 100)) });
    return NextResponse.json({ success: true, reports: reports.map(({ report_id, simulation_id, project_id, title, summary, status, progress, stage, created_at, updated_at }) =>
      ({ report_id, simulation_id, project_id, title, summary, status, progress, stage, created_at, updated_at })) });
  } catch (error) { return reportHttpError(error); }
}

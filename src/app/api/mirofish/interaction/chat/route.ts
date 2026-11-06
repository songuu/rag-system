import { NextRequest, NextResponse } from 'next/server';
import { readJsonObjectWithLimit } from '@/lib/security/request-validation';
import { getMiroFishReportRuntime } from '@/lib/mirofish/report-runtime';
import { resolveMiroFishRequestScope } from '@/lib/mirofish/request-scope';
import { publicReportId } from '@/lib/mirofish/report-contracts';
import { reportHttpError } from '@/lib/mirofish/report-http';
import { getHttpModelOverrideErrorResponse, validateHttpModelOverride } from '@/lib/mirofish/model-override';
export async function POST(request: NextRequest) {
  try {
    const { scope, actorId } = await resolveMiroFishRequestScope(request);
    const body = await readJsonObjectWithLimit(request, 32 * 1024);
    const modelOverride = validateHttpModelOverride(body.modelOverride) || undefined;
    const runtime = await getMiroFishReportRuntime(scope, modelOverride, request.headers.get('accept-language')?.startsWith('en') ? 'en' : 'zh');
    const response = await runtime.chat(publicReportId(body.report_id), body.question, actorId);
    return NextResponse.json({ success: true, ...response, timestamp: new Date().toISOString() });
  } catch (error) {
    const modelError = getHttpModelOverrideErrorResponse(error);
    return modelError ? NextResponse.json(modelError.body, { status: modelError.status }) : reportHttpError(error);
  }
}
export async function GET(request: NextRequest) {
  try {
    const { scope, actorId } = await resolveMiroFishRequestScope(request);
    const runtime = await getMiroFishReportRuntime(scope);
    return NextResponse.json({ success: true, messages: await runtime.history(publicReportId(request.nextUrl.searchParams.get('report_id')), actorId) });
  } catch (error) { return reportHttpError(error); }
}

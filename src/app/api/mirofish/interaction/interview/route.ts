import { NextRequest, NextResponse } from 'next/server';
import { readJsonObjectWithLimit } from '@/lib/security/request-validation';
import { getMiroFishInteractionRuntime } from '@/lib/mirofish/interaction-runtime';
import { resolveMiroFishRequestScope } from '@/lib/mirofish/request-scope';
import { boundedQuestion, MiroFishReportError, publicReportId } from '@/lib/mirofish/report-contracts';
import { reportBoolean, reportHttpError } from '@/lib/mirofish/report-http';
import { getHttpModelOverrideErrorResponse, validateHttpModelOverride } from '@/lib/mirofish/model-override';
export async function POST(request: NextRequest) {
  try {
    const { scope, actorId } = await resolveMiroFishRequestScope(request);
    const body = await readJsonObjectWithLimit(request, 64 * 1024);
    const modelOverride = validateHttpModelOverride(body.modelOverride) || undefined;
    const runtime = getMiroFishInteractionRuntime(scope, modelOverride, request.headers.get('accept-language')?.startsWith('en') ? 'en' : 'zh');
    const simulationId = publicReportId(body.simulation_id);
    const batch = reportBoolean(body.batch, 'batch');
    const conversationId = body.conversation_id === undefined ? undefined : publicReportId(body.conversation_id);
    if (body.interviews !== undefined) {
      if (!Array.isArray(body.interviews) || !body.interviews.length || body.interviews.length > 10) throw new MiroFishReportError('MIROFISH_INTERVIEW_AGENT_LIMIT', '问卷需包含 1–10 位 Agent。', 400);
      const inputs = body.interviews.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new MiroFishReportError('MIROFISH_INTERVIEW_INVALID_QUESTIONNAIRE', '采访问卷格式无效。', 400);
        return { agentId: publicReportId(item.agent_id), question: boundedQuestion(item.prompt ?? item.question) };
      });
      const responses = await runtime.askQuestionnaire({ simulationId, interviews: inputs, actorId, conversationId });
      return NextResponse.json({ success: true, responses });
    }
    const question = boundedQuestion(body.question);
    let agentIds: string[];
    if (body.agent_ids !== undefined) {
      if (!Array.isArray(body.agent_ids) || !body.agent_ids.length || body.agent_ids.length > 10) throw new MiroFishReportError('MIROFISH_INTERVIEW_AGENT_LIMIT', '每次采访请选择 1–10 位 Agent。', 400);
      agentIds = body.agent_ids.map(publicReportId);
    } else if (batch) agentIds = (await runtime.profiles(simulationId)).map(profile => profile.entity_id);
    else agentIds = [publicReportId(body.agent_id)];
    const responses = await runtime.askMany({ simulationId, agentIds, question, actorId, conversationId });
    return NextResponse.json({ success: true, responses, ...(responses.length === 1 ? { response: responses[0] } : {}) });
  } catch (error) {
    const modelError = getHttpModelOverrideErrorResponse(error);
    return modelError ? NextResponse.json(modelError.body, { status: modelError.status }) : reportHttpError(error);
  }
}
export async function GET(request: NextRequest) {
  try {
    const { scope, actorId } = await resolveMiroFishRequestScope(request);
    const search = request.nextUrl.searchParams;
    const runtime = getMiroFishInteractionRuntime(scope);
    const simulationId = publicReportId(search.get('simulation_id'));
    if (search.get('action') === 'history') {
      const conversation = await runtime.history(simulationId, publicReportId(search.get('agent_id')), actorId,
        search.has('conversation_id') ? publicReportId(search.get('conversation_id')) : undefined);
      return NextResponse.json({ success: true, messages: conversation?.messages ?? [], responses: conversation?.answers ?? [] });
    }
    return NextResponse.json({ success: true, profiles: await runtime.profiles(simulationId) });
  } catch (error) { return reportHttpError(error); }
}

import { createHash } from 'node:crypto';
import type { TextModelClient } from '../models/text-model';
import { createTextModelClientFromOverride } from './model-override';
import { InteractionAgent } from './interaction-agent';
import { getMiroFishRuntimeStore } from './runtime-store';
import { boundedQuestion, MIROFISH_REPORT_LIMITS, MiroFishReportError, publicReportId,
  type MiroFishReportScope, type MiroFishReportSnapshot, type MiroFishRuntimeStorage, type ReportSource } from './report-contracts';
import type { InterviewResponse, ModelOverride } from './types';
import { assertReportSimulationReady, loadMiroFishReportContext, reportContextIdentity } from './report-context';

export interface InterviewRuntimeAnswer extends InterviewResponse { platform_answers: Record<string, string>; sources: ReportSource[] }
export interface AgentConversation {
  simulation_id: string; agent_id: string; project_id: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string; sources?: ReportSource[] }>;
  answers: InterviewRuntimeAnswer[]; updated_at: string;
}
interface InteractionOptions { store: MiroFishRuntimeStorage; scope?: MiroFishReportScope; modelOverride?: ModelOverride;
  loadSnapshot?: (id: string) => Promise<MiroFishReportSnapshot | null>; model?: TextModelClient; locale?: 'zh' | 'en' }
interface InterviewInput { simulationId: string; agentIds: string[]; question: string; actorId?: string; conversationId?: string; model?: TextModelClient }
const interactionGlobal = globalThis as typeof globalThis & { __miroFishInterviewLocksV1?: Map<string, Promise<unknown>> };
const locks = interactionGlobal.__miroFishInterviewLocksV1 ??= new Map();

export class MiroFishInteractionRuntime {
  private readonly options: InteractionOptions;
  constructor(options: InteractionOptions) { this.options = options; }
  private async snapshot(id: string): Promise<MiroFishReportSnapshot> {
    publicReportId(id);
    const context = this.options.loadSnapshot ? null : await loadMiroFishReportContext(id, this.options.scope);
    if (context) assertReportSimulationReady(context);
    const snapshot = this.options.loadSnapshot ? await this.options.loadSnapshot(id) : context!.snapshot;
    if (!snapshot) throw new MiroFishReportError('MIROFISH_INTERVIEW_SIMULATION_NOT_FOUND', '模拟不存在。', 404);
    return snapshot;
  }
  async profiles(simulationId: string) { return (await this.snapshot(simulationId)).info.agent_profiles; }
  private sessionKey(simulationId: string, agentId: string, actorId = 'local-user', conversationId = 'default', runId?: string): string {
    return 'interview_' + createHash('sha256').update(JSON.stringify([simulationId, agentId, actorId, conversationId, runId ?? null])).digest('hex');
  }
  async history(simulationId: string, agentId: string, actorId = 'local-user', conversationId = 'default'): Promise<AgentConversation | null> {
    const snapshot = await this.snapshot(simulationId);
    if (!snapshot.info.agent_profiles.some(profile => profile.entity_id === agentId)) throw new MiroFishReportError('MIROFISH_INTERVIEW_AGENT_NOT_FOUND', 'Agent 不存在。', 404);
    return this.options.store.read<AgentConversation>('interaction', this.sessionKey(simulationId, agentId, actorId, conversationId, snapshot.projection?.runId));
  }
  async askMany(input: InterviewInput): Promise<InterviewRuntimeAnswer[]> {
    const question = boundedQuestion(input.question);
    const snapshot = await this.snapshot(input.simulationId);
    const ids = [...new Set(input.agentIds)];
    if (!ids.length || ids.length > MIROFISH_REPORT_LIMITS.selectedAgents) throw new MiroFishReportError('MIROFISH_INTERVIEW_AGENT_LIMIT', '每次采访请选择 1–10 位 Agent。', 400);
    if (ids.some(id => !snapshot.info.agent_profiles.some(profile => profile.entity_id === id))) throw new MiroFishReportError('MIROFISH_INTERVIEW_AGENT_NOT_FOUND', 'Agent 不存在。', 404);
    const model = input.model ?? this.model(Date.now() + MIROFISH_REPORT_LIMITS.modelTimeoutMs);
    const results: InterviewRuntimeAnswer[] = [];
    // Sequential interviews bound provider concurrency and preserve each actor's conversation order.
    for (const id of ids) {
      const session = this.sessionKey(input.simulationId, id, input.actorId, input.conversationId, snapshot.projection?.runId);
      const lock = JSON.stringify([this.options.scope, session]);
      const previous = locks.get(lock) ?? Promise.resolve();
      const work = previous.catch(() => undefined).then(() => this.ask(snapshot, id, question, session, model));
      locks.set(lock, work);
      try { results.push(await work); } finally { if (locks.get(lock) === work) locks.delete(lock); }
    }
    return results;
  }
  async askQuestionnaire(input: { simulationId: string; interviews: Array<{ agentId: string; question: string }>; actorId: string; conversationId?: string }): Promise<InterviewRuntimeAnswer[]> {
    if (!input.interviews.length || input.interviews.length > 10) throw new MiroFishReportError('MIROFISH_INTERVIEW_AGENT_LIMIT', '问卷需包含 1–10 位 Agent。', 400);
    const profiles = await this.profiles(input.simulationId);
    for (const item of input.interviews) {
      boundedQuestion(item.question);
      if (!profiles.some(profile => profile.entity_id === item.agentId)) throw new MiroFishReportError('MIROFISH_INTERVIEW_AGENT_NOT_FOUND', 'Agent 不存在。', 404);
    }
    const model = this.model(Date.now() + MIROFISH_REPORT_LIMITS.modelTimeoutMs);
    const results: InterviewRuntimeAnswer[] = [];
    for (const item of input.interviews) results.push(...await this.askMany({ simulationId: input.simulationId, agentIds: [item.agentId], question: item.question,
      actorId: input.actorId, conversationId: input.conversationId, model }));
    return results;
  }
  private model(deadline: number): TextModelClient {
    let calls = 0; let characters = 0;
    return { complete: async request => {
      characters += request.messages.reduce((total, message) => total + message.content.length, 0);
      if (++calls > 10 || characters > 250_000 || Date.now() >= deadline) throw new MiroFishReportError('MIROFISH_INTERVIEW_BUDGET_EXCEEDED', '采访预算已用完，请减少参与者或缩短问题。', 422);
      const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;
      const model = this.options.model ?? createTextModelClientFromOverride(this.options.modelOverride, {
        temperature: 0.5, requestTimeoutMs: MIROFISH_REPORT_LIMITS.modelTimeoutMs, requestSignal: signal,
        ollamaOptions: { format: 'json', num_ctx: 32768, numPredict: 2048 },
      });
      return model.complete({ ...request, signal });
    } };
  }
  private async ask(snapshot: MiroFishReportSnapshot, agentId: string, question: string, session: string, model: TextModelClient): Promise<InterviewRuntimeAnswer> {
    const bound = this.options.loadSnapshot ? null : await loadMiroFishReportContext(snapshot.info.simulation_id, this.options.scope);
    if (bound) assertReportSimulationReady(bound);
    if (bound && reportContextIdentity({ ...bound, snapshot }) !== reportContextIdentity(bound)) throw new MiroFishReportError('MIROFISH_REPORT_SOURCE_CHANGED', '模拟运行已变化，请重新打开采访。');
    const profile = snapshot.info.agent_profiles.find(value => value.entity_id === agentId)!;
    const old = await this.options.store.read<AgentConversation>('interaction', session);
    const posts = snapshot.posts.filter(post => post.author_id === agentId);
    const observations = snapshot.memory?.[agentId]?.observations ?? [];
    const actions = (snapshot.actions ?? []).filter(action => action.agentId === agentId).slice(-12).map(action => {
      const safe: Record<string, unknown> = {};
      for (const key of ['id', 'agentId', 'type', 'action', 'round', 'platform', 'content', 'targetAgentId', 'postId']) {
        const value = action[key];
        if (typeof value === 'string') safe[key] = value.slice(0, 300); else if (typeof value === 'number') safe[key] = value;
      }
      return safe;
    });
    const answer = await new InteractionAgent(this.options.modelOverride).interviewWithMemory(profile, question, posts, {
      observations, actions, history: old?.messages ?? [], platforms: snapshot.info.config.platforms, locale: this.options.locale,
    }, model);
    if (bound) {
      const current = await loadMiroFishReportContext(snapshot.info.simulation_id, this.options.scope);
      assertReportSimulationReady(current);
      if (reportContextIdentity(current) !== reportContextIdentity(bound)) throw new MiroFishReportError('MIROFISH_REPORT_SOURCE_CHANGED', '模拟来源已变化，请重新打开采访。');
    }
    const graphId = snapshot.sourceGraphIdentity?.documentId ?? '';
    const result: InterviewRuntimeAnswer = { ...answer, sources: [
      { kind: observations.length ? 'memory' : 'node', id: agentId, label: profile.entity_name, graphId },
      ...posts.slice(-10).map(post => ({ kind: 'post' as const, id: post.id, label: post.author_name, graphId })),
    ] };
    const record: AgentConversation = { simulation_id: snapshot.info.simulation_id, agent_id: agentId, project_id: snapshot.info.project_id,
      messages: [...(old?.messages ?? []), { role: 'user' as const, content: question, timestamp: answer.timestamp },
        { role: 'assistant' as const, content: answer.answer, timestamp: answer.timestamp, sources: result.sources }].slice(-MIROFISH_REPORT_LIMITS.historyMessages),
      answers: [...(old?.answers ?? []), result].slice(-20), updated_at: answer.timestamp };
    await this.options.store.write('interaction', session, record, { projectId: record.project_id });
    return result;
  }
}
export function getMiroFishInteractionRuntime(scope?: MiroFishReportScope, modelOverride?: ModelOverride, locale?: 'zh' | 'en'): MiroFishInteractionRuntime {
  return new MiroFishInteractionRuntime({ store: getMiroFishRuntimeStore(scope), scope, modelOverride, locale });
}

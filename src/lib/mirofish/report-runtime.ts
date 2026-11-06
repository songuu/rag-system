import { createHash, randomUUID } from 'node:crypto';
import type { TextModelClient, TextModelRequest } from '../models/text-model';
import type { ModelOverride } from './types';
import { createTextModelClientFromOverride } from './model-override';
import { ReportAgent } from './report-agent';
import { withMiroFishProjectLock } from './project-lifecycle';
import { KnowledgeGraphError } from '../knowledge-graph/contracts';
import { ReportTools, type ReportInterviewAnswer } from './report-tools';
import { assertReportSimulationReady, loadMiroFishReportContext, reportContextIdentity } from './report-context';
import { MIROFISH_REPORT_LIMITS, MiroFishReportError, boundedQuestion, publicReportId, safeReportError,
  type MiroFishReportContext, type MiroFishReportScope, type MiroFishRuntimeStorage, type ReportRuntimeEvent, type ReportRuntimeRecord,
  type ReportSource, type ReportToolName } from './report-contracts';

interface ReportRuntimeOptions {
  store: MiroFishRuntimeStorage;
  scope?: MiroFishReportScope;
  loadContext?: (simulationId: string) => Promise<MiroFishReportContext>;
  model?: TextModelClient;
  modelOverride?: ModelOverride;
  locale?: 'zh' | 'en';
  interview?: (context: MiroFishReportContext, ids: string[], question: string) => Promise<ReportInterviewAnswer[]>;
}
interface StartReport { simulationId: string; projectId?: string; forceRegenerate?: boolean; resumeReportId?: string; locale?: 'zh' | 'en' }
const runtimeGlobal = globalThis as typeof globalThis & { __miroFishReportWorkV1?: {
  jobs: Map<string, Promise<void>>; starts: Map<string, Promise<unknown>>;
} };
const { jobs, starts } = runtimeGlobal.__miroFishReportWorkV1 ??= { jobs: new Map(), starts: new Map() };
type ReportConversation = { report_id: string; project_id: string; messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string;
  sources?: ReportSource[]; tool_calls?: Array<{ name: ReportToolName; parameters: Record<string, unknown> }> }>; updated_at: string };

export class MiroFishReportRuntime {
  private readonly options: ReportRuntimeOptions;
  constructor(options: ReportRuntimeOptions) { this.options = options; }
  private key(id: string): string { return JSON.stringify([this.options.scope?.tenantId, this.options.scope?.corpusId, id]); }
  private loadContext(simulationId: string) { return this.options.loadContext?.(simulationId) ?? loadMiroFishReportContext(simulationId, this.options.scope); }
  async start(input: StartReport): Promise<ReportRuntimeRecord> {
    publicReportId(input.simulationId);
    const key = this.key(input.simulationId);
    const previous = starts.get(key) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.startExclusive(input));
    starts.set(key, work);
    try { return await work; } finally { if (starts.get(key) === work) starts.delete(key); }
  }
  private async startExclusive(input: StartReport): Promise<ReportRuntimeRecord> {
    const initial = await this.loadContext(input.simulationId);
    const scope = this.options.scope ?? { tenantId: initial.identity.tenantId, corpusId: initial.identity.corpusId };
    return withMiroFishProjectLock(scope, initial.projectId, () => this.startRegistered(input));
  }
  private async startRegistered(input: StartReport): Promise<ReportRuntimeRecord> {
    // Reset/delete share this short registration lock. Re-read the source after
    // acquiring it, then publish the initial durable record before releasing it.
    const context = { ...await this.loadContext(input.simulationId), locale: input.locale ?? 'zh' };
    assertReportSimulationReady(context);
    if (input.projectId && context.projectId !== input.projectId) throw new MiroFishReportError('MIROFISH_REPORT_PROJECT_MISMATCH', '模拟不属于该项目。', 404);
    const latest = await this.findForSimulation(input.simulationId, context.projectId);
    if (!input.forceRegenerate && !input.resumeReportId && latest && latest.source_authority === reportContextIdentity(context) && (latest.locale ?? 'zh') === context.locale) {
      if (latest.status === 'completed' || jobs.has(this.key(latest.report_id))) return latest;
    }
    let record: ReportRuntimeRecord;
    if (input.resumeReportId) {
      const existing = await this.get(publicReportId(input.resumeReportId));
      if (!existing || existing.simulation_id !== input.simulationId || existing.source_authority !== reportContextIdentity(context)) {
        throw new MiroFishReportError('MIROFISH_REPORT_SOURCE_CHANGED', '恢复报告时来源已变化，请重新生成。');
      }
      if (jobs.has(this.key(existing.report_id))) return existing;
      context.locale = existing.locale ?? 'zh';
      record = { ...existing, status: 'generating', stage: existing.outline ? 'generating' : 'planning', recoverable: false };
      delete record.error_code;
    } else {
      const now = new Date().toISOString();
      record = { report_id: `rpt_${randomUUID()}`, simulation_id: input.simulationId, project_id: context.projectId,
        status: 'generating', stage: 'pending', progress: 0, current_section: null, outline: null, locale: context.locale,
        graph_identity: context.identity, source_authority: reportContextIdentity(context), title: '生成中...', summary: '', sections: [],
        key_findings: [], sentiment_trend: [], events: [], event_count: 0, markdown_content: '',
        model_calls: 0, model_input_characters: 0, model_output_characters: 0, created_at: now, updated_at: now };
    }
    await this.save(record);
    const jobKey = this.key(record.report_id);
    const job = Promise.resolve().then(() => this.run(record, context)).finally(() => jobs.delete(jobKey));
    jobs.set(jobKey, job);
    // Keep rejected persistence work observed even after the initiating HTTP request returns.
    void job.catch(() => undefined);
    return structuredClone(record);
  }
  async wait(reportId: string): Promise<void> { await jobs.get(this.key(reportId)); }
  async getAuthorized(reportId: string): Promise<ReportRuntimeRecord | null> {
    const record = await this.get(reportId);
    if (!record) return null;
    const context = await this.loadContext(record.simulation_id);
    assertReportSimulationReady(context);
    if (record.source_authority !== reportContextIdentity(context)) throw new MiroFishReportError('MIROFISH_REPORT_SOURCE_CHANGED', '报告来源已变化，请重新生成。');
    return record;
  }
  async get(reportId: string): Promise<ReportRuntimeRecord | null> {
    const report = await this.options.store.read<ReportRuntimeRecord>('report', publicReportId(reportId));
    if (report?.status === 'generating' && !jobs.has(this.key(reportId))) {
      const interrupted: ReportRuntimeRecord = { ...report, status: 'failed', stage: 'failed', recoverable: true,
        error_code: 'MIROFISH_REPORT_INTERRUPTED', updated_at: new Date().toISOString() };
      await this.save(interrupted);
      return interrupted;
    }
    return report;
  }
  async list(input: { simulationId?: string; projectId?: string; limit?: number } = {}): Promise<ReportRuntimeRecord[]> {
    const limit = Math.max(1, Math.min(100, input.limit ?? 50));
    const reports = await this.options.store.list<ReportRuntimeRecord>('report', { projectId: input.projectId, limit: 100 });
    return reports.filter(report => !input.simulationId || report.simulation_id === input.simulationId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
  }
  async findForSimulation(simulationId: string, projectId?: string): Promise<ReportRuntimeRecord | null> {
    return (await this.list({ simulationId, projectId, limit: 1 }))[0] ?? null;
  }
  async listAuthorized(input: { simulationId?: string; projectId?: string; limit?: number } = {}): Promise<ReportRuntimeRecord[]> {
    const reports = await this.list(input);
    const contexts = new Map<string, Promise<MiroFishReportContext>>();
    const visible: ReportRuntimeRecord[] = [];
    for (const report of reports) {
      try {
        let pending = contexts.get(report.simulation_id);
        if (!pending) { pending = this.loadContext(report.simulation_id); contexts.set(report.simulation_id, pending); }
        const context = await pending;
        assertReportSimulationReady(context);
        if (report.source_authority !== reportContextIdentity(context)) continue;
        const current = report.status === 'generating' ? await this.get(report.report_id) : report;
        if (current) visible.push(current);
      } catch (error) {
        const unavailable = error instanceof MiroFishReportError && [
          'MIROFISH_REPORT_SOURCE_UNAVAILABLE', 'MIROFISH_REPORT_SOURCE_CHANGED', 'MIROFISH_REPORT_SOURCE_UNBOUND',
          'MIROFISH_REPORT_SIMULATION_NOT_FOUND', 'MIROFISH_REPORT_SIMULATION_NOT_READY',
        ].includes(error.code);
        if (!unavailable && !(error instanceof KnowledgeGraphError && error.code === 'KNOWLEDGE_GRAPH_CONFLICT')) throw error;
      }
    }
    return visible;
  }
  async delete(reportId: string): Promise<boolean> {
    if (jobs.has(this.key(reportId))) throw new MiroFishReportError('MIROFISH_REPORT_BUSY', '报告生成期间不能删除。');
    return this.options.store.delete('report', publicReportId(reportId));
  }
  private async save(record: ReportRuntimeRecord): Promise<void> {
    record.updated_at = new Date().toISOString();
    await this.options.store.write('report', record.report_id, record, { projectId: record.project_id });
  }
  private async event(record: ReportRuntimeRecord, action: ReportRuntimeEvent['action'], message: string,
    details?: ReportRuntimeEvent['details']): Promise<void> {
    record.event_count++;
    record.events = [...record.events, { sequence: record.event_count, timestamp: new Date().toISOString(), action,
      section_index: record.current_section ?? undefined, message, ...(details ? { details } : {}) }].slice(-MIROFISH_REPORT_LIMITS.events);
    await this.save(record);
  }
  private budgetModel(record: ReportRuntimeRecord, deadline: number): TextModelClient {
    return { complete: async (request: TextModelRequest) => {
      const input = request.messages.reduce((total, message) => total + message.content.length, 0);
      if (record.model_calls >= MIROFISH_REPORT_LIMITS.modelCalls
        || record.model_input_characters + input > MIROFISH_REPORT_LIMITS.modelInputCharacters || Date.now() >= deadline) {
        throw new MiroFishReportError('MIROFISH_REPORT_BUDGET_EXCEEDED', '报告调用或时间预算已用完，请缩小范围后重试。', 422);
      }
      record.model_calls++; record.model_input_characters += input;
      await this.save(record);
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(MIROFISH_REPORT_LIMITS.modelTimeoutMs, deadline - Date.now())));
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      const model = this.options.model ?? createTextModelClientFromOverride(this.options.modelOverride, {
        temperature: 0.3, requestTimeoutMs: MIROFISH_REPORT_LIMITS.modelTimeoutMs, requestSignal: signal,
        ollamaOptions: { format: 'json', num_ctx: 32768, numPredict: 4096 },
      });
      const result = await model.complete({ ...request, signal });
      record.model_output_characters += result.text.length;
      if (record.model_output_characters > MIROFISH_REPORT_LIMITS.modelOutputCharacters) throw new MiroFishReportError('MIROFISH_REPORT_BUDGET_EXCEEDED', '报告模型输出超过预算。', 422);
      return result;
    } };
  }
  private async assertCurrent(bound: MiroFishReportContext): Promise<void> {
    const current = await this.loadContext(bound.snapshot.info.simulation_id);
    assertReportSimulationReady(current);
    if (reportContextIdentity(current) !== reportContextIdentity(bound)) throw new MiroFishReportError('MIROFISH_REPORT_SOURCE_CHANGED', '模拟或图谱来源已变化，请重新生成报告。');
  }
  private tools(context: MiroFishReportContext, model: TextModelClient): ReportTools {
    return new ReportTools({ context, model, assertCurrent: () => this.assertCurrent(context),
      interview: (ids, question) => this.options.interview ? this.options.interview(context, ids, question) : this.interview(context, ids, question, model),
    });
  }
  private async interview(context: MiroFishReportContext, ids: string[], question: string, model: TextModelClient): Promise<ReportInterviewAnswer[]> {
    const { getMiroFishInteractionRuntime } = await import('./interaction-runtime');
    return getMiroFishInteractionRuntime(this.options.scope, this.options.modelOverride, context.locale).askMany({ simulationId: context.snapshot.info.simulation_id,
      agentIds: ids, question, conversationId: `research_${randomUUID()}`, model });
  }
  private async run(record: ReportRuntimeRecord, context: MiroFishReportContext): Promise<void> {
    try {
      const model = this.budgetModel(record, Date.now() + MIROFISH_REPORT_LIMITS.taskTimeoutMs);
      const agent = new ReportAgent(undefined, model);
      const tools = this.tools(context, model);
      await this.event(record, 'report_start', '报告任务已启动。');
      if (!record.outline) {
        record.stage = 'planning'; record.progress = 5;
        record.outline = await agent.planOutline(context);
        record.title = record.outline.title; record.summary = record.outline.summary;
        await this.event(record, 'planning_complete', '报告目录已规划。');
      }
      record.stage = 'generating';
      for (let index = record.sections.length; index < record.outline.sections.length; index++) {
        await this.assertCurrent(context);
        record.current_section = index; record.progress = 15 + Math.floor(75 * index / record.outline.sections.length);
        await this.event(record, 'section_start', `正在生成：${record.outline.sections[index].title}`);
        const content = await agent.generateSection({ outline: record.outline, index, previous: record.sections, context, tools,
          onToolCall: (name, parameters) => this.event(record, 'tool_call', `调用工具：${name}`, { tool_name: name, parameters }),
          onToolResult: result => this.event(record, 'tool_result', result.summary, { tool_name: result.tool, result }),
        });
        record.sections.push({ index, ...record.outline.sections[index], content });
        await this.event(record, 'section_complete', '章节已保存。', { content });
      }
      await this.assertCurrent(context);
      record.stage = 'assembling'; record.progress = 95;
      record.markdown_content = `# ${record.title}\n\n> ${record.summary}\n\n` + record.sections.map(section => `## ${section.title}\n\n${section.content}`).join('\n\n');
      record.sentiment_trend = context.snapshot.timeline.map(entry => ({ round: entry.round, ...entry.stats.sentiment_distribution }));
      record.status = 'completed'; record.stage = 'completed'; record.progress = 100; record.current_section = null;
      record.generated_at = new Date().toISOString(); record.recoverable = false;
      await this.event(record, 'report_complete', '报告已生成。');
    } catch (error) {
      const safe = safeReportError(error);
      record.status = 'failed'; record.stage = 'failed'; record.error_code = safe.code; record.recoverable = true;
      await this.event(record, 'error', safe.message);
    }
  }
  async history(reportId: string, actorId = 'local-user'): Promise<ReportConversation['messages']> {
    if (!await this.getAuthorized(reportId)) throw new MiroFishReportError('MIROFISH_REPORT_NOT_FOUND', '报告不存在。', 404);
    return (await this.options.store.read<ReportConversation>('interaction', this.conversationKey(reportId, actorId)))?.messages ?? [];
  }
  private conversationKey(reportId: string, actorId: string) { return `report_chat_${createHash('sha256').update(JSON.stringify([reportId, actorId])).digest('hex')}`; }
  async chat(reportId: string, question: unknown, actorId = 'local-user'): Promise<{ answer: string; tool_calls: Array<{ name: ReportToolName; parameters: Record<string, unknown> }>; sources: ReportSource[] }> {
    const key = this.key(`chat:${this.conversationKey(reportId, actorId)}`);
    const previous = starts.get(key) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.chatExclusive(reportId, question, actorId));
    starts.set(key, work);
    try { return await work; } finally { if (starts.get(key) === work) starts.delete(key); }
  }
  private async chatExclusive(reportId: string, question: unknown, actorId: string): Promise<{ answer: string; tool_calls: Array<{ name: ReportToolName; parameters: Record<string, unknown> }>; sources: ReportSource[] }> {
    const report = await this.get(reportId);
    if (!report) throw new MiroFishReportError('MIROFISH_REPORT_NOT_FOUND', '报告不存在。', 404);
    if (report.status !== 'completed') throw new MiroFishReportError('MIROFISH_REPORT_NOT_READY', '报告尚未生成完成。');
    const context = { ...await this.loadContext(report.simulation_id), locale: this.options.locale ?? report.locale ?? 'zh' };
    await this.assertCurrent(context);
    if (report.source_authority !== reportContextIdentity(context)) throw new MiroFishReportError('MIROFISH_REPORT_SOURCE_CHANGED', '报告来源已变化，请重新生成。');
    const counters = { ...report, model_calls: 0, model_input_characters: 0, model_output_characters: 0 };
    // Chat accounting is isolated from the completed report and cannot rewrite it.
    const client = this.chatModel(counters);
    const tools = this.tools(context, client);
    const calls: Array<{ name: ReportToolName; parameters: Record<string, unknown> }> = [];
    const sources: ReportSource[] = [{ kind: 'report', id: report.report_id, label: report.title, graphId: context.graph.graph_id }];
    const history = await this.history(reportId, actorId);
    const text = boundedQuestion(question);
    const answer = await new ReportAgent(undefined, client).chatWithTools({ report, question: text, history, tools, locale: context.locale,
      onToolCall: async (name, parameters) => { calls.push({ name, parameters }); }, onToolResult: async result => { sources.push(...result.sources); } });
    await this.assertCurrent(context);
    const timestamp = new Date().toISOString();
    const dedupSources = [...new Map(sources.map(source => [`${source.kind}:${source.id}`, source])).values()].slice(0, 60);
    await this.options.store.write('interaction', this.conversationKey(reportId, actorId), { report_id: reportId, project_id: report.project_id,
      updated_at: timestamp, messages: [...history, { role: 'user', content: text, timestamp }, { role: 'assistant', content: answer, timestamp, sources: dedupSources, tool_calls: calls }].slice(-MIROFISH_REPORT_LIMITS.historyMessages) }, { projectId: report.project_id });
    return { answer, tool_calls: calls, sources: dedupSources };
  }
  private chatModel(counters: ReportRuntimeRecord): TextModelClient {
    let calls = 0; let input = 0; let output = 0;
    const deadline = Date.now() + MIROFISH_REPORT_LIMITS.modelTimeoutMs;
    return { complete: async request => {
      input += request.messages.reduce((total, message) => total + message.content.length, 0);
      if (++calls > 15 || input > 200_000 || Date.now() >= deadline) throw new MiroFishReportError('MIROFISH_REPORT_BUDGET_EXCEEDED', '对话工具预算已用完。', 422);
      const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;
      const model = this.options.model ?? createTextModelClientFromOverride(this.options.modelOverride, { temperature: 0.3, requestSignal: signal,
        requestTimeoutMs: MIROFISH_REPORT_LIMITS.modelTimeoutMs, ollamaOptions: { format: 'json', num_ctx: 32768, numPredict: 4096 } });
      const result = await model.complete({ ...request, signal });
      output += result.text.length; counters.model_output_characters = output;
      if (output > 80_000) throw new MiroFishReportError('MIROFISH_REPORT_BUDGET_EXCEEDED', '对话输出超过预算。', 422);
      return result;
    } };
  }
}
export async function getMiroFishReportRuntime(scope?: MiroFishReportScope, modelOverride?: ModelOverride, locale?: 'zh' | 'en'): Promise<MiroFishReportRuntime> {
  const { getMiroFishRuntimeStore } = await import('./runtime-store');
  return new MiroFishReportRuntime({ store: getMiroFishRuntimeStore(scope), scope, modelOverride, locale });
}

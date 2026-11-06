import type { GraphData, ReportInfo, SimulationInfo, SimulationPost, TimelineEntry } from './types';
import type { MiroFishGraphArtifactIdentity } from './graph-artifact-store';

export interface MiroFishReportScope { tenantId: string; corpusId: string }
export interface MiroFishReportSnapshot {
  info: SimulationInfo;
  posts: SimulationPost[];
  timeline: TimelineEntry[];
  sourceGraphIdentity?: Pick<MiroFishGraphArtifactIdentity, 'documentId' | 'documentVersion' | 'trustLevel' | 'graphGeneration'>
    & Partial<Pick<MiroFishGraphArtifactIdentity, 'tenantId' | 'corpusId'>>;
  memory?: Record<string, { observations: string[]; recentActionIds: string[] }>;
  actions?: Array<{ agentId: string; [key: string]: unknown }>;
  projection?: { enabled: boolean; status: string; runId?: string; committedEventSequence?: number; projectedEventSequence?: number };
  scenario?: { requirement: string; seedFiles?: Array<{ filename: string; size?: number; [key: string]: unknown }> };
}
export interface MiroFishReportContext {
  locale?: 'zh' | 'en';
  snapshot: MiroFishReportSnapshot;
  graph: GraphData;
  identity: MiroFishGraphArtifactIdentity;
  authority: string;
  requirement: string;
  projectId: string;
}
export interface MiroFishRuntimeStorage {
  read<T>(kind: 'report' | 'interaction', id: string): Promise<T | null>;
  write<T>(kind: 'report' | 'interaction', id: string, value: T, options?: { projectId?: string }): Promise<void>;
  list<T>(kind: 'report' | 'interaction', options?: { projectId?: string; limit?: number }): Promise<T[]>;
  delete(kind: 'report' | 'interaction', id: string): Promise<boolean>;
}
export type ReportToolName = 'quick_search' | 'panorama_search' | 'insight_forge' | 'interview_agents';
export interface ReportSource { kind: 'node' | 'edge' | 'post' | 'memory' | 'report'; id: string; label: string; graphId: string }
export interface ReportToolResult {
  tool: ReportToolName;
  summary: string;
  sources: ReportSource[];
  data: Record<string, unknown>;
}
export interface ReportOutline {
  title: string;
  summary: string;
  sections: Array<{ title: string; type: ReportInfo['sections'][number]['type'] }>;
}
export interface ReportRuntimeEvent {
  sequence: number;
  timestamp: string;
  action: 'report_start' | 'planning_complete' | 'section_start' | 'tool_call' | 'tool_result' | 'section_complete' | 'report_complete' | 'error';
  section_index?: number;
  message: string;
  details?: { tool_name?: ReportToolName; parameters?: Record<string, unknown>; result?: ReportToolResult; content?: string };
}
export interface ReportRuntimeRecord extends ReportInfo {
  locale?: 'zh' | 'en';
  outline: ReportOutline | null;
  graph_identity: MiroFishGraphArtifactIdentity;
  source_authority: string;
  stage: 'pending' | 'planning' | 'generating' | 'assembling' | 'completed' | 'failed';
  progress: number;
  current_section: number | null;
  events: ReportRuntimeEvent[];
  event_count: number;
  markdown_content: string;
  error_code?: string;
  recoverable?: boolean;
  model_calls: number;
  model_input_characters: number;
  model_output_characters: number;
}
export const MIROFISH_REPORT_LIMITS = Object.freeze({
  sections: 8, sectionCharacters: 16_000, events: 160,
  toolsPerSection: 5, sectionIterations: 6, toolsPerChat: 2,
  modelCalls: 100, modelInputCharacters: 1_000_000, modelOutputCharacters: 500_000,
  taskTimeoutMs: 50 * 60_000, modelTimeoutMs: 300_000,
  questionCharacters: 2_000, historyMessages: 40, selectedAgents: 10,
});
export class MiroFishReportError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 409) {
    super(message); this.name = 'MiroFishReportError'; this.code = code; this.status = status;
  }
}
export function safeReportError(error: unknown): MiroFishReportError {
  if (error instanceof MiroFishReportError) return error;
  // Transport errors are wrapped by the neutral model client. Inspect only
  // bounded stable codes, never provider messages, prompts or credentials.
  const codes = new Set<string>();
  const names = new Set<string>();
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current);
    const cause = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof cause.code === 'string') codes.add(cause.code);
    if (typeof cause.name === 'string') names.add(cause.name);
    current = cause.cause;
  }
  if (codes.has('PROVIDER_QUEUE_TIMEOUT')) return new MiroFishReportError('MIROFISH_REPORT_MODEL_QUEUE_TIMEOUT', '模型队列等待超时，请稍后恢复报告生成。', 503);
  if (codes.has('PROVIDER_QUEUE_FULL')) return new MiroFishReportError('MIROFISH_REPORT_MODEL_BUSY', '模型队列已满，请稍后恢复报告生成。', 503);
  if (names.has('TimeoutError') || codes.has('ETIMEDOUT') || codes.has('UND_ERR_CONNECT_TIMEOUT') || codes.has('UND_ERR_HEADERS_TIMEOUT') || codes.has('UND_ERR_BODY_TIMEOUT')) {
    return new MiroFishReportError('MIROFISH_REPORT_MODEL_TIMEOUT', '模型请求超时，请检查模型服务后恢复报告生成。', 504);
  }
  if (names.has('AbortError')) return new MiroFishReportError('MIROFISH_REPORT_CANCELLED', '模型请求已取消，可恢复报告生成。');
  if (codes.has('MODEL_RESPONSE_INVALID')) return new MiroFishReportError('MIROFISH_REPORT_MODEL_RESPONSE_INVALID', '模型未返回可用的文本响应，请重试。', 502);
  if (codes.has('MODEL_INVOCATION_FAILED')) return new MiroFishReportError('MIROFISH_REPORT_MODEL_UNAVAILABLE', '模型请求失败，请检查模型服务后恢复报告生成。', 503);
  return new MiroFishReportError('MIROFISH_REPORT_OPERATION_FAILED', '报告操作失败，请检查模型服务后重试。', 503);
}
export function boundedQuestion(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MIROFISH_REPORT_LIMITS.questionCharacters) {
    throw new MiroFishReportError('MIROFISH_INTERACTION_INVALID_QUESTION', '问题必须为 1–2000 字的文本。', 400);
  }
  return value.trim();
}
export function publicReportId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) {
    throw new MiroFishReportError('MIROFISH_REPORT_INVALID_ID', '报告或模拟标识无效。', 400);
  }
  return value;
}

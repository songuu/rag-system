import { routeConversation } from './conversation-router';
import type { ConversationAction, ConversationIntent, ConversationRouteDecision } from './conversation-router';
import { calculateExpression } from './local-calculator';

export type AnswerProcessingStatus =
  | 'pending'
  | 'active'
  | 'completed'
  | 'skipped'
  | 'failed';

export interface AnswerProcessingStep {
  id: string;
  label: string;
  detail: string;
  status: AnswerProcessingStatus;
  durationMs?: number;
}

export interface AnswerProcessingDetails {
  version: 'answer-processing/v1';
  mode: 'direct' | 'rag';
  summary: string;
  disclosure: string;
  retrievalSkipped: boolean;
  totalDurationMs?: number;
  steps: AnswerProcessingStep[];
}

export type DirectConversationIntent = ConversationIntent;

export interface DirectConversationClassification {
  intent: DirectConversationIntent;
  normalizedQuery: string;
  routing: ConversationRouteDecision;
}

interface PublicExecutionTransition {
  from?: unknown;
  to?: unknown;
  at?: unknown;
}

interface PublicLaneExecution {
  laneId?: unknown;
  retriever?: unknown;
  status?: unknown;
  latencyMs?: unknown;
}

const PROCESS_DISCLOSURE =
  '这里展示可验证的处理阶段、是否检索及耗时，不展示模型内部的隐藏推理文本。';

const WORKFLOW_STEP_LABELS: Readonly<Record<string, string>> = {
  retrieve_original: '检索候选文档',
  retrieve_after_rewrite: '按优化问题重新检索',
  agent_model_request_tool: '规划检索步骤',
  read_scoped_rag_context: '读取授权范围内资料',
  agent_model_answer: '生成基于证据的回答',
  query_analysis: '分析问题',
  rerank: '重排候选文档',
  generate: '生成回答',
};

export function classifyDirectConversation(
  query: string
): DirectConversationClassification | null {
  const routing = routeConversation(query);
  return routing.route === 'direct'
    ? { intent: routing.actions[0].intent, normalizedQuery: routing.normalizedQuery, routing }
    : null;
}

export function createDirectConversationReply(
  query: string,
  now: Date = new Date(),
  runtime: { llmModel?: string } = {},
  validatedRouting?: ConversationRouteDecision
): {
  intent: DirectConversationIntent;
  answer: string;
  processing: AnswerProcessingDetails;
  routing: ConversationRouteDecision;
  answerSources: string[];
} | null {
  const classification = validatedRouting?.route === 'direct' && validatedRouting.actions.length > 0
    ? { intent: validatedRouting.actions[0].intent, normalizedQuery: validatedRouting.normalizedQuery, routing: validatedRouting }
    : classifyDirectConversation(query);
  if (!classification) return null;
  const needsClarification = classification.routing.actions.some(action => action.intent === 'clarification');

  return {
    intent: classification.intent,
    answer: classification.routing.actions.map(action =>
      directAnswer(action, classification.normalizedQuery, now, runtime)).join('\n'),
    routing: classification.routing,
    answerSources: [...new Set(classification.routing.actions.map(action => actionSource(action)))],
    processing: {
      version: 'answer-processing/v1',
      mode: 'direct',
      summary: needsClarification ? '问题中的指代对象尚未明确，已请求澄清。' : '已识别为日常对话，无需查询知识库。',
      disclosure: PROCESS_DISCLOSURE,
      retrievalSkipped: true,
      steps: [
        {
          id: 'classify',
          label: '识别问题类型',
          detail: (classification.routing.reason === 'semantic-capabilities' ? '使用轻量模型识别能力，参数已通过服务端校验。' : '')
            + classification.routing.actions.map(action => directIntentDetail(action.intent)).join(' '),
          status: 'completed',
        },
        {
          id: 'route',
          label: '知识库检索',
          detail: needsClarification ? '先确认指代对象，暂不检索，以免匹配无关资料。' : '该消息不需要文档事实，已跳过向量检索和重排。',
          status: 'skipped',
        },
        {
          id: 'respond',
          label: needsClarification ? '请求澄清' : '生成直接回复',
          detail: [...new Set(classification.routing.actions.map(action => actionDetail(action)))].join(' '),
          status: 'completed',
        },
      ],
    },
  };
}

export function createPendingAnswerProcessing(
  query: string
): AnswerProcessingDetails {
  const direct = classifyDirectConversation(query);
  if (direct) {
    const needsClarification = direct.routing.actions.some(action => action.intent === 'clarification');
    return {
      version: 'answer-processing/v1',
      mode: 'direct',
      summary: needsClarification ? '问题中的指代对象尚未明确，正在准备澄清。' : '已识别为日常对话，正在组织直接回复。',
      disclosure: PROCESS_DISCLOSURE,
      retrievalSkipped: true,
      steps: [
        {
          id: 'classify',
          label: '识别问题类型',
          detail: direct.routing.actions.map(action => directIntentDetail(action.intent)).join(' '),
          status: 'completed',
        },
        {
          id: 'route',
          label: '知识库检索',
          detail: needsClarification ? '先确认指代对象，暂不检索，以免匹配无关资料。' : '无需文档事实，跳过知识库检索。',
          status: 'skipped',
        },
        {
          id: 'respond',
          label: '生成直接回复',
          detail: '正在准备简洁回复。',
          status: 'active',
        },
      ],
    };
  }

  return {
    version: 'answer-processing/v1',
    mode: 'rag',
    summary: '正在分析问题并选择知识库处理路径。',
    disclosure: PROCESS_DISCLOSURE,
    retrievalSkipped: false,
    steps: [
      {
        id: 'classify',
        label: '分析问题',
        detail: '正在判断检索范围与回答方式。',
        status: 'active',
      },
      {
        id: 'retrieve',
        label: '检索并验证资料',
        detail: '等待问题分析完成后执行。',
        status: 'pending',
      },
      {
        id: 'generate',
        label: '组织回答',
        detail: '等待可用证据后执行。',
        status: 'pending',
      },
    ],
  };
}

export function createRagAnswerProcessing(input: {
  transitions: readonly PublicExecutionTransition[];
  laneExecutions?: readonly PublicLaneExecution[];
  evidenceCount: number;
}): AnswerProcessingDetails {
  const transitions = input.transitions.filter(isPublicTransition);
  const retrievalStartedAt = findTransitionTime(transitions, 'retrieving');
  const evidenceReadyAt =
    findTransitionTime(transitions, 'evidence_ready')
    ?? findCompletedTransitionTime(transitions, 'retrieving');
  const generationStartedAt = findTransitionTime(transitions, 'generating');
  const completedAt = findTransitionTime(transitions, 'completed');
  const steps: AnswerProcessingStep[] = [
    {
      id: 'route',
      label: '选择处理路径',
      detail: '已选择知识库检索路径。',
      status: 'completed',
    },
    {
      id: 'retrieve',
      label: '检索并验证资料',
      detail: input.evidenceCount > 0
        ? `已获得 ${input.evidenceCount} 条可用于回答的证据。`
        : '未获得满足条件的知识库证据。',
      status: 'completed',
      ...durationProperty(retrievalStartedAt, evidenceReadyAt),
    },
  ];

  const rerankLane = input.laneExecutions?.find(lane => {
    const laneId = typeof lane.laneId === 'string' ? lane.laneId : '';
    const retriever = typeof lane.retriever === 'string' ? lane.retriever : '';
    return laneId.toLowerCase().includes('rerank')
      || retriever.toLowerCase().includes('rerank');
  });
  if (rerankLane) {
    steps.push({
      id: 'rerank',
      label: '重排候选文档',
      detail: rerankLane.status === 'completed'
        ? '已按相关性重新排序候选资料。'
        : '当前请求未应用文档重排。',
      status: rerankLane.status === 'completed' ? 'completed' : 'skipped',
      ...(typeof rerankLane.latencyMs === 'number' && rerankLane.latencyMs >= 0
        ? { durationMs: Math.round(rerankLane.latencyMs) }
        : {}),
    });
  }

  steps.push({
    id: 'generate',
    label: '组织回答',
    detail: generationStartedAt === undefined
      ? '证据不足时返回明确说明，不编造知识库内容。'
      : '已基于筛选后的资料生成回答。',
    status: 'completed',
    ...durationProperty(generationStartedAt, completedAt),
  });

  const totalStartedAt = retrievalStartedAt;
  return {
    version: 'answer-processing/v1',
    mode: 'rag',
    summary: input.evidenceCount > 0
      ? `已检索并验证 ${input.evidenceCount} 条证据后生成回答。`
      : '知识库证据不足，已按无法可靠作答处理。',
    disclosure: PROCESS_DISCLOSURE,
    retrievalSkipped: false,
    ...durationProperty(totalStartedAt, completedAt, 'totalDurationMs'),
    steps,
  };
}

export function resolveAnswerProcessing(input: unknown): AnswerProcessingDetails | null {
  if (!isRecord(input)) return null;
  if (isAnswerProcessingDetails(input.processing)) return input.processing;

  const workflow = isRecord(input.workflow) ? input.workflow : null;
  if (!workflow || !Array.isArray(workflow.steps)) return null;
  const steps = workflow.steps.flatMap((rawStep, index): AnswerProcessingStep[] => {
    if (!isRecord(rawStep)) return [];
    const rawName = typeof rawStep.step === 'string'
      ? rawStep.step
      : typeof rawStep.name === 'string'
        ? rawStep.name
        : '';
    if (!rawName) return [];
    const normalizedName = rawName.trim();
    const durationMs = typeof rawStep.duration === 'number' && rawStep.duration >= 0
      ? Math.round(rawStep.duration)
      : undefined;
    return [{
      id: `workflow-${index + 1}`,
      label: publicWorkflowLabel(normalizedName),
      detail: publicWorkflowDetail(normalizedName),
      status: normalizeWorkflowStatus(rawStep.status),
      ...(durationMs === undefined ? {} : { durationMs }),
    }];
  });
  if (steps.length === 0) return null;

  const totalDurationMs = typeof workflow.totalDuration === 'number'
    && workflow.totalDuration >= 0
    ? Math.round(workflow.totalDuration)
    : undefined;
  return {
    version: 'answer-processing/v1',
    mode: 'rag',
    summary: '已完成知识库问答工作流。',
    disclosure: PROCESS_DISCLOSURE,
    retrievalSkipped: false,
    ...(totalDurationMs === undefined ? {} : { totalDurationMs }),
    steps,
  };
}

export function isAnswerProcessingDetails(
  value: unknown
): value is AnswerProcessingDetails {
  if (!isRecord(value)) return false;
  if (value.version !== 'answer-processing/v1') return false;
  if (value.mode !== 'direct' && value.mode !== 'rag') return false;
  if (typeof value.summary !== 'string' || typeof value.disclosure !== 'string') return false;
  if (typeof value.retrievalSkipped !== 'boolean' || !Array.isArray(value.steps)) return false;
  return value.steps.every(step => {
    if (!isRecord(step)) return false;
    return typeof step.id === 'string'
      && typeof step.label === 'string'
      && typeof step.detail === 'string'
      && isProcessingStatus(step.status)
      && (step.durationMs === undefined
        || (typeof step.durationMs === 'number' && step.durationMs >= 0));
  });
}

function directAnswer(action: ConversationAction, normalizedQuery: string, now: Date, runtime: { llmModel?: string }): string {
  const intent = action.intent;
  const english = /^[\x00-\x7F]+$/u.test(normalizedQuery) && /[a-z]/iu.test(normalizedQuery);
  if (intent === 'clarification') {
    const reference = normalizedQuery.match(/他们|她们|它们|他|她|它/u)?.[0];
    return english ? 'Which person or object do you mean? Please provide a name or quote the relevant sentence so I can check the knowledge base.'
      : `你说的${reference ? '“' + reference + '”' : '对象'}具体指谁或什么？请补充姓名、名称，或引用相关原文，我再根据知识库核实。`;
  }
  if ('timeZone' in action) {
    // Relative dates shift the requested zone's calendar, not a fixed 24h
    // duration: DST transitions otherwise move late-night queries by a day.
    let calendar = now;
    if (action.dayOffset !== 0) {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: action.timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
      }).formatToParts(now);
      const part = (type: string) => Number(parts.find(value => value.type === type)?.value);
      calendar = new Date(Date.UTC(part('year'), part('month') - 1, part('day') + action.dayOffset, 12));
    }
    const date = new Intl.DateTimeFormat(english ? 'en-US' : 'zh-CN', {
      timeZone: action.dayOffset === 0 ? action.timeZone : 'UTC',
      year: 'numeric', month: 'long', day: 'numeric',
      ...(intent === 'current-weekday' ? { weekday: 'long' } as const : {}),
      ...(intent === 'current-time' || intent === 'current-datetime' ? {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      } as const : {}),
    }).format(calendar);
    const zoneLabel = english && action.timeZone === 'Asia/Shanghai' ? 'China Standard Time' : action.zoneLabel;
    const dayLabel = action.dayOffset === -1 ? (english ? 'Yesterday' : '昨天')
      : action.dayOffset === 1 ? (english ? 'Tomorrow' : '明天') : (english ? 'Today' : '今天');
    return english ? `${dayLabel}: ${date} (${zoneLabel}).`
      : `${intent === 'current-time' || intent === 'current-datetime' ? '现在' : dayLabel}是${date}（${zoneLabel}）。`;
  }
  if (action.intent === 'calculation') {
    const result = calculateExpression(action.expression);
    // Preserve every digit of safe integer results; only round fractional
    // floating-point display noise (for example 0.1 + 0.2).
    if (result.success) return `${action.expression} = ${Number.isSafeInteger(result.value)
      ? result.value : Number(result.value.toPrecision(14))}`;
    const messages = {
      DIVISION_BY_ZERO: english ? 'Division by zero is undefined.' : '不能除以零，请检查算式。',
      INVALID_EXPRESSION: english ? 'Please provide a valid arithmetic expression.' : '算式不完整，请检查数字、运算符和括号。',
      CALCULATION_LIMIT: english ? 'This expression exceeds the local calculator limits.' : '算式超过本地计算器的长度、嵌套或数值范围限制。',
    };
    return messages[result.code];
  }
  if (intent === 'model-info') {
    return runtime.llmModel
      ? (english ? `The selected answer model is ${runtime.llmModel}. This reply is generated by the system without calling that model.`
        : `当前选择的回答模型是 ${runtime.llmModel}。本条回复由系统生成，未调用该模型。`)
      : (english ? 'The selected model must be confirmed by the server configuration.' : '当前模型名称需要由服务端配置确认。');
  }
  if (intent === 'connectivity' || intent === 'live-data') {
    return english
      ? 'This question requires a live internet data source, which this chat has not connected. I cannot verify current weather, news or market data from uploaded documents. You can provide up-to-date material for me to analyze.'
      : '当前问答入口尚未接入实时互联网数据源，无法核实实时天气、新闻或行情。知识库文档不能代替实时数据；你可以提供最新资料供我分析。';
  }
  if (english) {
    switch (intent) {
      case 'thanks':
        return 'You’re welcome! Ask me anytime about the documents in your knowledge base.';
      case 'farewell':
        return 'Goodbye! Come back anytime you want to explore your knowledge base.';
      default:
        return 'Hello! I’m your RAG knowledge-base assistant. Ask me about your uploaded documents, and I’ll retrieve relevant evidence before answering.';
    }
  }

  switch (intent) {
    case 'presence':
      return '在的。你可以直接问我已上传文档中的内容，我会基于相关资料回答。';
    case 'thanks':
      return '不客气！如果还想了解知识库里的内容，继续问我就好。';
    case 'farewell':
      return '再见！需要查阅知识库时，随时回来问我。';
    case 'identity':
      return '我是 RAG 知识库助手。我会检索你有权访问的文档，并基于相关证据回答问题。';
    case 'capability':
      return '我可以检索已上传的文档、筛选相关证据并回答问题；你也可以展开“处理过程”查看本次是否检索以及各阶段耗时。';
    default:
      return '你好！我是 RAG 知识库助手。你可以直接问我已上传文档中的内容，我会先判断是否需要检索，再基于相关资料回答。';
  }
}

function directIntentDetail(intent: DirectConversationIntent): string {
  const labels: Record<DirectConversationIntent, string> = {
    clarification: '问题缺少明确的指代对象，需要先澄清。',
    greeting: '识别为问候。',
    presence: '识别为在线确认。',
    thanks: '识别为感谢。',
    farewell: '识别为告别。',
    identity: '识别为助手身份询问。',
    capability: '识别为助手能力询问。',
    'current-date': '识别为当前日期询问。',
    'current-time': '识别为当前时间询问。',
    'current-weekday': '识别为星期询问。',
    'current-datetime': '识别为日期与时间询问。',
    'calculation': '识别为独立算术计算。',
    'model-info': '识别为当前模型配置询问。',
    'connectivity': '识别为实时查询能力询问。',
    'live-data': '识别为实时外部信息询问。',
  };
  return labels[intent];
}

function actionSource(action: ConversationAction): string {
  if (action.intent === 'clarification') return 'clarification-rule';
  if ('timeZone' in action) return 'system-clock';
  if (action.intent === 'calculation') return 'local-calculator';
  if (action.intent === 'model-info') return 'runtime-config';
  if (action.intent === 'connectivity' || action.intent === 'live-data') return 'capability-notice';
  return 'assistant';
}

function actionDetail(action: ConversationAction): string {
  if (action.intent === 'clarification') return '请求补充姓名、名称或相关原文，再核实文档事实。';
  if ('timeZone' in action) return `读取系统时钟并按${action.zoneLabel}回复${action.intent === 'current-time' ? '当前时间' : '日期/星期信息'}。`;
  if (action.intent === 'calculation') return '使用受限算术语法计算，不调用模型。';
  if (action.intent === 'model-info') return '读取当前请求经服务端验证的模型选择。';
  if (action.intent === 'connectivity' || action.intent === 'live-data') return '说明实时数据源尚未接入，未生成未经验证的实时信息。';
  return '使用简洁的助手回复，不引用知识库内容。';
}

function isPublicTransition(value: PublicExecutionTransition): value is {
  from?: unknown;
  to: string;
  at: string;
} {
  return typeof value.to === 'string'
    && typeof value.at === 'string'
    && Number.isFinite(Date.parse(value.at));
}

function findTransitionTime(
  transitions: readonly { to: string; at: string }[],
  to: string
): number | undefined {
  const match = transitions.find(transition => transition.to === to);
  return match ? Date.parse(match.at) : undefined;
}

function findCompletedTransitionTime(
  transitions: readonly { from?: unknown; to: string; at: string }[],
  from: string
): number | undefined {
  const match = transitions.find(transition => (
    transition.from === from && transition.to === 'completed'
  ));
  return match ? Date.parse(match.at) : undefined;
}

function durationProperty(
  startedAt: number | undefined,
  completedAt: number | undefined,
  key: 'durationMs' | 'totalDurationMs' = 'durationMs'
): { durationMs?: number; totalDurationMs?: number } {
  if (startedAt === undefined || completedAt === undefined) return {};
  return { [key]: Math.max(0, Math.round(completedAt - startedAt)) };
}

function publicWorkflowLabel(step: string): string {
  const normalized = step.trim().toLowerCase();
  if (WORKFLOW_STEP_LABELS[normalized]) return WORKFLOW_STEP_LABELS[normalized];
  if (/检索|retrieve|search/u.test(normalized)) return '检索候选文档';
  if (/重排|rerank|grade/u.test(normalized)) return '验证资料相关性';
  if (/生成|回答|answer|generate/u.test(normalized)) return '生成基于证据的回答';
  if (/分析|解析|plan|route/u.test(normalized)) return '分析问题并选择路径';
  return '执行问答步骤';
}

function publicWorkflowDetail(step: string): string {
  const normalized = step.trim().toLowerCase();
  if (/检索|retrieve|search/u.test(normalized)) return '在授权范围内查找候选资料。';
  if (/重排|rerank|grade/u.test(normalized)) return '验证并排序候选资料。';
  if (/生成|回答|answer|generate/u.test(normalized)) return '基于可用资料组织回答。';
  if (/分析|解析|plan|route/u.test(normalized)) return '分析问题并确定处理路径。';
  return '已完成一个可审计的问答工作流步骤。';
}

function normalizeWorkflowStatus(value: unknown): AnswerProcessingStatus {
  if (value === 'completed' || value === 'success') return 'completed';
  if (value === 'failed' || value === 'error') return 'failed';
  if (value === 'running' || value === 'active') return 'active';
  if (value === 'skipped') return 'skipped';
  return 'pending';
}

function isProcessingStatus(value: unknown): value is AnswerProcessingStatus {
  return value === 'pending'
    || value === 'active'
    || value === 'completed'
    || value === 'skipped'
    || value === 'failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

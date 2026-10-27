export const CONVERSATION_ROUTER_VERSION = 'conversation-router/v1' as const;

export type SocialIntent = 'greeting' | 'presence' | 'thanks' | 'farewell' | 'identity' | 'capability';
export type ClockIntent = 'current-date' | 'current-time' | 'current-weekday' | 'current-datetime';
export type ConversationIntent = SocialIntent | ClockIntent | 'calculation' | 'model-info' | 'connectivity' | 'live-data' | 'clarification';
export type ConversationAction =
  | { intent: SocialIntent | 'model-info' | 'connectivity' | 'clarification' }
  | { intent: ClockIntent; timeZone: string; zoneLabel: string; dayOffset: number }
  | { intent: 'calculation'; expression: string }
  | { intent: 'live-data'; topic: 'weather' | 'news' | 'market' };
export interface ConversationRouteDecision {
  version: typeof CONVERSATION_ROUTER_VERSION;
  route: 'direct' | 'rag';
  reason: 'supported-capabilities' | 'semantic-capabilities' | 'document-context' | 'uncertain' | 'complex-query' | 'missing-referent';
  normalizedQuery: string;
  actions: ConversationAction[];
}

const SOCIAL_RULES: ReadonlyArray<{ intent: SocialIntent; pattern: RegExp }> = [
  { intent: 'greeting', pattern: /^(?:你好|您好|你好吗|最近怎么样|嗨|哈喽|早|hello|hi|hey|yo|how are you|how are things|早上好|下午好|晚上好|早安|午安|晚安|good morning|good afternoon|good evening)(?:呀|啊|哈|哇|哦|喽)?$/iu },
  { intent: 'presence', pattern: /^(?:在吗|你在吗|在不在|有人吗|在不在线)$/u },
  { intent: 'thanks', pattern: /^(?:谢谢|谢谢你|感谢|感谢你|多谢|thanks|thank you|thank you so much)(?:啦|了|呀|啊)?$/iu },
  { intent: 'farewell', pattern: /^(?:再见|拜拜|回头见|bye|goodbye|see you)(?:啦|了|呀|啊)?$/iu },
  { intent: 'identity', pattern: /^(?:你是谁|你叫什么|你叫什么名字|介绍(?:一下)?(?:你)?自己|who are you|introduce yourself)$/iu },
  { intent: 'capability', pattern: /^(?:你(?:能|可以|会)(?:帮我)?做什么|你有什么功能|你有哪些功能|怎么使用你|怎么用你|what can you do|what are your capabilities)$/iu },
];
const ZONES: ReadonlyArray<{ aliases: string; timeZone: string; label: string }> = [
  { aliases: '北京|上海|中国|beijing|shanghai|china', timeZone: 'Asia/Shanghai', label: '北京时间' },
  { aliases: '东京|日本|tokyo|japan', timeZone: 'Asia/Tokyo', label: '东京时间' },
  { aliases: '伦敦|london', timeZone: 'Europe/London', label: '伦敦时间' },
  { aliases: '纽约|new york', timeZone: 'America/New_York', label: '纽约时间' },
  { aliases: 'utc|世界协调时间', timeZone: 'UTC', label: 'UTC' },
];

export function routeConversation(query: string): ConversationRouteDecision {
  const normalizedQuery = normalize(query);
  const base = { version: CONVERSATION_ROUTER_VERSION, normalizedQuery };
  const fallback = (reason: ConversationRouteDecision['reason']): ConversationRouteDecision =>
    ({ ...base, route: 'rag', reason, actions: [] });
  if (!normalizedQuery || normalizedQuery.length > 512) return fallback('complex-query');
  // This endpoint receives one question, not an authenticated conversation history.
  // Vector similarity cannot establish who an otherwise unnamed pronoun refers to.
  if (isUnresolvedReference(unwrap(normalizedQuery))) {
    return { ...base, route: 'direct', reason: 'missing-referent', actions: [{ intent: 'clarification' }] };
  }
  // Explicit document scope and explanatory questions win over topic words.
  // Otherwise "the time in this report" could silently lose its corpus scope.
  if (/(?:文档|知识库|附件|报告|原文|文中|章节|第.{0,3}章|历史|含义|定义|原因|原理|为什么|document|report|uploaded|knowledge base|according to|explain|summari[sz]e)/iu.test(normalizedQuery)) {
    return fallback('document-context');
  }
  const wholeAction = parseAction(normalizedQuery);
  if (wholeAction) return { ...base, route: 'direct', reason: 'supported-capabilities', actions: [wholeAction] };
  const clauses = normalizedQuery.split(/[,，;；。！？!?]+|\s+(?:and|then)\s+|(?:以及|然后|并且)/iu)
    .map(part => part.trim()).filter(Boolean);
  if (clauses.length > 6) return fallback('complex-query');
  const actions: ConversationAction[] = [];
  for (const clause of clauses) {
    const action = parseAction(clause);
    // No partial fast answer: every remaining clause must have an executor.
    if (!action) return fallback('uncertain');
    actions.push(action);
  }
  return actions.length
    ? { ...base, route: 'direct', reason: actions.some(action => action.intent === 'clarification') ? 'missing-referent' : 'supported-capabilities', actions }
    : fallback('uncertain');
}

function normalize(query: string): string {
  return query.normalize('NFKC').toLowerCase().replace(/[’‘]/gu, "'")
    .replace(/\s+/gu, ' ').trim().replace(/[。！？!?，,;；.~～…👋🙂😊]+$/gu, '').trim();
}

function unwrap(query: string): string {
  let text = query;
  for (let pass = 0; pass < 3; pass++) {
    text = text.replace(/^(?:麻烦(?:你)?(?:告诉我)?|请(?:问|告诉我|帮我|给我|提供)?|能否告诉我|能(?:不能)?(?:告诉我|说说)|可以告诉我|我想知道|想问(?:一下)?|告诉我|给我|帮我(?:查询一下|查一下|算一下)?|please\s+|(?:can|could) you (?:please )?(?:tell|show|give) me\s+|i (?:want|need|would like) to know\s+|(?:tell|show|give) me\s+)[,，\s]*/iu, '').trim();
  }
  return text.replace(/^(.+?)[,，\s]*(?:谢谢(?:你)?|please)$/iu, '$1')
    .replace(/[呢呀啊嘛吧]+$/u, '').replace(/[。！？!?，,]+$/gu, '').trim();
}

function parseAction(query: string): ConversationAction | null {
  const text = unwrap(query);
  if (isUnresolvedReference(text)) return { intent: 'clarification' };
  for (const rule of SOCIAL_RULES) if (rule.pattern.test(text)) return { intent: rule.intent };
  // These ask for an explanation, even when the final word names a live topic.
  if (/^(?:怎么|如何|怎样|什么是|介绍|解释|分析|预测|讨论|研究|how to\b)/iu.test(text)) return null;
  if (/^(?:你(?:用的?|使用的?)?(?:是)?(?:什么|哪个)模型|当前(?:使用的)?模型(?:名称)?(?:是)?(?:什么|哪个)|what model are you using|which model are you using)$/iu.test(text)) return { intent: 'model-info' };
  if (/^(?:你(?:能|可以)(?:联网|上网|查询实时信息)吗|你(?:有|是否有)联网功能|can you (?:browse|access the internet)|do you have internet access)$/iu.test(text)) return { intent: 'connectivity' };
  const clock = parseClock(text);
  if (clock) return clock;
  const expression = text.replace(/^(?:计算(?:一下)?|算一下|what(?: is|'s)\s+|calculate\s+)/iu, '')
    .replace(/(?:等于多少|是多少|的结果|=\s*\?)$/u, '')
    .replace(/(?:加上?|plus)/giu, '+').replace(/(?:减去?|minus)/giu, '-')
    .replace(/(?:乘以?|times|×)/giu, '*').replace(/(?<=[\d)])\s*x\s*(?=[\d(])/giu, '*')
    .replace(/(?:除以?|divided by|÷)/giu, '/').replace(/\s+/gu, '');
  if (/^[\d.()+*/%-]+$/u.test(expression) && /[+*/%-]/u.test(expression)) {
    return { intent: 'calculation', expression };
  }
  if (/^(?:(?:今天|现在|当前|明天|后天|周末)(?:的)?)?[\p{Script=Han}a-z ]{0,16}天气(?:怎么样|如何|预报|情况|好吗)?$/iu.test(text)
    || /^(?:what(?: is|'s)|how(?: is|'s)) (?:the )?weather(?: like)?(?: (?:right now|today|in [a-z ]{1,30}))?$/iu.test(text)) return { intent: 'live-data', topic: 'weather' };
  if (/^(?:今天的?|最新|当前|实时)(?:新闻|新闻头条|热点新闻)(?:是什么|有哪些)?$/u.test(text)) return { intent: 'live-data', topic: 'news' };
  if (/^(?:今天|现在|当前|实时|最新)[\p{Script=Han}a-z\d.-]{0,24}(?:汇率|股价|股票价格|币价)(?:是多少|怎么样)?$/iu.test(text)) return { intent: 'live-data', topic: 'market' };
  return null;
}

function isUnresolvedReference(text: string): boolean {
  // Full short clauses only: do not swallow a second question or a quoted work title.
  return /^(?:他们|她们|它们|他|她|它)(?:是|叫|有|的|在|到|从|出生|去世|死|何时|什么时候|怎么|如何|为什么|为啥|能|会|做|参加|经历|领导|管理|建立|属于|住|活|成为|曾经|指|和)[^,，;；。！？!?]{0,120}$/u.test(text)
    || /^(?:who is (?:he|she)|who are they|what is it|where (?:did (?:he|she|they) die|was (?:he|she) born)|what did (?:he|she|they) do)$/iu.test(text);
}

function parseClock(input: string): Extract<ConversationAction, { timeZone: string }> | null {
  let text = input;
  let zone = ZONES[0];
  for (const candidate of ZONES) {
    const prefix = new RegExp(`^(现在)?(?:in )?(${candidate.aliases})(?:时间)?[,，\\s]*`, 'iu');
    const suffix = new RegExp(`\\s+(?:in|at) (${candidate.aliases})$`, 'iu');
    if (prefix.test(text)) {
      text = text.replace(prefix, '$1').trim(); zone = candidate; break;
    }
    if (suffix.test(text)) {
      text = text.replace(suffix, '').trim(); zone = candidate; break;
    }
  }
  text = text.replace(/^(?:今儿|今个)/u, '今天')
    .replace(/^(?:此时此刻|此刻|当下|眼下)/u, '现在').replace(/[吗呢啦了]+$/u, '');
  const dayOffset = /^(?:昨天|昨日|yesterday)|\byesterday$/iu.test(text) ? -1
    : /^(?:明天|明日|tomorrow)|\btomorrow$/iu.test(text) ? 1 : 0;
  const clockText = text.replace(/^(?:今天|今日|现在|当前|昨天|昨日|明天|明日|今年)(?:到底|究竟)?(?:是|的)?/u, '')
    .replace(/\b(?:yesterday|tomorrow)$/iu, 'today').trim();
  let intent: ClockIntent | undefined;
  if (dayOffset === 0 && /^(?:日期和时间|日期与时间|date and time)$/iu.test(clockText)) intent = 'current-datetime';
  else if (/^(?:星期几|礼拜几|周几|what day of the week is (?:it|today))$/iu.test(clockText)) intent = 'current-weekday';
  else if (/^(?:日期|什么日期|哪一天|哪天|几号|多少号|几月几[日号]|哪一年|什么年份|是哪一年|什么日子|啥日子|what(?: is|'s) (?:today's date|the (?:current )?date(?: of today)?|the date today)|what date is today|today's date|the (?:current )?date|what year is it|what day is it today)$/iu.test(clockText)) intent = 'current-date';
  else if (dayOffset === 0 && /^(?:时间|时刻|钟点(?:是多少)?|什么时间|啥时间|几点(?:钟)?|报一下时间|报个时|what(?: is|'s) (?:the (?:current )?time|the time now)|what time (?:is it|it is)(?: now)?|the (?:current )?time|current time|what is the current time)$/iu.test(clockText)) intent = 'current-time';
  return intent ? { intent, timeZone: zone.timeZone, zoneLabel: zone.label, dayOffset } : null;
}

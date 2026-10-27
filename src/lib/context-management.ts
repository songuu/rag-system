'use strict';

/**
 * 上下文管理系统 (Context Management System)
 * 
 * 完全基于原生 LangChain 组件实现：
 * - BaseMessage (HumanMessage, AIMessage, SystemMessage) - 消息类型
 * - ChatPromptTemplate, MessagesPlaceholder - 提示模板
 * - StringOutputParser - 输出解析
 * - RunnableSequence, RunnableLambda, RunnableBranch - 链式调用
 * - trimMessages - 消息截断
 * - Document - 文档类型
 * 
 * 已更新为使用统一模型配置系统 (model-config.ts)
 */

import { 
  HumanMessage, 
  AIMessage, 
  SystemMessage, 
  BaseMessage,
  trimMessages,
  getBufferString,
} from '@langchain/core/messages';
import { 
  ChatPromptTemplate, 
  MessagesPlaceholder,
} from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { 
  RunnableSequence, 
  RunnableLambda, 
  RunnableBranch,
} from '@langchain/core/runnables';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Embeddings } from '@langchain/core/embeddings';
import { getMilvusInstance } from './milvus-client';
import {
  createLLM,
  createEmbedding,
  getModelDimension,
  selectModelByDimension,
  getModelFactory,
} from './model-config';
import { getEmbeddingConfigSummary } from './embedding-config';
import * as fs from 'fs';
import * as path from 'path';

// ==================== 类型定义 ====================

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ConversationMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  tokenCount?: number;
}

export interface RetrievedDocument {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface WorkflowStep {
  step: string;
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'error';
  startTime?: number;
  endTime?: number;
  duration?: number;
  details?: Record<string, unknown>;
}

export interface SessionMetadata {
  sessionId: string;
  userId?: string;
  createdAt: number;
  lastActiveAt: number;
  totalTokens: number;
  messageCount: number;
  truncatedCount: number;
  summarizedRounds: number;
}

export interface SessionData {
  metadata: SessionMetadata;
  messages: ConversationMessage[];
  summary?: string;
}

export interface ContextState {
  messages: ConversationMessage[];
  metadata: SessionMetadata;
  summary?: string;
  artifacts: {
    rewrittenQuery?: string;
    retrievedDocuments?: RetrievedDocument[];
  };
  workflowSteps: WorkflowStep[];
}

// SSE 流式输出事件类型
export type StreamEventType = StreamEvent['type'];

export type StreamEvent =
  | { type: 'workflow'; data: { step: WorkflowStep; allSteps: WorkflowStep[] } }
  | { type: 'token'; data: { content: string; fullResponse: string } }
  | { type: 'done'; data: StreamQueryResult }
  | { type: 'error'; data: { error: string; code?: ContextSessionErrorCode } };

export interface StreamQueryResult {
  response: string;
  state: ContextState;
  rewrittenQuery?: string;
  retrievedDocs: RetrievedDocument[];
  workflowSteps: WorkflowStep[];
}

export type WindowStrategy = 'sliding_window' | 'token_limit' | 'hybrid';

export interface WindowConfig {
  strategy: WindowStrategy;
  maxRounds?: number;
  maxTokens?: number;
  preserveSystemPrompt?: boolean;
}

export interface ContextManagerConfig {
  llmModel: string;
  embeddingModel: string;
  milvusCollection: string;
  windowConfig: WindowConfig;
  enableQueryRewriting: boolean;
  maxRetries: number;
  similarityThreshold: number;
  topK: number;
}

// ==================== 默认配置 ====================

/**
 * 获取默认配置，使用统一模型配置系统
 * - LLM 使用 MODEL_PROVIDER
 * - Embedding 使用 EMBEDDING_PROVIDER (独立配置)
 */
function getDefaultConfig(): ContextManagerConfig {
  const factory = getModelFactory();
  const envConfig = factory.getEnvConfig();
  const provider = factory.getProvider();
  
  // Embedding 使用独立配置
  const embeddingConfig = getEmbeddingConfigSummary();
  
  return {
    // LLM 根据 MODEL_PROVIDER 选择
    llmModel: provider === 'ollama' 
      ? envConfig.OLLAMA_LLM_MODEL 
      : envConfig.OPENAI_LLM_MODEL,
    // Embedding 使用独立的 EMBEDDING_PROVIDER 配置
    embeddingModel: embeddingConfig.model,
    milvusCollection: process.env.MILVUS_COLLECTION || 'rag_documents',
    windowConfig: {
      strategy: 'hybrid',
      maxRounds: 10,
      maxTokens: 4000,
      preserveSystemPrompt: true,
    },
    enableQueryRewriting: true,
    maxRetries: 3,
    similarityThreshold: 0.3,
    topK: 5,
  };
}

// 保持向后兼容的默认配置引用
const DEFAULT_CONFIG: ContextManagerConfig = getDefaultConfig();

// ==================== Token 计数器 (用于 trimMessages) ====================

/**
 * 估算文本的 Token 数量
 * 支持中英文混合文本
 */
function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

/**
 * LangChain 兼容的 Token 计数器
 * 用于 trimMessages 函数
 */
async function tokenCounter(messages: BaseMessage[]): Promise<number> {
  return messages.reduce((sum, msg) => {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    return sum + estimateTokens(content);
  }, 0);
}

// ==================== 工具函数 ====================

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function createStep(name: string): WorkflowStep {
  return { step: name, status: 'running', startTime: Date.now() };
}

function completeStep(step: WorkflowStep, details?: Record<string, unknown>): WorkflowStep {
  return {
    ...step,
    status: 'completed',
    endTime: Date.now(),
    duration: Date.now() - (step.startTime || Date.now()),
    details,
  };
}

// ==================== 消息转换工具 (LangChain BaseMessage) ====================

/**
 * 将自定义消息格式转换为 LangChain BaseMessage
 */
function toBaseMessages(messages: ConversationMessage[]): BaseMessage[] {
  return messages.map(msg => {
    switch (msg.role) {
      case 'user':
        return new HumanMessage({ content: msg.content, id: msg.id });
      case 'assistant':
        return new AIMessage({ content: msg.content, id: msg.id });
      case 'system':
        return new SystemMessage({ content: msg.content, id: msg.id });
      default:
        return new HumanMessage({ content: msg.content, id: msg.id });
    }
  });
}

/**
 * 将 LangChain BaseMessage 转换为自定义消息格式
 */
function fromBaseMessage(msg: BaseMessage, timestamp: number): ConversationMessage {
  let role: MessageRole = 'user';
  if (msg._getType() === 'ai') role = 'assistant';
  else if (msg._getType() === 'system') role = 'system';
  
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  
  return {
    id: (msg.id as string) || `${timestamp}-${role}`,
    role,
    content,
    timestamp,
    tokenCount: estimateTokens(content),
  };
}

// ==================== 文件持久化 ====================

const DATA_DIR = 'data/context-sessions';

type ContextSessionErrorCode = 'CONTEXT_SESSION_ID_INVALID' | 'CONTEXT_SESSION_STORAGE_UNSAFE';

export class ContextSessionError extends Error {
  readonly status: 400 | 503;

  constructor(readonly code: ContextSessionErrorCode) {
    super(code === 'CONTEXT_SESSION_ID_INVALID'
      ? 'Invalid context session ID.'
      : 'Context session storage failed its safety checks.');
    this.name = 'ContextSessionError';
    this.status = code === 'CONTEXT_SESSION_ID_INVALID' ? 400 : 503;
  }
}

export function assertContextSessionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) {
    throw new ContextSessionError('CONTEXT_SESSION_ID_INVALID');
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function unsafeSessionStorage(): never {
  // Do not expose the caller's ID, absolute path or native error in API responses.
  throw new ContextSessionError('CONTEXT_SESSION_STORAGE_UNSAFE');
}

function sessionPathStat(filename: string): fs.BigIntStats | undefined {
  try {
    return fs.lstatSync(filename, { bigint: true });
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    return unsafeSessionStorage();
  }
}

function checkSessionDirectory(candidate: string): void {
  const stat = sessionPathStat(candidate);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()
    || path.relative(candidate, fs.realpathSync(candidate)) !== '') unsafeSessionStorage();
}

function sessionDirectory(): string {
  try {
    // Keep path construction scoped to the runtime store, not the project root.
    // cwd is trusted configuration; canonical store checks below reject aliases.
    const root = process.cwd();
    // Private session state is runtime data, never a static release asset.
    const directory = path.resolve(/*turbopackIgnore: true*/ root, DATA_DIR);
    // Explicit calls retain data-scoped inputs in Turbopack's file analysis;
    // a loop variable here makes it collect the entire project as assets.
    checkSessionDirectory(path.join(/*turbopackIgnore: true*/ root, 'data'));
    checkSessionDirectory(directory);
    return directory;
  } catch {
    return unsafeSessionStorage();
  }
}

function ensureDataDir(): string {
  const directory = sessionDirectory();
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch {
    return unsafeSessionStorage();
  }
  if (sessionDirectory() !== directory) unsafeSessionStorage();
  return directory;
}

function getFilePath(sessionId: string): string {
  // Validate before even querying filesystem metadata for untrusted IDs.
  assertContextSessionId(sessionId);
  const directory = sessionDirectory();
  const filename = path.resolve(directory, `${sessionId}.json`);
  if (path.relative(directory, filename) !== `${sessionId}.json`) unsafeSessionStorage();
  return filename;
}

function checkedSessionFileStat(filename: string): fs.BigIntStats | undefined {
  const stat = sessionPathStat(filename);
  if (stat && (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== BigInt(1) || stat.ino <= BigInt(0))) {
    unsafeSessionStorage();
  }
  return stat;
}

function sameSessionFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function closeSessionFile(fd: number): void {
  try { fs.closeSync(fd); } catch { unsafeSessionStorage(); }
}

function openSessionFile(filename: string, flags: number, expected?: fs.BigIntStats): number {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filename, flags | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    const descriptor = fs.fstatSync(fd, { bigint: true });
    if (!descriptor.isFile() || descriptor.nlink !== BigInt(1) || descriptor.ino <= BigInt(0)
      || (expected && !sameSessionFile(expected, descriptor))) unsafeSessionStorage();
    if (sessionDirectory() !== path.dirname(filename)) unsafeSessionStorage();
    const named = checkedSessionFileStat(filename);
    if (!named || !sameSessionFile(named, descriptor)) unsafeSessionStorage();
    return fd;
  } catch {
    if (fd !== undefined) closeSessionFile(fd);
    return unsafeSessionStorage();
  }
}

function saveSession(data: SessionData): void {
  assertContextSessionId(data.metadata.sessionId);
  const content = JSON.stringify(data, null, 2);
  ensureDataDir();
  const filename = getFilePath(data.metadata.sessionId);
  const expected = checkedSessionFileStat(filename);
  // Existing files must be identified before truncation; new names are exclusive.
  const flags = fs.constants.O_WRONLY | (expected ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL);
  const fd = openSessionFile(filename, flags, expected);
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content, 'utf-8');
  } catch {
    unsafeSessionStorage();
  } finally {
    closeSessionFile(fd);
  }
}

function loadSession(sessionId: string): SessionData | null {
  const filePath = getFilePath(sessionId);
  const expected = checkedSessionFileStat(filePath);
  if (!expected) return null;
  const fd = openSessionFile(filePath, fs.constants.O_RDONLY, expected);
  let content: string;
  try {
    // This is a verified file descriptor, not a build-time filename pattern.
    content = fs.readFileSync(/*turbopackIgnore: true*/ fd, 'utf-8');
  } catch {
    return unsafeSessionStorage();
  } finally {
    closeSessionFile(fd);
  }
  
  try {
    const raw = JSON.parse(content);
    if (raw.metadata?.sessionId) {
      if (raw.metadata.sessionId !== sessionId) unsafeSessionStorage();
      return { metadata: raw.metadata, messages: raw.messages || [], summary: raw.summary };
    } else if (raw.sessionId) {
      if (raw.sessionId !== sessionId) unsafeSessionStorage();
      return { metadata: raw as SessionMetadata, messages: [] };
    }
    return null;
  } catch (error) {
    if (error instanceof ContextSessionError) throw error;
    return null;
  }
}

function listAllSessions(): SessionMetadata[] {
  const fullPath = ensureDataDir();
  const sessions: SessionMetadata[] = [];
  let files: string[];
  try { files = fs.readdirSync(fullPath); } catch { return unsafeSessionStorage(); }
  
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const sessionId = file.slice(0, -5);
    try { assertContextSessionId(sessionId); } catch { continue; }
    try {
      const data = loadSession(sessionId);
      if (data?.metadata) {
        sessions.push({ ...data.metadata, messageCount: data.messages.length });
      }
    } catch (error) {
      if (error instanceof ContextSessionError) throw error;
    }
  }
  
  return sessions.sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
}

function deleteSessionFile(sessionId: string): boolean {
  const filePath = getFilePath(sessionId);
  const expected = checkedSessionFileStat(filePath);
  if (!expected) return false;
  const fd = openSessionFile(filePath, fs.constants.O_RDONLY, expected);
  try {
    // The directory must remain writable only by the server's OS identity.
    // Portable Node unlink is name-based, not atomic against a hostile parent rename.
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return unsafeSessionStorage();
  } finally {
    closeSessionFile(fd);
  }
}

// ==================== 窗口管理器 (使用 LangChain trimMessages) ====================

/**
 * 使用 LangChain 原生 trimMessages 进行消息截断
 */
async function trimMessagesWithLangChain(
  messages: BaseMessage[],
  maxTokens: number,
  strategy: 'last' | 'first' = 'last'
): Promise<BaseMessage[]> {
  try {
    // 使用 LangChain 的 trimMessages 函数
    const trimmed = await trimMessages(messages, {
      maxTokens,
      tokenCounter,
      strategy,
      includeSystem: true,
      allowPartial: false,
      startOn: 'human',
    });
    return trimmed;
  } catch (error) {
    console.error('[trimMessages] Error:', error);
    // 降级到简单截断
    return messages.slice(-Math.floor(maxTokens / 100));
  }
}

/**
 * 对 ConversationMessage 进行窗口截断
 * 内部使用 LangChain trimMessages
 */
async function trimConversationMessages(
  messages: ConversationMessage[],
  config: WindowConfig
): Promise<{ messages: ConversationMessage[]; trimmedCount: number }> {
  const originalCount = messages.length;
  
  // 转换为 BaseMessage
  const baseMessages = toBaseMessages(messages);
  
  // 1. 滑动窗口策略
  let result = baseMessages;
  const maxRounds = config.maxRounds || 10;
  const maxMessages = maxRounds * 2;
  
  if (result.length > maxMessages) {
    const systemMsgs = config.preserveSystemPrompt 
      ? result.filter(m => m._getType() === 'system')
      : [];
    const nonSystemMsgs = result.filter(m => m._getType() !== 'system').slice(-maxMessages);
    result = [...systemMsgs, ...nonSystemMsgs];
  }
  
  // 2. Token 限制策略 (使用 LangChain trimMessages)
  if (config.strategy === 'token_limit' || config.strategy === 'hybrid') {
    const maxTokens = config.maxTokens || 4000;
    result = await trimMessagesWithLangChain(result, maxTokens, 'last');
  }
  
  // 转换回 ConversationMessage
  const now = Date.now();
  const trimmedMessages = result.map((msg, i) => fromBaseMessage(msg, now + i));
  
  return {
    messages: trimmedMessages,
    trimmedCount: originalCount - trimmedMessages.length,
  };
}

// ==================== 查询改写器 (使用 LangChain RunnableSequence) ====================

interface RewriteResult {
  rewrittenQuery: string;
  needsRewrite: boolean;
  reason: string;
}

/**
 * 创建查询改写链 (使用 LangChain 原生组件)
 */
function createRewriteChain(llm: BaseChatModel): RunnableSequence<{ history: string; query: string }, string> {
  const rewritePrompt = ChatPromptTemplate.fromMessages([
    ['system', `你是一个查询改写助手。将用户问题改写为独立完整的问题。

规则：
1. 只补全代词（它、这、那、他、她）和省略的主语
2. 不要添加无关内容
3. 如果问题已完整，原样返回
4. 只输出改写后的问题`],
    ['human', `对话历史:
{history}

当前问题: {query}

改写后:`],
  ]);
  
  return RunnableSequence.from([
    rewritePrompt,
    llm,
    new StringOutputParser(),
  ]);
}

/**
 * 检测话题切换
 */
function detectTopicSwitch(query: string, history: ConversationMessage[]): boolean {
  // 检测苹果双关
  if (query.includes('苹果')) {
    const isFruit = /好吃|味道|水果|哪里的|产地|新鲜|红富士|青苹果/.test(query);
    const historyHasApple = history.some(m => /iPhone|iPad|Mac|苹果手机|iOS/.test(m.content));
    if (isFruit && historyHasApple) return true;
  }
  
  // 检测明确的话题切换词
  return /换个话题|另外问|说点别的|不说这个了/.test(query);
}

/**
 * 检查是否需要改写
 */
function needsRewrite(query: string): boolean {
  const hasPronouns = /^(它|这|那|他|她|前面|上面|上个|刚才)/.test(query);
  const isShort = query.length < 6;
  const hasQuestion = /吗|呢|？|\?$/.test(query);
  return hasPronouns || isShort || (hasQuestion && query.length < 15);
}

/**
 * 执行查询改写
 */
async function rewriteQuery(
  query: string,
  history: ConversationMessage[],
  chain: RunnableSequence<{ history: string; query: string }, string>
): Promise<RewriteResult> {
  // 无历史，不改写
  if (history.length === 0) {
    return { rewrittenQuery: query, needsRewrite: false, reason: '首轮对话' };
  }
  
  // 检测话题切换
  if (detectTopicSwitch(query, history)) {
    return { rewrittenQuery: query, needsRewrite: false, reason: '新话题' };
  }
  
  // 检查是否需要改写
  if (!needsRewrite(query) && query.length > 10) {
    return { rewrittenQuery: query, needsRewrite: false, reason: '查询完整' };
  }
  
  // 构建历史文本 (使用 getBufferString 获取格式化的历史)
  const baseMessages = toBaseMessages(history.slice(-6));
  const historyText = getBufferString(baseMessages, 'User', 'AI');
  
  try {
    const rewritten = await chain.invoke({ history: historyText, query });
    const trimmed = rewritten.trim();
    
    // 验证改写结果
    if (trimmed.length > query.length * 3) {
      return { rewrittenQuery: query, needsRewrite: false, reason: '改写过长' };
    }
    
    const originalKeywords = query.match(/[\u4e00-\u9fff]{2,}/g) || [];
    const hasOriginalContent = originalKeywords.length === 0 || 
      originalKeywords.some(kw => trimmed.includes(kw));
    
    if (!hasOriginalContent) {
      return { rewrittenQuery: query, needsRewrite: false, reason: '改写无效' };
    }
    
    return {
      rewrittenQuery: trimmed,
      needsRewrite: trimmed !== query,
      reason: '已改写',
    };
  } catch (error) {
    console.error('[rewriteQuery] Error:', error);
    return { rewrittenQuery: query, needsRewrite: false, reason: '改写失败' };
  }
}

// ==================== 响应生成器 (使用 LangChain RunnableBranch) ====================

interface GenerateInput {
  query: string;
  rewrittenQuery: string;
  history: BaseMessage[];
  context: string;
  isGreeting: boolean;
}

/**
 * 创建响应生成链 (使用 RunnableBranch 实现条件分支)
 */
function createGenerateChain(llm: BaseChatModel): RunnableSequence<GenerateInput, string> {
  // 问候语提示模板
  const greetingPrompt = ChatPromptTemplate.fromMessages([
    ['system', '你是一个友好的智能助手。请自然地回应用户的问候或问题。保持简洁友好。'],
    new MessagesPlaceholder('history'),
    ['human', '{query}'],
  ]);
  
  // 知识问答提示模板
  const qaPrompt = ChatPromptTemplate.fromMessages([
    ['system', `你是一个智能助手。请根据参考资料回答用户问题。

要求：
1. 如果参考资料中有相关信息，基于资料回答
2. 如果参考资料中没有相关信息，尝试用你的知识回答，但要说明这不是来自资料库
3. 保持回答简洁友好
4. 不要编造不存在的信息

参考资料：
{context}`],
    new MessagesPlaceholder('history'),
    ['human', '{query}'],
  ]);
  
  // 问候语链
  const greetingChain = RunnableSequence.from([
    RunnableLambda.from((input: GenerateInput) => ({
      history: input.history,
      query: input.query,
    })),
    greetingPrompt,
    llm,
    new StringOutputParser(),
  ]);
  
  // 问答链
  const qaChain = RunnableSequence.from([
    RunnableLambda.from((input: GenerateInput) => ({
      history: input.history,
      query: input.rewrittenQuery !== input.query 
        ? `${input.query}（理解为：${input.rewrittenQuery}）`
        : input.query,
      context: input.context,
    })),
    qaPrompt,
    llm,
    new StringOutputParser(),
  ]);
  
  // 使用 RunnableBranch 实现条件分支
  const branchChain = RunnableBranch.from([
    [(input: GenerateInput) => input.isGreeting, greetingChain],
    qaChain, // 默认分支
  ]);
  
  return branchChain as unknown as RunnableSequence<GenerateInput, string>;
}

/**
 * 检测是否为问候语
 */
function isGreeting(query: string): boolean {
  const greetings = [
    /^(你好|您好|hi|hello|hey|嗨|哈喽)/i,
    /^(早上好|下午好|晚上好|早安|晚安)/,
    /^(你是谁|你叫什么|介绍一下你自己)/,
    /^(谢谢|感谢|多谢|辛苦了)/,
    /^(再见|拜拜|bye)/i,
  ];
  return greetings.some(p => p.test(query.trim()));
}

// ==================== 摘要生成链 (使用 LangChain 组件) ====================

/**
 * 创建摘要生成链
 */
function createSummaryChain(llm: BaseChatModel): RunnableSequence<{ conversation: string }, string> {
  const summaryPrompt = ChatPromptTemplate.fromMessages([
    ['system', '你是一个摘要助手。请将以下对话压缩为100-200字的摘要，保留关键信息和主要话题。'],
    ['human', '{conversation}'],
  ]);
  
  return RunnableSequence.from([
    summaryPrompt,
    llm,
    new StringOutputParser(),
  ]);
}

// ==================== 向量检索 (使用 LangChain Embeddings) ====================

/**
 * 执行向量检索
 */
async function retrieveDocuments(
  query: string,
  embeddings: Embeddings,
  collection: string,
  embeddingModel: string,
  topK: number,
  threshold: number
): Promise<RetrievedDocument[]> {
  try {
    const dimension = getModelDimension(embeddingModel);
    let actualEmbeddings = embeddings;
    
    const milvus = getMilvusInstance({
      collectionName: collection,
      embeddingDimension: dimension,
    });
    
    // 自动适配维度
    try {
      await milvus.connect();
      const stats = await milvus.getCollectionStats();
      if (stats?.embeddingDimension && stats.embeddingDimension !== dimension) {
        const model = selectModelByDimension(stats.embeddingDimension);
        // 使用统一配置系统创建 Embedding 模型
        actualEmbeddings = createEmbedding(model);
      }
    } catch { /* use default */ }
    
    // 使用 LangChain embeddings 生成查询向量
    const queryEmbedding = await actualEmbeddings.embedQuery(query);
    const results = await milvus.search(queryEmbedding, topK, threshold);
    
    return results.map(r => ({
      id: r.id || generateId(),
      content: r.content,
      score: r.score,
      metadata: r.metadata,
    }));
  } catch (error) {
    console.error('[retrieveDocuments] Error:', error);
    return [];
  }
}

/**
 * 相关性过滤
 */
function filterRelevantDocuments(docs: RetrievedDocument[], query: string): RetrievedDocument[] {
  if (docs.length === 0) return [];
  
  // 提取关键词
  const patterns = [
    /(?:华为|苹果|小米|三星)[A-Za-z0-9\u4e00-\u9fff]+/g,
    /(?:iPhone|iPad|MacBook|Mate|Galaxy)[A-Za-z0-9\s]*/gi,
    /版本|价格|配置|参数|续航|屏幕/g,
  ];
  
  const keywords: string[] = [];
  for (const p of patterns) {
    const m = query.match(p);
    if (m) keywords.push(...m);
  }
  
  const chinese = query.match(/[\u4e00-\u9fff]{2,6}/g);
  if (chinese) {
    const stops = ['什么', '怎么', '如何', '为什么', '哪个', '那个', '这个', '可以', '能够'];
    keywords.push(...chinese.filter(w => !stops.includes(w)));
  }
  
  const uniqueKeywords = [...new Set(keywords)];
  
  return docs.filter(doc => {
    if (doc.score < 0.2) return false;
    const content = doc.content.toLowerCase();
    const matches = uniqueKeywords.filter(kw => content.includes(kw.toLowerCase()));
    return matches.length > 0 || doc.score > 0.5;
  });
}

// ==================== 上下文管理器 ====================

export class ContextManager {
  private config: ContextManagerConfig;
  private llm: BaseChatModel;
  private embeddings: Embeddings;
  private rewriteChain: RunnableSequence<{ history: string; query: string }, string>;
  private generateChain: RunnableSequence<GenerateInput, string>;
  private summaryChain: RunnableSequence<{ conversation: string }, string>;
  
  constructor(config: Partial<ContextManagerConfig> = {}) {
    // 使用动态获取的默认配置
    const defaultConfig = getDefaultConfig();
    this.config = { ...defaultConfig, ...config };
    
    const factory = getModelFactory();
    console.log(`[ContextManager] 初始化, 提供商: ${factory.getProvider()}`);
    
    // 使用统一模型配置系统创建模型
    this.llm = createLLM(this.config.llmModel, { temperature: 0.7 });
    this.embeddings = createEmbedding(this.config.embeddingModel);
    
    console.log(`[ContextManager] LLM: ${this.config.llmModel}`);
    console.log(`[ContextManager] Embedding: ${this.config.embeddingModel}`);
    
    // 初始化 LangChain 链
    this.rewriteChain = createRewriteChain(this.llm);
    this.generateChain = createGenerateChain(this.llm);
    this.summaryChain = createSummaryChain(this.llm);
  }
  
  getConfig(): ContextManagerConfig {
    return this.config;
  }
  
  updateConfig(newConfig: Partial<ContextManagerConfig>): void {
    this.config = { ...this.config, ...newConfig };
    if (newConfig.llmModel) {
      // 使用统一模型配置系统
      this.llm = createLLM(this.config.llmModel, { temperature: 0.7 });
      // 重新创建所有链
      this.rewriteChain = createRewriteChain(this.llm);
      this.generateChain = createGenerateChain(this.llm);
      this.summaryChain = createSummaryChain(this.llm);
    }
    if (newConfig.embeddingModel) {
      this.embeddings = createEmbedding(this.config.embeddingModel);
    }
  }
  
  // ==================== 会话管理 ====================
  
  async createSession(userId?: string): Promise<ContextState> {
    const sessionId = generateId();
    const now = Date.now();
    
    const data: SessionData = {
      metadata: {
        sessionId, userId, createdAt: now, lastActiveAt: now,
        totalTokens: 0, messageCount: 0, truncatedCount: 0, summarizedRounds: 0,
      },
      messages: [],
    };
    
    saveSession(data);
    return { messages: [], metadata: data.metadata, artifacts: {}, workflowSteps: [] };
  }
  
  async getSession(sessionId: string): Promise<ContextState | null> {
    const data = loadSession(sessionId);
    if (!data) return null;
    
    return {
      messages: data.messages,
      metadata: {
        ...data.metadata,
        messageCount: data.messages.length,
        totalTokens: data.messages.reduce((sum, m) => sum + (m.tokenCount || 0), 0),
      },
      summary: data.summary,
      artifacts: {},
      workflowSteps: [],
    };
  }
  
  async listSessions(): Promise<SessionMetadata[]> {
    return listAllSessions();
  }
  
  async deleteSession(sessionId: string): Promise<boolean> {
    return deleteSessionFile(sessionId);
  }
  
  // ==================== 核心查询处理 ====================
  
  async processQuery(
    sessionId: string,
    userQuery: string,
    options: { userId?: string; topK?: number; similarityThreshold?: number } = {}
  ): Promise<{
    response: string;
    state: ContextState;
    rewrittenQuery?: string;
    retrievedDocs: RetrievedDocument[];
    workflowSteps: WorkflowStep[];
  }> {
    const workflowSteps: WorkflowStep[] = [];
    const topK = options.topK || this.config.topK;
    const threshold = options.similarityThreshold || this.config.similarityThreshold;
    
    // 1. 加载/创建会话
    const loadStep = createStep('状态加载');
    let sessionData = loadSession(sessionId);
    if (!sessionData) {
      sessionData = {
        metadata: {
          sessionId, userId: options.userId, createdAt: Date.now(), lastActiveAt: Date.now(),
          totalTokens: 0, messageCount: 0, truncatedCount: 0, summarizedRounds: 0,
        },
        messages: [],
      };
    }
    workflowSteps.push(completeStep(loadStep, { isNew: !sessionData.messages.length }));
    
    // 2. 窗口截断 (使用 LangChain trimMessages)
    const trimStep = createStep('窗口截断');
    const { messages: trimmedMessages, trimmedCount } = await trimConversationMessages(
      sessionData.messages,
      this.config.windowConfig
    );
    sessionData.messages = trimmedMessages;
    workflowSteps.push(completeStep(trimStep, { trimmedCount, remainingCount: trimmedMessages.length }));
    
    // 3. 查询改写 (使用 LangChain RunnableSequence)
    const rewriteStep = createStep('查询改写');
    let rewriteResult: RewriteResult = { rewrittenQuery: userQuery, needsRewrite: false, reason: '未启用' };
    
    if (this.config.enableQueryRewriting && sessionData.messages.length > 0) {
      rewriteResult = await rewriteQuery(userQuery, sessionData.messages, this.rewriteChain);
    }
    workflowSteps.push(completeStep(rewriteStep, {
      original: userQuery,
      rewritten: rewriteResult.rewrittenQuery,
      needsRewrite: rewriteResult.needsRewrite,
      reason: rewriteResult.reason,
    }));
    
    // 4. 判断是否需要检索
    const greeting = isGreeting(userQuery);
    let retrievedDocs: RetrievedDocument[] = [];
    
    if (!greeting) {
      // 5. 向量检索 (使用 LangChain Embeddings)
      const retrieveStep = createStep('向量检索');
      retrievedDocs = await retrieveDocuments(
        rewriteResult.rewrittenQuery,
        this.embeddings,
        this.config.milvusCollection,
        this.config.embeddingModel,
        topK,
        threshold
      );
      workflowSteps.push(completeStep(retrieveStep, {
        query: rewriteResult.rewrittenQuery,
        resultCount: retrievedDocs.length,
        topScore: retrievedDocs[0]?.score,
      }));
      
      // 6. 相关性过滤
      const filterStep = createStep('相关性验证');
      const originalCount = retrievedDocs.length;
      retrievedDocs = filterRelevantDocuments(retrievedDocs, rewriteResult.rewrittenQuery);
      workflowSteps.push(completeStep(filterStep, {
        originalCount,
        filteredCount: retrievedDocs.length,
      }));
    } else {
      workflowSteps.push(completeStep(createStep('向量检索'), { skipped: true, reason: '问候语' }));
      workflowSteps.push(completeStep(createStep('相关性验证'), { skipped: true }));
    }
    
    // 7. 生成响应 (使用 LangChain RunnableBranch)
    const generateStep = createStep('响应生成');
    const context = retrievedDocs.length > 0
      ? retrievedDocs.map((d, i) => `[${i + 1}] ${d.content}`).join('\n\n')
      : '无相关参考资料';
    
    let response: string;
    try {
      response = await this.generateChain.invoke({
        query: userQuery,
        rewrittenQuery: rewriteResult.rewrittenQuery,
        history: toBaseMessages(sessionData.messages.slice(-6)),
        context,
        isGreeting: greeting,
      });
    } catch (error) {
      console.error('[generateChain] Error:', error);
      response = '抱歉，生成回答时出错，请稍后重试。';
    }
    workflowSteps.push(completeStep(generateStep, { 
      responseLength: response.length,
      usedDocs: retrievedDocs.length,
    }));
    
    // 8. 保存消息
    const saveStep = createStep('状态保存');
    const now = Date.now();
    const userMsg: ConversationMessage = {
      id: `${now}-user`, role: 'user', content: userQuery,
      timestamp: now, tokenCount: estimateTokens(userQuery),
    };
    const aiMsg: ConversationMessage = {
      id: `${now}-ai`, role: 'assistant', content: response,
      timestamp: now + 1, tokenCount: estimateTokens(response),
    };
    
    sessionData.messages.push(userMsg, aiMsg);
    sessionData.metadata.lastActiveAt = now;
    sessionData.metadata.messageCount = sessionData.messages.length;
    sessionData.metadata.totalTokens = sessionData.messages.reduce((sum, m) => sum + (m.tokenCount || 0), 0);
    sessionData.metadata.truncatedCount += trimmedCount;
    
    saveSession(sessionData);
    workflowSteps.push(completeStep(saveStep, { messageCount: sessionData.messages.length }));
    
    return {
      response,
      state: {
        messages: sessionData.messages,
        metadata: sessionData.metadata,
        summary: sessionData.summary,
        artifacts: { rewrittenQuery: rewriteResult.rewrittenQuery, retrievedDocuments: retrievedDocs },
        workflowSteps,
      },
      rewrittenQuery: rewriteResult.needsRewrite ? rewriteResult.rewrittenQuery : undefined,
      retrievedDocs,
      workflowSteps,
    };
  }
  
  // ==================== 流式查询处理 (SSE) ====================
  
  /**
   * 流式查询处理 - 使用 AsyncGenerator 实现 SSE
   * 返回一个 AsyncGenerator，可以逐步输出工作流状态和响应 token
   */
  async *streamQuery(
    sessionId: string,
    userQuery: string,
    options: { userId?: string; topK?: number; similarityThreshold?: number } = {}
  ): AsyncGenerator<StreamEvent, StreamQueryResult, unknown> {
    const workflowSteps: WorkflowStep[] = [];
    const topK = options.topK || this.config.topK;
    const threshold = options.similarityThreshold || this.config.similarityThreshold;
    
    // 1. 加载/创建会话
    const loadStep = createStep('状态加载');
    let sessionData = loadSession(sessionId);
    if (!sessionData) {
      sessionData = {
        metadata: {
          sessionId, userId: options.userId, createdAt: Date.now(), lastActiveAt: Date.now(),
          totalTokens: 0, messageCount: 0, truncatedCount: 0, summarizedRounds: 0,
        },
        messages: [],
      };
    }
    const completedLoadStep = completeStep(loadStep, { isNew: !sessionData.messages.length });
    workflowSteps.push(completedLoadStep);
    yield { type: 'workflow', data: { step: completedLoadStep, allSteps: [...workflowSteps] } };
    
    // 2. 窗口截断
    const trimStep = createStep('窗口截断');
    const { messages: trimmedMessages, trimmedCount } = await trimConversationMessages(
      sessionData.messages,
      this.config.windowConfig
    );
    sessionData.messages = trimmedMessages;
    const completedTrimStep = completeStep(trimStep, { trimmedCount, remainingCount: trimmedMessages.length });
    workflowSteps.push(completedTrimStep);
    yield { type: 'workflow', data: { step: completedTrimStep, allSteps: [...workflowSteps] } };
    
    // 3. 查询改写
    const rewriteStep = createStep('查询改写');
    let rewriteResult: RewriteResult = { rewrittenQuery: userQuery, needsRewrite: false, reason: '未启用' };
    
    if (this.config.enableQueryRewriting && sessionData.messages.length > 0) {
      rewriteResult = await rewriteQuery(userQuery, sessionData.messages, this.rewriteChain);
    }
    const completedRewriteStep = completeStep(rewriteStep, {
      original: userQuery,
      rewritten: rewriteResult.rewrittenQuery,
      needsRewrite: rewriteResult.needsRewrite,
      reason: rewriteResult.reason,
    });
    workflowSteps.push(completedRewriteStep);
    yield { type: 'workflow', data: { step: completedRewriteStep, allSteps: [...workflowSteps] } };
    
    // 4. 判断是否需要检索
    const greeting = isGreeting(userQuery);
    let retrievedDocs: RetrievedDocument[] = [];
    
    if (!greeting) {
      // 5. 向量检索
      const retrieveStep = createStep('向量检索');
      retrievedDocs = await retrieveDocuments(
        rewriteResult.rewrittenQuery,
        this.embeddings,
        this.config.milvusCollection,
        this.config.embeddingModel,
        topK,
        threshold
      );
      const completedRetrieveStep = completeStep(retrieveStep, {
        query: rewriteResult.rewrittenQuery,
        resultCount: retrievedDocs.length,
        topScore: retrievedDocs[0]?.score,
      });
      workflowSteps.push(completedRetrieveStep);
      yield { type: 'workflow', data: { step: completedRetrieveStep, allSteps: [...workflowSteps] } };
      
      // 6. 相关性过滤
      const filterStep = createStep('相关性验证');
      const originalCount = retrievedDocs.length;
      retrievedDocs = filterRelevantDocuments(retrievedDocs, rewriteResult.rewrittenQuery);
      const completedFilterStep = completeStep(filterStep, {
        originalCount,
        filteredCount: retrievedDocs.length,
      });
      workflowSteps.push(completedFilterStep);
      yield { type: 'workflow', data: { step: completedFilterStep, allSteps: [...workflowSteps] } };
    } else {
      const skipRetrieveStep = completeStep(createStep('向量检索'), { skipped: true, reason: '问候语' });
      workflowSteps.push(skipRetrieveStep);
      yield { type: 'workflow', data: { step: skipRetrieveStep, allSteps: [...workflowSteps] } };
      
      const skipFilterStep = completeStep(createStep('相关性验证'), { skipped: true });
      workflowSteps.push(skipFilterStep);
      yield { type: 'workflow', data: { step: skipFilterStep, allSteps: [...workflowSteps] } };
    }
    
    // 7. 流式生成响应
    const generateStep = createStep('响应生成');
    yield { type: 'workflow', data: { step: generateStep, allSteps: [...workflowSteps, generateStep] } };
    
    const context = retrievedDocs.length > 0
      ? retrievedDocs.map((d, i) => `[${i + 1}] ${d.content}`).join('\n\n')
      : '无相关参考资料';
    
    let fullResponse = '';
    
    try {
      // 构建流式提示
      const systemPrompt = greeting
        ? '你是一个友好的智能助手。请自然地回应用户的问候或问题。保持简洁友好。'
        : `你是一个智能助手。请根据参考资料回答用户问题。

要求：
1. 如果参考资料中有相关信息，基于资料回答
2. 如果参考资料中没有相关信息，尝试用你的知识回答，但要说明这不是来自资料库
3. 保持回答简洁友好
4. 不要编造不存在的信息

参考资料：
${context}`;

      const historyText = sessionData.messages.slice(-6)
        .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`)
        .join('\n');
      
      const fullPrompt = historyText
        ? `${systemPrompt}\n\n历史对话:\n${historyText}\n\n用户: ${userQuery}\n\nAI:`
        : `${systemPrompt}\n\n用户: ${userQuery}\n\nAI:`;
      
      // 使用 LLM 流式输出
      const stream = await this.llm.stream(fullPrompt);
      
      for await (const chunk of stream) {
        const content = typeof chunk.content === 'string' ? chunk.content : '';
        if (content) {
          fullResponse += content;
          yield { type: 'token', data: { content, fullResponse } };
        }
      }
    } catch (error) {
      console.error('[streamQuery] Generation error:', error);
      fullResponse = '抱歉，生成回答时出错，请稍后重试。';
      yield { type: 'error', data: { error: error instanceof Error ? error.message : String(error) } };
    }
    
    const completedGenerateStep = completeStep(generateStep, { 
      responseLength: fullResponse.length,
      usedDocs: retrievedDocs.length,
    });
    workflowSteps[workflowSteps.length] = completedGenerateStep;
    yield { type: 'workflow', data: { step: completedGenerateStep, allSteps: [...workflowSteps] } };
    
    // 8. 保存消息
    const saveStep = createStep('状态保存');
    const now = Date.now();
    const userMsg: ConversationMessage = {
      id: `${now}-user`, role: 'user', content: userQuery,
      timestamp: now, tokenCount: estimateTokens(userQuery),
    };
    const aiMsg: ConversationMessage = {
      id: `${now}-ai`, role: 'assistant', content: fullResponse,
      timestamp: now + 1, tokenCount: estimateTokens(fullResponse),
    };
    
    sessionData.messages.push(userMsg, aiMsg);
    sessionData.metadata.lastActiveAt = now;
    sessionData.metadata.messageCount = sessionData.messages.length;
    sessionData.metadata.totalTokens = sessionData.messages.reduce((sum, m) => sum + (m.tokenCount || 0), 0);
    sessionData.metadata.truncatedCount += trimmedCount;
    
    saveSession(sessionData);
    const completedSaveStep = completeStep(saveStep, { messageCount: sessionData.messages.length });
    workflowSteps.push(completedSaveStep);
    yield { type: 'workflow', data: { step: completedSaveStep, allSteps: workflowSteps } };
    
    // 发送完成事件
    const result: StreamQueryResult = {
      response: fullResponse,
      state: {
        messages: sessionData.messages,
        metadata: sessionData.metadata,
        summary: sessionData.summary,
        artifacts: { rewrittenQuery: rewriteResult.rewrittenQuery, retrievedDocuments: retrievedDocs },
        workflowSteps,
      },
      rewrittenQuery: rewriteResult.needsRewrite ? rewriteResult.rewrittenQuery : undefined,
      retrievedDocs,
      workflowSteps,
    };
    
    yield { type: 'done', data: result };
    
    return result;
  }
  
  // ==================== 压缩功能 (使用 LangChain 链) ====================
  
  async compressBySummary(sessionId: string): Promise<{
    success: boolean;
    summary?: string;
    compressedCount?: number;
  }> {
    const data = loadSession(sessionId);
    if (!data || data.messages.length < 6) {
      return { success: false };
    }
    
    const oldMsgs = data.messages.slice(0, -4);
    const recentMsgs = data.messages.slice(-4);
    
    if (oldMsgs.length < 4) return { success: false };
    
    // 使用 getBufferString 格式化对话
    const baseMessages = toBaseMessages(oldMsgs);
    const conversation = getBufferString(baseMessages, '用户', 'AI');
    
    try {
      // 使用 LangChain 摘要链
      const summary = await this.summaryChain.invoke({ conversation });
      
      data.messages = recentMsgs;
      data.summary = summary.trim();
      data.metadata.summarizedRounds += Math.floor(oldMsgs.length / 2);
      data.metadata.messageCount = recentMsgs.length;
      
      saveSession(data);
      return { success: true, summary: data.summary, compressedCount: oldMsgs.length };
    } catch (error) {
      if (error instanceof ContextSessionError) throw error;
      console.error('[compressBySummary] Error:', error);
      return { success: false };
    }
  }
  
  getTokenStats(state: ContextState) {
    const totalTokens = state.messages.reduce((sum, m) => sum + (m.tokenCount || 0), 0);
    return {
      totalTokens,
      messageCount: state.messages.length,
      averageTokensPerMessage: state.messages.length > 0 ? Math.round(totalTokens / state.messages.length) : 0,
      isOverLimit: totalTokens > (this.config.windowConfig.maxTokens || 4000),
    };
  }
}

// ==================== 导出 ====================

export function createContextManager(config: Partial<ContextManagerConfig> = {}): ContextManager {
  return new ContextManager(config);
}

export { 
  DEFAULT_CONFIG as CONTEXT_MANAGER_DEFAULT_CONFIG, 
  estimateTokens, 
  generateId, 
  toBaseMessages, 
  fromBaseMessage,
  tokenCounter,
  trimMessagesWithLangChain,
};

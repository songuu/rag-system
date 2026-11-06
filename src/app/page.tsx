'use client';

import { useState, useEffect, useRef, useCallback, useMemo, type ComponentProps } from 'react';
import Link from 'next/link';
import { dbManager, projectMessageCitations, type ConversationMessage } from '@/lib/indexeddb';
import type { ChatQueryAnalysis, ChatRetrievalDetails, ChatSearchResult, QueryToken } from '@/lib/rag/chat-types';
import HomeHeader from '@/components/HomeHeader';
import { formatDocumentChunkCounts, parseDocumentChunkCounts, type DocumentChunkCounts } from '@/lib/documents/document-counts';
import ChatMessage from '@/components/ChatMessage';
import ResizableChatArea from '@/components/ResizableChatArea';
import AnswerProcessingPanel from '@/components/AnswerProcessingPanel';
import QueryAnalysis from '@/components/QueryAnalysis';
import QuestionSelector from '@/components/QuestionSelector';
import ParameterControls from '@/components/ParameterControls';
import RealtimeMonitoring from '@/components/RealtimeMonitoring';
import RetrievalDetailsPanel from '@/components/RetrievalDetailsPanel';
import SystemInfo from '@/components/SystemInfo';
import Toast from '@/components/Toast';
import IntentDistillationPanel from '@/components/IntentDistillationPanel';
import MilvusQueryVisualizer from '@/components/MilvusQueryVisualizer';
import AgenticWorkflowPanel from '@/components/AgenticWorkflowPanel';
import LangSmithTraceViewer from '@/components/LangSmithTraceViewer';
import AdaptiveEntityWorkflowPanel from '@/components/AdaptiveEntityWorkflowPanel';
import SuggestedQuestions from '@/components/SuggestedQuestions';
import ConversationExpansionWorkflow from '@/components/ConversationExpansionWorkflow';
import { ModelConfigPanel } from '@/components/ModelConfigPanel';
import { RAG_CLIENT_REQUEST_TIMEOUT_MS } from '@/lib/rag/core/request-budgets';
import { readAskProgressResponse } from '@/lib/rag/ask-progress-client';
import {
  resolveSessionModelConfig,
  requestSessionModelSelection,
  type SessionLlmSelection,
  type SessionModelConfig,
} from '@/lib/model-selection';
import {
  resolveAnswerProcessing,
  type AnswerProcessingDetails,
} from '@/lib/rag/answer-processing';
const ASK_SLOW_HINT_MS = 8_000;
const ANSWER_DRAFT_RENDER_MS = 40;

interface AnswerDraft {
  controller: AbortController;
  signal: AbortSignal;
  historyRevision: number;
  partition: string;
  text: string;
  timer: number | null;
}

interface Message extends ConversationMessage {
  retryStatus?: 'failed' | 'retrying';
}

type AgenticPanelProps = ComponentProps<typeof AgenticWorkflowPanel>;
type AdaptivePanelProps = ComponentProps<typeof AdaptiveEntityWorkflowPanel>;
type SuggestionsProps = ComponentProps<typeof SuggestedQuestions>;
type TraceViewerProps = ComponentProps<typeof LangSmithTraceViewer>;
type ModelWarmupIdentity = Readonly<{
  provider: string | undefined; model: string; embeddingModel: string; attempt: number;
}>;

type ConversationHistoryMessage = { role: 'user' | 'assistant'; content: string };

function appendCompletedTurn(
  history: ConversationHistoryMessage[], question: string, answer: string
): ConversationHistoryMessage[] {
  // Keep whole turns: truncation could change meaning or leave a misleading answer.
  if (!question.trim() || !answer.trim() || question.length > 1000 || answer.length > 1000) return [];
  const next: ConversationHistoryMessage[] = [...history, { role: 'user', content: question }, { role: 'assistant', content: answer }];
  while (next.length > 8 || next.reduce((sum, item) => sum + item.content.length, 0) > 6000) next.splice(0, 2);
  return next;
}

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'warning' | 'info';
}

interface CanonicalCreateAgentQueryAnalysis extends ChatQueryAnalysis {
  analysisMode: 'canonical-create-agent';
}

function isCanonicalCreateAgentQueryAnalysis(
  value: unknown
): value is CanonicalCreateAgentQueryAnalysis {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as Record<string, unknown>).analysisMode === 'canonical-create-agent'
  );
}

/**
 * 安全提取 API 响应中的回答内容为字符串
 * 防止 LangChain 对象被传递给 React 组件
 */
function safeAnswerString(answer: unknown): string {
  if (typeof answer === 'string') {
    return answer;
  }
  if (answer == null) {
    return '';
  }
  // LangChain AIMessage 对象有 content 属性
  if (typeof answer === 'object' && 'content' in answer) {
    const content = answer.content;
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content.map(item => 
        typeof item === 'string' ? item : (item?.text || '')
      ).join('');
    }
  }
  try {
    return JSON.stringify(answer);
  } catch {
    return String(answer);
  }
}

export default function HomePage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const latestUserMessageId = messages.findLast(message => message.type === 'user')?.id;
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isRequestSlow, setIsRequestSlow] = useState(false);
  const [activeProcessing, setActiveProcessing] = useState<AnswerProcessingDetails | null>(null);
  const [answerDraft, setAnswerDraft] = useState('');
  const answerDraftRef = useRef<AnswerDraft | null>(null);
  const [topK, setTopK] = useState(3);
  const [threshold, setThreshold] = useState(0.0);
  const [llmModel, setLlmModel] = useState('llama3.1');
  const [embeddingModel, setEmbeddingModel] = useState('nomic-embed-text');
  const [modelConfig, setModelConfig] = useState<{
    llm: { provider: string; model: string };
    embedding: { provider: string; model: string; dimension: number };
  } | undefined>(undefined);
  const [queryAnalysis, setQueryAnalysis] = useState<ChatQueryAnalysis | null>(null);
  const [showParams, setShowParams] = useState(false);
  const [showQueryAnalysis, setShowQueryAnalysis] = useState(false);
  const [docCount, setDocCount] = useState(0);
  const [embeddingDim, setEmbeddingDim] = useState(0);
  const [systemStatus, setSystemStatus] = useState('检查中...');
  const [vectorizationProgress, setVectorizationProgress] = useState(0);
  const [vectorizationStatus, setVectorizationStatus] = useState('');
  const [showVectorization, setShowVectorization] = useState(false);
  const [queryProcessingStatus, setQueryProcessingStatus] = useState('');
  const [showQueryProcessing, setShowQueryProcessing] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [radarChartData, setRadarChartData] = useState<ComponentProps<typeof QueryAnalysis>['radarChartData']>(null);
  const [currentQuery, setCurrentQuery] = useState('');
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [viewingAnalysisFor, setViewingAnalysisFor] = useState<string | null>(null);
  const [retrievalDetails, setRetrievalDetails] = useState<ChatRetrievalDetails | null>(null);
  const [vectorizationDetails, setVectorizationDetails] = useState<ComponentProps<typeof RealtimeMonitoring>['vectorizationDetails']>(null);
  const [showIntentDistillation, setShowIntentDistillation] = useState(false);

  // Milvus 相关状态
  // Production requests are scoped to a tenant/corpus and therefore require
  // the canonical Milvus retrieval path. The old in-memory route is local-only.
  const [storageBackend] = useState<'memory' | 'milvus'>('milvus');
  const [milvusConnected, setMilvusConnected] = useState(false);
  const [publicationMode, setPublicationMode] = useState(false);
  const publicationModeRef = useRef(false);
  const [vectorBackendDisabled, setVectorBackendDisabled] = useState(false);
  const [runtimeStatusLoaded, setRuntimeStatusLoaded] = useState(false);
  const [milvusStats, setMilvusStats] = useState<{ embeddingDimension?: number } | null>(null);
  const [documentCounts, setDocumentCounts] = useState<DocumentChunkCounts | null>(null);
  const documentCountsRequestRef = useRef<AbortController | null>(null);
  const documentCountsRefreshRef = useRef<Promise<void> | null>(null);
  const invalidateDocumentCounts = useCallback(() => {
    documentCountsRequestRef.current?.abort();
    documentCountsRequestRef.current = null;
    documentCountsRefreshRef.current = null;
    setDocumentCounts(null);
  }, []);

  // Agentic RAG 相关状态
  const [useAgenticRAG, setUseAgenticRAG] = useState(false);
  const [agenticWorkflow, setAgenticWorkflow] = useState<AgenticPanelProps['workflow'] | null>(null);
  const [agenticQueryAnalysis, setAgenticQueryAnalysis] = useState<AgenticPanelProps['queryAnalysis'] | null>(null);
  const [agenticRetrievalQuality, setAgenticRetrievalQuality] = useState<AgenticPanelProps['retrievalQuality'] | null>(null);
  const [agenticSelfReflection, setAgenticSelfReflection] = useState<AgenticPanelProps['selfReflection'] | null>(null);
  const [agenticHallucinationCheck, setAgenticHallucinationCheck] = useState<AgenticPanelProps['hallucinationCheck'] | null>(null);
  const [agenticRetrievalGrade, setAgenticRetrievalGrade] = useState<TraceViewerProps['retrievalGrade'] | null>(null);
  const [agenticDebugInfo, setAgenticDebugInfo] = useState<TraceViewerProps['debugInfo'] | null>(null);
  const [showAgenticPanel, setShowAgenticPanel] = useState(false);

  // 自适应实体路由 RAG 相关状态
  const [useAdaptiveEntityRAG, setUseAdaptiveEntityRAG] = useState(false);
  const [adaptiveEntityWorkflow, setAdaptiveEntityWorkflow] = useState<AdaptivePanelProps['workflow'] | null>(null);
  const [adaptiveEntityQueryAnalysis, setAdaptiveEntityQueryAnalysis] = useState<AdaptivePanelProps['queryAnalysis'] | null>(null);
  const [adaptiveEntityValidation, setAdaptiveEntityValidation] = useState<AdaptivePanelProps['entityValidation'] | null>(null);
  const [adaptiveEntityRoutingDecision, setAdaptiveEntityRoutingDecision] = useState<AdaptivePanelProps['routingDecision'] | null>(null);
  const [adaptiveEntityRetrievalDetails, setAdaptiveEntityRetrievalDetails] = useState<AdaptivePanelProps['retrievalDetails'] | null>(null);
  const [showAdaptiveEntityPanel, setShowAdaptiveEntityPanel] = useState(false);

  // 对话延伸（推荐问题）相关状态
  const [enableSuggestions, setEnableSuggestions] = useState(true);
  const [suggestedQuestions, setSuggestedQuestions] = useState<SuggestionsProps['suggestions']>([]);
  const [suggestionAnchor, setSuggestionAnchor] = useState<NonNullable<SuggestionsProps['anchor']> | null>(null);
  const [isSuggestionsLoading, setIsSuggestionsLoading] = useState(false);
  const [showSuggestionDetails, setShowSuggestionDetails] = useState(false);
  const [suggestionTimings, setSuggestionTimings] = useState<NonNullable<SuggestionsProps['timings']> | null>(null);
  const [suggestionProcessingTime, setSuggestionProcessingTime] = useState<number>(0);
  const [lastUserQuery, setLastUserQuery] = useState<string>('');
  const [lastAiResponse, setLastAiResponse] = useState<string>('');
  const [showExpansionWorkflow, setShowExpansionWorkflow] = useState(true);

  const askAbortControllerRef = useRef<AbortController | null>(null);
  const conversationHistoryRef = useRef<ConversationHistoryMessage[]>([]);
  const conversationHistoryRevisionRef = useRef(0);
  const conversationHistoryPartitionRef = useRef<string | null>(null);
  const conversationVerifiedPartitionRef = useRef<string | null>(null);
  const sessionLlmSelectionRef = useRef<SessionLlmSelection | null>(null);
  const [citationPartition, setCitationPartition] = useState<string | null>(null);
  const [citationAccessStatus, setCitationAccessStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [citationClockOffsetMs, setCitationClockOffsetMs] = useState<number | null>(null);
  const citationPartitionRef = useRef<string | null>(null);
  const citationClockOffsetRef = useRef<number | null>(null);
  const citationIdentityRequestRef = useRef<AbortController | null>(null);
  const citationIdentityPendingRef = useRef<Promise<void> | null>(null);
  const citationIdentityRevisionRef = useRef(0);
  const citationInvalidationRevisionRef = useRef(0);
  const citationMountedRef = useRef(false);
  const [modelReadinessResult, setModelReadinessResult] = useState<{
    key: ModelWarmupIdentity; value: NonNullable<ComponentProps<typeof SystemInfo>['modelReadiness']>;
  } | null>(null);
  const [modelWarmupAttempt, setModelWarmupAttempt] = useState(0);
  const modelWarmupKey = useMemo<ModelWarmupIdentity>(() => ({ provider: modelConfig?.llm.provider,
    model: llmModel, embeddingModel, attempt: modelWarmupAttempt }),
  [modelConfig?.llm.provider, llmModel, embeddingModel, modelWarmupAttempt]);
  // Derive loading immediately from the selection/attempt. Resetting it in an
  // effect briefly presents the previous model's readiness before that effect runs.
  const modelReadiness = useMemo(() => modelConfig?.llm.provider !== 'ollama' ? null
    : modelReadinessResult?.key === modelWarmupKey ? modelReadinessResult.value
      : { model: llmModel, phase: 'loading' as const, detail: '正在准备回答和检索模型，知识库问答会等待准备完成后继续。' },
  [modelConfig?.llm.provider, modelWarmupKey, modelReadinessResult, llmModel]);

  const clearAnswerDraft = useCallback((controller?: AbortController) => {
    const draft = answerDraftRef.current;
    if (controller && draft?.controller !== controller) return;
    if (draft?.timer !== null && draft?.timer !== undefined) window.clearTimeout(draft.timer);
    answerDraftRef.current = null;
    if (citationMountedRef.current) setAnswerDraft('');
  }, []);

  const flushAnswerDraft = useCallback(() => {
    const draft = answerDraftRef.current;
    if (!draft) return;
    if (draft.timer !== null) window.clearTimeout(draft.timer);
    draft.timer = null;
    if (!citationMountedRef.current || draft.signal.aborted || askAbortControllerRef.current !== draft.controller
      || draft.historyRevision !== conversationHistoryRevisionRef.current) {
      clearAnswerDraft(draft.controller);
      return;
    }
    // A focus refresh can temporarily hide a valid account. Retain the bounded
    // draft in memory, but expose it only after that same identity is verified.
    setAnswerDraft(!citationIdentityPendingRef.current
      && draft.partition === conversationVerifiedPartitionRef.current
      && draft.partition === conversationHistoryPartitionRef.current ? draft.text : '');
  }, [clearAnswerDraft]);

  const waitForCitationIdentity = useCallback(async (signal: AbortSignal) => {
    while (citationIdentityPendingRef.current && !signal.aborted) {
      const pending = citationIdentityPendingRef.current;
      await new Promise<void>(resolve => {
        const finish = () => { signal.removeEventListener('abort', finish); resolve(); };
        signal.addEventListener('abort', finish, { once: true });
        void pending.then(finish);
        if (signal.aborted) finish();
      });
    }
  }, []);

  const refreshCitationPartition = useCallback(async (clearExisting = false) => {
    if (!citationMountedRef.current) return;
    // Defer completed answers until the refreshed identity is known.
    let resolveVerification!: () => void;
    const verification = new Promise<void>(resolve => { resolveVerification = resolve; });
    citationIdentityPendingRef.current = verification;
    setAnswerDraft('');
    if (answerDraftRef.current?.timer !== null && answerDraftRef.current?.timer !== undefined) {
      window.clearTimeout(answerDraftRef.current.timer);
      answerDraftRef.current.timer = null;
    }
    citationIdentityRequestRef.current?.abort();
    const controller = new AbortController();
    citationIdentityRequestRef.current = controller;
    const revision = ++citationIdentityRevisionRef.current;
    const isCurrent = () => citationMountedRef.current && !controller.signal.aborted
      && revision === citationIdentityRevisionRef.current;
    citationPartitionRef.current = null;
    conversationVerifiedPartitionRef.current = null;
    citationClockOffsetRef.current = null;
    dbManager.setCitationClockOffset(null);
    setCitationPartition(null);
    setCitationClockOffsetMs(null);
    setCitationAccessStatus('loading');
    const clearHandles = async () => {
      if (!isCurrent()) return;
      citationInvalidationRevisionRef.current++;
      setMessages(current => current.map(message => {
        const cleared = { ...message };
        delete cleared.citations;
        return cleared;
      }));
      await dbManager.invalidateCitationReferences();
    };
    try {
      if (clearExisting) await clearHandles();
      await dbManager.waitForCitationClear();
      if (!isCurrent()) return;
      let response = await fetch('/rag-api/ask/citations/preview', {
        method: 'GET', credentials: 'same-origin', cache: 'no-store',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
      if (!isCurrent()) return;
      let citationsAvailable = response.ok;
      if (response.status === 503) {
        // The retrieval guard can disable citation preview while direct chat
        // remains usable; verify the account independently in that case.
        response = await fetch('/rag-api/ask/conversation-identity', {
          method: 'GET', credentials: 'same-origin', cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        citationsAvailable = false;
        if (!isCurrent()) return;
      }
      if (response.status === 401 || response.status === 403) {
        await clearHandles();
        throw new Error('Citation identity is no longer authorized.');
      }
      if (!response.ok) throw new Error('Citation identity unavailable.');
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object') throw new Error('Invalid citation identity.');
      const identity = body as Record<string, unknown>;
      if (identity.success !== true || typeof identity.partition !== 'string'
        || !/^[a-f0-9]{64}$/.test(identity.partition)
        || typeof identity.now !== 'number' || !Number.isFinite(identity.now)) throw new Error('Invalid citation identity.');
      if (!isCurrent()) return;
      const partition = identity.partition;
      await dbManager.waitForCitationClear();
      if (!isCurrent()) return;
      if (conversationHistoryPartitionRef.current !== partition) {
        conversationHistoryRef.current = [];
        if (conversationHistoryPartitionRef.current !== null) {
          conversationHistoryRevisionRef.current++;
          askAbortControllerRef.current?.abort(new DOMException('会话身份已更改', 'AbortError'));
          invalidateDocumentCounts();
        }
      }
      conversationHistoryPartitionRef.current = partition;
      conversationVerifiedPartitionRef.current = partition;
      dbManager.setCitationIdentity(citationsAvailable ? partition : null);
      const offsetMs = Date.now() - identity.now;
      citationClockOffsetRef.current = offsetMs;
      dbManager.setCitationClockOffset(offsetMs);
      citationPartitionRef.current = citationsAvailable ? partition : null;
      setCitationPartition(citationsAvailable ? partition : null);
      setCitationClockOffsetMs(offsetMs);
      setCitationAccessStatus(citationsAvailable ? 'ready' : 'unavailable');
      if (citationsAvailable) setMessages(current => current.map(message => ({
        ...message, citations: projectMessageCitations(message.citations, partition, identity.now as number),
      })));
      // One shared identity read covers the whole conversation; preview still reauthorizes each click.
      await dbManager.init();
      if (isCurrent() && citationsAvailable) {
        await dbManager.pruneConversationCitations(partition, identity.now);
      }
    } catch {
      if (isCurrent()) {
        conversationHistoryRef.current = [];
        conversationHistoryPartitionRef.current = null;
        conversationVerifiedPartitionRef.current = null;
        conversationHistoryRevisionRef.current++;
        askAbortControllerRef.current?.abort(new DOMException('会话身份无法验证', 'AbortError'));
        citationPartitionRef.current = null;
        setCitationPartition(null);
        setCitationAccessStatus('unavailable');
        invalidateDocumentCounts();
      }
    } finally {
      if (citationIdentityPendingRef.current === verification) {
        citationIdentityPendingRef.current = null;
        flushAnswerDraft();
      }
      resolveVerification();
    }
  }, [invalidateDocumentCounts, flushAnswerDraft]);

  useEffect(() => {
    citationMountedRef.current = true;
    const refresh = () => { void refreshCitationPartition(); };
    const invalidate = () => {
      conversationHistoryRevisionRef.current++;
      conversationHistoryRef.current = [];
      conversationHistoryPartitionRef.current = null;
      conversationVerifiedPartitionRef.current = null;
      askAbortControllerRef.current?.abort(new DOMException('会话上下文已更改', 'AbortError'));
      void refreshCitationPartition(true);
    };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', refresh);
    window.addEventListener('rag-auth-change', invalidate);
    window.addEventListener('rag-corpus-change', invalidate);
    return () => {
      citationMountedRef.current = false;
      citationIdentityRequestRef.current?.abort();
      window.removeEventListener('focus', refresh);
      window.removeEventListener('storage', refresh);
      window.removeEventListener('rag-auth-change', invalidate);
      window.removeEventListener('rag-corpus-change', invalidate);
    };
  }, [refreshCitationPartition]);

  useEffect(() => {
    if (modelConfig?.llm.provider !== 'ollama') return;
    const controller = new AbortController();
    const model = llmModel;
    let inFlight = false;
    let wasHidden = document.visibilityState !== 'visible';
    let refreshTimer: number | undefined;
    const clearRefreshTimer = () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = undefined;
    };
    const refresh = async () => {
      if (controller.signal.aborted || inFlight) return;
      if (document.visibilityState !== 'visible') { wasHidden = true; return; }
      clearRefreshTimer();
      inFlight = true;
      let ready = false;
      try {
        const response = await fetch('/rag-api/model-warmup', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ llmModel: model, embeddingModel }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        });
        let data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || '模型预加载未完成。');
        const pollingDeadline = Date.now() + 620_000;
        while (data.readiness?.phase === 'loading' && !controller.signal.aborted && Date.now() < pollingDeadline) {
          await new Promise<void>(resolve => {
            const finish = () => { window.clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve(); };
            const timer = window.setTimeout(finish, 2000);
            controller.signal.addEventListener('abort', finish, { once: true });
          });
          if (controller.signal.aborted) return;
          const status = await fetch(`/rag-api/model-warmup?model=${encodeURIComponent(model)}&embeddingModel=${encodeURIComponent(embeddingModel)}`, {
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]), cache: 'no-store',
          });
          data = await status.json();
          if (!status.ok || !data.success) throw new Error(data.error || '读取模型加载状态失败。');
        }
        if (data.readiness?.phase !== 'ready' || data.readiness.model !== model) {
          throw new Error(data.readiness?.detail || '模型预加载未完成，请重试加载。');
        }
        if (controller.signal.aborted) return;
        ready = true;
        setModelReadinessResult({ key: modelWarmupKey, value: { model, phase: 'ready' } });
      } catch (error) {
        if (!controller.signal.aborted) setModelReadinessResult({ key: modelWarmupKey, value: { model, phase: 'failed',
          detail: error instanceof Error ? error.message : '模型预加载失败，请检查本地服务。' } });
      } finally {
        inFlight = false;
        if (ready && !controller.signal.aborted && document.visibilityState === 'visible') {
          refreshTimer = window.setTimeout(() => { void refresh(); }, 5 * 60_000);
        }
      }
    };
    const refreshOnReturn = () => {
      if (document.visibilityState !== 'visible') {
        wasHidden = true;
        clearRefreshTimer();
        return;
      }
      if (!wasHidden) return;
      wasHidden = false;
      void refresh();
    };
    document.addEventListener('visibilitychange', refreshOnReturn);
    window.addEventListener('focus', refreshOnReturn);
    void refresh();
    // Hiding only stops future work; another tab may share the existing load.
    // Selection changes/unmount still retire this client's stale responses.
    return () => {
      controller.abort();
      clearRefreshTimer();
      document.removeEventListener('visibilitychange', refreshOnReturn);
      window.removeEventListener('focus', refreshOnReturn);
    };
  }, [llmModel, embeddingModel, modelConfig?.llm.provider, modelWarmupKey]);

  useEffect(() => () => {
    askAbortControllerRef.current?.abort(
      new DOMException('页面已关闭', 'AbortError')
    );
  }, []);

  // 检查系统健康状态
  const checkSystemHealth = useCallback(async (): Promise<'enabled' | 'disabled' | 'unavailable' | 'publication'> => {
    try {
      const response = await fetch('/rag-api/health', { signal: AbortSignal.timeout(30_000) });
      const data = await response.json();
      // A transport error must not switch a known published session to probes
      // against mutable legacy indexes. An explicit healthy response may switch.
      const published = data.publication?.mode === 'active'
        || (data.success !== true && publicationModeRef.current);
      publicationModeRef.current = published;
      setPublicationMode(published);
      const disabled = data.vectorBackend?.disabled === true;
      setVectorBackendDisabled(disabled);
      if (disabled) {
        setMilvusConnected(false);
        setMilvusStats(null);
      }
      // 依赖服务未就绪时健康接口仍返回模型配置，避免显示过期的默认模型。
      if (data.modelConfig) {
        const activeConfig = resolveSessionModelConfig(data.modelConfig, sessionLlmSelectionRef.current);
        if (activeConfig === data.modelConfig) sessionLlmSelectionRef.current = null;
        setLlmModel(activeConfig.llm.model);
        setEmbeddingModel(activeConfig.embedding.model);
        // 保存完整的 modelConfig 用于 SystemInfo 组件
        setModelConfig(activeConfig);
        // 如果有嵌入维度信息，也更新
        if (data.modelConfig.embedding?.dimension) {
          setEmbeddingDim(data.modelConfig.embedding.dimension);
        }
      }
      if (data.success) {
        setSystemStatus(published ? '发布目录就绪' : disabled ? '知识库维护中' : '运行中');
        setDocCount(data.ragSystem?.documentCount || 0);
        setEmbeddingDim(data.modelConfig?.embedding?.dimension || data.ragSystem?.embeddingDimension || 0);
      } else {
        setSystemStatus('错误');
        return published ? 'publication' : 'unavailable';
      }
      return published ? 'publication' : disabled ? 'disabled' : 'enabled';
    } catch (error) {
      setSystemStatus('错误');
      setVectorBackendDisabled(false);
      return publicationModeRef.current ? 'publication' : 'unavailable';
    }
  }, []);

  // 检查 Milvus 状态
  const checkMilvusStatus = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch('/rag-api/milvus?action=status');
      const data = await response.json();
      if (data.success) {
        const disabled = data.disabled === true;
        setVectorBackendDisabled(disabled);
        const connected = !disabled && Boolean(data.connected);
        setMilvusConnected(connected);
        setMilvusStats(data.stats);
        return connected;
      } else {
        setMilvusConnected(false);
        return false;
      }
    } catch (error) {
      setMilvusConnected(false);
      return false;
    }
  }, []);

  const refreshDocumentCounts = useCallback((invalidate = false): Promise<void> => {
    // Focus and visibility often arrive together. Only a scope change should
    // replace an authorized read; aborting ordinary refreshes repeats server work.
    if (!invalidate && documentCountsRefreshRef.current) return documentCountsRefreshRef.current;
    documentCountsRequestRef.current?.abort();
    const controller = new AbortController();
    documentCountsRequestRef.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    const refresh = Promise.resolve().then(async () => {
      try {
        await waitForCitationIdentity(signal);
        signal.throwIfAborted();
        const partition = conversationVerifiedPartitionRef.current;
        const identityRevision = conversationHistoryRevisionRef.current;
        if (!partition) { setDocumentCounts(null); return; }
        const response = await fetch('/rag-api/documents', { cache: 'no-store', signal });
        const data = await response.json();
        await waitForCitationIdentity(signal);
        if (!controller.signal.aborted) {
          setDocumentCounts(!signal.aborted && partition === conversationVerifiedPartitionRef.current
            && identityRevision === conversationHistoryRevisionRef.current && response.ok && data.success === true
            ? parseDocumentChunkCounts(data.summary) : null);
        }
      } catch {
        // Storage counts cannot substitute for an unavailable visibility-aware count.
        if (!controller.signal.aborted) setDocumentCounts(null);
      } finally {
        if (documentCountsRequestRef.current === controller) {
          documentCountsRequestRef.current = null;
          documentCountsRefreshRef.current = null;
        }
      }
    });
    documentCountsRefreshRef.current = refresh;
    return refresh;
  }, [waitForCitationIdentity]);

  useEffect(() => {
    // Storage/focus can reveal a new account without a rag-auth-change event.
    // Refill counts only after that identity has been verified.
    if (citationAccessStatus !== 'loading' && conversationVerifiedPartitionRef.current) void refreshDocumentCounts();
  }, [citationAccessStatus, citationPartition, refreshDocumentCounts]);

  const refreshRuntimeStatus = useCallback(() => Promise.all([checkSystemHealth(), refreshDocumentCounts()]).then(async ([runtimeStatus]) => {
    // /api/health 在 Elasticsearch 或 PostgreSQL 未就绪时也返回 503，此时 Milvus
    // 可能完好；徽标只应反映 Milvus 自身探测结果，仅显式维护模式才跳过探测。
    if (runtimeStatus !== 'disabled' && runtimeStatus !== 'publication') await checkMilvusStatus();
    setRuntimeStatusLoaded(true);
  }), [checkMilvusStatus, checkSystemHealth, refreshDocumentCounts]);

  const handleRuntimeStatusRefresh = () => {
    setRuntimeStatusLoaded(false);
    void refreshRuntimeStatus();
  };

  useEffect(() => {
    const refresh = () => { void refreshDocumentCounts(); };
    const refreshVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    const invalidate = () => { setDocumentCounts(null); void refreshDocumentCounts(true); };
    // Disabling documents in another tab must update every home counter on return.
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    window.addEventListener('rag-auth-change', invalidate);
    window.addEventListener('rag-corpus-change', invalidate);
    const interval = window.setInterval(refreshVisible, 30_000);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.removeEventListener('rag-auth-change', invalidate);
      window.removeEventListener('rag-corpus-change', invalidate);
      documentCountsRequestRef.current?.abort();
      documentCountsRequestRef.current = null;
      documentCountsRefreshRef.current = null;
    };
  }, [refreshDocumentCounts]);

  // 处理模型切换
  const handleModelChange = async (newLlmModel: string, newEmbeddingModel: string, onProgress?: (message: string) => void) => {
    if (newLlmModel === llmModel && newEmbeddingModel === embeddingModel) {
      showToast('模型未做任何更改', 'info');
      return;
    }

    const data = await requestSessionModelSelection(newLlmModel, newEmbeddingModel, fetch, onProgress);
    const activeConfig: SessionModelConfig = {
      ...data.config,
      embedding: { ...data.config.embedding, dimension: data.config.embedding.dimension ?? modelConfig?.embedding.dimension ?? embeddingDim },
    };

    sessionLlmSelectionRef.current = {
      provider: data.config.llm.provider,
      serverModel: data.defaultLlmModel,
      model: data.config.llm.model,
    };
    setLlmModel(data.config.llm.model);
    setEmbeddingModel(data.config.embedding.model);
    setEmbeddingDim(activeConfig.embedding.dimension);
    setModelConfig(activeConfig);
    setRuntimeStatusLoaded(false);
    await refreshRuntimeStatus();
    showToast(`已应用模型：${data.config.llm.model}；向量模型：${data.config.embedding.model}`, 'success');
  };

  // Toast 通知
  const showToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = Date.now().toString();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  }, []);

  // 高亮匹配文本
  const highlightMatchingText = (content: string, query: string) => {
    if (!query || query.length < 2) return content.substring(0, 200) + '...';
    const keywords = query.toLowerCase().split(/\s+/).filter(word => word.length > 1);
    let highlighted = content;
    keywords.forEach(keyword => {
      const regex = new RegExp(`(${keyword})`, 'gi');
      highlighted = highlighted.replace(regex, '<mark class="bg-yellow-200">$1</mark>');
    });
    return highlighted.length > 200 ? highlighted.substring(0, 200) + '...' : highlighted;
  };

  // 保存消息到 IndexedDB
  const saveMessageToDB = async (message: ConversationMessage) => {
    const generation = dbManager.captureCitationWriteGeneration();
    const invalidationRevision = citationInvalidationRevisionRef.current;
    try {
      console.log('[IndexedDB] 保存消息:', message.id, message.type);
      await dbManager.init();

      if (!currentConversationId) {
        console.log('[IndexedDB] 创建新对话');
        const conversation = await dbManager.createNewConversation(
          message.content.substring(0, 50) + (message.content.length > 50 ? '...' : '')
        );
        setCurrentConversationId(conversation.id);
        console.log('[IndexedDB] 新对话 ID:', conversation.id);
      }

      if (currentConversationId) {
        // 确保时间戳是 Date 对象
        const messageToSave: ConversationMessage = {
          ...message,
          citations: invalidationRevision === citationInvalidationRevisionRef.current ? message.citations : undefined,
          timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp)
        };

        await dbManager.addMessageToConversation(currentConversationId, messageToSave, generation);
        console.log('[IndexedDB] 消息已保存到对话:', currentConversationId);
      }
    } catch (error) {
      console.error('[IndexedDB] 保存消息到数据库失败:', error);
      showToast('保存消息失败: ' + (error instanceof Error ? error.message : String(error)), 'error');
    }
  };

  // Initialize external status and restore the latest persisted conversation.
  useEffect(() => {
    void refreshRuntimeStatus();
    const invalidationRevision = citationInvalidationRevisionRef.current;
    // getLatestConversation already enumerates the store. A second full read
    // solely for debug logging doubles startup IO for long conversation histories.
    void dbManager.init().then(() => dbManager.getLatestConversation()).then(latestConv => {
      // Restoring a different conversation must not retain or complete a turn
      // from the session that was visible while IndexedDB was loading.
      conversationHistoryRevisionRef.current++;
      conversationHistoryRef.current = [];
      askAbortControllerRef.current?.abort(new DOMException('会话已切换', 'AbortError'));

      if (latestConv) {
        console.log(`[IndexedDB] 找到最新对话: ${latestConv.id}`);
        console.log(`[IndexedDB] 对话消息数: ${latestConv.messages?.length || 0}`);

        if (latestConv.messages && latestConv.messages.length > 0) {
          setCurrentConversationId(latestConv.id);

          // 确保时间戳正确转换
          const restoredMessages: Message[] = latestConv.messages.map((msg, index) => {
            const timestamp = msg.timestamp instanceof Date
              ? msg.timestamp
              : new Date(msg.timestamp);

            console.log(`[IndexedDB] 消息 ${index + 1}: ${msg.type}, ID=${msg.id}, 内容长度=${msg.content?.length || 0}`);

            return {
              id: msg.id,
              type: msg.type,
              content: msg.content,
              timestamp,
              traceId: msg.traceId,
              storageBackend: msg.storageBackend,
              retrievalDetails: msg.retrievalDetails || null,
              queryAnalysis: msg.queryAnalysis || null,
              processingDetails: msg.processingDetails,
              citations: invalidationRevision === citationInvalidationRevisionRef.current
                ? projectMessageCitations(msg.citations, citationPartitionRef.current,
                  citationClockOffsetRef.current === null ? null : Date.now() - citationClockOffsetRef.current)
                : undefined,
            };
          });

          setMessages(restoredMessages);
          console.log(`[IndexedDB] 已恢复 ${restoredMessages.length} 条消息到界面`);

          // 恢复最后一条助手消息的检索详情
          const lastAssistantMessage = restoredMessages
            .filter(m => m.type === 'assistant' && m.retrievalDetails)
            .pop();
          if (lastAssistantMessage?.retrievalDetails) {
            setRetrievalDetails(lastAssistantMessage.retrievalDetails);
            console.log('[IndexedDB] 已恢复检索详情');
          }

          // 恢复最后一条用户消息的查询分析
          const lastUserMessage = restoredMessages
            .filter(m => m.type === 'user' && m.queryAnalysis)
            .pop();
          if (lastUserMessage?.queryAnalysis) {
            setQueryAnalysis(lastUserMessage.queryAnalysis);
            setShowQueryAnalysis(true);
            if (lastUserMessage.queryAnalysis.embedding?.semanticAnalysis?.vectorFeatures) {
              setRadarChartData(lastUserMessage.queryAnalysis.embedding.semanticAnalysis.vectorFeatures);
            }
            console.log('[IndexedDB] 已恢复查询分析数据');
          }

          showToast(`已恢复 ${restoredMessages.length} 条历史消息`, 'success');
        } else {
          console.warn('[IndexedDB] 对话存在但没有消息');
          setCurrentConversationId(latestConv.id);
          setMessages([]);
        }
      } else {
        console.log('[IndexedDB] 没有找到历史对话');
        setMessages([]);
        setCurrentConversationId(null);
        setQueryAnalysis(null);
        setRadarChartData(null);
        setRetrievalDetails(null);
        setShowQueryAnalysis(false);
        // 清空对话延伸引擎相关状态
        setSuggestedQuestions([]);
        setSuggestionAnchor(null);
        setSuggestionTimings(null);
        setLastUserQuery('');
        setLastAiResponse('');
      }
    }).catch(error => {
      console.error('[IndexedDB] 加载历史对话失败:', error);
      console.error('[IndexedDB] 错误详情:', error instanceof Error ? error.stack : String(error));
      showToast('加载历史对话失败: ' + (error instanceof Error ? error.message : String(error)), 'error');
      // 即使失败，也清空状态
      conversationHistoryRevisionRef.current++;
      conversationHistoryRef.current = [];
      askAbortControllerRef.current?.abort(new DOMException('会话加载失败', 'AbortError'));
      setMessages([]);
      setCurrentConversationId(null);
      // 清空对话延伸引擎相关状态
      setSuggestedQuestions([]);
      setSuggestionAnchor(null);
      setSuggestionTimings(null);
      setLastUserQuery('');
      setLastAiResponse('');
    });
  }, [refreshRuntimeStatus, showToast]);

  // 一键删除所有对话
  const handleDeleteAllConversations = async () => {
    if (!confirm('确定要删除所有对话记录吗？此操作不可恢复！')) return;

    try {
      await dbManager.init();
      await dbManager.deleteAllConversations();
      conversationHistoryRevisionRef.current++;
      conversationHistoryRef.current = [];
      askAbortControllerRef.current?.abort(new DOMException('会话已删除', 'AbortError'));
      setMessages([]);
      setCurrentConversationId(null);
      setViewingAnalysisFor(null);
      setQueryAnalysis(null);
      setRadarChartData(null);
      setRetrievalDetails(null);
      setActiveProcessing(null);
      
      // 清空对话延伸引擎相关状态
      setSuggestedQuestions([]);
      setSuggestionAnchor(null);
      setIsSuggestionsLoading(false);
      setSuggestionTimings(null);
      setSuggestionProcessingTime(0);
      setLastUserQuery('');
      setLastAiResponse('');
      
      showToast('所有对话已删除', 'success');
    } catch (error) {
      console.error('删除所有对话失败:', error);
      showToast('删除失败', 'error');
    }
  };

  // 生成模拟 Token（智能分词）
  const generateMockTokens = (text: string) => {
    const tokens: QueryToken[] = [];
    // 使用简单规则分词：中文按字符，英文按单词，数字按连续数字
    const pattern = /[\u4e00-\u9fff]|[a-zA-Z]+|[0-9]+|[.,!?:;()\-？！。，、；：（）]/g;
    let match;
    let tokenId = 1000;
    
    while ((match = pattern.exec(text)) !== null) {
      const token = match[0];
      tokens.push({
        token: token,
        tokenId: tokenId++,
        type: /[\u4e00-\u9fff]/.test(token) ? 'chinese' :
          /[a-zA-Z]/.test(token) ? 'english' :
          /[0-9]/.test(token) ? 'number' :
          /[.,!?:;()\-？！。，、；：（）]/.test(token) ? 'punctuation' : 'special'
      });
    }
    return tokens;
  };
  
  // 生成基于实体和关键词的增强 Token
  const generateEnhancedTokens = (text: string, entities?: Array<{ name: string; type?: string; confidence?: number }>, keywords?: string[]) => {
    const MAX_TOKENS = 100; // 限制最大 Token 数量
    const tokens: QueryToken[] = [];
    let tokenId = 1000;
    
    // 安全检查：限制输入长度
    const safeText = (text || '').slice(0, 500);
    if (!safeText) return tokens;
    
    // 收集实体和关键词，过滤无效值
    const specialTerms = new Set<string>();
    if (entities && Array.isArray(entities)) {
      entities.forEach(e => {
        if (e?.name && typeof e.name === 'string' && e.name.trim()) {
          specialTerms.add(e.name.trim());
        }
      });
    }
    if (keywords && Array.isArray(keywords)) {
      keywords.forEach(k => {
        if (k && typeof k === 'string' && k.trim()) {
          specialTerms.add(k.trim());
        }
      });
    }
    
    // 排序，长的优先匹配，过滤空字符串
    const sortedTerms = Array.from(specialTerms)
      .filter(t => t.length > 0)
      .sort((a, b) => b.length - a.length);
    
    let remaining = safeText;
    let iterations = 0;
    const MAX_ITERATIONS = 1000; // 防止无限循环
    
    while (remaining.length > 0 && tokens.length < MAX_TOKENS && iterations < MAX_ITERATIONS) {
      iterations++;
      let matched = false;
      
      // 尝试匹配特殊词
      for (const term of sortedTerms) {
        if (term && remaining.startsWith(term)) {
          const entity = entities?.find(e => e?.name === term);
          tokens.push({
            token: term,
            tokenId: tokenId++,
            type: entity ? 'entity' : 'keyword',
            entityType: entity?.type,
            confidence: entity?.confidence,
          });
          remaining = remaining.slice(term.length);
          matched = true;
          break;
        }
      }
      
      if (!matched) {
        const char = remaining[0];
        // 空白字符跳过
        if (/\s/.test(char)) {
          remaining = remaining.slice(1);
          continue;
        }
        
        const type = /[\u4e00-\u9fff]/.test(char) ? 'chinese' :
          /[a-zA-Z]/.test(char) ? 'english' :
          /[0-9]/.test(char) ? 'number' :
          /[.,!?:;()\-？！。，、；：（）]/.test(char) ? 'punctuation' : 'special';
        
        tokens.push({
          token: char,
          tokenId: tokenId++,
          type: type,
        });
        remaining = remaining.slice(1);
      }
    }
    
    return tokens;
  };

  // 生成推荐问题（异步调用，不阻塞主流程）
  const generateSuggestedQuestions = async (
    userQuery: string,
    aiResponse: string,
    contextChunks: ChatSearchResult[]
  ) => {
    setIsSuggestionsLoading(true);
    setSuggestedQuestions([]);
    setSuggestionAnchor(null);
    setLastUserQuery(userQuery);
    setLastAiResponse(aiResponse);
    setSuggestionProcessingTime(0);

    try {
      const response = await fetch('/rag-api/conversation-expansion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'expand',
          userQuery,
          aiResponse,
          contextChunks: contextChunks.map(chunk => ({
            id: chunk.id || chunk.document?.id,
            content: chunk.content || chunk.document?.pageContent || chunk.document?.content,
            metadata: chunk.metadata || chunk.document?.metadata,
            score: chunk.score,
          })),
          llmModel,
          maxSuggestions: 5,
          enableValidation: true,
        }),
      });

      const data = await response.json();
      
      if (data.success) {
        setSuggestedQuestions(data.suggestions || []);
        setSuggestionAnchor(data.anchor);
        setSuggestionTimings(data.timings);
        setSuggestionProcessingTime(data.processingTime || 0);
        console.log('[Suggestions] Generated:', data.suggestions?.length, 'questions');
      } else {
        console.error('[Suggestions] Error:', data.error);
      }
    } catch (error) {
      console.error('[Suggestions] Failed:', error);
    } finally {
      setIsSuggestionsLoading(false);
    }
  };

  // 处理推荐问题点击
  const handleSuggestionClick = (question: string) => {
    setInput(question);
  };
  const handleCancelRequest = () => {
    askAbortControllerRef.current?.abort(new DOMException('用户已取消请求', 'AbortError'));
  };


  const handleSendQuestion = async (question: string, userMessageId: string, isRetry = false) => {
    const submittedQuestion = question.trim();
    if (!submittedQuestion || isLoading || askAbortControllerRef.current) return;
    if (isRetry && (userMessageId !== latestUserMessageId
      || !messages.some(message => message.id === userMessageId
        && message.type === 'user' && message.retryStatus === 'failed'))) return;
    const citationInvalidationRevision = citationInvalidationRevisionRef.current;
    const historyRevision = conversationHistoryRevisionRef.current;
    const userMessage: Message = {
      id: userMessageId,
      type: 'user',
      content: submittedQuestion,
      timestamp: new Date()
    };

    if (isRetry) {
      // Reuse the failed turn so retries never duplicate the question or stale error.
      setMessages(prev => prev.filter(message => message.id !== `${userMessageId}-error`)
        .map(message => message.id === userMessageId ? { ...message, retryStatus: 'retrying' as const } : message));
    } else {
      setMessages(prev => [...prev, userMessage]);
    }
    setCurrentQuery(submittedQuestion);
    // The client cannot know whether the server will use direct or RAG routing.
    setActiveProcessing({
      version: 'answer-processing/v1', mode: 'rag', retrievalSkipped: false,
      summary: '正在等待服务端判断处理路径。',
      disclosure: '最终处理阶段和是否检索以服务端返回结果为准。',
      steps: [{ id: 'route', label: '处理请求', detail: '正在等待服务端处理。', status: 'active' }],
    });
    setIsLoading(true);
    setShowQueryAnalysis(false);
    setShowQueryProcessing(true);

    const requestController = new AbortController();
    const requestTimeoutSignal = AbortSignal.timeout(RAG_CLIENT_REQUEST_TIMEOUT_MS);
    const requestSignal = AbortSignal.any([
      requestController.signal,
      requestTimeoutSignal,
    ]);
    askAbortControllerRef.current = requestController;
    const discardDraft = () => clearAnswerDraft(requestController);
    requestSignal.addEventListener('abort', discardDraft, { once: true });
    setIsRequestSlow(false);
    const slowHintTimer = window.setTimeout(() => setIsRequestSlow(true), ASK_SLOW_HINT_MS);
    try {
      if (!isRetry) await saveMessageToDB({
        id: userMessageId,
        type: 'user',
        content: submittedQuestion,
        timestamp: new Date()
      });
      await waitForCitationIdentity(requestSignal);
      if (requestSignal.aborted || historyRevision !== conversationHistoryRevisionRef.current) {
        throw new DOMException('会话上下文已更改或请求已取消', 'AbortError');
      }
      const historyPartition = conversationVerifiedPartitionRef.current;
      if (!historyPartition || historyPartition !== conversationHistoryPartitionRef.current) {
        throw new Error('无法验证会话身份，请稍后重试。');
      }
      const conversationHistory = conversationHistoryRef.current.map(item => ({ ...item }));
      answerDraftRef.current = { controller: requestController, signal: requestSignal,
        historyRevision, partition: historyPartition, text: '', timer: null };

      // 清空之前的 Agentic RAG 状态
      if (useAgenticRAG) {
        setAgenticWorkflow(null);
        setAgenticQueryAnalysis(null);
        setAgenticRetrievalQuality(null);
        setAgenticSelfReflection(null);
        setAgenticHallucinationCheck(null);
        setAgenticRetrievalGrade(null);
        setAgenticDebugInfo(null);
        setShowAgenticPanel(false);
      }

      // 清空之前的自适应实体 RAG 状态
      if (useAdaptiveEntityRAG) {
        setAdaptiveEntityWorkflow(null);
        setAdaptiveEntityQueryAnalysis(null);
        setAdaptiveEntityValidation(null);
        setAdaptiveEntityRoutingDecision(null);
        setAdaptiveEntityRetrievalDetails(null);
        setShowAdaptiveEntityPanel(false);
      }

      const response = await readAskProgressResponse(await fetch('/rag-api/ask', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          ...(historyPartition
            ? { 'x-rag-conversation-partition': historyPartition } : {}),
        },
        signal: requestSignal,
        body: JSON.stringify({
          question: submittedQuestion,
          conversationHistory,
          topK,
          similarityThreshold: threshold,
          llmModel,
          embeddingModel,
          userId: 'demo-user',
          sessionId: 'demo-session',
          storageBackend,
          useAgenticRAG: useAgenticRAG && storageBackend === 'milvus' && !useAdaptiveEntityRAG, // 只有 Milvus 后端支持 Agentic RAG
          useAdaptiveEntityRAG: useAdaptiveEntityRAG && storageBackend === 'milvus', // 只有 Milvus 后端支持自适应实体 RAG
          maxRetries: 2,
          enableReranking: true,
        }),
      }), { signal: requestSignal, onProgress: progress => {
        if (requestSignal.aborted || historyRevision !== conversationHistoryRevisionRef.current) return;
        setActiveProcessing({ version: 'answer-processing/v1', mode: 'rag', retrievalSkipped: false,
          summary: progress.label,
          disclosure: '完整回答和引用将在校验完成后保存。',
          steps: [{ id: progress.stage, label: progress.label, detail: '服务端正在处理。', status: 'active' }],
        });
      }, onAnswerDelta: delta => {
        const draft = answerDraftRef.current;
        if (!draft || draft.controller !== requestController || askAbortControllerRef.current !== requestController
          || requestSignal.aborted || historyRevision !== conversationHistoryRevisionRef.current) return;
        draft.text += delta.text;
        if (draft.timer === null) draft.timer = window.setTimeout(flushAnswerDraft, ANSWER_DRAFT_RENDER_MS);
      } });

      clearAnswerDraft(requestController);

      const data = await response.json();
      // A same-account refresh must not cancel a long request. Do not expose
      // its response until every concurrent identity check has settled.
      await waitForCitationIdentity(requestSignal);
      if (requestSignal.aborted || historyRevision !== conversationHistoryRevisionRef.current) {
        throw new DOMException('会话上下文已更改或请求已取消', 'AbortError');
      }
      if (response.status === 409 && data.code === 'CONVERSATION_PARTITION_MISMATCH') {
        conversationHistoryRef.current = [];
        conversationHistoryPartitionRef.current = null;
        showToast('会话身份已变更，请重新提问。', 'error');
        void refreshCitationPartition(true);
        return;
      }

      console.log('data', data);
      if (data.conversationMode === 'direct') {
        setShowAgenticPanel(false);
        setShowAdaptiveEntityPanel(false);
      }

      // 处理自适应实体 RAG 响应
      if (data.adaptiveEntityMode) {
        setShowAdaptiveEntityPanel(true);
        setAdaptiveEntityWorkflow(data.workflow);
        setAdaptiveEntityQueryAnalysis(data.queryAnalysis);
        setAdaptiveEntityValidation(data.entityValidation);
        setAdaptiveEntityRoutingDecision(data.routingDecision);
        setAdaptiveEntityRetrievalDetails(data.retrievalDetails);
      }

      // 处理 Agentic RAG 响应
      if (data.agenticMode) {
        setShowAgenticPanel(true);
        setAgenticWorkflow(data.workflow);
        setAgenticQueryAnalysis(data.queryAnalysis);
        setAgenticRetrievalQuality(data.retrievalDetails?.quality);
        setAgenticSelfReflection(data.retrievalDetails?.selfReflection);
        setAgenticHallucinationCheck(data.hallucinationCheck);
        setAgenticRetrievalGrade(data.retrievalGrade);
        setAgenticDebugInfo(data.debugInfo);
      }

      if (data.success) {
        let queryAnalysisData: ChatQueryAnalysis | null;
        const processingDetails = resolveAnswerProcessing(data) || undefined;
        // 重要：始终使用用户原始输入，防止 LLM 返回错误的 originalQuery
        const userOriginalInput = submittedQuestion;
        const canonicalCreateAgentResponse = data.agenticMode === true && (
          isCanonicalCreateAgentQueryAnalysis(data.queryAnalysis)
          || data.workflow?.runtime === 'langchain-create-agent-v1'
          || data.agent?.runtime === 'langchain-create-agent-v1'
        );
        
        // 直接对话没有执行向量化，不能伪造 token/vector 分析数据。
        if (data.conversationMode === 'direct') {
          queryAnalysisData = null;
          setRadarChartData(null);
          setSuggestedQuestions([]);
          setSuggestionAnchor(null);
          setSuggestionTimings(null);
        }
        // 处理自适应实体 RAG 模式的查询分析数据
        else if (data.adaptiveEntityMode && data.queryAnalysis) {
          const adaptiveAnalysis = data.queryAnalysis;
          // 使用增强的 Token 生成，突出显示实体和关键词
          const enhancedTokens = generateEnhancedTokens(
            userOriginalInput, 
            adaptiveAnalysis.entities, 
            adaptiveAnalysis.keywords
          );
          queryAnalysisData = {
            tokenization: {
              tokenCount: enhancedTokens.length,
              tokens: enhancedTokens,
              processingTime: data.workflow?.steps?.find((s: { step?: string; duration?: number }) => s.step?.includes('认知解析'))?.duration || 0,
              originalText: userOriginalInput
            },
            embedding: {
              embeddingDimension: 768,
              semanticAnalysis: {
                context: adaptiveAnalysis.intent === 'factual' ? '事实查询语境' :
                         adaptiveAnalysis.intent === 'exploratory' ? '探索性语境' :
                         adaptiveAnalysis.intent === 'comparison' ? '比较分析语境' :
                         adaptiveAnalysis.intent === 'conceptual' ? '概念理解语境' :
                         adaptiveAnalysis.intent === 'procedural' ? '操作指导语境' : '通用语境',
                semanticCategory: adaptiveAnalysis.intent || '一般',
                confidence: adaptiveAnalysis.confidence || 0.8,
                nearestConcepts: adaptiveAnalysis.keywords || [],
                vectorFeatures: {
                  techScore: adaptiveAnalysis.intent === 'factual' ? 0.7 : 0.4,
                  businessScore: 0.3,
                  dailyScore: adaptiveAnalysis.complexity === 'simple' ? 0.6 : 0.3,
                  emotionScore: 0.1,
                  vectorMagnitude: 1.2
                }
              }
            },
            // 保留原始自适应实体分析数据
            adaptiveEntityAnalysis: {
              originalQuery: adaptiveAnalysis.originalQuery,
              intent: adaptiveAnalysis.intent,
              complexity: adaptiveAnalysis.complexity,
              confidence: adaptiveAnalysis.confidence,
              entities: adaptiveAnalysis.entities,
              keywords: adaptiveAnalysis.keywords,
              logicalRelations: adaptiveAnalysis.logicalRelations
            }
          };
          setRadarChartData({
            techScore: adaptiveAnalysis.intent === 'factual' ? 0.7 : 0.4,
            businessScore: 0.3,
            dailyScore: adaptiveAnalysis.complexity === 'simple' ? 0.6 : 0.3,
            emotionScore: 0.1,
            vectorMagnitude: 1.2
          });
        }
        // Canonical createAgent 仅保留服务端已经计算的分析字段。
        // 它不包含 legacy token/vector 契约，因此不能为了旧 UI 伪造这些数据。
        else if (canonicalCreateAgentResponse) {
          queryAnalysisData = isCanonicalCreateAgentQueryAnalysis(data.queryAnalysis)
            ? data.queryAnalysis
            : null;
          setRadarChartData(null);
        }
        // 处理 legacy Agentic RAG 模式的查询分析数据
        else if (data.agenticMode && data.queryAnalysis) {
          // 将 Agentic RAG 的查询分析转换为标准格式
          const agenticAnalysis = data.queryAnalysis;
          queryAnalysisData = {
            tokenization: {
              tokenCount: agenticAnalysis.keywords?.length || Math.floor(userOriginalInput.length / 2),
              tokens: agenticAnalysis.keywords?.map((kw: string, i: number) => ({
                token: kw,
                tokenId: 1000 + i,
                type: /[\u4e00-\u9fff]/.test(kw) ? 'chinese' : 'english'
              })) || generateMockTokens(userOriginalInput),
              processingTime: data.workflow?.steps?.find((s: { step?: string; duration?: number }) => s.step === '查询分析与优化')?.duration || 0,
              // 始终使用用户原始输入，不信任 API 返回的 originalQuery（可能被 LLM 错误修改）
              originalText: userOriginalInput
            },
            embedding: {
              embeddingDimension: data.retrievalDetails?.searchResults?.[0]?.document?.metadata?.dimension || 768,
              semanticAnalysis: {
                context: agenticAnalysis.intent === 'factual' ? '事实查询语境' :
                         agenticAnalysis.intent === 'exploratory' ? '探索性语境' :
                         agenticAnalysis.intent === 'comparison' ? '比较分析语境' :
                         agenticAnalysis.intent === 'procedural' ? '操作指导语境' : '通用语境',
                semanticCategory: agenticAnalysis.intent || '一般',
                confidence: agenticAnalysis.confidence || 0.8,
                nearestConcepts: agenticAnalysis.keywords || [],
                vectorFeatures: {
                  techScore: agenticAnalysis.intent === 'factual' ? 0.7 : 0.4,
                  businessScore: 0.3,
                  dailyScore: agenticAnalysis.complexity === 'simple' ? 0.6 : 0.3,
                  emotionScore: 0.1,
                  vectorMagnitude: 1.2
                }
              }
            },
            // 保留原始 Agentic 分析数据
            agenticAnalysis: {
              originalQuery: agenticAnalysis.originalQuery,
              rewrittenQuery: agenticAnalysis.rewrittenQuery,
              intent: agenticAnalysis.intent,
              complexity: agenticAnalysis.complexity,
              needsRetrieval: agenticAnalysis.needsRetrieval,
              keywords: agenticAnalysis.keywords
            }
          };
          setRadarChartData({
            techScore: agenticAnalysis.intent === 'factual' ? 0.7 : 0.4,
            businessScore: 0.3,
            dailyScore: agenticAnalysis.complexity === 'simple' ? 0.6 : 0.3,
            emotionScore: 0.1,
            vectorMagnitude: 1.2
          });
        } else if (data.queryAnalysis) {
          // 普通模式的查询分析
          queryAnalysisData = data.queryAnalysis;
          if (data.queryAnalysis.embedding?.semanticAnalysis?.vectorFeatures) {
            setRadarChartData(data.queryAnalysis.embedding.semanticAnalysis.vectorFeatures);
          }
        } else {
          // 默认数据
          queryAnalysisData = {
            tokenization: {
              tokenCount: Math.floor(submittedQuestion.length / 2),
              tokens: generateMockTokens(submittedQuestion),
              processingTime: 15,
              originalText: submittedQuestion
            },
            embedding: {
              embeddingDimension: 768,
              semanticAnalysis: {
                context: submittedQuestion.includes('智能') ? '人工智能语境' : '通用语境',
                semanticCategory: submittedQuestion.includes('智能') ? 'AI技术' : '一般',
                confidence: 0.85,
                nearestConcepts: submittedQuestion.includes('智能')
                  ? ['人工智能', '机器学习', '深度学习']
                  : ['文本', '信息', '内容'],
                vectorFeatures: {
                  techScore: 0.7,
                  businessScore: 0.3,
                  dailyScore: 0.2,
                  emotionScore: 0.1,
                  vectorMagnitude: 1.2
                }
              }
            }
          };
          setRadarChartData({
            techScore: 0.7,
            businessScore: 0.3,
            dailyScore: 0.2,
            emotionScore: 0.1,
            vectorMagnitude: 1.2
          });
        }

        setMessages(prev => prev.map(msg =>
          msg.id === userMessageId
            ? { ...msg, queryAnalysis: queryAnalysisData }
            : msg
        ));

        if (currentConversationId) {
          try {
            const generation = dbManager.captureCitationWriteGeneration();
            await dbManager.init();
            const conversation = await dbManager.getConversation(currentConversationId);
            if (conversation) {
              const userMsgIndex = conversation.messages.findIndex(m => m.id === userMessageId);
              if (userMsgIndex !== -1) {
                conversation.messages[userMsgIndex].queryAnalysis = queryAnalysisData;
                conversation.updatedAt = new Date();
                await dbManager.saveConversation(conversation, generation);
              }
            }
          } catch (error) {
            console.error('更新用户消息分析数据失败:', error);
          }
        }

        // 安全提取回答内容，防止 LangChain 对象被传递给 React
        const answerContent = safeAnswerString(data.answer);
        await waitForCitationIdentity(requestSignal);
        if (requestSignal.aborted || historyRevision !== conversationHistoryRevisionRef.current) return;
        if (historyPartition && historyPartition === conversationVerifiedPartitionRef.current
          && historyPartition === conversationHistoryPartitionRef.current) {
          conversationHistoryRef.current = appendCompletedTurn(conversationHistoryRef.current, submittedQuestion, answerContent);
        }
        const citations = citationInvalidationRevision === citationInvalidationRevisionRef.current
          ? projectMessageCitations(data.citations, undefined,
            // eslint-disable-next-line react-hooks/purity -- Expiry is checked after the event's Ask response, outside rendering.
            citationClockOffsetRef.current === null ? null : Date.now() - citationClockOffsetRef.current)
          : undefined;
        if (citations && citations.partition !== citationPartitionRef.current) void refreshCitationPartition();
        
        const assistantMessage: Message = {
          // eslint-disable-next-line react-hooks/purity -- A completed request allocates its message ID in the submit/retry event.
          id: (Date.now() + 1).toString(),
          type: 'assistant',
          content: answerContent,
          timestamp: new Date(),
          traceId: data.traceId,
          storageBackend: data.storageBackend,
          retrievalDetails: data.retrievalDetails,
          processingDetails,
          citations,
        };

        setMessages(prev => [...prev.map(message => message.id === userMessageId
          ? { ...message, retryStatus: undefined } : message), assistantMessage]);
        setShowQueryAnalysis(true);
        setQueryAnalysis(queryAnalysisData);
        setRetrievalDetails(data.retrievalDetails || null);

        await saveMessageToDB({
          id: assistantMessage.id,
          type: 'assistant',
          content: answerContent,
          timestamp: new Date(),
          traceId: data.traceId,
          storageBackend: data.storageBackend,
          retrievalDetails: data.retrievalDetails,
          processingDetails,
          citations,
        });

        // 异步生成推荐问题（不阻塞主流程）
        if (enableSuggestions && data.retrievalDetails?.searchResults?.length > 0) {
          generateSuggestedQuestions(
            submittedQuestion,
            answerContent,
            data.retrievalDetails.searchResults
          );
        }
      } else {
        throw new Error(data.error || '请求失败');
      }
    } catch (error) {
      if (historyRevision !== conversationHistoryRevisionRef.current) {
        if (requestController.signal.reason instanceof DOMException
          && requestController.signal.reason.message === '会话身份无法验证') {
          setMessages(prev => [...prev.map(message => message.id === userMessageId
            ? { ...message, retryStatus: 'failed' as const } : message), {
            id: `${userMessageId}-error`, type: 'assistant',
            content: '无法验证会话身份，请稍后重试。', timestamp: new Date(),
          }]);
        }
        return;
      }
      console.error('Error:', error);
      const failureMessage = requestTimeoutSignal.aborted
        ? `请求超过 ${RAG_CLIENT_REQUEST_TIMEOUT_MS / 1000} 秒，已自动停止。建议切换到“模型选择”中的轻量模型后重试。`
        : requestController.signal.aborted
          ? '请求已取消。'
          : `抱歉，处理您的问题时出现了错误：${error instanceof Error ? error.message : '未知错误'}`;
      const errorMessage: Message = {
        id: `${userMessageId}-error`,
        type: 'assistant',
        content: failureMessage,
        timestamp: new Date()
      };
      setMessages(prev => [...prev.map(message => message.id === userMessageId
        ? { ...message, retryStatus: 'failed' as const } : message), errorMessage]);
    } finally {
      requestSignal.removeEventListener('abort', discardDraft);
      clearAnswerDraft(requestController);
      window.clearTimeout(slowHintTimer);
      if (isRetry) {
        // Identity/session changes may return before either the success or error path.
        setMessages(prev => prev.map(message => message.id === userMessageId && message.retryStatus === 'retrying'
          ? { ...message, retryStatus: 'failed' as const } : message));
      }
      if (askAbortControllerRef.current === requestController) {
        askAbortControllerRef.current = null;
      }
      setIsRequestSlow(false);
      setActiveProcessing(null);
      setIsLoading(false);
      if (!isRetry) setInput('');
      setShowQueryProcessing(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // eslint-disable-next-line react-hooks/purity -- This clock is read only by the native form submission handler.
    await handleSendQuestion(input, Date.now().toString());
  };

  // 雷达图配置
  const getRadarChartOption = () => {
    if (!radarChartData) return null;

    return {
      title: {
        text: '向量特征分析',
        left: 'center',
        textStyle: { fontSize: 12, color: '#374151' }
      },
      tooltip: { trigger: 'item' },
      radar: {
        indicator: [
          { name: '技术特征', max: 1 },
          { name: '商业特征', max: 1 },
          { name: '日常特征', max: 1 },
          { name: '情感倾向', max: 1, min: -1 },
          { name: '向量强度', max: Math.max(1, radarChartData.vectorMagnitude || 1) }
        ],
        radius: '60%',
        axisName: { fontSize: 10, color: '#6B7280' },
        splitLine: { lineStyle: { color: '#E5E7EB' } },
        axisLine: { lineStyle: { color: '#D1D5DB' } }
      },
      series: [{
        name: '向量特征',
        type: 'radar',
        data: [{
          value: [
            radarChartData.techScore || 0,
            radarChartData.businessScore || 0,
            radarChartData.dailyScore || 0,
            radarChartData.emotionScore || 0,
            (radarChartData.vectorMagnitude || 0) / Math.max(1, radarChartData.vectorMagnitude || 1)
          ],
          name: '当前查询',
          itemStyle: { color: '#3B82F6' },
          areaStyle: { color: 'rgba(59, 130, 246, 0.2)' }
        }]
      }]
    };
  };

  // 获取当前查看的分析数据
  const getCurrentAnalysis = () => {
    if (viewingAnalysisFor) {
      const message = messages.find(m => m.id === viewingAnalysisFor);
      return message?.queryAnalysis;
    }
    return queryAnalysis;
  };
  const currentAnalysis = getCurrentAnalysis();

  return (
    <div className="bg-gray-50 min-h-screen">
      <HomeHeader
        vectorBackendDisabled={vectorBackendDisabled}
        milvusConnected={milvusConnected}
        publicationMode={publicationMode}
        showRagModes={storageBackend === 'milvus' && !vectorBackendDisabled && !publicationMode}
        useAgenticRAG={useAgenticRAG}
        useAdaptiveEntityRAG={useAdaptiveEntityRAG}
        systemStatus={systemStatus}
        onToggleAgentic={() => {
          setUseAgenticRAG(!useAgenticRAG);
          if (!useAgenticRAG) {
            setShowAgenticPanel(true);
            setUseAdaptiveEntityRAG(false);
          }
        }}
        onToggleEntity={() => {
          setUseAdaptiveEntityRAG(!useAdaptiveEntityRAG);
          if (!useAdaptiveEntityRAG) {
            setShowAdaptiveEntityPanel(true);
            setUseAgenticRAG(false);
          }
        }}
        onClearConversations={handleDeleteAllConversations}
        onRefreshStatus={handleRuntimeStatusRefresh}
      />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Milvus 查询可视化 - 当选择 Milvus 后端时显示 */}
        {runtimeStatusLoaded && !publicationMode && storageBackend === 'milvus' && !vectorBackendDisabled && systemStatus === '运行中' && !useAgenticRAG && !useAdaptiveEntityRAG && (
          <MilvusQueryVisualizer
            embeddingModel={embeddingModel}
            documentCounts={documentCounts}
            defaultExpanded={false}
          />
        )}

        {/* Agentic RAG 工作流面板 - 当启用 Agentic RAG 时显示 */}
        {storageBackend === 'milvus' && !vectorBackendDisabled && useAgenticRAG && showAgenticPanel && (
          <div className="mb-6 space-y-4">
            <AgenticWorkflowPanel
              workflow={agenticWorkflow ?? undefined}
              queryAnalysis={agenticQueryAnalysis ?? undefined}
              retrievalQuality={agenticRetrievalQuality ?? undefined}
              selfReflection={agenticSelfReflection ?? undefined}
              hallucinationCheck={agenticHallucinationCheck ?? undefined}
              isLoading={isLoading}
              className="shadow-lg"
            />
            
            {/* LangSmith 追踪可视化 */}
            {agenticWorkflow?.steps && agenticWorkflow.steps.length > 0 && (
              <LangSmithTraceViewer
                workflowSteps={agenticWorkflow.steps}
                queryAnalysis={agenticQueryAnalysis ?? undefined}
                retrievalGrade={agenticRetrievalGrade ?? undefined}
                debugInfo={agenticDebugInfo ?? undefined}
                totalDuration={agenticWorkflow.totalDuration}
                defaultExpanded={false}
                className="shadow-lg"
              />
            )}
          </div>
        )}

        {/* 自适应实体路由 RAG 工作流面板 - 当启用自适应实体 RAG 时显示 */}
        {storageBackend === 'milvus' && !vectorBackendDisabled && useAdaptiveEntityRAG && showAdaptiveEntityPanel && (
          <div className="mb-6">
            <AdaptiveEntityWorkflowPanel
              workflow={adaptiveEntityWorkflow ?? undefined}
              queryAnalysis={adaptiveEntityQueryAnalysis ?? undefined}
              entityValidation={adaptiveEntityValidation ?? undefined}
              routingDecision={adaptiveEntityRoutingDecision ?? undefined}
              retrievalDetails={adaptiveEntityRetrievalDetails ?? undefined}
              isLoading={isLoading}
              className="shadow-lg"
              defaultExpanded={false}
              onClose={() => setShowAdaptiveEntityPanel(false)}
            />
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 主聊天区域 */}
          <div className="min-w-0 lg:col-span-2">
            <div className="bg-white rounded-lg shadow-sm border">
              {/* 聊天头部 */}
              <div className="border-b px-6 py-4">
                <h2 className="text-lg font-medium text-gray-900">智能问答</h2>
                <p className="text-sm text-gray-500 mt-1">向知识库提问，获得基于文档的准确回答</p>
              </div>

              {/* 聊天消息区域 */}
              <ResizableChatArea>
                {messages.length === 0 ? (
                  <div className="text-center text-gray-500 text-sm">
                    <i className={`fas ${vectorBackendDisabled ? 'fa-pause-circle text-amber-500' : 'fa-comments'} text-2xl mb-2`}></i>
                    <p>
                      {vectorBackendDisabled
                        ? '知识库维护中：文档检索暂不可用，但仍可以发送问候。'
                        : '开始提问吧！我会根据已上传的文档来回答您的问题。'}
                    </p>
                  </div>
                ) : (
                  messages.map((message) => (
                    <ChatMessage
                      key={message.id}
                      message={message}
                      currentQuery={currentQuery}
                      highlightMatchingText={highlightMatchingText}
                      citationPartition={citationPartition}
                      citationAccessStatus={citationAccessStatus}
                      citationClockOffsetMs={citationClockOffsetMs}
                      onRetry={message.id === latestUserMessageId && message.type === 'user' && message.retryStatus
                        ? () => handleSendQuestion(message.content, message.id, true) : undefined}
                      retryDisabled={isLoading}
                      isRetrying={message.retryStatus === 'retrying'}
                    />
                  ))
                )}

                {isLoading && answerDraft && (
                  <section aria-label="正在生成的回答" aria-busy="true" className="max-w-[85%] rounded-xl border border-slate-700/50 bg-slate-800/80 p-4">
                    <p className="mb-2 text-sm text-slate-400">正在生成，完成后保存</p>
                    <p className="whitespace-pre-wrap break-words text-slate-100">{answerDraft}</p>
                  </section>
                )}

                {isLoading && activeProcessing && (
                  <div className="flex justify-start">
                    <div className="w-full max-w-[85%]">
                      <AnswerProcessingPanel
                        details={activeProcessing}
                        defaultExpanded
                        isLive
                        slowMessage={isRequestSlow
                          ? '模型可能正在加载，准备完成后会自动继续；也可取消请求'
                          : undefined}
                        onCancel={handleCancelRequest}
                      />
                    </div>
                  </div>
                )}

                {/* 推荐问题（猜你想问）- 只显示通过校验的最终结果 */}
                {!vectorBackendDisabled && enableSuggestions && !isLoading && !isSuggestionsLoading &&
                  suggestedQuestions.filter(q => q.validated).length > 0 && (
                  <div className="mt-4 p-4 bg-gradient-to-r from-slate-800/80 to-slate-900/80 rounded-xl border border-slate-700/50">
                    <SuggestedQuestions
                      suggestions={suggestedQuestions.filter(q => q.validated)}
                      anchor={suggestionAnchor ?? undefined}
                      timings={suggestionTimings ?? undefined}
                      isLoading={false}
                      onQuestionClick={handleSuggestionClick}
                      showDetails={false}
                    />
                  </div>
                )}
              </ResizableChatArea>

              {/* 输入区域 */}
              <div className="border-t p-4 sm:p-6">
                {!vectorBackendDisabled && (
                  <ParameterControls
                    topK={topK}
                    threshold={threshold}
                    llmModel={llmModel}
                    embeddingModel={embeddingModel}
                    llmProvider={modelConfig?.llm.provider}
                    embeddingProvider={modelConfig?.embedding.provider}
                    onTopKChange={setTopK}
                    onThresholdChange={setThreshold}
                    onLLMModelChange={value => {
                      void handleModelChange(value, embeddingModel).catch(error => {
                        showToast(error instanceof Error ? error.message : '模型切换失败', 'error');
                      });
                    }}
                    onEmbeddingModelChange={value => {
                      void handleModelChange(llmModel, value).catch(error => {
                        showToast(error instanceof Error ? error.message : '模型切换失败', 'error');
                      });
                    }}
                    showParams={showParams}
                    onToggle={() => setShowParams(!showParams)}
                  />
                )}

                {vectorBackendDisabled && (
                  <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="status">
                    向量知识库正在维护，问答参数、上传和检索已临时暂停；模型与账户配置保持不变。
                  </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                      <div className="min-w-0 flex-[1_0_100%] sm:flex-1">
                        <input
                          type="text"
                          value={input}
                          onChange={(e) => setInput(e.target.value)}
                          placeholder={vectorBackendDisabled
                            ? '知识库维护中；仍可发送“你好”等问候'
                            : '请输入您的问题...'}
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          disabled={isLoading}
                          required
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowIntentDistillation(!showIntentDistillation)}
                        className={`px-4 py-2 rounded-lg transition-colors ${showIntentDistillation
                          ? 'bg-purple-600 text-white'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }`}
                        title="意图蒸馏"
                        disabled={vectorBackendDisabled}
                      >
                        <i className="fas fa-brain mr-2"></i>
                        🧠
                      </button>
                      <button
                        type="button"
                        onClick={() => setEnableSuggestions(!enableSuggestions)}
                        className={`px-4 py-2 rounded-lg transition-colors ${enableSuggestions
                          ? 'bg-teal-600 text-white'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }`}
                        title={enableSuggestions ? '关闭推荐问题' : '开启推荐问题'}
                        disabled={vectorBackendDisabled}
                      >
                        💬
                      </button>
                      {enableSuggestions && (
                        <button
                          type="button"
                          onClick={() => setShowExpansionWorkflow(!showExpansionWorkflow)}
                          className={`px-4 py-2 rounded-lg transition-colors ${showExpansionWorkflow
                            ? 'bg-cyan-600 text-white'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                          }`}
                          title={showExpansionWorkflow ? '隐藏思考过程' : '显示思考过程'}
                          disabled={vectorBackendDisabled}
                        >
                          🔬
                        </button>
                      )}
                      <button
                        type="submit"
                        disabled={isLoading || !input.trim()}
                        className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <i className="fas fa-paper-plane mr-2"></i>
                        发送
                      </button>
                    </div>

                    {/* 意图蒸馏面板 */}
                    {!vectorBackendDisabled && showIntentDistillation && input.trim() && (
                      <div className="bg-gradient-to-br from-purple-50 to-blue-50 border-2 border-purple-200 rounded-xl p-4">
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                            <span className="text-xl">🧠</span>
                            意图蒸馏分析
                          </h3>
                          <button
                            onClick={() => setShowIntentDistillation(false)}
                            className="text-gray-400 hover:text-gray-600"
                          >
                            ✕
                          </button>
                        </div>
                        <IntentDistillationPanel
                          query={input}
                          onQuerySelect={(query) => {
                            setInput(query);
                            setShowIntentDistillation(false);
                          }}
                        />
                      </div>
                    )}
                  </div>

                  {/* 用户问题处理结果展示 */}
                  <div className="space-y-4">
                    <QuestionSelector
                      messages={messages}
                      viewingAnalysisFor={viewingAnalysisFor}
                      onSelect={setViewingAnalysisFor}
                    />

                    {/* 显示选中的问题分析 */}
                    {viewingAnalysisFor
                      && currentAnalysis
                      && !isCanonicalCreateAgentQueryAnalysis(currentAnalysis) && (
                      <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
                        <h4 className="text-sm font-medium text-blue-800 mb-3">
                          <i className="fas fa-cogs mr-2"></i>
                          用户问题处理分析
                          <span className="text-xs font-normal text-blue-600 ml-2">
                            ({messages.find(m => m.id === viewingAnalysisFor)?.content.substring(0, 50)}...)
                          </span>
                        </h4>
                        <QueryAnalysis
                          analysis={currentAnalysis}
                          radarChartData={radarChartData}
                          topK={topK}
                          threshold={threshold}
                          getRadarChartOption={getRadarChartOption}
                        />
                      </div>
                    )}

                    {/* 显示当前查询的分析（如果没有选中历史问题） */}
                    {!viewingAnalysisFor
                      && showQueryAnalysis
                      && currentAnalysis
                      && !isCanonicalCreateAgentQueryAnalysis(currentAnalysis) && (
                      <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
                        <h4 className="text-sm font-medium text-blue-800 mb-3">
                          <i className="fas fa-cogs mr-2"></i>
                          用户问题处理分析
                        </h4>
                        <QueryAnalysis
                          analysis={currentAnalysis}
                          radarChartData={radarChartData}
                          topK={topK}
                          threshold={threshold}
                          getRadarChartOption={getRadarChartOption}
                        />
                      </div>
                    )}

                    {/* 猜你想问 - 思考过程可视化（每次都显示完整检索过程） */}
                    {!vectorBackendDisabled && enableSuggestions && showExpansionWorkflow && (isSuggestionsLoading || suggestionAnchor || suggestedQuestions.length > 0) && (
                      <div className="mt-4">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <h4 className="text-sm font-medium text-gray-800">
                              <span className="mr-2">💬</span>
                              对话延伸引擎
                            </h4>
                            <span className="text-xs text-gray-500">思考过程可视化</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => setShowExpansionWorkflow(!showExpansionWorkflow)}
                            className="text-xs text-gray-500 hover:text-gray-700 transition-colors"
                          >
                            {showExpansionWorkflow ? '收起' : '展开'}
                          </button>
                        </div>
                        <ConversationExpansionWorkflow
                          anchor={suggestionAnchor}
                          suggestions={suggestedQuestions}
                          timings={suggestionTimings}
                          processingTime={suggestionProcessingTime}
                          isLoading={isSuggestionsLoading}
                          userQuery={lastUserQuery}
                          aiResponse={lastAiResponse}
                        />
                      </div>
                    )}
                  </div>
                </form>
              </div>
            </div>
          </div>

          {/* 侧边栏 */}
          <div className="space-y-4">

            {/* 高级 RAG 模式快捷入口 */}
            {!vectorBackendDisabled && (
              <div className="bg-gradient-to-br from-indigo-50 via-purple-50 to-pink-50 rounded-xl border border-indigo-200 p-4">
              <h3 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
                <span className="text-lg">🚀</span>
                高级 RAG 模式
              </h3>
              <div className="grid grid-cols-2 gap-2">
                <Link
                  href="/reasoning-rag"
                  className="group flex flex-col items-center gap-1.5 p-2.5 bg-white rounded-lg border border-purple-200 hover:border-purple-400 hover:shadow-md transition-all"
                >
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white text-base group-hover:scale-110 transition-transform">
                    🧠
                  </div>
                  <span className="text-xs font-medium text-gray-700">Reasoning</span>
                  <span className="text-[9px] text-gray-500">推理增强</span>
                </Link>
                <Link
                  href="/self-corrective-rag"
                  className="group flex flex-col items-center gap-1.5 p-2.5 bg-white rounded-lg border border-teal-200 hover:border-teal-400 hover:shadow-md transition-all"
                >
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-teal-400 to-cyan-500 flex items-center justify-center text-white text-base group-hover:scale-110 transition-transform">
                    🔄
                  </div>
                  <span className="text-xs font-medium text-gray-700">Corrective</span>
                  <span className="text-[9px] text-gray-500">自省修正</span>
                </Link>
                <Link
                  href="/agentic-rag"
                  className="group flex flex-col items-center gap-1.5 p-2.5 bg-white rounded-lg border border-fuchsia-200 hover:border-fuchsia-400 hover:shadow-md transition-all"
                >
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-fuchsia-400 to-purple-500 flex items-center justify-center text-white text-base group-hover:scale-110 transition-transform">
                    🤖
                  </div>
                  <span className="text-xs font-medium text-gray-700">Agentic</span>
                  <span className="text-[9px] text-gray-500">代理工作流</span>
                </Link>
                <Link
                  href="/entity-extraction"
                  className="group flex flex-col items-center gap-1.5 p-2.5 bg-white rounded-lg border border-rose-200 hover:border-rose-400 hover:shadow-md transition-all"
                >
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-rose-500 to-orange-500 flex items-center justify-center text-white text-base group-hover:scale-110 transition-transform">
                    🕸️
                  </div>
                  <span className="text-xs font-medium text-gray-700">GraphRAG</span>
                  <span className="text-[9px] text-gray-500">实体抽取</span>
                </Link>
                <Link
                  href="/adaptive-entity-rag"
                  className="group flex flex-col items-center gap-1.5 p-2.5 bg-white rounded-lg border border-cyan-200 hover:border-cyan-400 hover:shadow-md transition-all"
                >
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-white text-base group-hover:scale-110 transition-transform">
                    🛤️
                  </div>
                  <span className="text-xs font-medium text-gray-700">Entity RAG</span>
                  <span className="text-[9px] text-gray-500">实体路由</span>
                </Link>
                <Link
                  href="/context-management"
                  className="group flex flex-col items-center gap-1.5 p-2.5 bg-white rounded-lg border border-amber-200 hover:border-amber-400 hover:shadow-md transition-all"
                >
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-white text-base group-hover:scale-110 transition-transform">
                    📚
                  </div>
                  <span className="text-xs font-medium text-gray-700">Context</span>
                  <span className="text-[9px] text-gray-500">上下文管理</span>
                </Link>
              </div>
              <p className="text-[10px] text-gray-500 mt-3 text-center">
                基于 LangGraph + Milvus 的智能检索增强生成
              </p>
              </div>
            )}

            <section className="rounded-lg border border-blue-200 bg-blue-50/60 shadow-sm">
              <div className="border-b border-blue-200 px-6 py-4">
                <h3 className="text-lg font-medium text-gray-900">文档工作区</h3>
                <p className="mt-1 text-sm text-gray-600">上传与原文检索已迁移到独立页面</p>
              </div>
              <div className="grid grid-cols-2 gap-3 p-4">
                <Link href="/documents" className="rounded-lg border border-blue-200 bg-white p-3 text-sm font-medium text-blue-700 transition-colors hover:border-blue-400 hover:bg-blue-50">
                  <i className="fas fa-file-arrow-up mr-2"></i>
                  文档管理
                  <span className="mt-1 block text-[10px] font-normal text-gray-500">文件、URL 与文本导入</span>
                </Link>
                <Link href="/document-search" className="rounded-lg border border-emerald-200 bg-white p-3 text-sm font-medium text-emerald-700 transition-colors hover:border-emerald-400 hover:bg-emerald-50">
                  <i className="fas fa-magnifying-glass mr-2"></i>
                  文档搜索
                  <span className="mt-1 block text-[10px] font-normal text-gray-500">Milvus + ES 融合检索</span>
                </Link>
              </div>
            </section>

            <section className="rounded-lg border bg-white shadow-sm">
              <div className="flex items-center justify-between border-b px-6 py-4">
                <div>
                  <h3 className="text-lg font-medium text-gray-900">受保护的知识库</h3>
                  <p className="mt-1 text-sm text-gray-500">
                    {publicationMode ? '文档经过三库验证后统一发布，问答使用当前发布版本' : vectorBackendDisabled ? '向量检索已临时关闭' : '文件会直接写入当前 Milvus 语料库'}
                  </p>
                </div>
                <button
                  onClick={handleRuntimeStatusRefresh}
                  className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                  title="刷新知识库状态"
                  aria-label="刷新知识库状态"
                >
                  <i className="fas fa-sync-alt"></i>
                </button>
              </div>
              <div className="space-y-2 p-6 text-sm text-gray-600">
                <p>
                  {publicationMode
                    ? documentCounts ? formatDocumentChunkCounts(documentCounts) : '当前发布目录暂不可用，请刷新状态。'
                    : vectorBackendDisabled
                    ? '维护模式已启用：不会连接 Milvus 或 Zilliz，也不会写入向量库。'
                    : milvusConnected
                    ? formatDocumentChunkCounts(documentCounts)
                    : '正在检查 Milvus 连接状态；连接恢复后可继续上传和提问。'}
                </p>
                <p className="text-xs text-gray-500">
                  为保证租户与语料库隔离，生产环境不再展示旧版原始文件清单，也不提供不受范围保护的删除或全量重建操作。
                </p>
              </div>
            </section>

            {!vectorBackendDisabled && (
              <RealtimeMonitoring
                showVectorization={showVectorization}
                vectorizationDetails={vectorizationDetails}
                vectorizationProgress={vectorizationProgress}
                vectorizationStatus={vectorizationStatus}
                showQueryProcessing={showQueryProcessing}
                queryProcessingStatus={queryProcessingStatus}
                isLoading={isLoading}
                queryAnalysis={isCanonicalCreateAgentQueryAnalysis(queryAnalysis) ? null : queryAnalysis}
                retrievalDetails={retrievalDetails}
              />
            )}

            {/* 检索详情面板 */}
            {!vectorBackendDisabled && (
              <RetrievalDetailsPanel
                retrievalDetails={retrievalDetails}
                queryText={currentQuery}
              />
            )}

            <SystemInfo
              docCount={storageBackend === 'milvus' ? documentCounts?.searchableChunkCount ?? null : docCount}
              documentCounts={documentCounts}
              embeddingDim={publicationMode ? embeddingDim : storageBackend === 'milvus' ? (milvusStats?.embeddingDimension || 0) : embeddingDim}
              systemStatus={systemStatus}
              llmModel={llmModel}
              embeddingModel={embeddingModel}
              modelConfig={modelConfig}
              modelReadiness={modelReadiness?.model === llmModel ? modelReadiness : null}
              onRetryModelWarmup={() => setModelWarmupAttempt(attempt => attempt + 1)}
              onRefresh={handleRuntimeStatusRefresh}
              onModelChange={handleModelChange}
            />

            {/* 模型配置面板 */}
            <ModelConfigPanel />
          </div>
        </div>
      </div>

      <Toast toasts={toasts} />
    </div>
  );
}

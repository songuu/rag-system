import { NextRequest, NextResponse } from 'next/server';
import { prepareAskRequest, resolveAskRequestId } from './prepared-request';
import { createDirectConversationReply } from '@/lib/rag/answer-processing';
import { RagRequestAbortedError, throwIfRagRequestAborted } from '@/lib/rag/core/cancellation';
import { RagSecurityError } from '@/lib/security/request-context';
import { publicErrorPayload, RequestValidationError, resolveRuntimeEmbeddingProvider, resolveRuntimeEmbeddingModel } from '@/lib/security/request-validation';
import { getUnifiedPublicationWriteBlock } from '@/lib/security/unified-publication-write-guard';
import { warmOllamaEmbeddingModel } from '@/lib/ollama-readiness';
import { executeAskRequest } from '../../../lib/rag/core/request-execution';
import { observeAskStage, withAskAnswerStreamingEnabled } from '../../../lib/rag/core/provider-usage-observer';

export const runtime = 'nodejs';
export const maxDuration = 390;

export async function POST(request: NextRequest) {
  const requestId = resolveAskRequestId(request);
  return executeAskRequest(request, { requestId,
    execute: signal => executeAsk(new NextRequest(request, { signal }), requestId),
  });
}

async function executeAsk(request: NextRequest, requestId: string) {
  try {
    const prepared = await observeAskStage('auth', () => prepareAskRequest(request, requestId));
    const { question, executionMode, llmModel, embeddingModel, storageBackend } = prepared.input;
    const direct = executionMode === 'sync'
      ? createDirectConversationReply(question, new Date(), { llmModel }) : null;
    if (direct) {
      const traceId = `conversation-${requestId}`;
      const response = NextResponse.json({
        success: true, question, answer: direct.answer,
        conversationMode: 'direct', conversationIntent: direct.intent, storageBackend,
        models: { llm: llmModel, embedding: embeddingModel },
        modelUsage: { llm: false, embedding: false },
        evidence: [], laneExecutions: [], processing: direct.processing,
        routing: direct.routing, answerSources: direct.answerSources,
        traceId, requestId, timestamp: new Date().toISOString(),
      });
      response.headers.set('x-rag-trace-id', traceId);
      response.headers.set('x-rag-route', 'direct-conversation');
      response.headers.set('x-rag-conversation-router', direct.routing.version);
      response.headers.set('x-request-id', requestId);
      response.headers.set('cache-control', 'no-store');
      return response;
    }
    if (executionMode === 'sync') {
      const { replyToConversation } = await import('@/lib/rag/conversation-chat');
      const chat = await observeAskStage('route', () => replyToConversation(question, prepared.input.conversationHistory, { signal: request.signal }));
      throwIfRagRequestAborted(request.signal);
      if (chat) {
        const traceId = `conversation-${requestId}`;
        const response = NextResponse.json({
          success: true, question, answer: chat.answer,
          conversationMode: 'direct', conversationIntent: 'chat', storageBackend,
          models: { llm: llmModel, embedding: embeddingModel },
          modelUsage: { llm: chat.modelUsed, embedding: false },
          ...(chat.modelUsed ? { routingModel: process.env.FAST_LLM_MODEL || 'qwen2.5:0.5b' } : {}),
          evidence: [], laneExecutions: [],
          processing: { version: 'answer-processing/v1', mode: 'direct',
            summary: '已处理本次对话。', disclosure: '对话内容是用户提供的陈述，不代表已核实的身份或知识库事实。',
            retrievalSkipped: true, steps: [
              { id: 'route', label: '选择处理路径', detail: '按对话内容处理。', status: 'completed' },
              { id: 'retrieve', label: '知识库检索', detail: '本次没有查询知识库。', status: 'skipped' },
              { id: 'respond', label: '组织回复', detail: chat.modelUsed ? '尝试使用闲聊模型处理。' : '根据当前对话生成回复。', status: 'completed' },
            ] },
          routing: { version: 'conversation-chat/v1', route: 'direct', reason: 'conversation' },
          answerSources: ['conversation'], traceId, requestId, timestamp: new Date().toISOString(),
        });
        response.headers.set('x-rag-trace-id', traceId);
        response.headers.set('x-rag-route', 'direct-conversation');
        response.headers.set('x-request-id', requestId);
        response.headers.set('cache-control', 'no-store');
        return response;
      }
    }
    // Separate only independently recognizable identity clauses; the remaining
    // capabilities still use their own verified executors.
    const mixed = executionMode === 'sync' ? await import('@/lib/rag/mixed-conversation-answer') : null;
    const knowledgeQuestion = mixed?.splitMixedIdentityQuestion(question) ?? null;
    const remainingDirect = knowledgeQuestion
      ? createDirectConversationReply(knowledgeQuestion, new Date(), { llmModel }) : null;
    if (mixed && remainingDirect) {
      const traceId = `conversation-${requestId}`;
      const response = NextResponse.json({ success: true, question, answer: remainingDirect.answer,
        conversationMode: 'direct', conversationIntent: remainingDirect.intent, storageBackend,
        models: { llm: llmModel, embedding: embeddingModel }, modelUsage: { llm: false, embedding: false },
        evidence: [], laneExecutions: [], processing: remainingDirect.processing,
        routing: remainingDirect.routing, answerSources: remainingDirect.answerSources,
        traceId, requestId, timestamp: new Date().toISOString(),
      }, { headers: { 'cache-control': 'no-store', 'x-rag-trace-id': traceId,
        'x-rag-route': 'direct-conversation', 'x-request-id': requestId } });
      const history = prepared.input.conversationHistory;
      const userTurnIndex = history.findLastIndex(turn => turn.role === 'user');
      const composed = await mixed.composeMixedConversationAnswer(response, { question, history, userTurnIndex,
        quote: userTurnIndex >= 0 ? history[userTurnIndex].content : '' }, request.signal);
      throwIfRagRequestAborted(request.signal);
      if (composed.combined) return composed.response;
      return NextResponse.json({ success: false, code: 'MIXED_RESPONSE_UNAVAILABLE',
        error: '无法完整处理会话追问和其他问题，请分别提问。', requestId },
      { status: 503, headers: { 'cache-control': 'no-store' } });
    }
    const unifiedPublication = process.env.RAG_UNIFIED_PUBLICATION_MODE?.trim().toLowerCase() === 'active';
    // An invalid mode still fails closed; active requests use only published
    // generations and their pinned embedding identities below.
    if (getUnifiedPublicationWriteBlock() && !unifiedPublication) {
      throw new RequestValidationError('PUBLICATION_READ_UNAVAILABLE', '统一发布检索暂不可用。', 503);
    }
    if (!unifiedPublication && executionMode === 'sync' && resolveRuntimeEmbeddingProvider() === 'ollama') {
      // A stale selection must not evict/load a model before returning 409.
      // The executor repeats this check to catch index changes during warmup.
      if (embeddingModel.replace(/:latest$/u, '') !== resolveRuntimeEmbeddingModel().replace(/:latest$/u, '')) {
        throw new RequestValidationError('EMBEDDING_INDEX_CHANGED', '知识库嵌入模型已更新，请刷新页面后重试。', 409);
      }
      // Empty-input loading also checks residency after Ollama has evicted a
      // previously ready model. Start the 30s retrieval clock only afterwards.
      await observeAskStage('warmup', () => warmOllamaEmbeddingModel(embeddingModel, { signal: request.signal }));
      throwIfRagRequestAborted(request.signal);
    }
    // Only separate a complete, independently recognizable identity clause.
    // RAG must not answer it from documents or contradict the session reply.
    const ragPrepared = knowledgeQuestion ? {
      ...prepared,
      body: { ...prepared.body, question: knowledgeQuestion },
      input: { ...prepared.input, question: knowledgeQuestion,
        raw: { ...prepared.input.raw, question: knowledgeQuestion } },
    } : prepared;
    // Keep provider SDKs and the RAG barrel out of direct-request startup.
    const executeLegacy = async () => (await import('./runtime')).executePreparedAsk(request, ragPrepared);
    const allowAnswerDraft = !unifiedPublication && executionMode === 'sync' && storageBackend === 'milvus'
      && !knowledgeQuestion && !prepared.input.useAgenticRAG && !prepared.input.useAdaptiveEntityRAG;
    const result = unifiedPublication
      ? await (await import('./publication-runtime')).executePublishedAsk(request, ragPrepared)
      : allowAnswerDraft ? await withAskAnswerStreamingEnabled(executeLegacy) : await executeLegacy();
    // Preserve the executor's redacted terminal diagnostics on cancellation.
    if (!result.ok) return result;
    throwIfRagRequestAborted(request.signal);
    const history = prepared.input.conversationHistory;
    const userTurnIndex = executionMode === 'sync' ? history.findLastIndex(turn => turn.role === 'user') : -1;
    if (mixed && knowledgeQuestion) {
      const composed = await mixed.composeMixedConversationAnswer(result, {
        question,
        history,
        userTurnIndex,
        quote: userTurnIndex >= 0 ? history[userTurnIndex].content : '',
      }, request.signal);
      throwIfRagRequestAborted(request.signal);
      if (composed.combined || !result.ok) return composed.response;
      return NextResponse.json({ success: false, code: 'MIXED_RESPONSE_UNAVAILABLE',
        error: '无法完整处理会话追问和知识库问题，请分别提问。', requestId },
      { status: 503, headers: { 'cache-control': 'no-store' } });
    }
    return result;
  } catch (error) {
    const preparationCode = error instanceof Error
      ? 'code' in error ? error.code : error.message === 'MODEL_PRELOAD_BUSY' ? error.message : undefined
      : undefined;
    if (!request.signal.aborted && (preparationCode === 'PROVIDER_QUEUE_FULL' || preparationCode === 'PROVIDER_QUEUE_TIMEOUT')) {
      return NextResponse.json({ success: false, code: preparationCode, requestId,
        error: '模型服务繁忙，请稍后重试。' },
      { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '3' } });
    }
    if (!request.signal.aborted && (preparationCode === 'EMBEDDING_PRELOAD_FAILED'
      || preparationCode === 'EMBEDDING_PRELOAD_TIMEOUT' || preparationCode === 'MODEL_PRELOAD_BUSY')) {
      const timedOut = preparationCode === 'EMBEDDING_PRELOAD_TIMEOUT';
      return NextResponse.json({ success: false, code: preparationCode,
        error: timedOut ? '嵌入模型加载超过 90 秒，请检查 Ollama 状态后重试。'
          : preparationCode === 'MODEL_PRELOAD_BUSY' ? '模型加载任务繁忙，请稍后重试。'
            : '嵌入模型预加载失败，请检查 Ollama 服务和模型是否可用。', requestId },
      { status: timedOut ? 504 : 503, headers: { 'cache-control': 'no-store', 'retry-after': '3' } });
    }
    const mapped = error instanceof RagRequestAbortedError || request.signal.aborted
      ? { status: 499, body: { error: { code: 'RAG_REQUEST_ABORTED', message: 'RAG 请求已取消' } } }
      : error instanceof RagSecurityError
        ? { status: error.status, body: { error: { code: error.code, message: error.message } } }
        : publicErrorPayload(error, 'ASK_INTERNAL_ERROR', '处理问题时发生错误', requestId);
    // Error messages and request payloads may contain secrets; only log codes.
    console.error(`[Ask API] requestId=${requestId}`, { code: mapped.body.error.code });
    return NextResponse.json({ success: false, error: mapped.body.error.message,
      code: mapped.body.error.code, requestId }, { status: mapped.status });
  }
}

export async function GET(request: NextRequest) {
  return (await import('./runtime')).GET(request);
}

export async function PATCH(request: NextRequest) {
  return (await import('./runtime')).PATCH(request);
}

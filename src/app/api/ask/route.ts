import { NextRequest, NextResponse } from 'next/server';
import { prepareAskRequest, resolveAskRequestId } from './prepared-request';
import { createDirectConversationReply } from '@/lib/rag/answer-processing';
import { RagRequestAbortedError, throwIfRagRequestAborted } from '@/lib/rag/core/cancellation';
import { RagSecurityError } from '@/lib/security/request-context';
import { publicErrorPayload, resolveRuntimeEmbeddingProvider } from '@/lib/security/request-validation';
import { warmOllamaEmbeddingModel } from '@/lib/ollama-readiness';

export const runtime = 'nodejs';
export const maxDuration = 390;

export async function POST(request: NextRequest) {
  const requestId = resolveAskRequestId(request);
  try {
    const prepared = await prepareAskRequest(request, requestId);
    const { question, executionMode, llmModel, embeddingModel, storageBackend } = prepared.input;
    let direct = executionMode === 'sync'
      ? createDirectConversationReply(question, new Date(), { llmModel }) : null;
    if (!direct && executionMode === 'sync') {
      const { routeConversationSemantically } = await import('@/lib/rag/semantic-conversation-router');
      const routing = await routeConversationSemantically(question, { signal: request.signal });
      throwIfRagRequestAborted(request.signal);
      if (routing) direct = createDirectConversationReply(question, new Date(), { llmModel }, routing);
    }
    if (direct) {
      const traceId = `conversation-${requestId}`;
      const response = NextResponse.json({
        success: true, question, answer: direct.answer,
        conversationMode: 'direct', conversationIntent: direct.intent, storageBackend,
        models: { llm: llmModel, embedding: embeddingModel },
        modelUsage: { llm: direct.routing.reason === 'semantic-capabilities', embedding: false },
        ...(direct.routing.reason === 'semantic-capabilities' ? { routingModel: process.env.FAST_LLM_MODEL || 'qwen2.5:0.5b' } : {}),
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
    if (executionMode === 'sync' && resolveRuntimeEmbeddingProvider() === 'ollama') {
      // Empty-input loading also checks residency after Ollama has evicted a
      // previously ready model. Start the 30s retrieval clock only afterwards.
      await warmOllamaEmbeddingModel(embeddingModel, { signal: request.signal });
      throwIfRagRequestAborted(request.signal);
    }
    // Keep provider SDKs and the RAG barrel out of direct-request startup.
    const { executePreparedAsk } = await import('./runtime');
    return await executePreparedAsk(request, prepared);
  } catch (error) {
    const preparationCode = error instanceof Error
      ? 'code' in error ? error.code : error.message === 'MODEL_PRELOAD_BUSY' ? error.message : undefined
      : undefined;
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

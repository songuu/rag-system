import { NextResponse, type NextRequest } from 'next/server';
import type { PreparedAskRequest } from './prepared-request';
import { getPostgresClient } from '@/lib/postgres/client';
import { assertPublicationViewCurrent } from '@/lib/documents/publication-view';
import { searchPublishedDocumentsForAnswer } from '@/lib/documents/publication-search-runtime';
import { createRetrievalScope } from '@/lib/security/retrieval-scope';
import { createLLM } from '@/lib/model-config';
import { ANSWER_MAX_OUTPUT_TOKENS, assertCompleteAnswer } from '@/lib/models/answer-output';
import { composeEvidenceContextV2 } from '@/lib/rag/core/context-composer';
import { createMilvusAnswerMessages } from '@/lib/rag/retrieval/ask-route-contract';
import { RequestValidationError } from '@/lib/security/request-validation';
import { throwIfRagRequestAborted } from '@/lib/rag/core/cancellation';
import { RAG_GENERATION_EXECUTION_BUDGET_MS } from '@/lib/rag/core/request-budgets';
import { issuePublishedAnswerCitations } from '@/lib/rag/citations/publication-runtime';
import { publicationReadWithin } from '@/lib/documents/publication-read-deadline';
import { observeProviderInvocation, observeAskStage } from '@/lib/rag/core/provider-usage-observer';

/** Active publication answers have a single source of authority. Old durable
 * checkpoints and mutable retrieval indexes cannot be replayed through here. */
export async function executePublishedAsk(request: NextRequest, prepared: PreparedAskRequest) {
  if (prepared.input.executionMode !== 'sync') {
    throw new RequestValidationError('PUBLICATION_READ_UNAVAILABLE', '统一发布问答暂不支持旧版持久任务。', 503);
  }
  throwIfRagRequestAborted(request.signal);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(RAG_GENERATION_EXECUTION_BUDGET_MS + 60_000)]);
  const { input, securityContext, requestId } = prepared;
  const scope = createRetrievalScope({ tenantId: securityContext.tenantId, corpusId: securityContext.corpusId, enforceIsolation: true });
  const db = getPostgresClient();
  if (!db) throw new RequestValidationError('PUBLICATION_READ_UNAVAILABLE', '统一发布检索暂不可用。', 503);
  const started = Date.now();
  const { view, result: retrieved } = await observeAskStage('retrieval', () => searchPublishedDocumentsForAnswer({ query: input.question, strategy: 'hybrid', topK: input.topK,
    scope, signal }));
  // Retrieval and answer generation share the same server-issued head. All
  // post-retrieval, post-generation and post-citation freshness fences remain.
  if (retrieved.diagnostics.viewDigest !== view.digest) throw new RequestValidationError('PUBLICATION_VIEW_CHANGED', '知识库版本已更新，请重试。', 409);
  const searchTime = Date.now() - started;
  const pack = composeEvidenceContextV2(retrieved.evidence, { maxTokens: 4000, scope, order: 'retrieval' });
  let answer = '根据当前知识库无法回答该问题。';
  let llmTime = 0;
  if (pack.includedEvidence.length && pack.context.trim()) {
    const { invokeGenerationWithDeadline } = await import('./runtime');
    const messages = createMilvusAnswerMessages({ question: input.question, context: pack.context, evidence: pack.includedEvidence });
    const generationStarted = Date.now();
    const result = await invokeGenerationWithDeadline({ modelKey: `answer:${input.llmModel}`,
      timeoutMs: RAG_GENERATION_EXECUTION_BUDGET_MS, signal,
      invoke: signal => {
        const llm = createLLM(input.llmModel, { requestTimeoutMs: RAG_GENERATION_EXECUTION_BUDGET_MS,
          requestSignal: signal, maxTokens: ANSWER_MAX_OUTPUT_TOKENS });
        return observeProviderInvocation('generation', () => llm.invoke(messages, { signal }));
      } });
    assertCompleteAnswer(result);
    answer = answerText(result);
    if (!answer.trim()) throw new Error('Published answer model returned no text.');
    llmTime = Date.now() - generationStarted;
  }
  throwIfRagRequestAborted(request.signal);
  await observeAskStage('validation', () => publicationReadWithin(() => assertPublicationViewCurrent(view, scope, db), signal));
  throwIfRagRequestAborted(request.signal);
  const citations = await observeAskStage('citation', () => issuePublishedAnswerCitations({ answer, servedEvidence: pack.includedEvidence, security: securityContext, signal }));
  await observeAskStage('validation', () => publicationReadWithin(() => assertPublicationViewCurrent(view, scope, db), signal));
  throwIfRagRequestAborted(request.signal);
  const traceId = `publication-${requestId}`;
  return NextResponse.json({ success: true, question: input.question, answer,
    storageBackend: 'milvus', models: { llm: input.llmModel, embedding: view.documents[0]?.embedding.model ?? input.embeddingModel },
    modelUsage: { llm: llmTime > 0, embedding: pack.includedEvidence.length > 0 },
    evidence: pack.includedEvidence, citations, laneExecutions: [], answerSources: pack.includedEvidence.length ? ['documents'] : [],
    processing: { version: 'answer-processing/v1', mode: 'rag', retrievalSkipped: false,
      summary: '已检索当前发布版本并根据资料组织回复。', steps: [
        { id: 'retrieve', label: '知识库检索', detail: `已检索 ${pack.includedEvidence.length} 条已发布资料。`, status: 'completed' },
        { id: 'respond', label: '组织回复', detail: pack.includedEvidence.length ? '根据检索资料生成回复。' : '没有可用于回答的资料。', status: 'completed' },
      ] },
    retrievalDetails: { diagnostics: retrieved.diagnostics, topK: input.topK, searchTime, llmTime,
      totalDocuments: new Set(retrieved.evidence.map(item => item.documentId)).size,
      searchResults: retrieved.evidence.map((item, index) => ({ document: { id: item.id, content: item.content,
        metadata: { ...item.metadata, source: item.source, documentId: item.documentId, documentVersion: item.documentVersion } },
        similarity: item.retrievalScore, index })), contextPacking: { version: pack.version, includedEvidenceIds: pack.includedEvidenceIds,
        excludedEvidenceIds: pack.excludedEvidenceIds, tokenEstimate: pack.tokenEstimate, truncated: pack.truncated } },
    traceId, requestId, publicationViewDigest: view.digest, timestamp: new Date().toISOString(),
  }, { headers: { 'cache-control': 'no-store', 'x-rag-trace-id': traceId, 'x-request-id': requestId, 'x-rag-route': 'published-documents' } });
}

function answerText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || !('content' in value)) return '';
  const content = value.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(item => item && typeof item === 'object' && typeof item.text === 'string' ? item.text : '').join('');
}

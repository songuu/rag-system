import { randomUUID } from 'node:crypto';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import { executeWithPrivateLangChainTracing } from '../../langsmith/private-tracing';
import type { RagRetrievalScope } from '../../security/retrieval-scope';
import { invokeScopedRetrievalAgent, ScopedRetrievalAgentError } from '../agents/scoped-retrieval-agent';
import { ScopedEvidenceValidationError } from '../agents/append-scoped-evidence';
import { composeEvidenceContextV2 } from '../core/context-composer';
import type { RagEvidence } from '../core/types';
import type {
  RagEvalAgentTrajectory, RagEvalCorpusDocument, RagEvalTarget, RagEvalTargetResult,
} from './types';

export interface ScopedAgentEvalRetrievalInput {
  query: string;
  scope: RagRetrievalScope;
  corpus: readonly RagEvalCorpusDocument[];
  topK: number;
  signal: AbortSignal;
}
export interface ScopedAgentEvalRerankInput {
  query: string;
  evidence: readonly RagEvidence[];
  signal: AbortSignal;
}
export interface ScopedAgentEvalTargetOptions {
  id: string;
  mode: RagEvalAgentTrajectory['mode'];
  decisionMode?: 'native-tools' | 'structured';
  modelFactory: (input: { signal: AbortSignal }) => BaseChatModel | Promise<BaseChatModel>;
  retrieve: (input: ScopedAgentEvalRetrievalInput) => Promise<RagEvidence[]>;
  rerank?: (input: ScopedAgentEvalRerankInput) => Promise<RagEvidence[]>;
  budget?: Partial<RagEvalAgentTrajectory['budget']>;
  signal?: AbortSignal;
  /** Factory contract: all returned models have provider retries disabled. */
  providerRetries?: 0;
}

/** Evaluates the production scoped createAgent entry point against injected retrieval. */
export function createScopedAgentEvalTarget(options: ScopedAgentEvalTargetOptions): RagEvalTarget {
  const budget = {
    maxDurationMs: 120_000, maxContextTokens: 2_000, maxEvidence: 6, maxSearches: 2,
    ...options.budget,
  };
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('[scoped-agent eval] ' + name + ' must be a positive integer');
  }
  if (budget.maxSearches > 2) throw new Error('[scoped-agent eval] maxSearches must not exceed 2');
  if (!options.id.trim()) throw new Error('[scoped-agent eval] target id is required');
  if (!['snapshot', 'rerank', 'iterative'].includes(options.mode)) throw new Error('[scoped-agent eval] unsupported mode');
  if (options.mode === 'rerank' && !options.rerank) throw new Error('[scoped-agent eval] rerank mode requires a reranker');
  let circuitOpen = false;
  let active = false;

  return { id: options.id, async run(input): Promise<RagEvalTargetResult> {
    if (circuitOpen) throw new Error('[scoped-agent eval] circuit open after failed provider or deadline; no further calls started');
    if (active) throw new Error('[scoped-agent eval] concurrent runs are unsupported');
    if (!input.evalCase.scope) throw new Error('[scoped-agent eval] an explicit evaluation scope is required');
    active = true;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('[scoped-agent eval] total deadline exceeded')), budget.maxDurationMs);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const scope: RagRetrievalScope = { ...input.evalCase.scope, allowedTrustLevels: [...input.evalCase.scope.allowedTrustLevels], enforceIsolation: true };
    const canonicalById = new Map(input.corpus.map(item => [item.evidenceId, item]));
    let modelCallCount = 0;
    let modelResponseCount = 0;
    let observedToolCallCount = 0;
    let contextTokenEstimate = 0;
    let deliveredEvidenceCount = 0;
    let retrievalCallCount = 0;
    let rerankCallCount = 0;
    let retrievalLatencyMs = 0;
    let providerRetryMeasurement: RagEvalAgentTrajectory['providerRetryMeasurement'] = 'disabled';
    const traceId = 'scoped-agent-eval-' + randomUUID();
    const retrieve = async (query: string): Promise<RagEvidence[]> => {
      signal.throwIfAborted();
      const start = Date.now();
      retrievalCallCount++;
      try {
        let evidence = await abortable(() => options.retrieve({ query, scope, corpus: input.corpus, topK: input.topK, signal }), signal);
        validateEvidence(evidence, canonicalById, scope);
        if (options.mode !== 'snapshot' && options.rerank && evidence.length > 0) {
          rerankCallCount++;
          const originalIds = new Set(evidence.map(item => item.id));
          evidence = await abortable(() => options.rerank!({ query, evidence, signal }), signal);
          validateEvidence(evidence, canonicalById, scope);
          if (evidence.some(item => !originalIds.has(item.id))) throw new ScopedEvidenceValidationError('[scoped-agent eval] reranker introduced evidence outside retrieval');
        }
        return evidence.slice(0, budget.maxEvidence);
      } finally { retrievalLatencyMs += Math.max(0, Date.now() - start); }
    };
    try {
      const initialEvidence = await retrieve(input.evalCase.query);
      const contextPack = composeEvidenceContextV2(initialEvidence, { scope, maxTokens: budget.maxContextTokens });
      contextTokenEstimate = contextPack.tokenEstimate;
      deliveredEvidenceCount = contextPack.includedEvidence.length;
      const trajectory: RagEvalAgentTrajectory = {
        mode: options.mode, decisionMode: options.mode === 'iterative' ? options.decisionMode ?? 'native-tools' : 'native-tools', modelCallCount: 0, modelResponseCount: 0,
        modelCallMeasurement: 'langchain-callback-start', providerRetryMeasurement,
        toolCallCount: 0, retrievalCallCount, rerankCallCount, searchCallCount: 0,
        searchStopReason: 'empty_context', contextTokenEstimate: contextPack.tokenEstimate,
        deliveredEvidenceCount: contextPack.includedEvidence.length, citationValidation: 'reference-only',
        abstainDecision: 'empty-context', budget: { ...budget }, budgetViolations: [],
      };
      if (contextPack.includedEvidence.length === 0) return {
        answer: '根据当前知识库无法回答该问题。', abstained: true, evidence: [], citations: [],
        policyId: 'scoped-agent-' + options.mode, laneIds: ['scoped-fixture-lexical'], traceId, trajectory,
        usage: { retrievalLatencyMs, generationLatencyMs: 0, totalLatencyMs: Date.now() - startedAt,
          tokenMeasurement: 'unavailable', costMeasurement: 'unavailable', embeddingCalls: 0, generationCalls: 0 },
      };
      const model = await abortable(() => Promise.resolve(options.modelFactory({ signal })), signal);
      // Runtime starts cannot reveal undocumented HTTP retries. The CLI disables
      // retries; injected adapters explicitly disclose unavailable retry counts.
      providerRetryMeasurement = options.providerRetries === 0 ? 'disabled' : 'unavailable';
      const generationStartedAt = Date.now();
      const initialRetrievalLatencyMs = retrievalLatencyMs;
      const result = await abortable(() => executeWithPrivateLangChainTracing(() => invokeScopedRetrievalAgent({
        model, question: input.evalCase.query, contextPack, scope, traceId, signal,
        callbacks: [{ name: 'scoped-eval-local-call-counter',
          handleChatModelStart() { modelCallCount++; },
          handleLLMEnd() { modelResponseCount++; },
          handleToolStart() { observedToolCallCount++; },
        }],
        ...(options.mode === 'iterative' ? { retrieval: {
          decisionMode: options.decisionMode ?? 'native-tools',
          search: ({ query }: { query: string; signal?: AbortSignal }) => retrieve(query),
          maxSearches: budget.maxSearches, maxContextTokens: budget.maxContextTokens, maxEvidence: budget.maxEvidence,
        } } : {}),
      })), signal);
      const finalPack = result.contextPack;
      const deliveredById = new Map(finalPack.includedEvidence.map(item => [item.id, item]));
      const citations = result.diagnostics.citations.citedEvidenceIds.map(evidenceId => ({
        evidenceId, startOffset: 0, endOffset: deliveredById.get(evidenceId)!.content.length,
      }));
      // Preserve invalid references so metrics penalize them rather than silently
      // converting a partly invalid answer into an all-valid citation set.
      for (let index = 0; index < result.diagnostics.citations.invalidCitationCount; index++) {
        let evidenceId = '__invalid_scoped_agent_citation_' + index + '__';
        while (canonicalById.has(evidenceId)) evidenceId += '_';
        citations.push({ evidenceId, startOffset: 0, endOffset: 1 });
      }
      const abstained = result.answerDisposition ? result.answerDisposition === 'abstain' : isExplicitAbstention(result.answer);
      const usage = result.diagnostics.usage;
      Object.assign(trajectory, {
        modelCallCount, providerRetryMeasurement, modelResponseCount: result.diagnostics.modelResponseCount,
        toolCallCount: result.toolCallCount, retrievalCallCount, rerankCallCount,
        searchCallCount: result.searchCallCount, searchStopReason: result.searchStopReason,
        contextTokenEstimate: finalPack.tokenEstimate, deliveredEvidenceCount: finalPack.includedEvidence.length,
        abstainDecision: abstained ? result.answerDisposition === 'abstain' ? 'structured-decision' : 'explicit-text-rule' : 'not-abstained',
      });
      if (Date.now() - startedAt > budget.maxDurationMs) trajectory.budgetViolations.push('duration');
      if (modelCallCount > (options.mode === 'iterative' ? 4 : 2)) trajectory.budgetViolations.push('model_calls');
      if (result.searchCallCount > budget.maxSearches) trajectory.budgetViolations.push('search_calls');
      if (finalPack.tokenEstimate > budget.maxContextTokens) trajectory.budgetViolations.push('context_tokens');
      if (finalPack.includedEvidence.length > budget.maxEvidence) trajectory.budgetViolations.push('evidence_count');
      return {
        answer: result.answer, abstained, citations, traceId, trajectory,
        evidence: finalPack.includedEvidence.map(item => {
          const canonical = canonicalById.get(item.id)!;
          return { ...canonical, score: item.rerankScore ?? item.retrievalScore ?? item.score ?? 0, laneId: item.laneId };
        }),
        policyId: 'scoped-agent-' + options.mode, laneIds: [...new Set(finalPack.includedEvidence.map(item => item.laneId))],
        usage: {
          retrievalLatencyMs, generationLatencyMs: Math.max(0, Date.now() - generationStartedAt - (retrievalLatencyMs - initialRetrievalLatencyMs)), totalLatencyMs: Date.now() - startedAt,
          tokenMeasurement: usage.measurement, costMeasurement: 'unavailable', embeddingCalls: 0, generationCalls: modelCallCount,
          ...(usage.measurement === 'provider'
            ? { inputTokens: usage.inputTokenCount, outputTokens: usage.outputTokenCount }
            : { partialInputTokens: usage.inputTokenCount, partialOutputTokens: usage.outputTokenCount }),
        },
      };
    } catch (error) {
      circuitOpen = true;
      controller.abort(error);
      // Only known error codes leave this boundary. Provider payloads and stack
      // traces can contain prompts or credentials; call counts remain auditable.
      const code = error instanceof ScopedRetrievalAgentError || error instanceof ScopedEvidenceValidationError ? error.code : undefined;
      const stopReason = signal.aborted && signal.reason instanceof Error && /deadline/.test(signal.reason.message)
        ? 'deadline' : code ?? 'execution_failed';
      const message = error instanceof Error && error.message.startsWith('[scoped-agent eval]')
        ? error.message : '[scoped-agent eval] execution failed (' + (code ?? 'provider_error') + ')';
      throw Object.assign(new Error(message), { ...(code ? { code } : {}), trajectory: {
        mode: options.mode, decisionMode: options.mode === 'iterative' ? options.decisionMode ?? 'native-tools' : 'native-tools', modelCallCount, modelResponseCount,
        modelCallMeasurement: 'langchain-callback-start', providerRetryMeasurement,
        toolCallCount: observedToolCallCount, retrievalCallCount, rerankCallCount,
        searchCallCount: Math.max(0, retrievalCallCount - 1), searchStopReason: stopReason,
        contextTokenEstimate, deliveredEvidenceCount, citationValidation: 'reference-only',
        abstainDecision: 'not-abstained', budget: { ...budget },
        budgetViolations: stopReason === 'deadline' || code === 'RAG_AGENT_TOOL_LIMIT' || code === 'RAG_AGENT_MAX_STEPS'
          ? [stopReason] : [],
      } satisfies RagEvalAgentTrajectory });
    } finally { clearTimeout(timer); active = false; }
  } };
}

function isExplicitAbstention(answer: string): boolean {
  return /(?:当前知识库|现有(?:资料|证据)|提供的(?:资料|上下文)).{0,20}(?:无法回答|不能回答|不足以回答)|(?:无法|不能)根据.{0,20}(?:资料|上下文|证据).{0,8}回答|(?:current knowledge base|provided (?:context|evidence)).{0,40}(?:cannot answer|does not contain|insufficient)|(?:cannot|unable to) answer.{0,30}(?:context|evidence)/iu.test(answer);
}

// Eval adapters share the production fatal evidence boundary: integrity failures
// during follow-up retrieval must never become a recoverable provider outage.
function validateEvidence(evidence: readonly RagEvidence[], canonical: ReadonlyMap<string, RagEvalCorpusDocument>, scope: RagRetrievalScope): void {
  const seen = new Set<string>();
  for (const item of evidence) {
    if (item.tenantId !== scope.tenantId || item.corpusId !== scope.corpusId || item.trustLevel === 'quarantined' || !scope.allowedTrustLevels.includes(item.trustLevel)) {
      throw new ScopedEvidenceValidationError('[scoped-agent eval] retrieved evidence violates scope');
    }
    const original = canonical.get(item.id);
    if (!original || ['content', 'source', 'documentId', 'documentVersion', 'tenantId', 'corpusId', 'trustLevel'].some(field => item[field as keyof RagEvidence] !== original[field as keyof RagEvalCorpusDocument])) {
      throw new ScopedEvidenceValidationError('[scoped-agent eval] retrieved evidence violates canonical corpus identity');
    }
    if (seen.has(item.id)) throw new ScopedEvidenceValidationError('[scoped-agent eval] duplicate evidence');
    seen.add(item.id);
  }
}

function abortable<T>(execute: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return execute(); })
      .then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

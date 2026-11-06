import { canonicalJsonSha256 } from './canonical-json';
import { parseRagEvalDataset, createRagEvalDatasetHash } from './dataset';
import { validateExperimentContract, type RagEvalConfiguration } from './experiment-contract';
import { parseCitationReferences } from '../citations/reference-parser';
import { readAskProviderUsage } from '../core/provider-usage-observer';
import type { RagEvalTarget, RagEvalTargetResult, RagEvalScope, RagEvalRetrievedEvidence } from './types';

export interface LiveAskInput {
  question: string; scope: RagEvalScope; topK: number; similarityThreshold: number;
  llmModel: string; embeddingModel: string;
}
export interface LiveAskEvalOptions {
  dataset: unknown; experiment: unknown;
  observeRuntime: () => Promise<RagEvalConfiguration>;
  invokeAsk: (input: LiveAskInput) => Promise<Response>;
  now?: () => number;
}

/** The owned CLI wires these ports to the actual Ask POST and independent runtime reads. */
export function createLiveAskEvalTarget(options: LiveAskEvalOptions): RagEvalTarget {
  const dataset = parseRagEvalDataset(options.dataset);
  const experiment = validateExperimentContract(dataset, options.experiment);
  const configuration = experiment.configuration;
  const canonical = new Map(dataset.corpus.map(item => [item.evidenceId, item]));
  const now = options.now ?? (() => performance.now());
  let halted = false, active = false;
  const verifyRuntime = async () => {
    if (canonicalJsonSha256(await options.observeRuntime()) !== experiment.configurationHash) {
      throw new Error('[rag-eval live Ask] observed runtime configuration changed');
    }
  };
  return { id: 'live-ask-published-v1', async run(input): Promise<RagEvalTargetResult> {
    if (halted) throw new Error('[rag-eval live Ask] halted after an invalid observation');
    if (active) throw new Error('[rag-eval live Ask] concurrent runs are unsupported');
    active = true;
    try {
      if (!input.evalCase.scope || input.topK !== configuration.retrieval.topK
        || createRagEvalDatasetHash({ ...dataset, corpus: [...input.corpus] }) !== experiment.datasetSha256) {
        throw new Error('[rag-eval live Ask] dataset, scope or topK binding mismatch');
      }
      await verifyRuntime();
      const started = now();
      const response = await options.invokeAsk({ question: input.evalCase.query, scope: input.evalCase.scope,
        topK: input.topK, similarityThreshold: configuration.retrieval.similarityThreshold,
        llmModel: configuration.model.name, embeddingModel: configuration.embedding.name });
      const bodyReadStartedAt = now();
      if (!response.ok) throw new Error('[rag-eval live Ask] Ask returned HTTP ' + response.status);
      const body = record(JSON.parse(await readBoundedResponse(response)));
      const responseCompletedAt = now();
      const capturedUsage = readAskProviderUsage(response);
      if (body.success !== true || typeof body.answer !== 'string') throw new Error('[rag-eval live Ask] invalid Ask answer');
      const direct = body.conversationMode === 'direct';
      if (!direct && body.publicationViewDigest !== configuration.index.revision) throw new Error('[rag-eval live Ask] publication snapshot mismatch');
      const models = record(body.models);
      if (models.llm !== configuration.model.name || models.embedding !== configuration.embedding.name) throw new Error('[rag-eval live Ask] effective model identity mismatch');
      if (!Array.isArray(body.evidence)) throw new Error('[rag-eval live Ask] missing observed evidence');
      const evidence = body.evidence.map(value => {
        const item = record(value), id = string(item.id);
        const original = canonical.get(id);
        if (!original) throw new Error('[rag-eval live Ask] evidence is outside frozen corpus');
        const content = string(item.content);
        const truncated = content !== original.content && record(item.metadata ?? {}).contextTruncated === true
          && original.content.startsWith(content);
        if (content !== original.content && !truncated) throw new Error('[rag-eval live Ask] observed evidence content mismatch');
        for (const key of ['source','documentId','documentVersion','tenantId','corpusId','trustLevel'] as const) {
          if (item[key] !== original[key]) throw new Error('[rag-eval live Ask] observed evidence identity/content mismatch');
        }
        return { ...original, content, ...(truncated ? { servedSpan: { startOffset: 0, endOffset: content.length } } : {}),
          evidenceId: id, score: finite(item.rerankScore ?? item.retrievalScore ?? item.score), laneId: string(item.laneId) } as RagEvalRetrievedEvidence;
      });
      if (new Set(evidence.map(item => item.evidenceId)).size !== evidence.length) throw new Error('[rag-eval live Ask] duplicate observed evidence');
      const details = body.retrievalDetails === undefined ? {} : record(body.retrievalDetails);
      let candidates: string[] | undefined;
      if (Array.isArray(details.searchResults)) {
        candidates = details.searchResults.map(value => {
          const document = record(record(value).document), id = string(document.id), original = canonical.get(id);
          if (!original || document.content !== original.content) throw new Error('[rag-eval live Ask] candidate outside frozen corpus or content changed');
          const metadata = record(document.metadata);
          for (const key of ['source','documentId','documentVersion'] as const) {
            if (metadata[key] !== original[key]) throw new Error('[rag-eval live Ask] candidate identity mismatch');
          }
          return id;
        });
      }
      const packing = details.contextPacking === undefined ? undefined : record(details.contextPacking);
      const context = packing ? ids(packing.includedEvidenceIds) : evidence.map(item => item.evidenceId);
      const byId = new Map(evidence.map(item => [item.evidenceId,item]));
      if (context.some(id => !byId.has(id))) throw new Error('[rag-eval live Ask] context references missing observed evidence');
      const delivered = context.map(id => byId.get(id)!);
      const lanes = Array.isArray(body.laneExecutions) ? body.laneExecutions.map(record) : [];
      const reranks = lanes.filter(lane => lane.status === 'completed' && lane.reranking !== undefined);
      // Independent lanes do not define a single global ranked list.
      const reranked = reranks.length === 1 ? ids(record(reranks[0].reranking).afterEvidenceIds) : undefined;
      const numbered = parseCitationReferences(body.answer, delivered.length);
      const citations = numbered.ranges.flatMap(range => range.numbers.map(number => {
        const item = delivered[number - 1];
        return { evidenceId: item?.evidenceId ?? '__invalid_live_reference_' + number,
          startOffset: 0, endOffset: item?.content.length ?? 1 };
      }));
      const disposition = body.answerDisposition === 'answer' || body.answerDisposition === 'abstain' || body.answerDisposition === 'clarify'
        ? body.answerDisposition : body.conversationIntent === 'clarification' ? 'clarify'
          : !direct && delivered.length === 0 ? 'abstain' : undefined;
      await verifyRuntime();
      const tokens = capturedUsage?.tokens ?? { measurement: 'unavailable' as const };
      const usage = { retrievalLatencyMs: nonNegative(details.searchTime ?? 0),
        generationLatencyMs: nonNegative(capturedUsage?.latencyMs?.generation ?? details.llmTime ?? 0),
        totalLatencyMs: capturedUsage?.latencyMs?.total === undefined ? nonNegative(responseCompletedAt - started)
          : nonNegative(capturedUsage.latencyMs.total + responseCompletedAt - bodyReadStartedAt),
        tokenMeasurement: tokens.measurement, costMeasurement: 'unavailable' as const,
        embeddingCalls: capturedUsage?.calls?.embedding ?? 0, generationCalls: capturedUsage?.calls?.generation ?? 0,
        ...(tokens.measurement === 'provider' || tokens.measurement === 'estimated'
          ? { inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens }
          : tokens.measurement === 'partial' ? { partialInputTokens: tokens.inputTokens, partialOutputTokens: tokens.outputTokens } : {}) };
      return { answer: body.answer, abstained: disposition === 'abstain' || disposition === 'clarify',
        ...(disposition ? { disposition } : {}), evidence: delivered, citations,
        policyId: direct ? 'conversation' : 'milvus-2step', laneIds: [...new Set(delivered.map(item => item.laneId!))].concat(delivered.length ? [] : [direct ? 'conversation' : 'document-search']),
        traceId: string(body.traceId), usage,
        retrievalStages: { ...(candidates ? { candidates } : {}), ...(reranked ? { reranked } : {}), context },
        usageObservation: { ...capturedUsage, tokens, calls: capturedUsage?.calls ?? {}, latencyMs: { total: usage.totalLatencyMs,
          ...(details.searchTime === undefined ? {} : { retrieval: usage.retrievalLatencyMs }),
          ...(details.llmTime === undefined && capturedUsage?.latencyMs?.generation === undefined ? {} : { generation: usage.generationLatencyMs }) } },
        observation: { disposition: disposition ? disposition === 'abstain' && !delivered.length ? 'empty-context' : 'structured' : 'unavailable',
          citations: 'reference-only', calls: capturedUsage ? 'provider' : 'unavailable' } };
    } catch (error) {
      halted = true;
      // Provider bodies and connection credentials must not enter persisted case errors.
      if (error instanceof Error && error.message.startsWith('[rag-eval live Ask]')) throw error;
      throw new Error('[rag-eval live Ask] transport or runtime observation failed');
    } finally { active = false; }
  } };
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) throw new Error('[rag-eval live Ask] missing response body');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break;
    size += part.value.byteLength; if (size > 16 * 1024 * 1024) { await reader.cancel(); throw new Error('[rag-eval live Ask] response exceeds 16 MiB'); }
    chunks.push(part.value);
  } } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('[rag-eval live Ask] invalid response object');
  return value as Record<string, unknown>;
}
function string(value: unknown): string { if (typeof value !== 'string' || !value.trim()) throw new Error('[rag-eval live Ask] missing response identity'); return value; }
function ids(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('[rag-eval live Ask] missing evidence snapshot');
  const list = value.map(string); if (new Set(list).size !== list.length) throw new Error('[rag-eval live Ask] duplicate snapshot evidence'); return list;
}
function finite(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('[rag-eval live Ask] invalid score'); return value; }
function nonNegative(value: unknown): number { const result = finite(value); if (result < 0) throw new Error('[rag-eval live Ask] negative measurement'); return result; }

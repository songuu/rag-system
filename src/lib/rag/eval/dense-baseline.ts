import type {
  RagEvalCorpusDocument,
  RagEvalCitation,
  RagEvalCostMeasurement,
  RagEvalRetrievedEvidence,
  RagEvalTarget,
  RagEvalTargetCase,
  RagEvalTokenMeasurement,
} from './types';

export interface RagEvalEmbeddings {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export interface RagEvalAnswerGeneratorInput {
  evalCase: RagEvalTargetCase;
  evidence: readonly RagEvalRetrievedEvidence[];
}

export interface RagEvalAnswerGeneratorResult {
  answer: string;
  abstained: boolean;
  inputTokens?: number;
  outputTokens?: number;
  tokenMeasurement: RagEvalTokenMeasurement;
  costUsd?: number;
  costMeasurement: RagEvalCostMeasurement;
  generationCalls?: number;
  citations?: RagEvalCitation[];
}

export interface RagEvalAnswerGenerator {
  generate(input: RagEvalAnswerGeneratorInput): Promise<RagEvalAnswerGeneratorResult>;
}

export interface DenseBaselineTargetOptions {
  id?: string;
  embeddings: RagEvalEmbeddings;
  generator: RagEvalAnswerGenerator;
  policyId?: string;
  laneId?: string;
  minimumScore?: number;
  now?: () => number;
}

export function createDenseBaselineTarget(options: DenseBaselineTargetOptions): RagEvalTarget {
  const now = options.now ?? (() => performance.now());
  const targetId = options.id ?? 'dense-baseline-v1';
  const laneId = options.laneId ?? 'dense-vector-required';
  const policyId = options.policyId ?? targetId;
  let cachedCorpusIdentity: string | undefined;
  let cachedCorpusEmbeddings: Promise<number[][]> | undefined;

  return {
    id: targetId,
    async run({ evalCase, corpus, topK }) {
      assertPositiveInteger(topK, 'topK');
      if (corpus.length === 0) {
        throw new Error('[rag-eval dense] corpus must not be empty');
      }

      const eligibleCorpus = filterCorpusByScope(corpus, evalCase);
      const corpusIdentity = createCorpusIdentity(eligibleCorpus, evalCase);
      const retrievalStart = now();
      const corpusCacheMiss =
        cachedCorpusIdentity !== corpusIdentity ||
        cachedCorpusEmbeddings === undefined;
      if (corpusCacheMiss) {
        cachedCorpusIdentity = corpusIdentity;
        cachedCorpusEmbeddings = options.embeddings.embedDocuments(
          eligibleCorpus.map(document => document.content)
        );
      }
      const documentVectorsPromise = cachedCorpusEmbeddings;
      if (!documentVectorsPromise) {
        throw new Error('[rag-eval dense] corpus embedding cache was not initialized');
      }

      const [documentVectors, queryVector] = await Promise.all([
        documentVectorsPromise,
        options.embeddings.embedQuery(evalCase.query),
      ]);
      validateEmbeddingBatch(documentVectors, eligibleCorpus.length, 'document embeddings');
      validateEmbedding(queryVector, 'query embedding');

      const evidence = eligibleCorpus
        .map((document, index) => ({
          index,
          document,
          score: cosineSimilarity(queryVector, documentVectors[index]),
        }))
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .filter(item => item.score >= (options.minimumScore ?? Number.NEGATIVE_INFINITY))
        .slice(0, topK)
        .map(({ document, score }) => ({
          evidenceId: document.evidenceId,
          score,
          content: document.content,
          source: document.source,
          ...(document.tenantId === undefined ? {} : { tenantId: document.tenantId }),
          ...(document.corpusId === undefined ? {} : { corpusId: document.corpusId }),
          ...(document.documentId === undefined ? {} : { documentId: document.documentId }),
          ...(document.documentVersion === undefined
            ? {}
            : { documentVersion: document.documentVersion }),
          ...(document.trustLevel === undefined
            ? {}
            : { trustLevel: document.trustLevel }),
          laneId,
        }));
      const retrievalLatencyMs = elapsed(retrievalStart, now());

      const generationStart = now();
      const generated = await options.generator.generate({ evalCase, evidence });
      validateGenerationResult(generated);
      const generationLatencyMs = elapsed(generationStart, now());

      return {
        answer: generated.answer,
        abstained: generated.abstained,
        evidence,
        citations: generated.citations ?? [],
        policyId,
        laneIds: [laneId],
        usage: {
          retrievalLatencyMs,
          generationLatencyMs,
          totalLatencyMs: retrievalLatencyMs + generationLatencyMs,
          ...(generated.inputTokens === undefined
            ? {}
            : { inputTokens: generated.inputTokens }),
          ...(generated.outputTokens === undefined
            ? {}
            : { outputTokens: generated.outputTokens }),
          tokenMeasurement: generated.tokenMeasurement,
          ...(generated.costUsd === undefined ? {} : { costUsd: generated.costUsd }),
          costMeasurement: generated.costMeasurement,
          embeddingCalls: corpusCacheMiss ? 2 : 1,
          generationCalls: generated.generationCalls ?? 1,
        },
      };
    },
  };
}

function filterCorpusByScope(
  corpus: readonly RagEvalCorpusDocument[],
  evalCase: RagEvalTargetCase
): RagEvalCorpusDocument[] {
  const scope = evalCase.scope;
  if (!scope) return [...corpus];
  return corpus.filter(
    document =>
      document.tenantId === scope.tenantId &&
      document.corpusId === scope.corpusId &&
      document.trustLevel !== undefined &&
      document.trustLevel !== 'quarantined' &&
      scope.allowedTrustLevels.includes(document.trustLevel)
  );
}

function createCorpusIdentity(
  corpus: readonly RagEvalCorpusDocument[],
  evalCase: RagEvalTargetCase
): string {
  const scope = evalCase.scope;
  const scopeIdentity = scope
    ? [
        scope.tenantId,
        scope.corpusId,
        ...scope.allowedTrustLevels,
      ].join(':')
    : 'unscoped-v1';
  return [
    scopeIdentity,
    ...corpus.map(document =>
      [
        document.evidenceId,
        document.documentVersion ?? 'legacy',
        document.content,
      ].join(':')
    ),
  ].join('|');
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  validateEmbedding(left, 'left embedding');
  validateEmbedding(right, 'right embedding');
  if (left.length !== right.length) {
    throw new Error(
      `[rag-eval dense] embedding dimensions differ: ${left.length} versus ${right.length}`
    );
  }

  let dotProduct = 0;
  let leftNormSquared = 0;
  let rightNormSquared = 0;
  for (let index = 0; index < left.length; index += 1) {
    dotProduct += left[index] * right[index];
    leftNormSquared += left[index] * left[index];
    rightNormSquared += right[index] * right[index];
  }
  if (leftNormSquared === 0 || rightNormSquared === 0) {
    return 0;
  }
  return dotProduct / Math.sqrt(leftNormSquared * rightNormSquared);
}

function validateEmbeddingBatch(
  embeddings: readonly (readonly number[])[],
  expectedCount: number,
  label: string
): void {
  if (embeddings.length !== expectedCount) {
    throw new Error(
      `[rag-eval dense] ${label} count ${embeddings.length} does not match corpus count ${expectedCount}`
    );
  }
  embeddings.forEach((embedding, index) => validateEmbedding(embedding, `${label}[${index}]`));
}

function validateEmbedding(embedding: readonly number[], label: string): void {
  if (embedding.length === 0) {
    throw new Error(`[rag-eval dense] ${label} must not be empty`);
  }
  if (embedding.some(value => !Number.isFinite(value))) {
    throw new Error(`[rag-eval dense] ${label} contains a non-finite value`);
  }
}

function validateGenerationResult(result: RagEvalAnswerGeneratorResult): void {
  if (typeof result.answer !== 'string') {
    throw new Error('[rag-eval dense] generator answer must be a string');
  }
  if (result.inputTokens !== undefined) {
    assertNonNegativeFinite(result.inputTokens, 'inputTokens');
  }
  if (result.outputTokens !== undefined) {
    assertNonNegativeFinite(result.outputTokens, 'outputTokens');
  }
  if (result.costUsd !== undefined) {
    assertNonNegativeFinite(result.costUsd, 'costUsd');
  }
  if (result.generationCalls !== undefined) {
    assertPositiveInteger(result.generationCalls, 'generationCalls');
  }
  for (const [index, citation] of (result.citations ?? []).entries()) {
    if (!citation.evidenceId.trim()) {
      throw new Error('[rag-eval dense] citations[' + index + '] evidenceId is required');
    }
    if (
      !Number.isInteger(citation.startOffset) ||
      !Number.isInteger(citation.endOffset) ||
      citation.startOffset < 0 ||
      citation.endOffset <= citation.startOffset
    ) {
      throw new Error('[rag-eval dense] citations[' + index + '] has an invalid span');
    }
  }
}

function elapsed(start: number, end: number): number {
  return Math.max(0, end - start);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`[rag-eval dense] ${label} must be a positive integer`);
  }
}

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`[rag-eval dense] ${label} must be a non-negative finite number`);
  }
}

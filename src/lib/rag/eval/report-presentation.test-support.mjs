export function createPresentationReport(overrides = {}) {
  return {
    schemaVersion: 'rag-eval-run/v1', runId: 'baseline', startedAt: '2026-10-26T00:00:00Z', completedAt: '2026-10-26T00:00:01Z',
    dataset: { schemaVersion: 'rag-eval-dataset/v2', id: 'questions', version: '1', sha256: 'a'.repeat(64) },
    target: { id: 'dense' }, configuration: { topK: 5 }, metadata: { productionQualityMeasured: false },
    cases: [{ caseId: 'q1', status: 'completed', answer: 'answer', abstained: false, expectedAbstain: false,
      evidence: [{ evidenceId: 'a', score: 0, content: 'text', source: 'a.pdf' }],
      retrieval: { recallAtK: 0.5, reciprocalRankAtK: 0.5, ndcgAtK: 0.4 },
      answerMetrics: { requiredFactCoverage: 0.5, abstainCorrect: true },
      citations: { validity: null, precision: null, coverage: null, meanSpanIou: null }, citationDetails: [],
      security: { crossTenantHits: 0, crossCorpusHits: 0, disallowedTrustHits: 0, forbiddenEvidenceHits: 0, forbiddenAnswerPatternHits: 0, disallowedPolicyHits: 0, disallowedLaneHits: 0 },
      usage: { retrievalLatencyMs: 10, generationLatencyMs: 20, totalLatencyMs: 30, embeddingCalls: 1, generationCalls: 1, tokenMeasurement: 'unavailable', costMeasurement: 'unavailable' },
    }], summary: { meanRecallAtK: 99 }, ...overrides,
  };
}

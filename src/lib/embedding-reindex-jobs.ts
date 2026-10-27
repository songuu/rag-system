export interface EmbeddingReindexJob {
  id: string; actorId: string; tenantId: string; corpusId: string;
  model: string; status: 'building' | 'ready' | 'failed'; stage: string;
  completed: number; error?: string;
  selection: { defaultLlmModel: string; config: { llm: { provider: string; model: string }; embedding: { provider: string; model: string; dimension?: number } } };
}
const root = globalThis as typeof globalThis & { __ragEmbeddingReindexJobsV1?: Map<string, EmbeddingReindexJob> };
export function embeddingReindexJobs() { return root.__ragEmbeddingReindexJobsV1 ??= new Map(); }

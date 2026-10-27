import { createHash, randomUUID } from 'node:crypto';
import { getMilvusConnectionConfig } from './milvus-config';
import { getMilvusInstance } from './milvus-client';
import { createRetrievalScope, stampDocumentScope } from './security/retrieval-scope';
import type { RagSecurityContext } from './security/request-context';
import { RequestValidationError, resolveRuntimeEmbeddingProvider } from './security/request-validation';
import { redactErrorForLog } from './security/error-redaction';
import { embeddingIndexBaseKey } from './embedding-index-state';
import { embeddingIndexPointerStore, publishEmbeddingIndex } from './embedding-index-persistence';
import { embeddingReindexJobs } from './embedding-reindex-jobs';
import type { EmbeddingReindexJob } from './embedding-reindex-jobs';
import { beginVectorIngest } from './rag/vector-ingest-state';
import { fingerprintReindexChunks, rebuildEmbeddingIndex } from './rag/embedding-index-rebuild';

export function beginEmbeddingReindex(model: string, context: RagSecurityContext, selection: EmbeddingReindexJob['selection']): EmbeddingReindexJob {
  if (resolveRuntimeEmbeddingProvider() !== 'ollama') throw new RequestValidationError('EMBEDDING_SWITCH_UNSUPPORTED', '当前切换入口支持 Ollama 嵌入模型。', 409);
  // Check durable storage before starting an expensive model load.
  embeddingIndexPointerStore();
  const jobs = embeddingReindexJobs();
  const busy = [...jobs.values()].find(job => job.status === 'building');
  if (busy) {
    if (busy.actorId === context.actorId && busy.tenantId === context.tenantId && busy.corpusId === context.corpusId && busy.model === model) return busy;
    throw new RequestValidationError('EMBEDDING_REINDEX_BUSY', '已有索引重建任务，请等待完成后再切换。', 409);
  }
  const config = getMilvusConnectionConfig();
  const sourceConfig = { address: config.address, token: config.token, username: config.username, password: config.password,
    ssl: config.ssl, database: config.database, collectionName: config.defaultCollection, embeddingDimension: config.defaultDimension,
    indexType: config.defaultIndexType, metricType: config.defaultMetricType, flushOnInsert: true, reloadAfterInsert: false };
  const id = randomUUID();
  const lease = beginVectorIngest({ operationId: `embedding-reindex-${id}`, collectionName: config.defaultCollection, stage: 'reindexing' });
  const job: EmbeddingReindexJob = { id, actorId: context.actorId, tenantId: context.tenantId, corpusId: context.corpusId,
    model, status: 'building', stage: 'preparing', completed: 0, selection };
  for (const [key, old] of jobs) if (jobs.size >= 32 && old.status !== 'building') jobs.delete(key);
  jobs.set(id, job);
  const scope = createRetrievalScope({ tenantId: context.tenantId, corpusId: context.corpusId,
    enforceIsolation: true, allowedTrustLevels: ['trusted', 'reviewed', 'external', 'quarantined'] });
  const source = getMilvusInstance(sourceConfig);
  const collection = 'ragidx_' + randomUUID().replaceAll('-', '');
  const signal = AbortSignal.timeout(30 * 60_000);
  let targetDimension = 0;
  const run = async () => {
    await rebuildEmbeddingIndex(model, {
      readSource: () => source.readReindexChunks(scope),
      async embed(texts, signal) {
        const response = await fetch(`${(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/u, '')}/api/embed`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: texts, truncate: false, keep_alive: '15m' }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]),
        });
        if (!response.ok) throw new Error(`嵌入模型 ${model} 返回 HTTP ${response.status}，旧索引未更改。`);
        return (await response.json()).embeddings;
      },
      async createTarget(dimension) {
        targetDimension = dimension;
        await getMilvusInstance({ ...sourceConfig, collectionName: collection, embeddingDimension: dimension }).initializeCollection();
        return collection;
      },
      async insert(_collection, rows) {
        const store = getMilvusInstance({ ...sourceConfig, collectionName: collection, embeddingDimension: rows[0].embedding.length });
        const documents = rows.map(row => ({ ...row,
          metadata: stampDocumentScope({ ...row.metadata, embedding_model: model, embeddingModel: model,
            embeddingDimension: targetDimension, dimension: targetDimension }, scope,
          row.metadata.trust_level as 'trusted' | 'reviewed' | 'external' | 'quarantined') }));
        if (documents.some(row => JSON.stringify(row.metadata).length > 65000)) throw new Error('文档元数据超过集合容量，拒绝截断后切换。');
        await store.insertDocuments(documents);
      },
      async count() {
        const target = getMilvusInstance({ ...sourceConfig, collectionName: collection, embeddingDimension: targetDimension });
        await target.loadCollection();
        // Collection statistics lag behind recent flushes (e.g. 8 vs 42 rows).
        // Publication requires a strongly consistent logical query count.
        return target.countScopedDocuments(scope);
      },
      async verifySource(expected) {
        const fingerprints: string[] = [];
        for await (const rows of source.readReindexChunks(scope)) for (const row of rows) fingerprints.push(fingerprintReindexChunks([row]));
        if (createHash('sha256').update(fingerprints.sort().join('\n')).digest('hex') !== expected) throw new Error('重建期间源文档发生变化，已保留旧索引，请重试。');
      },
      async publish(index) {
        await publishEmbeddingIndex({ ...index, provider: 'ollama', baseKey: embeddingIndexBaseKey(), version: 1, updatedAt: new Date().toISOString() });
        job.selection.config.embedding = { provider: 'ollama', model, dimension: index.dimension };
      },
      progress(completed, stage) { job.completed = completed; job.stage = stage; },
    }, signal);
    job.status = 'ready'; job.stage = 'ready';
  };
  // A background job frees the model-selection HTTP request immediately.
  void run().catch(error => {
    console.error('[Embedding Reindex]', { jobId: id, stage: job.stage, ...redactErrorForLog(error) });
    job.error = `索引重建失败，旧模型和旧索引未更改。失败阶段：${job.stage}，请检查模型和向量服务后重试。`;
    job.status = 'failed'; job.stage = 'failed';
    lease.fail(error);
  }).finally(() => lease.release());
  return job;
}

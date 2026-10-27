import { createHash } from 'node:crypto';

export interface ReindexChunk { id: string; content: string; metadata: Record<string, unknown> }
export interface CompletedEmbeddingIndex { model: string; collection: string; dimension: number; chunkCount: number }
export interface EmbeddingIndexRebuildPorts {
  readSource(): AsyncIterable<ReindexChunk[]>;
  embed(texts: string[], signal: AbortSignal): Promise<number[][]>;
  createTarget(dimension: number): Promise<string>;
  insert(collection: string, rows: (ReindexChunk & { embedding: number[] })[]): Promise<void>;
  count(collection: string): Promise<number>;
  verifySource?(fingerprint: string): Promise<void>;
  publish(index: CompletedEmbeddingIndex): Promise<void>;
  progress?(completed: number, stage: string): void;
}
export function fingerprintReindexChunks(rows: readonly ReindexChunk[]): string {
  return createHash('sha256').update(rows.map(row => {
    const metadata = Object.fromEntries(Object.entries(row.metadata).sort(([a], [b]) => a.localeCompare(b)));
    return createHash('sha256').update(JSON.stringify([row.id, row.content, metadata])).digest('hex');
  }).sort().join('\n')).digest('hex');
}
export async function rebuildEmbeddingIndex(model: string, ports: EmbeddingIndexRebuildPorts, signal: AbortSignal): Promise<CompletedEmbeddingIndex> {
  signal.throwIfAborted();
  let collection = '';
  let dimension = 0;
  let completed = 0;
  const seen = new Set<string>();
  const fingerprints: string[] = [];
  const acceptVectors = (vectors: number[][], expected: number) => {
    if (!Array.isArray(vectors) || vectors.length !== expected) throw new Error('嵌入模型返回的向量数量不完整。');
    for (const vector of vectors) {
      if (!Array.isArray(vector) || vector.length < 1 || vector.length > 32768 || !vector.every(Number.isFinite)) throw new Error('嵌入模型返回了无效向量。');
      if (!dimension) dimension = vector.length;
      if (vector.length !== dimension) throw new Error('嵌入模型返回的向量维度不一致。');
    }
  };
  for await (const rows of ports.readSource()) {
    signal.throwIfAborted();
    for (const row of rows) {
      if (!row.id || typeof row.content !== 'string' || seen.has(row.id)) throw new Error('知识库快照存在无效或重复文档块。');
      seen.add(row.id);
      fingerprints.push(fingerprintReindexChunks([row]));
    }
    for (let offset = 0; offset < rows.length; offset += 8) {
      const batch = rows.slice(offset, offset + 8);
      ports.progress?.(completed, 'embedding');
      const vectors = await ports.embed(batch.map(row => row.content), signal);
      signal.throwIfAborted();
      acceptVectors(vectors, batch.length);
      if (!collection) collection = await ports.createTarget(dimension);
      await ports.insert(collection, batch.map((row, i) => ({ ...row, embedding: vectors[i] })));
      signal.throwIfAborted();
      completed += batch.length;
      ports.progress?.(completed, 'storing');
    }
  }
  if (!collection) {
    acceptVectors(await ports.embed(['embedding dimension probe'], signal), 1);
    signal.throwIfAborted();
    collection = await ports.createTarget(dimension);
  }
  if (await ports.count(collection) !== completed) throw new Error('新索引的文档块数量不完整，已保留旧索引。');
  signal.throwIfAborted();
  await ports.verifySource?.(createHash('sha256').update(fingerprints.sort().join('\n')).digest('hex'));
  signal.throwIfAborted();
  const result = { model, collection, dimension, chunkCount: completed };
  ports.progress?.(completed, 'publishing');
  // Persist the pointer last. Any earlier failure leaves the old index active.
  await ports.publish(result);
  return result;
}

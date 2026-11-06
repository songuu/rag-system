import { createHash } from 'node:crypto';
import { ConsistencyLevelEnum, type MilvusClient } from '@zilliz/milvus2-sdk-node';
import type { RagRetrievalScope } from '../security/retrieval-scope';
import {
  buildPublicationCollectionSchema,
  createPublicationChunk,
  type PublicationChunkInput,
} from './milvus-publication-generation';

type Client = Pick<MilvusClient, 'hasCollection' | 'createCollection' | 'createIndex' | 'insert' | 'flushSync' | 'loadCollectionSync' | 'query'>;
type Row = ReturnType<typeof createPublicationChunk>;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 1000;
const PAGE_SIZE = 32;
const OUTPUT_FIELDS = ['id', 'tenant_id', 'corpus_id', 'document_id', 'publication_generation', 'document_version',
  'trust_level', 'chunk_index', 'content', 'embedding', 'payload_digest'];

/**
 * Local experiment only. It cannot prove exclusive external write access or the
 * absence of SDK/gRPC retries, so its result is never a publication authority.
 * A timed-out RPC can still finish remotely: the collection must be abandoned.
 */
export class MilvusPublicationWriter {
  readonly productionCapable = false as const;
  private consumed = false;
  private readonly client: Client;
  private readonly collection: string;
  private readonly dimension: number;
  private readonly rows: readonly Row[];
  private readonly checkLease: () => Promise<boolean>;
  private readonly timeoutMs: number;

  constructor(input: {
    client: Client;
    collection: string;
    scope: RagRetrievalScope;
    dimension: number;
    chunks: readonly PublicationChunkInput[];
    checkLease: () => Promise<boolean>;
    timeoutMs: number;
  }) {
    if (!/^rag_publication_[a-f0-9]{32}$/.test(input.collection)) throw new Error('Invalid isolated publication collection.');
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 30000) throw new Error('Invalid publication timeout.');
    if (typeof input.checkLease !== 'function' || !Array.isArray(input.chunks)
      || input.chunks.length < 1 || input.chunks.length > MAX_ROWS) throw new Error('Invalid publication manifest.');
    const rows = input.chunks.map(chunk => createPublicationChunk(input.scope, chunk, input.dimension));
    const first = rows[0];
    if (rows.some(row => row.document_id !== first.document_id || row.publication_generation !== first.publication_generation
      || row.document_version !== first.document_version)) throw new Error('Publication manifest must describe one document generation.');
    if (new Set(rows.map(row => row.id)).size !== rows.length || new Set(rows.map(row => row.chunk_index)).size !== rows.length) {
      throw new Error('Duplicate publication manifest chunk.');
    }
    if (Buffer.byteLength(JSON.stringify(rows), 'utf8') > MAX_BYTES) throw new Error('Publication manifest exceeds byte capacity.');
    this.client = input.client;
    this.collection = input.collection;
    this.dimension = input.dimension;
    this.rows = rows.map(row => ({ ...row, embedding: [...row.embedding] }));
    this.checkLease = input.checkLease;
    this.timeoutMs = input.timeoutMs;
  }

  async observe(): Promise<{ kind: 'multi-read-observation'; count: number; digest: string; productionAuthorized: false }> {
    if (this.consumed) throw new Error('Publication writer already consumed; use a new generation.');
    this.consumed = true;
    const exists = await this.step(() => this.client.hasCollection({ collection_name: this.collection }));
    assertSuccess(exists);
    if (exists.value !== false) throw new Error('Publication collection already exists or is ambiguous.');
    assertSuccess(await this.step(() => this.client.createCollection(buildPublicationCollectionSchema(this.collection, this.dimension))));
    assertSuccess(await this.step(() => this.client.createIndex({ collection_name: this.collection, field_name: 'embedding',
      index_name: 'publication_vector_index', index_type: 'FLAT', metric_type: 'COSINE' })));
    const inserted = await this.step(() => this.client.insert({ collection_name: this.collection, data: this.rows.map(row => ({ ...row, embedding: [...row.embedding] })) }));
    assertSuccess(inserted);
    if (readSafeInteger(inserted.insert_cnt) !== this.rows.length) throw new Error('Publication insert count mismatch.');
    assertSuccess(await this.step(() => this.client.flushSync({ collection_names: [this.collection] })));
    assertSuccess(await this.step(() => this.client.loadCollectionSync({ collection_name: this.collection })));

    const count = async () => {
      const result = await this.step(() => this.client.query({ collection_name: this.collection, consistency_level: ConsistencyLevelEnum.Strong,
        output_fields: ['count(*)'], filter: '' }));
      assertSuccess(result);
      const rows = result.data as unknown as Record<string, unknown>[];
      if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || readSafeInteger(rows[0]['count(*)']) !== this.rows.length) {
        throw new Error('Publication observed row count mismatch.');
      }
    };
    await count();
    const expected = new Map(this.rows.map(row => [row.id, row]));
    const seen = new Set<string>();
    for (;;) {
      const seenIds = [...seen];
      const result = await this.step(() => this.client.query({ collection_name: this.collection, consistency_level: ConsistencyLevelEnum.Strong,
        output_fields: OUTPUT_FIELDS, filter: seenIds.length ? 'id not in {seenIds}' : '',
        ...(seenIds.length ? { exprValues: { seenIds } } : {}), limit: PAGE_SIZE }));
      assertSuccess(result);
      const rows = result.data as unknown as Record<string, unknown>[];
      if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw new Error('Invalid publication readback.');
      if (!rows.length) break;
      for (const observed of rows) {
        const id = observed.id;
        const reference = typeof id === 'string' ? expected.get(id) : undefined;
        if (!reference || seen.has(reference.id) || !sameRow(reference, observed)) throw new Error('Publication readback does not match manifest.');
        seen.add(reference.id);
        if (seen.size > this.rows.length) throw new Error('Duplicate publication readback.');
      }
    }
    if (seen.size !== this.rows.length) throw new Error('Publication readback is incomplete.');
    await count();
    const digest = createHash('sha256').update(JSON.stringify([...this.rows].sort((a, b) => a.id.localeCompare(b.id)))).digest('hex');
    // Multiple strong reads do not form an atomic snapshot and do not stop a late writer.
    return { kind: 'multi-read-observation', count: seen.size, digest, productionAuthorized: false };
  }

  private async step<T>(work: () => Promise<T>): Promise<T> {
    await this.guard();
    const value = await this.withTimeout(work);
    await this.guard();
    return value;
  }

  private async guard(): Promise<void> {
    if (await this.withTimeout(this.checkLease) !== true) throw new Error('Publication lease lost; generation abandoned.');
  }

  private async withTimeout<T>(work: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Publication RPC timeout; generation abandoned.')), this.timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function assertSuccess(response: unknown): void {
  if (!response || typeof response !== 'object') throw new Error('Invalid Milvus publication response.');
  const record = response as Record<string, unknown>;
  const status = record.status && typeof record.status === 'object' ? record.status as Record<string, unknown> : record;
  if (status.error_code !== 'Success' || (status.code !== undefined && readSafeInteger(status.code) !== 0)) {
    throw new Error('Milvus publication operation failed.');
  }
}

function sameRow(expected: Row, actual: Record<string, unknown>): boolean {
  for (const key of ['id', 'tenant_id', 'corpus_id', 'document_id', 'document_version', 'trust_level', 'content', 'payload_digest'] as const) {
    if (actual[key] !== expected[key]) return false;
  }
  if (readSafeInteger(actual.publication_generation) !== expected.publication_generation
    || readSafeInteger(actual.chunk_index) !== expected.chunk_index) return false;
  if (!Array.isArray(actual.embedding) || actual.embedding.length !== expected.embedding.length) return false;
  for (let index = 0; index < expected.embedding.length; index++) {
    if (!Object.hasOwn(actual.embedding, index)) return false;
    const value: unknown = actual.embedding[index];
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))) return false;
    if ((Object.is(Math.fround(value), -0) ? 0 : Math.fround(value)) !== expected.embedding[index]) return false;
  }
  return true;
}

function readSafeInteger(value: unknown): number | null {
  if (typeof value === 'string') {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
    value = Number(value);
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

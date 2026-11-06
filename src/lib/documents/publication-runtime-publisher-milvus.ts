import { createHash } from 'node:crypto';
import { ConsistencyLevelEnum, type MilvusClient } from '@zilliz/milvus2-sdk-node';
import type { createPublicationChunk } from './milvus-publication-generation';

type Row = ReturnType<typeof createPublicationChunk>;
type Client = Pick<MilvusClient, 'describeCollection' | 'query' | 'config' | 'channelOptions' | 'channelPool' | 'isGlobal'>;
const FIELDS = ['id', 'tenant_id', 'corpus_id', 'document_id', 'publication_generation', 'document_version',
  'trust_level', 'chunk_index', 'content', 'embedding', 'payload_digest'];

/** Check before any Milvus request; client or transport retries may duplicate inserts. */
export function assertRuntimeMilvusNoRetries(client: Client): void {
  if (!client || client.config.maxRetries !== 0 || client.isGlobal !== false
    || client.channelOptions['grpc.enable_retries'] !== 0
    || (client.channelPool as unknown as Record<string, unknown>).__failoverHandler !== undefined) {
    throw new Error('Milvus publisher client must disable all retry and global failover.');
  }
}

/**
 * A fresh independent read of actual rows, not a seal. The isolated trusted
 * publisher must also prove no other writer can access this collection and
 * that its own write RPCs settled. Milvus 2.5 offers no server-side barrier.
 */
export async function verifyRuntimeMilvusReadback(input: {
  client: Client;
  collection: string;
  expectedRows: readonly Row[];
  assertLease(): Promise<void>;
  timeoutMs: number;
}): Promise<{ kind: 'strong-multiread'; collectionId: string; evidenceDigest: string; productionAuthorized: false }> {
  assertRuntimeMilvusNoRetries(input.client);
  if (!/^rag_publication_[a-f0-9]{32}$/.test(input.collection) || !Number.isSafeInteger(input.timeoutMs)
    || input.timeoutMs < 1 || input.timeoutMs > 30000 || typeof input.assertLease !== 'function'
    || !Array.isArray(input.expectedRows) || input.expectedRows.length < 1 || input.expectedRows.length > 1000) {
    throw new Error('Invalid Milvus publisher readback request.');
  }
  const expected = new Map(input.expectedRows.map(row => [row.id, row]));
  if (expected.size !== input.expectedRows.length) throw new Error('Duplicate expected Milvus chunk.');
  const call = async <T>(work: () => Promise<T>): Promise<T> => {
    await bounded(input.assertLease, input.timeoutMs);
    const result = await bounded(work, input.timeoutMs);
    await bounded(input.assertLease, input.timeoutMs);
    return result;
  };
  const describe = async () => {
    const response = await call(() => input.client.describeCollection({ collection_name: input.collection }));
    assertSuccess(response);
    if (response.collection_name !== input.collection || typeof response.collectionID !== 'string'
      || !/^[1-9][0-9]{0,18}$/.test(response.collectionID) || response.schema?.name !== input.collection) {
      throw new Error('Milvus publication collection identity changed.');
    }
    return response.collectionID;
  };
  const count = async () => {
    const result = await call(() => input.client.query({ collection_name: input.collection,
      consistency_level: ConsistencyLevelEnum.Strong, output_fields: ['count(*)'], filter: '' }));
    assertSuccess(result);
    const rows = result.data as unknown as Record<string, unknown>[];
    if (!Array.isArray(rows) || rows.length !== 1 || integer(rows[0]?.['count(*)']) !== expected.size) {
      throw new Error('Milvus publication row count changed.');
    }
  };
  const collectionId = await describe();
  await count();
  const seen = new Set<string>();
  for (;;) {
    const seenIds = [...seen];
    const response = await call(() => input.client.query({ collection_name: input.collection,
      consistency_level: ConsistencyLevelEnum.Strong, output_fields: FIELDS, filter: seenIds.length ? 'id not in {seenIds}' : '',
      ...(seenIds.length ? { exprValues: { seenIds } } : {}), limit: 32 }));
    assertSuccess(response);
    const rows = response.data as unknown as Record<string, unknown>[];
    if (!Array.isArray(rows) || rows.length > 32) throw new Error('Invalid Milvus publication readback.');
    if (!rows.length) break;
    for (const row of rows) {
      const reference = typeof row?.id === 'string' ? expected.get(row.id) : undefined;
      if (!reference || seen.has(reference.id) || !sameRow(reference, row)) throw new Error('Milvus publication differs from the authoritative manifest.');
      seen.add(reference.id);
      if (seen.size > expected.size) throw new Error('Milvus publication exceeds expected count.');
    }
  }
  if (seen.size !== expected.size) throw new Error('Milvus publication readback is incomplete.');
  await count();
  if (await describe() !== collectionId) throw new Error('Milvus publication collection was replaced.');
  const manifest = [...input.expectedRows].sort((a, b) => a.id.localeCompare(b.id));
  return { kind: 'strong-multiread', collectionId,
    evidenceDigest: `sha256:${createHash('sha256').update(JSON.stringify([collectionId, manifest])).digest('hex')}`,
    productionAuthorized: false };
}

function sameRow(expected: Row, actual: Record<string, unknown>): boolean {
  for (const field of ['id', 'tenant_id', 'corpus_id', 'document_id', 'document_version', 'trust_level', 'content', 'payload_digest'] as const) {
    if (actual[field] !== expected[field]) return false;
  }
  if (integer(actual.publication_generation) !== expected.publication_generation
    || integer(actual.chunk_index) !== expected.chunk_index || !Array.isArray(actual.embedding)
    || actual.embedding.length !== expected.embedding.length) return false;
  for (let index = 0; index < expected.embedding.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(actual.embedding, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'number'
      || !Number.isFinite(descriptor.value) || Math.fround(descriptor.value) !== expected.embedding[index]) return false;
  }
  return true;
}

function integer(value: unknown): number | null {
  if (typeof value === 'string') {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
    value = Number(value);
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function assertSuccess(value: { status?: { error_code?: unknown; code?: unknown } }): void {
  if (value.status?.error_code !== 'Success' || (value.status.code !== undefined && integer(value.status.code) !== 0)) {
    throw new Error('Milvus publication readback failed.');
  }
}

async function bounded<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Milvus publication readback timed out; abandon the generation.')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

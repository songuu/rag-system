import { queryPostgres, getPostgresClient, type PostgresQueryClient } from '../postgres/client';
import { assertPostgresPersistenceConfigured, getPostgresRuntimeConfig, shouldUsePostgresPersistence } from '../postgres/env';

export type MiroFishRuntimeKind = 'simulation' | 'report' | 'interaction' | 'prepare' | 'graph';
export interface MiroFishRuntimeScope { tenantId: string; corpusId: string }
export interface MiroFishRuntimeListOptions { projectId?: string; limit?: number }
export interface MiroFishRuntimeStore {
  read<T>(kind: MiroFishRuntimeKind, id: string): Promise<T | null>;
  write<T>(kind: MiroFishRuntimeKind, id: string, value: T, options?: { projectId?: string }): Promise<void>;
  list<T>(kind: MiroFishRuntimeKind, options?: MiroFishRuntimeListOptions): Promise<T[]>;
  delete(kind: MiroFishRuntimeKind, id: string): Promise<boolean>;
}

const KINDS = new Set(['simulation', 'report', 'interaction', 'prepare', 'graph']);
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_HISTORY_RECORDS = 200;
interface RuntimeRecord { schemaVersion: 1; kind: MiroFishRuntimeKind; id: string; projectId?: string; updatedAt: string; value: unknown }
interface BlobRow { filename: string; data: Buffer | string }
const runtimeGlobal = globalThis as typeof globalThis & { __miroFishRuntimeRecordsV1?: Map<string, string> };
const localRecords = runtimeGlobal.__miroFishRuntimeRecordsV1 ??= new Map<string, string>();

export class MiroFishRuntimeStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'MiroFishRuntimeStoreError'; this.code = code; }
}

function validateId(id: string): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(id) || id === '.' || id === '..') {
    throw new MiroFishRuntimeStoreError('MIROFISH_RUNTIME_INVALID_ID', 'Invalid MiroFish runtime identifier.');
  }
}
function validateScope(scope: MiroFishRuntimeScope): void {
  const valid = (value: string) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
  if (!valid(scope.tenantId) || !valid(scope.corpusId)) {
    throw new MiroFishRuntimeStoreError('MIROFISH_RUNTIME_INVALID_SCOPE', 'Invalid MiroFish runtime scope.');
  }
}
function prefix(kind: MiroFishRuntimeKind): string {
  if (!KINDS.has(kind)) throw new MiroFishRuntimeStoreError('MIROFISH_RUNTIME_INVALID_KIND', 'Invalid MiroFish runtime record kind.');
  return `mirofish-runtime/${kind}/`;
}
function filename(kind: MiroFishRuntimeKind, id: string): string { validateId(id); return `${prefix(kind)}${id}.json`; }
function historyLimit(value: number | undefined): number {
  return value === undefined ? 100 : Math.max(1, Math.min(MAX_HISTORY_RECORDS, Number.isSafeInteger(value) ? value : 100));
}
function invalidRecord(): MiroFishRuntimeStoreError {
  return new MiroFishRuntimeStoreError('MIROFISH_RUNTIME_INVALID_RECORD', 'MiroFish runtime record is invalid or exceeds its storage limit.');
}
function encode<T>(kind: MiroFishRuntimeKind, id: string, value: T, options: { projectId?: string }): string {
  if (options.projectId !== undefined) validateId(options.projectId);
  try {
    if (value === undefined) throw invalidRecord();
    const data = JSON.stringify({ schemaVersion: 1, kind, id, projectId: options.projectId, updatedAt: new Date().toISOString(), value });
    if (Buffer.byteLength(data, 'utf8') > MAX_RECORD_BYTES) throw invalidRecord();
    return data;
  } catch { throw invalidRecord(); }
}
function decode(data: Buffer | string, kind: MiroFishRuntimeKind, id?: string): RuntimeRecord {
  try {
    if (Buffer.byteLength(data) > MAX_RECORD_BYTES) throw invalidRecord();
    const record: RuntimeRecord = JSON.parse(typeof data === 'string' ? data : new TextDecoder('utf-8', { fatal: true }).decode(data));
    if (!record || record.schemaVersion !== 1 || record.kind !== kind || (id !== undefined && record.id !== id)
      || !Object.prototype.hasOwnProperty.call(record, 'value') || !Number.isFinite(Date.parse(record.updatedAt))) throw invalidRecord();
    validateId(record.id);
    return record;
  } catch { throw invalidRecord(); }
}

/** Explicit local-memory mode only. PostgreSQL remains authoritative in deployed mode. */
export class MemoryMiroFishRuntimeStore implements MiroFishRuntimeStore {
  private readonly scopeKey: string;
  constructor(scope: MiroFishRuntimeScope) { validateScope(scope); this.scopeKey = JSON.stringify([scope.tenantId, scope.corpusId]); }
  async read<T>(kind: MiroFishRuntimeKind, id: string): Promise<T | null> {
    const data = localRecords.get(this.scopeKey + filename(kind, id));
    return data === undefined ? null : decode(data, kind, id).value as T;
  }
  async write<T>(kind: MiroFishRuntimeKind, id: string, value: T, options: { projectId?: string } = {}): Promise<void> {
    const key = this.scopeKey + filename(kind, id);
    if (!localRecords.has(key) && localRecords.size >= 1_000) throw new MiroFishRuntimeStoreError('MIROFISH_RUNTIME_CAPACITY', 'Local MiroFish runtime capacity reached.');
    localRecords.set(key, encode(kind, id, value, options));
  }
  async list<T>(kind: MiroFishRuntimeKind, options: MiroFishRuntimeListOptions = {}): Promise<T[]> {
    const keyPrefix = this.scopeKey + prefix(kind);
    return [...localRecords].filter(([key]) => key.startsWith(keyPrefix)).map(([, data]) => decode(data, kind))
      .filter(record => options.projectId === undefined || record.projectId === options.projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, historyLimit(options.limit)).map(record => record.value as T);
  }
  async delete(kind: MiroFishRuntimeKind, id: string): Promise<boolean> { return localRecords.delete(this.scopeKey + filename(kind, id)); }
}

/** Reuses scoped object_blobs; no second database or schema migration is needed. */
export class PostgresMiroFishRuntimeStore implements MiroFishRuntimeStore {
  private readonly client: PostgresQueryClient;
  private readonly scope: MiroFishRuntimeScope;
  constructor(client: PostgresQueryClient, scope: MiroFishRuntimeScope) {
    this.client = client;
    this.scope = scope;
    validateScope(scope);
  }
  async read<T>(kind: MiroFishRuntimeKind, id: string): Promise<T | null> {
    const result = await queryPostgres<BlobRow>(this.client,
      'select filename, data from public.object_blobs where tenant_id = $1 and corpus_id = $2 and filename = $3 and kind = \'artifact\' limit 1',
      [this.scope.tenantId, this.scope.corpusId, filename(kind, id)], 'read MiroFish runtime record');
    return result.rows[0] ? decode(result.rows[0].data, kind, id).value as T : null;
  }
  async write<T>(kind: MiroFishRuntimeKind, id: string, value: T, options: { projectId?: string } = {}): Promise<void> {
    const key = filename(kind, id);
    const data = Buffer.from(encode(kind, id, value, options), 'utf8');
    await queryPostgres(this.client, `insert into public.object_blobs
      (tenant_id, corpus_id, filename, data, kind, content_type, metadata, created_at, updated_at)
      values ($1, $2, $3, $4, 'artifact', 'application/json', $5::jsonb, now(), now())
      on conflict (tenant_id, corpus_id, filename) do update set data = excluded.data,
        metadata = excluded.metadata, content_type = excluded.content_type, updated_at = now()`,
    [this.scope.tenantId, this.scope.corpusId, key, data, JSON.stringify({ mirofishKind: kind, mirofishProjectId: options.projectId ?? null })],
    'write MiroFish runtime record');
  }
  async list<T>(kind: MiroFishRuntimeKind, options: MiroFishRuntimeListOptions = {}): Promise<T[]> {
    if (options.projectId !== undefined) validateId(options.projectId);
    const result = await queryPostgres<BlobRow>(this.client,
      `select filename, data from public.object_blobs where tenant_id = $1 and corpus_id = $2 and kind = 'artifact'
       and starts_with(filename, $3) and ($4::text is null or metadata->>'mirofishProjectId' = $4)
       order by updated_at desc, filename limit $5`,
      [this.scope.tenantId, this.scope.corpusId, prefix(kind), options.projectId ?? null, historyLimit(options.limit)], 'list MiroFish runtime history');
    return result.rows.map(row => decode(row.data, kind).value as T);
  }
  async delete(kind: MiroFishRuntimeKind, id: string): Promise<boolean> {
    const result = await queryPostgres(this.client,
      'delete from public.object_blobs where tenant_id = $1 and corpus_id = $2 and filename = $3 and kind = \'artifact\'',
      [this.scope.tenantId, this.scope.corpusId, filename(kind, id)], 'delete MiroFish runtime record');
    return (result.rowCount ?? 0) > 0;
  }
}

export function getMiroFishRuntimeStore(scope?: MiroFishRuntimeScope): MiroFishRuntimeStore {
  const config = getPostgresRuntimeConfig();
  const resolvedScope = scope ?? { tenantId: config.defaultTenantId || 'local-dev-tenant', corpusId: config.defaultCorpusId || 'local-dev-corpus' };
  if (!shouldUsePostgresPersistence(config)) return new MemoryMiroFishRuntimeStore(resolvedScope);
  assertPostgresPersistenceConfigured(config);
  const client = getPostgresClient(config);
  if (!client) throw new MiroFishRuntimeStoreError('MIROFISH_RUNTIME_UNAVAILABLE', 'MiroFish PostgreSQL persistence is unavailable.');
  return new PostgresMiroFishRuntimeStore(client, resolvedScope);
}

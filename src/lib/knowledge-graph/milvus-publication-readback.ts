import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { boundedProviderCall } from '../rag/eval/bounded-provider-call';
import { canonicalJson } from '../rag/eval/canonical-json';
import type { RagTrustLevel } from '../security/retrieval-scope';

type Code = 'invalid-config' | 'invalid-request' | 'invalid-readback' | 'query-failed' | 'query-timeout'
  | 'provider-contract-invalid' | 'halted' | 'busy' | 'read-limit' | 'row-capacity' | 'parameter-capacity';
export class MilvusPublicationReadbackError extends Error {
  readonly productionAuthorized = false;
  readonly automaticRetryAllowed = false;
  readonly code: Code;
  readonly pendingCompletionUnknown: boolean;
  constructor(code: Code, pendingCompletionUnknown = false) {
    super(`[milvus publication readback] ${code}`); this.name = 'MilvusPublicationReadbackError';
    this.code = code; this.pendingCompletionUnknown = pendingCompletionUnknown; Object.freeze(this);
  }
}
type Fields = Record<string, unknown>;
type Scope = { readonly environment: string; readonly tenantId: string; readonly corpusId: string };
type Row = { readonly id: string; readonly content: string; readonly tenant_id: string; readonly corpus_id: string;
  readonly document_id: string; readonly document_version: string; readonly trust_level: RagTrustLevel;
  readonly chunk_index: number; readonly total_chunks: number };
export interface MilvusPublicationData {
  readonly scope: Scope;
  readonly collection: string;
  readonly schemaManifest: Readonly<Fields>;
  readonly indexManifest: Readonly<Fields>;
  readonly rows: readonly Row[];
}
const ROW_FIELDS = ['id', 'content', 'tenant_id', 'corpus_id', 'document_id', 'document_version', 'trust_level', 'chunk_index', 'total_chunks'] as const;
const SCOPE_FILTER = 'tenant_id == {tenantId} && corpus_id == {corpusId}';
// SDK 3.0.1's default loader returns enum names; formatDescribedCol adds
// numeric/convenience helpers. Their agreement is checked, not hashed as DB fields.
const DATA_TYPES: Readonly<Record<string, number>> = Object.freeze({ None: 0, Bool: 1, Int8: 2, Int16: 3, Int32: 4, Int64: 5,
  Float: 10, Double: 11, VarChar: 21, Array: 22, JSON: 23, Geometry: 24, Timestamptz: 26, BinaryVector: 100, FloatVector: 101,
  Float16Vector: 102, BFloat16Vector: 103, SparseFloatVector: 104, Int8Vector: 105, ArrayOfVector: 106, Struct: 201 });
const PROTO_FIELD_KEYS = new Set(['fieldID', 'name', 'is_primary_key', 'description', 'data_type', 'type_params', 'index_params', 'autoID', 'state',
  'element_type', 'default_value', 'is_dynamic', 'is_partition_key', 'is_clustering_key', 'nullable', 'is_function_output', 'external_field']);
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function snapshot(value: unknown): unknown { return freeze(JSON.parse(canonicalJson(value))); }
function record(value: unknown): Fields {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
  for (const key of Reflect.ownKeys(value)) { if (typeof key !== 'string') throw new Error(); const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) throw new Error(); }
  return value as Fields;
}
function exact(value: Fields, names: readonly string[]): void { if (Object.keys(value).length !== names.length || names.some(k => !Object.hasOwn(value, k))) throw new Error(); }
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) throw new Error();
  if (Reflect.ownKeys(value).length !== value.length + 1) throw new Error();
  for (let index = 0; index < value.length; index++) { const d = Object.getOwnPropertyDescriptor(value, String(index));
    if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) throw new Error(); }
  return value;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(); return value;
}
function sdkInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value === 'string') { if (!/^(0|[1-9]\d*)$/.test(value) || value.length > 16) throw new Error(); value = Number(value); }
  return integer(value, minimum, maximum);
}
function decimalId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > BigInt('9223372036854775807')) throw new Error(); return value;
}
function identifier(value: unknown): string { if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) throw new Error(); return value; }
function collectionName(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(value)) throw new Error(); return value; }
function unicode(value: string): void { for (let i = 0; i < value.length; i++) { const unit = value.charCodeAt(i);
  if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(); }
  else if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error(); } }
function opaqueId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 512 || /[\u0000-\u001f]/.test(value)) throw new Error(); unicode(value); return value;
}
function status(value: unknown): void {
  const s = record(snapshot(value)); if (s.error_code !== 'Success' || (Object.hasOwn(s, 'code') && s.code !== 0) || s.reason !== '') throw new Error();
}
function keyValues(value: unknown): Record<string, string> {
  const values: Record<string, string> = Object.create(null);
  for (const entry of array(value, 128)) { const pair = record(entry); exact(pair, ['key', 'value']);
    if (typeof pair.key !== 'string' || !pair.key || typeof pair.value !== 'string' || Object.hasOwn(values, pair.key)) throw new Error();
    values[pair.key] = pair.value; }
  return values;
}
function method(client: unknown, name: string): (request: Fields) => unknown {
  if (!client || typeof client !== 'object' || types.isProxy(client)) throw new Error();
  let current: object | null = client;
  for (let depth = 0; current && depth < 16; depth++) { if (types.isProxy(current)) throw new Error();
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) { if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function' || types.isProxy(descriptor.value)) throw new Error();
      const captured = descriptor.value; return request => Reflect.apply(captured, client, [request]); }
    current = Object.getPrototypeOf(current);
  }
  throw new Error();
}

/** Actual SDK business-data reader. Strong reads and before/after equality are
 * observations, not an atomic snapshot, authenticated environment, IAM proof or
 * PublicationSource authorization. SDK-internal retries are outside this port. */
export class MilvusKnowledgeGraphPublicationReadback {
  readonly executionProfile = 'local-reference' as const;
  readonly productionCapable = false;
  #scope: Scope;
  #collection: string;
  #timeout: number;
  #maxReads: number;
  #pageSize: number;
  #maxRows: number;
  #rowBytes: number;
  #parameterBytes: number;
  #query: (request: Fields) => unknown;
  #describeCollection: (request: Fields) => unknown;
  #describeIndex: (request: Fields) => unknown;
  #busy = false;
  #halted = false;
  #pendingCompletionUnknown = false;
  #reads = 0;
  constructor(client: unknown, options: unknown) {
    try { const cfg = record(snapshot(options)); exact(cfg, ['executionProfile', 'scope', 'collection', 'operationTimeoutMs', 'maxReads', 'pageSize', 'maxRows', 'maxTotalRowBytes', 'maxQueryParameterBytes']);
      if (cfg.executionProfile !== 'local-reference') throw new Error(); const scope = record(cfg.scope); exact(scope, ['environment', 'tenantId', 'corpusId']);
      Object.values(scope).forEach(identifier); this.#scope = scope as Scope; this.#collection = collectionName(cfg.collection);
      this.#timeout = integer(cfg.operationTimeoutMs, 1, 30000); this.#maxReads = integer(cfg.maxReads, 1, 128);
      this.#pageSize = integer(cfg.pageSize, 1, 128); this.#maxRows = integer(cfg.maxRows, 1, 65536);
      this.#rowBytes = integer(cfg.maxTotalRowBytes, 1, 64 * 1024 * 1024); this.#parameterBytes = integer(cfg.maxQueryParameterBytes, 1, 64 * 1024 * 1024);
      this.#query = method(client, 'query'); this.#describeCollection = method(client, 'describeCollection'); this.#describeIndex = method(client, 'describeIndex'); Object.freeze(this);
    } catch { throw new MilvusPublicationReadbackError('invalid-config'); }
  }
  async readPublication(request: unknown): Promise<MilvusPublicationData> {
    if (this.#halted) throw new MilvusPublicationReadbackError('halted'); if (this.#busy) throw new MilvusPublicationReadbackError('busy');
    try { exact(record(snapshot(request)), []); } catch { throw new MilvusPublicationReadbackError('invalid-request'); }
    if (this.#reads >= this.#maxReads) throw new MilvusPublicationReadbackError('read-limit'); this.#reads++; this.#busy = true;
    try {
      const deadline = performance.now() + this.#timeout;
      const observed = await boundedProviderCall(async () => {
        try { return { value: await this.#collect(deadline) }; }
        catch (error) { return { error: error instanceof MilvusPublicationReadbackError ? error : new MilvusPublicationReadbackError('invalid-readback') }; }
      }, this.#timeout);
      if (observed.status === 'timeout' || observed.status === 'invalid-return') { this.#halted = true;
        throw new MilvusPublicationReadbackError(observed.status === 'timeout' ? 'query-timeout' : 'provider-contract-invalid',
          observed.pendingCompletionUnknown || this.#pendingCompletionUnknown); }
      if (observed.status === 'rejected') throw new MilvusPublicationReadbackError('query-failed');
      const result = observed.value as { value?: MilvusPublicationData; error?: MilvusPublicationReadbackError };
      if (result.error) throw result.error; return result.value!;
    } finally { this.#busy = false; }
  }
  async #io(call: (request: Fields) => unknown, request: Fields, deadline: number): Promise<{ readonly value: unknown }> {
    if (this.#halted) throw new MilvusPublicationReadbackError('halted'); const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) { this.#halted = true; throw new MilvusPublicationReadbackError('query-timeout'); }
    // The real SDK writes expr/expr_template_values into its request. A fresh
    // detached transport shell permits that without exposing frozen private
    // scope, options, previous pages or the accumulated PK exclusion state.
    const sdkRequest = structuredClone({ ...request, collection_name: this.#collection, timeout: remaining });
    const observed = await boundedProviderCall(() => {
      // Timers cannot preempt cloning or synchronous JS. Recheck immediately
      // before business dispatch, not merely before constructing its request.
      const dispatchRemaining = Math.floor(deadline - performance.now());
      if (this.#halted || dispatchRemaining < 1) { this.#halted = true; throw new MilvusPublicationReadbackError('query-timeout'); }
      sdkRequest.timeout = dispatchRemaining; this.#pendingCompletionUnknown = true; return call(sdkRequest);
    }, remaining);
    if (observed.status === 'timeout' || observed.status === 'invalid-return') { this.#halted = true;
      this.#pendingCompletionUnknown = observed.pendingCompletionUnknown;
      throw new MilvusPublicationReadbackError(observed.status === 'timeout' ? 'query-timeout' : 'provider-contract-invalid', observed.pendingCompletionUnknown); }
    this.#pendingCompletionUnknown = false;
    if (observed.status === 'rejected') throw new MilvusPublicationReadbackError(this.#halted ? 'query-timeout' : 'query-failed');
    // An async raw return would Promise-resolve the unvalidated fulfilled
    // payload and invoke its `then` getter. Only adopt our fresh safe wrapper;
    // callers then validate raw descriptors before reading business fields.
    if (this.#halted) throw new MilvusPublicationReadbackError('halted'); return Object.freeze({ value: observed.value });
  }
  async #schema(deadline: number): Promise<Readonly<Fields>> {
    const result = record(snapshot((await this.#io(this.#describeCollection, { cache: false }, deadline)).value)); status(result.status);
    if (result.collection_name !== this.#collection) throw new Error(); decimalId(result.collectionID);
    const schema = record(result.schema); if (schema.name !== this.#collection || schema.autoID !== false || typeof schema.enable_dynamic_field !== 'boolean') throw new Error();
    // The SDK irreversibly rewrites struct children. Reject that unsupported
    // shape explicitly instead of inventing a supposedly original schema.
    if (Object.hasOwn(schema, 'struct_array_fields') && array(schema.struct_array_fields, 256).length) throw new Error();
    const fields = array(schema.fields, 256); if (!fields.length) throw new Error(); const byName = new Map<string, Fields>(); const fieldIds = new Set<string>();
    const normalizedFields: Fields[] = [];
    for (const item of fields) { const field = record(item); const name = collectionName(field.name); const fieldId = decimalId(field.fieldID);
      if (byName.has(name) || fieldIds.has(fieldId) || typeof field.is_primary_key !== 'boolean' || typeof field.autoID !== 'boolean') throw new Error();
      if (typeof field.data_type !== 'string' || !Object.hasOwn(DATA_TYPES, field.data_type) || field.dataType !== DATA_TYPES[field.data_type]
        || field._placeholderType !== (field.is_function_output === true ? 21 : DATA_TYPES[field.data_type])) throw new Error();
      const params = keyValues(field.type_params); keyValues(field.index_params); const normalized = { ...field };
      delete normalized.dataType; delete normalized._placeholderType;
      for (const [key, value] of Object.entries(params)) {
        if (PROTO_FIELD_KEYS.has(key) || ['dataType', '_placeholderType', 'elementType'].includes(key) || !Object.hasOwn(field, key) || field[key] !== value) throw new Error();
        delete normalized[key];
      }
      normalizedFields.push(normalized);
      byName.set(name, field); fieldIds.add(fieldId); }
    for (const name of ROW_FIELDS) { const field = byName.get(name); if (!field || field.data_type !== (name === 'chunk_index' || name === 'total_chunks' ? 'Int64' : 'VarChar')) throw new Error(); }
    const primary = fields.filter(item => record(item).is_primary_key); if (primary.length !== 1 || record(primary[0]).name !== 'id' || record(primary[0]).autoID !== false) throw new Error();
    const embedding = byName.get('embedding'); if (!embedding || embedding.data_type !== 'FloatVector') throw new Error();
    sdkInteger(keyValues(embedding.type_params).dim, 1, 65536);
    for (const name of ['metadata_json', 'source', 'created_at']) { const field = byName.get(name); if (!field || field.data_type !== (name === 'created_at' ? 'Int64' : 'VarChar')) throw new Error(); }
    const functions = new Set<string>();
    for (const item of array(schema.functions, 128)) { const fn = record(item); const name = collectionName(fn.name);
      if (functions.has(name) || typeof fn.type !== 'string' || !fn.type) throw new Error(); functions.add(name);
      keyValues(fn.params); for (const key of ['input_field_names', 'output_field_names']) for (const field of array(fn[key], 256)) if (typeof field !== 'string' || !byName.has(field)) throw new Error(); }
    // Keep every actual schema field/function and all schema flags, including
    // extras; expected config or a hand-picked required-field hash hides drift.
    const actualCollection: Fields = {};
    for (const key of ['db_name', 'db_id', 'num_partitions', 'consistency_level', 'properties', 'created_timestamp', 'created_utc_timestamp']) {
      if (Object.hasOwn(result, key)) actualCollection[key] = result[key];
    }
    return freeze({ collection_name: result.collection_name, collectionID: result.collectionID, ...actualCollection, schema: { ...schema, fields: normalizedFields } });
  }
  async #indexes(schemaManifest: Readonly<Fields>, deadline: number): Promise<Readonly<Fields>> {
    const result = record(snapshot((await this.#io(this.#describeIndex, {}, deadline)).value)); status(result.status);
    const fields = new Set(array(record(schemaManifest.schema).fields, 256).map(item => record(item).name));
    const indexes = array(result.index_descriptions, 512); if (!indexes.length) throw new Error(); const names = new Set<string>(); const ids = new Set<string>();
    let finishedEmbedding = false;
    const manifests = indexes.map(item => { const index = record(item); const name = collectionName(index.index_name); const id = decimalId(index.indexID);
      if (names.has(name) || ids.has(id) || !fields.has(index.field_name)) throw new Error(); names.add(name); ids.add(id);
      const params = keyValues(index.params); if (!params.index_type) throw new Error();
      if (index.state !== 'Finished' || index.index_state_fail_reason !== '') throw new Error();
      const total = sdkInteger(index.total_rows, 0, Number.MAX_SAFE_INTEGER); const indexed = sdkInteger(index.indexed_rows, 0, Number.MAX_SAFE_INTEGER);
      const pending = sdkInteger(index.pending_index_rows, 0, Number.MAX_SAFE_INTEGER); if (indexed > total || pending > total) throw new Error();
      if (index.field_name === 'embedding') { if (!params.metric_type) throw new Error(); finishedEmbedding = true; }
      const { indexed_rows: _indexed, total_rows: _total, pending_index_rows: _pending, ...manifest } = index;
      void _indexed; void _total; void _pending; return manifest;
    });
    if (!finishedEmbedding) throw new Error(); manifests.sort((a, b) => String(a.index_name).localeCompare(String(b.index_name), 'en'));
    // Progress counters are mutable operational data, not index identity.
    return freeze({ indexes: manifests });
  }
  #parameters(seenIds?: readonly string[]): Fields {
    const params = { tenantId: this.#scope.tenantId, corpusId: this.#scope.corpusId, ...(seenIds ? { seenIds: [...seenIds] } : {}) };
    if (Buffer.byteLength(JSON.stringify(params), 'utf8') > this.#parameterBytes) throw new MilvusPublicationReadbackError('parameter-capacity'); return freeze(params);
  }
  async #count(deadline: number): Promise<number> {
    const result = record((await this.#io(this.#query, { filter: SCOPE_FILTER, exprValues: this.#parameters(), output_fields: ['count(*)'], consistency_level: 'Strong' }, deadline)).value);
    exact(result, ['status', 'data']); status(result.status); const rows = array(result.data, 1); if (rows.length !== 1) throw new Error();
    const row = record(rows[0]); exact(row, ['count(*)']); const count = sdkInteger(row['count(*)'], 0, Number.MAX_SAFE_INTEGER);
    if (count > this.#maxRows) throw new MilvusPublicationReadbackError('row-capacity'); if (count === 0) throw new Error(); return count;
  }
  #row(input: unknown): Row {
    const row = record(input); exact(row, ROW_FIELDS);
    if (row.tenant_id !== this.#scope.tenantId || row.corpus_id !== this.#scope.corpusId || typeof row.content !== 'string' || !row.content || Buffer.byteLength(row.content, 'utf8') > 65536) throw new Error();
    unicode(row.content); if (!['trusted', 'reviewed', 'external', 'quarantined'].includes(row.trust_level as string)) throw new Error();
    const total = sdkInteger(row.total_chunks, 1, 65536); const index = sdkInteger(row.chunk_index, 0, 65535); if (index >= total) throw new Error();
    return Object.freeze({ id: opaqueId(row.id), content: row.content, tenant_id: this.#scope.tenantId, corpus_id: this.#scope.corpusId,
      document_id: opaqueId(row.document_id), document_version: opaqueId(row.document_version), trust_level: row.trust_level as Row['trust_level'], chunk_index: index, total_chunks: total });
  }
  async #collect(deadline: number): Promise<MilvusPublicationData> {
    const schemaManifest = await this.#schema(deadline); const indexManifest = await this.#indexes(schemaManifest, deadline); const before = await this.#count(deadline);
    const rows: Row[] = []; const seenIds: string[] = []; const seen = new Set<string>(); let rowBytes = 0;
    for (;;) {
      // Excluding all observed PKs needs no ordering guarantee or raw string
      // interpolation. count equality alone is never the terminal condition.
      const result = record((await this.#io(this.#query, { filter: SCOPE_FILTER + (seenIds.length ? ' && id not in {seenIds}' : ''),
        exprValues: this.#parameters(seenIds.length ? seenIds : undefined), output_fields: [...ROW_FIELDS], limit: this.#pageSize, consistency_level: 'Strong' }, deadline)).value);
      exact(result, ['status', 'data']); status(result.status); const page = array(result.data, this.#pageSize); if (!page.length) break;
      for (const item of page) { const row = this.#row(item); if (seen.has(row.id)) throw new Error(); if (rows.length >= this.#maxRows) throw new MilvusPublicationReadbackError('row-capacity');
        rowBytes += Buffer.byteLength(JSON.stringify(row), 'utf8'); if (rowBytes > this.#rowBytes) throw new MilvusPublicationReadbackError('row-capacity');
        seen.add(row.id); seenIds.push(row.id); rows.push(row); }
    }
    if (rows.length !== before || await this.#count(deadline) !== before) throw new Error();
    if (canonicalJson(await this.#schema(deadline)) !== canonicalJson(schemaManifest)
      || canonicalJson(await this.#indexes(schemaManifest, deadline)) !== canonicalJson(indexManifest)) throw new Error();
    return Object.freeze({ scope: this.#scope, collection: this.#collection, schemaManifest, indexManifest, rows: Object.freeze(rows) });
  }
}

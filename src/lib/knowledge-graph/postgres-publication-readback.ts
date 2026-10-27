import { types } from 'node:util';
import type { PostgresQueryClient } from '../postgres/client';
import { boundedProviderCall } from '../rag/eval/bounded-provider-call';
import { canonicalJson } from '../rag/eval/canonical-json';
import { validateBuildPublicationManifest } from './build-publication-manifest';
import type { KnowledgeGraphDocumentIdentity } from './contracts';

// LEFT JOIN keeps missing/unacknowledged records visible. Filtering to a
// desired graph/status or issuing three separate SELECTs could hide drift.
// Ceiling acknowledgements to milliseconds prevents losing PG microseconds
// from moving an actual acknowledgement before the reader's time boundary.
const READ_PUBLICATION_SQL = `select jsonb_build_object(
  'pointer', jsonb_build_object('tenantId', pointer.tenant_id, 'corpusId', pointer.corpus_id,
    'graphVersion', pointer.graph_version, 'revision', pointer.revision),
  'outbox', case when event.id is null then null else jsonb_build_object(
    'tenantId', event.tenant_id, 'corpusId', event.corpus_id, 'graphVersion', event.graph_version,
    'revision', event.revision, 'eventType', event.event_type,
    'publishedAt', to_char((date_trunc('milliseconds', event.published_at)
      + case when event.published_at > date_trunc('milliseconds', event.published_at)
        then interval '1 millisecond' else interval '0' end) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'deadLetteredAt', to_char(event.dead_lettered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) end,
  'buildJob', case when job.id is null then null else jsonb_build_object(
    'tenantId', job.tenant_id, 'corpusId', job.corpus_id, 'graphVersion', job.graph_version,
    'status', job.status, 'artifactDigest', job.artifact_digest,
    'publicationManifest', job.metadata->'publicationManifest') end
) as publication
from public.graph_active_snapshots pointer
left join public.graph_publication_outbox event
  on event.tenant_id = pointer.tenant_id and event.corpus_id = pointer.corpus_id
  and event.revision = pointer.revision
left join public.graph_build_jobs job
  on job.tenant_id = pointer.tenant_id and job.corpus_id = pointer.corpus_id
  and job.graph_version = pointer.graph_version
where pointer.tenant_id = $1 and pointer.corpus_id = $2`;

type Code = 'invalid-config' | 'invalid-request' | 'invalid-readback' | 'query-failed' | 'query-timeout' | 'provider-contract-invalid' | 'halted' | 'busy' | 'read-limit';
export class PostgresPublicationReadbackError extends Error {
  readonly productionAuthorized = false;
  readonly automaticRetryAllowed = false;
  readonly code: Code;
  readonly pendingCompletionUnknown: boolean;
  constructor(code: Code, pendingCompletionUnknown = false) {
    super(`[postgres publication readback] ${code}`); this.name = 'PostgresPublicationReadbackError';
    this.code = code; this.pendingCompletionUnknown = pendingCompletionUnknown; Object.freeze(this);
  }
}
type Fields = Record<string, unknown>;
type Scope = { readonly environment: string; readonly tenantId: string; readonly corpusId: string };
type Pointer = { readonly tenantId: string; readonly corpusId: string; readonly graphVersion: string; readonly revision: number };
export interface PostgresPublicationData {
  readonly scope: Scope;
  readonly pointer: Pointer;
  readonly outbox: Pointer & { readonly eventType: 'graph.snapshot.activated'; readonly publishedAt: string; readonly deadLetteredAt: null };
  readonly buildJob: { readonly tenantId: string; readonly corpusId: string; readonly graphVersion: string; readonly status: 'published';
    readonly artifactDigest: string; readonly documents: readonly Readonly<KnowledgeGraphDocumentIdentity>[] };
}
function freeze<T>(v: T): T { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
function snapshot(v: unknown): unknown { return freeze(JSON.parse(canonicalJson(v))); }
function record(v: unknown): Fields { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(); return v as Fields; }
function exact(v: Fields, fields: readonly string[]): void { if (Object.keys(v).length !== fields.length || fields.some(k => !Object.hasOwn(v, k))) throw new Error(); }
function identifier(v: unknown, max = 128): string { if (typeof v !== 'string' || v.length > max || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v)) throw new Error(); return v; }
function integer(v: unknown, max: number): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > max) throw new Error(); return v; }
function iso(v: unknown): void { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
  || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) throw new Error(); }
function same(a: unknown, b: unknown): void { if (canonicalJson(a) !== canonicalJson(b)) throw new Error(); }

/** Native PG business-data adapter, not a PublicationSource proof issuer.
 * Environment is a frozen local deployment label, not authenticated DB identity.
 * Enterprise connection trust, read-only IAM and source/runner binding remain separate gates. */
export class PostgresKnowledgeGraphPublicationReadback {
  readonly executionProfile = 'local-reference' as const;
  readonly productionCapable = false;
  #scope: Scope;
  #query: (sql: string, values: unknown[]) => unknown;
  #timeout: number;
  #maxReads: number;
  #reads = 0;
  #busy = false;
  #halted = false;

  constructor(client: PostgresQueryClient, options: unknown) {
    try {
      const cfg = record(snapshot(options)); exact(cfg, ['executionProfile', 'scope', 'operationTimeoutMs', 'maxReads']);
      if (cfg.executionProfile !== 'local-reference') throw new Error(); const s = record(cfg.scope); exact(s, ['environment', 'tenantId', 'corpusId']);
      for (const v of Object.values(s)) identifier(v); this.#scope = s as Scope;
      this.#timeout = integer(cfg.operationTimeoutMs, 30000); this.#maxReads = integer(cfg.maxReads, 128);
      if (!client || typeof client !== 'object' || types.isProxy(client)) throw new Error();
      const d = Object.getOwnPropertyDescriptor(client, 'query'); if (!d || !Object.hasOwn(d, 'value') || typeof d.value !== 'function' || types.isProxy(d.value)) throw new Error();
      const query = d.value; this.#query = (sql, values) => Reflect.apply(query, client, [sql, values]); Object.freeze(this);
    } catch { throw new PostgresPublicationReadbackError('invalid-config'); }
  }

  async readPublication(request: unknown): Promise<PostgresPublicationData> {
    if (this.#halted) throw new PostgresPublicationReadbackError('halted'); if (this.#busy) throw new PostgresPublicationReadbackError('busy');
    try { exact(record(snapshot(request)), []); } catch { throw new PostgresPublicationReadbackError('invalid-request'); }
    if (this.#reads >= this.#maxReads) throw new PostgresPublicationReadbackError('read-limit'); this.#reads++; this.#busy = true;
    try {
      const observed = await boundedProviderCall(() => this.#query(READ_PUBLICATION_SQL, [this.#scope.tenantId, this.#scope.corpusId]), this.#timeout);
      if (observed.status === 'timeout' || observed.status === 'invalid-return') {
        this.#halted = true;
        throw new PostgresPublicationReadbackError(observed.status === 'timeout' ? 'query-timeout' : 'provider-contract-invalid', observed.pendingCompletionUnknown);
      }
      if (observed.status === 'rejected') throw new PostgresPublicationReadbackError('query-failed');
      try {
        const result = record(snapshot(observed.value)); exact(result, ['rows', 'rowCount']);
        if (result.rowCount !== 1 || !Array.isArray(result.rows) || result.rows.length !== 1) throw new Error();
        const row = record(result.rows[0]); exact(row, ['publication']); const p = record(row.publication); exact(p, ['pointer', 'outbox', 'buildJob']);
        const pointer = record(p.pointer); exact(pointer, ['tenantId', 'corpusId', 'graphVersion', 'revision']); identifier(pointer.graphVersion, 512); integer(pointer.revision, Number.MAX_SAFE_INTEGER);
        same({ tenantId: pointer.tenantId, corpusId: pointer.corpusId }, { tenantId: this.#scope.tenantId, corpusId: this.#scope.corpusId });
        const outbox = record(p.outbox); exact(outbox, ['tenantId', 'corpusId', 'graphVersion', 'revision', 'eventType', 'publishedAt', 'deadLetteredAt']);
        same({ tenantId: outbox.tenantId, corpusId: outbox.corpusId, graphVersion: outbox.graphVersion, revision: outbox.revision }, pointer);
        if (outbox.eventType !== 'graph.snapshot.activated' || outbox.deadLetteredAt !== null) throw new Error(); iso(outbox.publishedAt);
        const job = record(p.buildJob); exact(job, ['tenantId', 'corpusId', 'graphVersion', 'status', 'artifactDigest', 'publicationManifest']);
        if (job.status !== 'published') throw new Error(); const manifest = validateBuildPublicationManifest(job.publicationManifest);
        same({ tenantId: job.tenantId, corpusId: job.corpusId, graphVersion: job.graphVersion },
          { tenantId: pointer.tenantId, corpusId: pointer.corpusId, graphVersion: pointer.graphVersion });
        same({ tenantId: manifest.tenantId, corpusId: manifest.corpusId, graphVersion: manifest.graphVersion, artifactDigest: manifest.artifactDigest },
          { tenantId: job.tenantId, corpusId: job.corpusId, graphVersion: job.graphVersion, artifactDigest: job.artifactDigest });
        const { publicationManifest: _manifest, ...fields } = job; void _manifest;
        return freeze({ scope: this.#scope, pointer, outbox, buildJob: { ...fields, documents: manifest.documents } }) as unknown as PostgresPublicationData;
      } catch { throw new PostgresPublicationReadbackError('invalid-readback'); }
    } finally { this.#busy = false; }
  }
}

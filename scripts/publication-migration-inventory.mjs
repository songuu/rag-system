import pg from 'pg';
import { pathToFileURL } from 'node:url';

const QUERY = `
select a.id::text as asset_id, a.external_document_id, a.source_hash,
 a.metadata, a.raw_blob_filename is not null as raw_reference,
 a.parsed_blob_filename is not null as parsed_reference,
 raw.kind as raw_kind, parsed.kind as parsed_kind,
 case when raw.data is not null then 'sha256:' || encode(sha256(raw.data), 'hex') end as raw_digest,
 case when parsed.data is not null then 'sha256:' || encode(sha256(parsed.data), 'hex') end as parsed_digest,
 (select count(*)::text from public.elasticsearch_lexical_chunks c
  where c.tenant_id=a.tenant_id and c.corpus_id=a.corpus_id
    and c.document_id=a.external_document_id and c.document_version=
      coalesce(nullif(a.metadata #>> '{document,documentVersion}',''),
        nullif(a.metadata #>> '{document,document_version}',''), a.source_hash)) as chunk_count
from public.document_assets a
left join public.object_blobs raw on raw.tenant_id=a.tenant_id and raw.corpus_id=a.corpus_id and raw.filename=a.raw_blob_filename
left join public.object_blobs parsed on parsed.tenant_id=a.tenant_id and parsed.corpus_id=a.corpus_id and parsed.filename=a.parsed_blob_filename
where a.tenant_id=$1 and a.corpus_id=$2 and a.id > $3::uuid
order by a.id limit $4`;
const NIL = '00000000-0000-0000-0000-000000000000';
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TRUST = new Set(['trusted', 'reviewed', 'external', 'quarantined']);

/** Evidence only: even a candidate requires rebuilding and independent verification. */
export function classifyInventoryRow(row) {
  const m = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {};
  const d = m.document && typeof m.document === 'object' && !Array.isArray(m.document) ? m.document : {};
  const version = d.documentVersion ?? d.document_version ?? d.sourceHash ?? d.source_hash ?? row.source_hash;
  const trust = d.trustLevel ?? d.trust_level;
  const lifecycle = m.lifecycle ?? 'active';
  const raw = row.raw_kind === 'raw' && DIGEST.test(row.raw_digest ?? '');
  const parsed = row.parsed_kind === 'parsed' && DIGEST.test(row.parsed_digest ?? '');
  const matches = DIGEST.test(version ?? '') ? [raw && row.raw_digest === version ? 'raw' : null,
    parsed && row.parsed_digest === version ? 'parsed' : null].filter(Boolean) : [];
  const reasons = [];
  if (!row.external_document_id) reasons.push('missing_document_id');
  if (m.persistence_status !== 'ready') reasons.push('persistence_not_ready');
  if (lifecycle !== 'active') reasons.push('inactive_lifecycle');
  if (m.retrieval_enabled === false || m.retrieval_enabled === 'false') reasons.push('retrieval_disabled');
  else if (m.retrieval_enabled !== undefined && m.retrieval_enabled !== true) reasons.push('retrieval_state_unknown');
  if (!TRUST.has(trust)) reasons.push('trust_unknown');
  if (!raw) reasons.push('raw_source_missing');
  if (!matches.length) reasons.push('version_unverified');
  // The legacy upsert can preserve an older raw blob while replacing parsed
  // content. A parsed digest match alone cannot establish raw provenance.
  if (raw && !matches.includes('raw')) reasons.push('raw_version_unverified');
  if (!DIGEST.test(row.source_hash ?? '') || row.source_hash !== version) reasons.push('version_conflict');
  const count = Number(row.chunk_count);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid inventory chunk count.');
  return { assetId: row.asset_id, documentId: row.external_document_id, lifecycle,
    retrievalEnabled: m.retrieval_enabled === undefined || m.retrieval_enabled === true, trust: TRUST.has(trust) ? trust : 'unknown',
    rawAvailable: raw, parsedAvailable: parsed, versionVerifiedAgainst: matches,
    lexicalChunkCount: count, reembeddingRequired: true, status: reasons.length ? 'needs_review' : 'candidate',
    reasons, publicationAuthorized: false };
}

export async function inventoryScope(client, tenantId, corpusId, { pageSize = 250, maxRows = 10000 } = {}) {
  if (![tenantId, corpusId].every(x => typeof x === 'string' && x.trim() === x && x.length > 0 && x.length <= 128)
    || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500
    || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > 10000) throw new Error('Invalid inventory scope or limit.');
  await client.query('begin isolation level repeatable read read only');
  try {
    const items = [];
    let cursor = NIL;
    for (;;) {
      const result = await client.query(QUERY, [tenantId, corpusId, cursor, Math.min(pageSize, maxRows - items.length + 1)]);
      if (!Array.isArray(result.rows)) throw new Error('Invalid inventory query response.');
      for (const row of result.rows) {
        if (items.length >= maxRows) throw new Error('Inventory limit exceeded; narrow the scope.');
        items.push(classifyInventoryRow(row));
      }
      if (result.rows.length < Math.min(pageSize, maxRows - (items.length - result.rows.length) + 1)) break;
      cursor = result.rows.at(-1).asset_id;
    }
    await client.query('commit');
    return { tenantId, corpusId, items, publicationAuthorized: false };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

async function main() {
  const { PUBLICATION_INVENTORY_DATABASE_URL: url, PUBLICATION_INVENTORY_TENANT: tenant,
    PUBLICATION_INVENTORY_CORPUS: corpus } = process.env;
  if (!url || !tenant || !corpus) throw new Error('Inventory connection and scope must be configured.');
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10000, statement_timeout: 30000 });
  try { await client.connect(); process.stdout.write(JSON.stringify(await inventoryScope(client, tenant, corpus)) + '\n'); }
  finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('Inventory failed; verify database access, scope and limits.\n'); process.exitCode = 1; });
}

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const BACKENDS = ['elasticsearch', 'milvus', 'neo4j'];
const TRUST = ['trusted', 'reviewed', 'external', 'quarantined'];
const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function checkedInput(input) {
  if (!input || !/^[a-f0-9]{24}$/.test(input.sandboxId ?? '')
    || ['tenantId', 'corpusId'].some(key => typeof input[key] !== 'string' || !input[key]
      || input[key] !== input[key].trim() || Buffer.byteLength(input[key]) > 128 || /[\u0000-\u001f\u007f]/.test(input[key])))
    throw new Error('Invalid reconciliation sandbox or scope.');
  return { sandboxId: input.sandboxId, tenantId: input.tenantId, corpusId: input.corpusId };
}

/** Observations only: this command never repairs resources or changes a head.
 * Errors are classified without serializing SDK errors, content or credentials. */
export async function reconcilePublicationScope(input, dependencies) {
  const scope = checkedInput(input);
  const report = { version: 1, ...scope, readOnly: true, ok: false, outcome: 'authority-unavailable',
    observedAt: new Date().toISOString(), currentHeads: 'unavailable', documents: [],
    guarantee: 'Read-window observations under trusted local administrators; not a distributed transaction or a new seal.' };
  let authority;
  try { authority = await dependencies.readAuthority(); }
  catch { return report; }
  if (!authority || !Array.isArray(authority.documents) || authority.documents.length > 128) return report;
  for (const document of authority.documents) {
    const result = { documentId: document.documentId, generation: document.generation, manifestDigest: document.manifestDigest, backends: {} };
    for (const backend of BACKENDS) {
      try { result.backends[backend] = { status: 'verified', ...await dependencies[backend](document) }; }
      catch { result.backends[backend] = { status: 'mismatch-or-unavailable' }; }
    }
    report.documents.push(result);
  }
  try { await dependencies.assertCurrent(authority); report.currentHeads = 'unchanged'; }
  catch { report.currentHeads = 'changed-or-unavailable'; }
  report.ok = report.currentHeads === 'unchanged'
    && report.documents.every(document => BACKENDS.every(backend => document.backends[backend].status === 'verified'));
  report.outcome = !report.ok ? 'mismatch-or-unavailable' : report.documents.length ? 'verified' : 'no-active-publications';
  return report;
}

/** All clients are private, constructed from the explicitly selected sandbox.
 * PostgreSQL is additionally forced into read-only transactions at connection startup. */
export async function reconcileSandbox(input) {
  const scope = checkedInput(input);
  const { readSandboxConfig } = await import('../deploy/publication-sandbox/sandbox.mjs');
  const { default: pg } = await import('pg');
  const { Client: EsClient } = await import('@elastic/elasticsearch');
  const { MilvusClient } = await import('@zilliz/milvus2-sdk-node');
  const { createNeo4jClient } = await import('../src/lib/neo4j/driver.ts');
  const { readPublicationView } = await import('../src/lib/documents/publication-view.ts');
  const { materializePublicationManifests } = await import('../src/lib/documents/publication-publisher.ts');
  const { observeSealedGenerationIndex } = await import('../src/lib/elasticsearch/generation-seal.ts');
  const { verifyRuntimeMilvusReadback } = await import('../src/lib/documents/publication-runtime-publisher-milvus.ts');
  const { assertMilvusPublicationIdentity } = await import('../src/lib/documents/publication-retrieval.ts');
  const { compileDocumentPublicationGraph, documentGraphManifest, serializeDocumentPublicationGraph } = await import('../src/lib/knowledge-graph/document-graph-publication.ts');
  const { Neo4jKnowledgeGraphCommandStore } = await import('../src/lib/knowledge-graph/neo4j-command-store.ts');
  const { expectedDocumentGraphEdges, readDocumentGraphEdges } = await import('../src/lib/knowledge-graph/document-generation-edges.ts');
  const config = readSandboxConfig(scope.sandboxId);
  const c = config.credentials; const p = config.ports;
  const db = new pg.Client({ host: '127.0.0.1', port: p.postgres, database: config.database, user: 'pub_migration', password: c.dbMigration,
    options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 5000, statement_timeout: 10000, query_timeout: 15000 });
  const es = new EsClient({ node: `https://127.0.0.1:${p.elasticsearch}`, auth: { username: 'pub_reader', password: c.esReader },
    tls: { ca: config.ca }, maxRetries: 0, requestTimeout: 10000 });
  const milvus = new MilvusClient({ address: `127.0.0.1:${p.milvus}`, username: 'pub_reader', password: c.milvusReader,
    maxRetries: 0, isGlobal: false, timeout: 10000, channelOptions: { 'grpc.enable_retries': 0 } });
  void milvus.connectPromise.catch(() => {});
  // Community edition has one administrative identity; it stays in this local
  // CLI and is used exclusively via executeRead, never in the application.
  const graph = createNeo4jClient({ uri: `bolt://127.0.0.1:${p.neo4j}`, username: 'neo4j', password: c.neo4j,
    database: 'neo4j', connectionTimeoutMs: 5000, queryTimeoutMs: 30000, writeTimeoutMs: 30000, maxTransactionRetryTimeMs: 0, maxConnectionPoolSize: 1 });
  const retrievalScope = { tenantId: scope.tenantId, corpusId: scope.corpusId, allowedTrustLevels: TRUST, enforceIsolation: true };
  const loaded = new Map();
  const headRows = async () => (await db.query(`select document_id,active_generation::text,revision::text,generation::text
    from public.document_publication_heads where tenant_id=$1 and corpus_id=$2 and not revoked and active_generation is not null
    order by document_id limit 129`, [scope.tenantId, scope.corpusId])).rows;
  try {
    await db.connect();
    return await reconcilePublicationScope(scope, {
      readAuthority: async () => {
        await db.query('begin isolation level repeatable read read only');
        try {
          const corpus = await db.query('select 1 from public.corpora where tenant_id=$1 and id=$2', [scope.tenantId, scope.corpusId]);
          if (corpus.rows.length !== 1) throw new Error('Reconciliation corpus is unavailable.');
          const view = await readPublicationView(retrievalScope, db);
          const heads = await headRows();
          if (heads.length !== view.documents.length || heads.some(row => !view.documents.some(document => document.documentId === row.document_id && document.generation === row.active_generation)))
            throw new Error('Active heads are not completely represented by the verified read view.');
          const capacity = await db.query(`select coalesce(sum(octet_length(a.source_bytes)+octet_length(a.source_identity_bytes)+octet_length(a.manifest_json)),0)::text as bytes
            from public.document_publication_heads h join public.document_publication_assets a on a.tenant_id=h.tenant_id and a.corpus_id=h.corpus_id
              and a.document_id=h.document_id and a.generation=h.active_generation
            where h.tenant_id=$1 and h.corpus_id=$2 and not h.revoked and h.active_generation is not null`, [scope.tenantId, scope.corpusId]);
          if (BigInt(capacity.rows[0].bytes) > 134217728n) throw new Error('Reconciliation source capacity exceeded.');
          let payloadBytes = 0;
          for (const document of view.documents) {
            const result = await db.query(`select a.expected_revision::text,a.status,a.required_providers,asset.*,
                g.graph_version,g.graph_manifest_json,g.graph_manifest_digest,g.configuration_digest as graph_configuration_digest,
                g.evidence_digest as graph_evidence_digest,g.snapshot_json,
                m.provider_manifest_json as milvus_manifest,e.provider_manifest_json as elasticsearch_manifest,
                (select jsonb_agg(ch.payload order by ch.chunk_index) from public.document_publication_asset_chunks ch
                  where ch.tenant_id=asset.tenant_id and ch.corpus_id=asset.corpus_id and ch.document_id=asset.document_id and ch.generation=asset.generation) as chunks
              from public.document_publication_attempts a join public.document_publication_assets asset using(tenant_id,corpus_id,document_id,generation)
              left join public.document_graph_publication_seals g using(tenant_id,corpus_id,document_id,generation)
              join public.document_publication_provider_seals m on m.tenant_id=a.tenant_id and m.corpus_id=a.corpus_id and m.document_id=a.document_id and m.generation=a.generation and m.provider='milvus'
              join public.document_publication_provider_seals e on e.tenant_id=a.tenant_id and e.corpus_id=a.corpus_id and e.document_id=a.document_id and e.generation=a.generation and e.provider='elasticsearch'
              where a.tenant_id=$1 and a.corpus_id=$2 and a.document_id=$3 and a.generation=$4::bigint`, [scope.tenantId, scope.corpusId, document.documentId, document.generation]);
            if (result.rows.length !== 1) throw new Error('Published asset is unavailable.');
            const row = result.rows[0];
            if (row.status !== 'published' || JSON.stringify([...row.required_providers].sort()) !== JSON.stringify([...BACKENDS].sort())
              || row.manifest_digest !== document.manifestDigest || row.content_version !== document.contentVersion)
              throw new Error('A current head is not a three-provider publication.');
            const attempt = { tenantId: scope.tenantId, corpusId: scope.corpusId, documentId: document.documentId, generation: document.generation,
              revision: row.expected_revision, manifestDigest: row.manifest_digest, physicalCollection: document.collection };
            const asset = { tenantId: scope.tenantId, corpusId: scope.corpusId, documentId: document.documentId, contentVersion: row.content_version,
              manifestDigest: row.manifest_digest, manifestJson: row.manifest_json, sourceBytes: row.source_bytes, sourceIdentityBytes: row.source_identity_bytes, chunksJson: JSON.stringify(row.chunks) };
            payloadBytes += Buffer.byteLength(asset.chunksJson);
            if (payloadBytes > 33554432) throw new Error('Reconciliation chunk capacity exceeded.');
            const materialized = materializePublicationManifests(retrievalScope, attempt, asset);
            if (row.milvus_manifest !== materialized.milvusManifestJson || row.elasticsearch_manifest !== materialized.elasticsearchManifestJson)
              throw new Error('Provider seals differ from authoritative source reconstruction.');
            loaded.set(document.documentId, { attempt, asset, materialized, row });
          }
          await db.query('commit');
          return { digest: view.digest, heads: JSON.stringify(heads), documents: view.documents };
        } catch (error) { await db.query('rollback'); throw error; }
      },
      assertCurrent: async authority => {
        await db.query('begin isolation level repeatable read read only');
        try {
          const view = await readPublicationView(retrievalScope, db);
          if (view.digest !== authority.digest || JSON.stringify(await headRows()) !== authority.heads) throw new Error('Published heads changed.');
          await db.query('commit');
        } catch (error) { await db.query('rollback'); throw error; }
      },
      elasticsearch: async document => {
        const { materialized } = loaded.get(document.documentId);
        const observed = await observeSealedGenerationIndex({ client: es, indexName: document.indexName, indexUuid: document.indexUuid,
          ownerMarker: document.ownerMarker, identity: { tenantId: scope.tenantId, corpusId: scope.corpusId, documentId: document.documentId,
            generation: document.generation, documentVersion: document.contentVersion }, documents: materialized.lexicalDocuments,
          signal: AbortSignal.timeout(60000) });
        if (`sha256:${observed.digest}` !== document.elasticsearchEvidenceDigest) throw new Error('Elasticsearch evidence differs from its seal.');
        return { count: observed.count, indexUuid: document.indexUuid, evidenceDigest: `sha256:${observed.digest}` };
      },
      milvus: async document => {
        const { materialized } = loaded.get(document.documentId);
        await assertMilvusPublicationIdentity(milvus, document);
        const observed = await verifyRuntimeMilvusReadback({ client: milvus, collection: document.collection,
          expectedRows: materialized.rows, assertLease: async () => {}, timeoutMs: 10000 });
        await assertMilvusPublicationIdentity(milvus, document);
        if (observed.collectionId !== document.collectionId || observed.evidenceDigest !== document.milvusEvidenceDigest)
          throw new Error('Milvus evidence differs from its seal.');
        return { count: materialized.rows.length, collectionId: observed.collectionId, evidenceDigest: observed.evidenceDigest };
      },
      neo4j: async document => {
        const { row, attempt, asset } = loaded.get(document.documentId);
        const expected = compileDocumentPublicationGraph(attempt, asset);
        const snapshotJson = serializeDocumentPublicationGraph(expected);
        const manifest = documentGraphManifest(attempt, asset, expected);
        if (row.snapshot_json !== snapshotJson || row.graph_manifest_json !== manifest || row.graph_version !== expected.graphVersion
          || digest(manifest) !== row.graph_manifest_digest || digest(manifest) !== row.graph_evidence_digest
          || JSON.parse(manifest).snapshotDigest !== digest(snapshotJson)
          || row.graph_configuration_digest !== digest(JSON.stringify({ uri: `bolt://127.0.0.1:${p.neo4j}`, username: 'neo4j', database: 'neo4j', profile: 'neo4j-exclusive-asset-graph/v1' })))
          throw new Error('Graph seal does not match authoritative source compilation.');
        await graph.executeRead('reconcile complete sealed document graph', async tx => {
          const identity = { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: expected.graphVersion };
          const inventory = await tx.run(`MATCH (n) WHERE n.tenantId=$tenantId AND n.corpusId=$corpusId AND n.graphVersion=$graphVersion
            RETURN labels(n) AS labels,count(*) AS total LIMIT 8`, identity);
          const counts = new Map(Object.entries({ GraphSnapshot: 1, DocumentVersion: expected.documents.length, Passage: expected.passages.length,
            Entity: expected.entities.length, Claim: expected.claims.length, Community: expected.communities.length }).filter(([, count]) => count > 0));
          if (inventory.records.length !== counts.size) throw new Error('Graph node inventory differs.');
          for (const record of inventory.records) {
            const labels = record.get('labels');
            if (!Array.isArray(labels) || labels.length !== 1 || counts.get(labels[0]) !== Number(record.get('total'))) throw new Error('Graph node counts differ.');
            counts.delete(labels[0]);
          }
          const inTransaction = { executeRead: async (_operation, work) => work(tx), executeWrite: async () => { throw new Error('Read-only reconciliation.'); }, verifyConnectivity: async () => {}, close: async () => {} };
          const actual = await new Neo4jKnowledgeGraphCommandStore(inTransaction).getSnapshot(identity, retrievalScope);
          if (!actual || serializeDocumentPublicationGraph(actual) !== snapshotJson) throw new Error('Graph node content differs.');
          const edges = await readDocumentGraphEdges(inTransaction, identity);
          if (JSON.stringify(edges.map(edge => JSON.stringify(edge)).sort()) !== JSON.stringify(expectedDocumentGraphEdges(expected).map(edge => JSON.stringify(edge)).sort()))
            throw new Error('Graph relationships differ.');
        });
        return { graphVersion: expected.graphVersion, passages: expected.passages.length, entities: expected.entities.length,
          claims: expected.claims.length, evidenceDigest: row.graph_evidence_digest };
      },
    });
  } finally { await Promise.allSettled([db.end(), es.close(), milvus.closeConnection(), graph.close()]); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 5) {
    process.stderr.write('Usage: node --import tsx scripts/publication-reconcile.mjs <sandbox-id> <tenant-id> <corpus-id>\n');
    process.exitCode = 1;
  } else {
    reconcileSandbox({ sandboxId: process.argv[2], tenantId: process.argv[3], corpusId: process.argv[4] }).then(report => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); process.exitCode = report.ok ? 0 : 1;
    }, () => { process.stderr.write('Read-only reconciliation unavailable; no backend or head was changed.\n'); process.exitCode = 1; });
  }
}

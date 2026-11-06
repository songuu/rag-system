import { createHash, randomBytes } from 'node:crypto';
import { Client as PgClient, type ClientConfig } from 'pg';
import { Client as EsClient } from '@elastic/elasticsearch';
import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import { createRetrievalScope } from '../security/retrieval-scope';
import { PublicationOwnerSession } from './publication-owner-session';
import { PublicationRequestQueue } from './publication-request-queue';
import { PostgresDocumentPublicationStore } from './publication-control-cas';
import { PostgresPublicationAssetStore } from './publication-asset-store';
import { PostgresElasticsearchPublicationOperations } from '../elasticsearch/publication-operation';
import { createRuntimePublisherPorts } from './publication-runtime-publisher-adapters';
import { publishRuntimeGeneration, type RuntimeMaterialized } from './publication-runtime-publisher';
import { createGenerationAccess } from './publication-generation-access';
import { PublicationGrantJournal } from './publication-grant-journal';
import { verifyRuntimeMilvusReadback } from './publication-runtime-publisher-milvus';
import { loadPublicationManifests } from './publication-publisher';
import { recordVerifiedPublicationSeal } from './publication-seal-store';
import { publishVerifiedGeneration } from './publication-live-publisher';
import { retireGenerationIdentity } from './publication-milvus-retirement';
import { assertMilvusPublicationBaseline } from './publication-milvus-capability';
import { inspectPublicationElasticsearchSecurity } from '../elasticsearch/publication-security-preflight';
import { assertPublisherPostgresCapability } from './publication-publisher-capability';
import { TrustedDocumentGraphPublisher, recordDocumentGraphPublicationSeal } from '../knowledge-graph/document-graph-publication';

type Config = { postgres: ClientConfig; elasticsearch: { node: string; ca: string; admin: { username: string; password: string }; reader: string; writer: { username: string; password: string }; sealer: { username: string; password: string } };
  milvus: { address: string; admin: { username: string; password: string }; reader: { username: string; password: string } };
  neo4j?: { uri: string; username: string; password: string }; timeoutMs: number };

/** Single trusted host: only this process holds admin credentials. The OS,
 * administrators and Docker are trusted; never expose this class over HTTP. */
export class TrustedPublicationService {
  #config: Config;
  constructor(config: Config) { this.#config = { ...config, postgres: { ...config.postgres },
    elasticsearch: { ...config.elasticsearch, admin: { ...config.elasticsearch.admin }, writer: { ...config.elasticsearch.writer }, sealer: { ...config.elasticsearch.sealer } },
    milvus: { ...config.milvus, admin: { ...config.milvus.admin }, reader: { ...config.milvus.reader } },
    ...(config.neo4j ? { neo4j: { ...config.neo4j } } : {}) }; }
  /** operationId must be durably recorded by the trusted worker before calling. */
  async publishNext(operationId: string): Promise<void> {
    if (typeof operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
      throw new Error('Invalid trusted publisher operation identity.');
    }
    const cfg = this.#config;
    // The isolated Milvus endpoint has no transport TLS and PostgreSQL may be
    // configured without TLS. Never send credentials to a non-local endpoint.
    const milvusAddress = /^(?:127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})$/.exec(cfg.milvus.address);
    const milvusPort = milvusAddress ? Number(milvusAddress[1]) : 0;
    const postgresHost = cfg.postgres.host;
    const postgresPort = cfg.postgres.port;
    const permittedPgKeys = new Set(['host', 'port', 'user', 'password', 'database']);
    if (!milvusAddress || milvusPort < 1 || milvusPort > 65535
      || !['127.0.0.1', '::1', 'localhost'].includes(postgresHost ?? '')
      || !Number.isInteger(postgresPort) || postgresPort! < 1 || postgresPort! > 65535
      || Object.keys(cfg.postgres).some(key => !permittedPgKeys.has(key))
      || typeof cfg.postgres.user !== 'string' || !cfg.postgres.user
      || typeof cfg.postgres.password !== 'string' || !cfg.postgres.password
      || typeof cfg.postgres.database !== 'string' || !cfg.postgres.database) {
      throw new Error('Trusted publisher requires explicit local PostgreSQL and Milvus endpoints.');
    }
    if (!cfg.elasticsearch.node.startsWith('https://') || !cfg.elasticsearch.ca || !cfg.elasticsearch.writer.password ||
      !cfg.elasticsearch.sealer.password || !cfg.elasticsearch.admin.password || !cfg.elasticsearch.reader ||
      new Set([cfg.elasticsearch.writer.username, cfg.elasticsearch.sealer.username, cfg.elasticsearch.admin.username, cfg.elasticsearch.reader]).size !== 4 ||
      !validMilvusCredential(cfg.milvus.admin) || !validMilvusCredential(cfg.milvus.reader)
      || cfg.milvus.admin.username === cfg.milvus.reader.username ||
      !Number.isSafeInteger(cfg.timeoutMs) || cfg.timeoutMs < 1000 || cfg.timeoutMs > 30000) throw new Error('Invalid trusted publisher configuration.');
    // Rebuild instead of spreading ClientConfig so alternate transports and
    // connection string overrides can never reach either PostgreSQL client.
    const postgres: ClientConfig = { host: postgresHost, port: postgresPort,
      user: cfg.postgres.user, password: cfg.postgres.password, database: cfg.postgres.database };
    // Validate graph configuration before constructing eager Milvus clients.
    const graph = cfg.neo4j ? new TrustedDocumentGraphPublisher(cfg.neo4j) : undefined;
    const owner = new PublicationOwnerSession(postgres, 300000);
    const db = new PgClient(postgres);
    const esSealer = new EsClient({ node: cfg.elasticsearch.node, auth: cfg.elasticsearch.sealer, tls: { ca: cfg.elasticsearch.ca } });
    const esWriter = new EsClient({ node: cfg.elasticsearch.node, auth: cfg.elasticsearch.writer, tls: { ca: cfg.elasticsearch.ca } });
    const mc = { address: cfg.milvus.address, maxRetries: 0, isGlobal: false, channelOptions: { 'grpc.enable_retries': 0 } };
    // Credentials cannot override endpoint, retry policy or channel settings.
    const admin = new MilvusClient({ ...mc, username: cfg.milvus.admin.username, password: cfg.milvus.admin.password });
    const reader = new MilvusClient({ ...mc, username: cfg.milvus.reader.username, password: cfg.milvus.reader.password });
    const anonymous = new MilvusClient(mc);
    const defaultRoot = new MilvusClient({ ...mc, username: 'root', password: 'Milvus' });
    // These clients intentionally fail authentication; observe eager SDK
    // connection rejection before the explicit negative probes below.
    void anonymous.connectPromise.catch(() => {});
    void defaultRoot.connectPromise.catch(() => {});
    try {
      await owner.start(); await db.connect();
      await owner.execute(async signal => {
        const inspectEs = async (indexName: string) => {
          await inspectPublicationElasticsearchSecurity({ node: cfg.elasticsearch.node, ca: cfg.elasticsearch.ca,
            admin: cfg.elasticsearch.admin, writer: cfg.elasticsearch.writer.username, sealer: cfg.elasticsearch.sealer.username,
            reader: cfg.elasticsearch.reader, indexName });
        };
        const baseline = async () => {
          const [writerIdentity, sealerIdentity, readerProbe] = await Promise.all([
            esWriter.security.authenticate(), esSealer.security.authenticate(), reader.hasCollection({ collection_name: 'sandbox_probe_nonexistent' }),
          ]);
          if (writerIdentity.username !== cfg.elasticsearch.writer.username || sealerIdentity.username !== cfg.elasticsearch.sealer.username
            || readerProbe.status?.error_code !== 'Success') throw new Error('Publisher backend authentication failed.');
          await assertMilvusPublicationBaseline(admin, anonymous, defaultRoot);
        };
        // Preflight happens before the irreversible one-shot claim.
        if (signal.aborted) throw new Error('Publisher ownership lost.');
        await owner.assertOwner();
        await Promise.all([baseline(), inspectEs(`codex-generation-seal-${randomBytes(16).toString('hex')}`),
          assertPublisherPostgresCapability(owner), assertPublisherPostgresCapability(db), graph?.preflight()]);
        if (signal.aborted) throw new Error('Publisher ownership lost.');
        await owner.assertOwner();
        if (signal.aborted) throw new Error('Publisher ownership lost.');
        const { asset } = await new PublicationRequestQueue(owner).claim(operationId);
        const scope = createRetrievalScope({ tenantId: asset.tenantId, corpusId: asset.corpusId,
          allowedTrustLevels: ['trusted', 'reviewed', 'external', 'quarantined'], enforceIsolation: true });
        const control = new PostgresDocumentPublicationStore(db);
        const assets = new PostgresPublicationAssetStore(db);
        const journal = new PublicationGrantJournal(db);
        const operationIdentity = { operationId, physicalCollection: `rag_publication_${randomBytes(16).toString('hex')}` };
        const base = createRuntimePublisherPorts({ scope, control, assets, publisherDb: db,
          operations: new PostgresElasticsearchPublicationOperations(db), esSealer, esWriter, milvus: reader,
          verifyIsolation: async () => { throw new Error('Unreachable'); }, timeoutMs: cfg.timeoutMs, operationIdentity,
          requiredProviders: graph ? ['milvus', 'elasticsearch', 'neo4j'] : ['milvus', 'elasticsearch'] });
        const check = async () => { if (signal.aborted) throw new Error('Publisher ownership lost.'); await owner.assertOwner(); };
        const configurationDigest = `sha256:${createHash('sha256').update(JSON.stringify({ es: cfg.elasticsearch.node,
          milvus: cfg.milvus.address, writer: cfg.elasticsearch.writer.username, sealer: cfg.elasticsearch.sealer.username,
          admin: cfg.milvus.admin.username, reader: cfg.milvus.reader.username })).digest('hex')}`;
        let milvusSeal: Awaited<ReturnType<typeof base.verifyMilvus>> | undefined;
        let indexName: string | undefined;
        const ports = { ...base,
          async assertIsolation(): Promise<{ configurationDigest: string }> {
            await check();
            await Promise.all([baseline(), inspectEs(indexName ?? `codex-generation-seal-${randomBytes(16).toString('hex')}`),
              assertPublisherPostgresCapability(owner), assertPublisherPostgresCapability(db), graph?.preflight()]);
            await check();
            return { configurationDigest };
          },
          async createElasticsearch(...args: Parameters<typeof base.createElasticsearch>) {
            await check(); const index = await base.createElasticsearch(...args); indexName = index.indexName;
            await inspectEs(indexName); await check(); return index;
          },
          async writeMilvus(attempt: Parameters<typeof base.writeMilvus>[0], materialized: RuntimeMaterialized) {
            await check(); const data = await loadPublicationManifests(scope, attempt, assets);
            const actor = await createGenerationAccess({ collection: attempt.physicalCollection, dimension: data.rows[0].embedding.length,
              address: cfg.milvus.address, admin, timeoutMs: cfg.timeoutMs,
              checkLease: async () => { await check(); await control.renew(attempt, 300000); return true; },
              persistIntent: async identity => { const persisted = await journal.readIntent(operationId);
                if (JSON.stringify(persisted) !== JSON.stringify(identity)) throw new Error('Generation identity differs from durable intent.'); } });
            await actor.createIndex(); await actor.insert(data.rows); await actor.flush(); await actor.load(); await actor.revoke();
            // Unknown is persisted before identity retirement; a crash never
            // makes this single-use identity available for another generation.
            await retireGenerationIdentity({ operationId, identity: actor.identity, actor, journal, admin, check }); await baseline();
            await check(); const observed = await verifyRuntimeMilvusReadback({ client: reader, collection: attempt.physicalCollection,
              expectedRows: data.rows, assertLease: async () => { await check(); await control.renew(attempt, 300000); }, timeoutMs: cfg.timeoutMs });
            milvusSeal = { ...materialized.identity, provider: 'milvus', resourceName: attempt.physicalCollection,
              resourceId: observed.collectionId, manifestJson: data.milvusManifestJson, configurationDigest, evidenceDigest: observed.evidenceDigest };
          },
          async verifyMilvus() { await check(); if (!milvusSeal) throw new Error('Milvus verification unavailable.'); return milvusSeal; },
          async sealElasticsearch(...args: Parameters<typeof base.sealElasticsearch>) { await check(); const seal = await base.sealElasticsearch(...args); await inspectEs(seal.resourceName); await check(); return { ...seal, configurationDigest }; },
          async recordSeal(attempt: Parameters<typeof base.recordSeal>[0], seal: Parameters<typeof base.recordSeal>[1]) {
            await check(); const data = await loadPublicationManifests(scope, attempt, assets);
            await recordVerifiedPublicationSeal(db, attempt, { ...data, identity: { ...seal }, ids: data.rows.map(row => row.id) }, seal);
          },
          async publish(attempt: Parameters<typeof base.publish>[0]) {
            await check();
            if (graph) {
              const seal = await graph.stage(postgres as { host: string; port: number; user: string; password: string; database: string }, attempt, check);
              await check();
              await recordDocumentGraphPublicationSeal(db, attempt, seal);
              await check();
            }
            return publishVerifiedGeneration(db, attempt);
          },
        };
        await publishRuntimeGeneration(asset, ports, { timeoutMs: cfg.timeoutMs, signal });
      });
    } finally { await Promise.allSettled([owner.close(), db.end(), esSealer.close(), esWriter.close(), admin.closeConnection(), reader.closeConnection(), anonymous.closeConnection(), defaultRoot.closeConnection(), graph?.close()]); }
  }
}

function validMilvusCredential(value: { username: string; password: string }): boolean {
  return !!value && Object.keys(value).length === 2
    && Object.keys(value).every(key => key === 'username' || key === 'password')
    && typeof value.username === 'string' && !!value.username
    && typeof value.password === 'string' && !!value.password;
}



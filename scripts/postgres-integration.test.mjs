import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pg from 'pg';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error?.code === 'ERR_MODULE_NOT_FOUND'
        && (specifier.startsWith('./') || specifier.startsWith('../'))
      ) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { PostgresBlobStore } = await import('../src/lib/persistence/postgres-blob-store.ts');
const { PostgresUploadManifestStore } = await import('../src/lib/persistence/postgres-corpus-store.ts');
const { PostgresPipelineStore } = await import('../src/lib/persistence/postgres-pipeline-store.ts');
const { PostgresTraceStore } = await import('../src/lib/persistence/postgres-trace-store.ts');
const { PostgresMaicStore } = await import('../src/lib/maic/course-store.ts');
const { checkPostgresReadiness } = await import('../src/lib/postgres/client.ts');
const { applyLocalBackfill, buildLocalBackfillPlan, inspectLocalBackfill } = await import('./backfill-local-postgres.mjs');
const { grantApplicationRole, runMigrationSession } = await import('./migrate-postgres.mjs');
const {
  resolveRuntimeVerificationConfig,
  verifyPostgresRuntime,
} = await import('./verify-postgres-runtime.mjs');

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();

test('real PostgreSQL migration and persistence round trip', {
  skip: databaseUrl ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenantId = `integration-${suffix}`;
  const corpusId = `corpus-${suffix}`;
  const appRole = `rag_app_${suffix}`;
  const appPassword = `runtime_${suffix}_A1`;
  const backfillRoot = await mkdtemp(path.join(tmpdir(), 'rag-pg-backfill-integration-'));
  const client = new pg.Client({ connectionString: databaseUrl, ssl: false });
  let appClient;
  await client.connect();

  const config = {
    databaseUrl,
    defaultTenantId: tenantId,
    defaultCorpusId: corpusId,
    sslMode: 'disable',
    maxConnections: 2,
    idleTimeoutMs: 30000,
    connectionTimeoutMs: 5000,
    persistenceBackend: 'postgres',
    vectorBackend: 'milvus',
  };
  const queryClient = {
    async query(text, values = []) {
      const result = await client.query(text, values);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };

  try {
    // The runner grants an existing least-privilege role; role creation remains
    // an explicit DBA responsibility in production.
    await client.query(`create role "${appRole}" login password '${appPassword}'`);
    const migration = await runMigrationSession(client, {
      seedScope: { tenantId, corpusId },
      appRole,
    });
    assert.equal(migration.seeded, true);
    const repeatedMigration = await runMigrationSession(client, {
      seedScope: { tenantId, corpusId },
      appRole,
    });
    assert.deepEqual(repeatedMigration.applied, []);
    assert.deepEqual(repeatedMigration.skipped, ['0001', '0002']);

    const appDatabaseUrl = new URL(databaseUrl);
    appDatabaseUrl.username = appRole;
    appDatabaseUrl.password = appPassword;
    const runtimeVerificationConfig = resolveRuntimeVerificationConfig({
      POSTGRES_URL: appDatabaseUrl.toString(),
      POSTGRES_APP_ROLE: appRole,
      POSTGRES_SSL_MODE: 'disable',
      RAG_DEFAULT_TENANT_ID: tenantId,
      RAG_DEFAULT_CORPUS_ID: corpusId,
    });
    appClient = new pg.Client({
      connectionString: runtimeVerificationConfig.databaseUrl,
      ssl: runtimeVerificationConfig.ssl,
    });
    await appClient.connect();
    assert.deepEqual(
      await verifyPostgresRuntime(appClient, runtimeVerificationConfig),
      {
        role: appRole,
        postgresMajor: 17,
        scopeVerified: true,
        transactionalDmlVerified: true,
      }
    );
    await appClient.end();
    appClient = undefined;

    assert.deepEqual(await checkPostgresReadiness(config, queryClient), {
      connected: true,
      schemaReady: true,
    });
    const missingScopeConfig = {
      ...config,
      defaultCorpusId: `missing-${suffix}`,
    };
    assert.deepEqual(await checkPostgresReadiness(missingScopeConfig, queryClient), {
      connected: true,
      schemaReady: false,
    });

    // Simulate grants left by an older release and prove the current grant pass
    // actively removes parent-table writes and future-table blanket DML.
    await client.query(
      `grant insert, update, delete on table public.tenants, public.corpora to "${appRole}"`
    );
    await client.query(
      `alter default privileges in schema public
       grant select, insert, update, delete on tables to "${appRole}"`
    );
    await grantApplicationRole(client, appRole);

    await client.query('begin');
    try {
      await client.query(`set local role "${appRole}"`);
      await assert.rejects(
        () => client.query(
          `update public.corpora set metadata = metadata where tenant_id = $1 and id = $2`,
          [tenantId, corpusId]
        ),
        error => error?.code === '42501'
      );
    } finally {
      await client.query('rollback');
    }

    const maicCourseId = `course-${suffix}`;
    let maicSessionId;
    await client.query('begin');
    try {
      await client.query(`set local role "${appRole}"`);
      const maicStore = new PostgresMaicStore(config, queryClient);
      await maicStore.createCourse({
        course_id: maicCourseId,
        title: 'MAIC PostgreSQL integration',
        source_filename: 'course.pdf',
        source_text: 'MAIC source text',
      });
      await maicStore.setCoursePrepared(maicCourseId, preparedCourse());
      const [firstSession, concurrentSession] = await Promise.all([
        maicStore.getOrCreateSession(maicCourseId, ['teacher', 'manager']),
        maicStore.getOrCreateSession(maicCourseId, ['teacher', 'manager']),
      ]);
      assert.equal(concurrentSession.session_id, firstSession.session_id);
      maicSessionId = firstSession.session_id;
      await maicStore.appendUtterance(firstSession.session_id, {
        id: `utterance-${suffix}`,
        speaker: 'student',
        speaker_name: '我',
        content: 'PostgreSQL keeps the classroom state',
        timestamp: '2026-08-17T00:00:00.000Z',
      });
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }

    const reloadedMaicStore = new PostgresMaicStore(config, queryClient);
    assert.equal((await reloadedMaicStore.getCourse(maicCourseId))?.status, 'ready');
    assert.equal(
      (await reloadedMaicStore.getSession(maicSessionId))?.state.H_t[0]?.content,
      'PostgreSQL keeps the classroom state'
    );

    await client.query('begin');
    try {
      await client.query(`set local role "${appRole}"`);
      assert.equal(await reloadedMaicStore.deleteCourse(maicCourseId), true);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
    assert.equal(await reloadedMaicStore.getSession(maicSessionId), undefined);

    const blobStore = new PostgresBlobStore(config, queryClient);
    await blobStore.write('round-trip.txt', 'hello PostgreSQL', {
      kind: 'parsed',
      contentType: 'text/plain',
      metadata: { test: true },
    });
    assert.equal(await blobStore.exists('round-trip.txt'), true);
    assert.equal(await blobStore.readText('round-trip.txt'), 'hello PostgreSQL');
    assert.equal((await blobStore.stat('round-trip.txt')).size, 16);

    const documentId = randomUUID();
    const pipelineStore = new PostgresPipelineStore(config, queryClient);
    const assetId = await pipelineStore.recordCompletedDocument({
      tenantId,
      corpusId,
      actorId: 'integration-actor',
      documentId,
      originalName: 'pipeline.txt',
      contentType: 'text/plain',
      sourceHash: `sha256:${suffix}`,
      sourceKind: 'text',
      source: 'pipeline source',
      metadata: { chunks: 1 },
    });
    assert.match(assetId, /^[0-9a-f-]{36}$/i);
    const replacementDocumentId = randomUUID();
    await pipelineStore.recordCompletedDocument({
      tenantId,
      corpusId,
      actorId: 'integration-actor',
      documentId: replacementDocumentId,
      originalName: 'pipeline-replacement.txt',
      contentType: 'text/plain',
      sourceHash: `sha256:${suffix}`,
      sourceKind: 'text',
      source: 'pipeline source replacement',
      metadata: { chunks: 2 },
    });
    const deduplicatedRows = await client.query(
      `select external_document_id from document_assets
       where tenant_id = $1 and corpus_id = $2 and source_hash = $3`,
      [tenantId, corpusId, `sha256:${suffix}`]
    );
    assert.deepEqual(deduplicatedRows.rows, [{
      external_document_id: replacementDocumentId,
    }]);

    const manifestStore = new PostgresUploadManifestStore(config, queryClient);
    await manifestStore.recordUpload({
      id: `manifest-${suffix}`,
      originalName: 'legacy.pdf',
      originalExtension: '.pdf',
      storedFilename: 'legacy.pdf',
      parsedFilename: 'legacy-parsed.txt',
      size: 10,
      contentLength: 20,
      uploadedAt: new Date().toISOString(),
      parseMethod: 'pdf',
      pages: 1,
    });
    await manifestStore.recordUpload({
      id: `manifest-${suffix}`,
      originalName: 'legacy-v2.pdf',
      originalExtension: '.pdf',
      storedFilename: 'legacy-v2.pdf',
      parsedFilename: 'legacy-v2-parsed.txt',
      size: 11,
      contentLength: 21,
      uploadedAt: new Date().toISOString(),
      parseMethod: 'pdf',
      pages: 1,
    });
    const manifest = await manifestStore.loadManifest();
    assert.equal(Object.keys(manifest).length, 1);
    assert.equal(manifest[`manifest-${suffix}`].originalName, 'legacy-v2.pdf');
    const manifestRows = await client.query(
      `select source_hash from document_assets
       where tenant_id = $1 and corpus_id = $2 and external_document_id = $3`,
      [tenantId, corpusId, `manifest-${suffix}`]
    );
    assert.deepEqual(manifestRows.rows, [{
      source_hash: `manifest-${suffix}:legacy-v2.pdf:11:21`,
    }]);
    await manifestStore.saveManifest({});
    const remainingAssets = await client.query(
      `select external_document_id, metadata ? 'manifest_id' as is_manifest
       from document_assets where tenant_id = $1 and corpus_id = $2`,
      [tenantId, corpusId]
    );
    assert.deepEqual(remainingAssets.rows, [{
      external_document_id: replacementDocumentId,
      is_manifest: false,
    }]);

    const backfillText = `MAIC PostgreSQL integration ${suffix}`;
    const backfillFilename = `maic_${suffix}_parsed.txt`;
    const backfillId = `maic_${suffix}`;
    const backfillSourceHash = `${'a'.repeat(52)}${suffix}`;
    await writeFile(path.join(backfillRoot, backfillFilename), backfillText, 'utf8');
    await writeFile(path.join(backfillRoot, 'file-manifest.json'), JSON.stringify({
      [backfillId]: {
        id: backfillId,
        originalName: 'course.pptx',
        originalExtension: '.pptx',
        storedFilename: backfillFilename,
        parsedFilename: backfillFilename,
        size: Buffer.byteLength(backfillText),
        contentLength: backfillText.length,
        uploadedAt: '2026-08-14T00:00:00.000Z',
        parseMethod: 'maic-slide-parser',
        pages: 1,
        source: 'maic',
        sourceHash: backfillSourceHash,
      },
    }), 'utf8');
    const backfillPlan = await buildLocalBackfillPlan([backfillRoot]);
    assert.equal((await inspectLocalBackfill(client, backfillPlan, {
      tenantId,
      corpusId,
    })).complete, false);
    assert.deepEqual(await applyLocalBackfill(client, [backfillRoot], { tenantId, corpusId }), {
      planHash: backfillPlan.hash,
      documents: 1,
      blobs: 1,
      bytes: Buffer.byteLength(backfillText),
    });
    assert.deepEqual(await applyLocalBackfill(client, [backfillRoot], { tenantId, corpusId }), {
      planHash: backfillPlan.hash,
      documents: 1,
      blobs: 1,
      bytes: Buffer.byteLength(backfillText),
    });
    const backfillRows = await client.query(
      `select blob.kind, convert_from(blob.data, 'UTF8') as text,
              asset.external_document_id, asset.source_hash,
              corpus.metadata->'local_postgres_backfill'->>'plan_sha256' as receipt_hash
       from object_blobs blob
       join document_assets asset
         on asset.tenant_id = blob.tenant_id
        and asset.corpus_id = blob.corpus_id
        and asset.raw_blob_filename = blob.filename
       join corpora corpus
         on corpus.tenant_id = blob.tenant_id and corpus.id = blob.corpus_id
       where blob.tenant_id = $1 and blob.corpus_id = $2 and blob.filename = $3`,
      [tenantId, corpusId, backfillFilename]
    );
    assert.deepEqual(backfillRows.rows, [{
      kind: 'parsed',
      text: backfillText,
      external_document_id: backfillId,
      source_hash: backfillSourceHash,
      receipt_hash: backfillPlan.hash,
    }]);

    const traceId = randomUUID();
    const observationId = randomUUID();
    const traceStore = new PostgresTraceStore(config, queryClient);
    await traceStore.upsertTrace({
      id: traceId,
      userId: 'integration-actor',
      name: 'integration trace',
      input: { question: 'works?' },
      output: { answer: 'yes' },
      status: 'SUCCESS',
      startTime: '2026-08-13T00:00:00.000Z',
      endTime: '2026-08-13T00:00:01.000Z',
      observations: [{
        id: observationId,
        traceId: randomUUID(),
        type: 'SPAN',
        name: 'database',
        startTime: '2026-08-13T00:00:00.000Z',
        endTime: '2026-08-13T00:00:00.500Z',
      }],
      scores: [],
    });
    const trace = await traceStore.getTrace(traceId);
    assert.equal(trace?.userId, 'integration-actor');
    assert.equal(trace?.observations?.[0]?.traceId, traceId);
    await traceStore.addScore({
      traceId,
      observationId,
      name: 'quality',
      value: 1,
      source: 'USER',
    });
    assert.equal((await traceStore.listTraces()).traces.length, 1);

    await assert.rejects(
      () => client.query(
        `insert into document_assets (
           tenant_id, corpus_id, original_name, content_type, source_hash
         ) values ($1, $2, 'bad', 'text/plain', $3)`,
        ['another-tenant', corpusId, `bad:${suffix}`]
      ),
      error => error?.code === '23503'
    );
  } finally {
    await appClient?.end().catch(() => {});
    await client.query('delete from tenants where id = $1', [tenantId]).catch(() => {});
    await client.query(`drop owned by "${appRole}"`).catch(() => {});
    await client.query(`drop role if exists "${appRole}"`).catch(() => {});
    await client.end();
    await rm(backfillRoot, { recursive: true, force: true });
  }
});

function preparedCourse() {
  return {
    pages: [{ index: 0, raw_text: 'MAIC source text', description: '', key_points: [] }],
    knowledge_tree: {
      id: 'root',
      title: 'MAIC PostgreSQL integration',
      summary: '',
      page_refs: [0],
      children: [],
    },
    lecture_script: [],
    active_questions: [],
    stage: {
      title: 'MAIC PostgreSQL integration',
      summary: '',
      objectives: [],
      scene_count: 0,
      estimated_minutes: 8,
    },
    scenes: [],
  };
}

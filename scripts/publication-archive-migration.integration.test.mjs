import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { planArchiveMigration, applyArchiveMigration } from './publication-archive-migration.mjs';

test('archive preserves disabled rows, metadata and exact blobs; conflicts and drift roll back',{
  skip:process.env.PUBLICATION_ARCHIVE_TEST_SANDBOX!=='372b94728dedfdab252e037f',timeout:120000,
},async()=>{
  const root='deploy/publication-sandbox/runtime/372b94728dedfdab252e037f';
  const state=JSON.parse(readFileSync(join(root,'state.json'),'utf8'));
  const credentials=JSON.parse(readFileSync(join(root,'credentials.json'),'utf8'));
  const connection=(database,user,password)=>new pg.Client({host:'127.0.0.1',port:state.ports.postgres,database,user,password,
    connectionTimeoutMillis:5000,query_timeout:30000});
  const admin=connection('postgres','sandbox_admin',credentials.postgresAdmin);
  const suffix=randomUUID().replaceAll('-',''); const names=[`archive_src_${suffix}`,`archive_dst_${suffix}`];
  const clients=[];
  await admin.connect();
  try {
    for(const name of names) {
      assert.match(name,/^archive_(src|dst)_[a-f0-9]{32}$/);
      await admin.query(`create database "${name}" owner pub_migration`);
      const client=connection(name,'pub_migration',credentials.dbMigration);await client.connect();clients.push(client);
      await client.query(readFileSync('db/postgres/migrations/0001_core_schema.sql','utf8'));
    }
    const [source,target]=clients;const assetId=randomUUID(),blobId=randomUUID();const bytes=Buffer.from([0,255,1,16,3]);
    const preciseMetadata='{"large":9007199254740993,"fraction":0.123456789012345678901234567890,"retrieval_enabled":false,"lifecycle":"deleted","document":{"trustLevel":"quarantined","documentVersion":"old"}}';
    await source.query("insert into public.tenants(id,name,metadata) values('archive-t','Archive fixture',$1::jsonb)",[preciseMetadata]);
    await source.query("insert into public.corpora(id,tenant_id,name,source_kind) values('archive-c','archive-t','Archive fixture','text')");
    await source.query("update public.corpora set metadata=$1::jsonb where id='archive-c'",[preciseMetadata]);
    await source.query(`insert into public.object_blobs(id,tenant_id,corpus_id,kind,filename,data,metadata,created_at,updated_at)
      values($1,'archive-t','archive-c','raw','raw.bin',$2,$3::jsonb,'2026-01-02 03:04:05.123456+00','2026-01-02 03:04:05.123456+00')`,
      [blobId,bytes,preciseMetadata]);
    const metadata={retrieval_enabled:false,lifecycle:'deleted',persistence_status:'missing',document:{trustLevel:'quarantined',documentVersion:'old'}};
    await source.query(`insert into public.document_assets(id,tenant_id,corpus_id,external_document_id,original_name,content_type,byte_size,
      source_hash,raw_blob_filename,parsed_blob_filename,metadata,created_at,updated_at)
      values($1,'archive-t','archive-c','archive-doc','raw.bin','application/octet-stream',5,'old','raw.bin','missing.txt',$2::jsonb,
      '2026-01-02 03:04:05.123456+00','2026-01-02 03:04:05.123456+00')`,[assetId,preciseMetadata]);
    const plan=await planArchiveMigration(source,target);
    assert.equal(plan.status,'ready');assert.equal(plan.missingBlobReferences,1);assert.equal(plan.counts.assets,1);
    assert.equal((await target.query('select count(*)::int as n from public.document_assets')).rows[0].n,0,'dry-run never writes');
    const archived=await applyArchiveMigration(source,target,plan.snapshotDigest);
    assert.equal(archived.targetDigest,plan.snapshotDigest);assert.equal(archived.status,'archived');
    const actual=(await target.query('select metadata,created_at::text,parsed_blob_filename from public.document_assets where id=$1',[assetId])).rows[0];
    assert.equal(actual.metadata.retrieval_enabled,metadata.retrieval_enabled);assert.match(actual.created_at,/\.123456\+00$/);assert.equal(actual.parsed_blob_filename,'missing.txt');
    for(const table of ['tenants','corpora','document_assets','object_blobs']) {
      const original=(await source.query(`select metadata::text as exact from public.${table}`)).rows[0].exact;
      const copied=(await target.query(`select metadata::text as exact from public.${table}`)).rows[0].exact;
      assert.equal(copied,original);assert.ok(copied.includes('9007199254740993'));assert.ok(copied.includes('0.123456789012345678901234567890'));
    }
    assert.deepEqual((await target.query('select data from public.object_blobs where id=$1',[blobId])).rows[0].data,bytes);
    const replay=await applyArchiveMigration(source,target,plan.snapshotDigest);assert.equal(replay.inserts.assets,0);assert.equal(replay.reused.assets,1);
    await target.query('update public.object_blobs set data=$2 where id=$1',[blobId,Buffer.from('different')]);
    const conflict=await planArchiveMigration(source,target);assert.equal(conflict.status,'conflict');
    await assert.rejects(applyArchiveMigration(source,target,plan.snapshotDigest),/conflict/);
    assert.deepEqual((await source.query('select data from public.object_blobs where id=$1',[blobId])).rows[0].data,bytes,'source remains unchanged');
    await source.query('update public.document_assets set original_name=$2 where id=$1',[assetId,'changed.bin']);
    await assert.rejects(applyArchiveMigration(source,target,plan.snapshotDigest),/changed after/);
    await source.query("update public.document_assets set metadata=$2::jsonb where id=$1",[assetId,JSON.stringify({retrieval_enabled:true,lifecycle:'active'})]);
    await assert.rejects(planArchiveMigration(source,target),/inactive/);
  } finally {
    await Promise.allSettled(clients.map(client=>client.end()));
    for(const name of names) await admin.query(`drop database if exists "${name}"`).catch(()=>{});
    await admin.end();
  }
});

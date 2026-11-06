import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import pg from 'pg';
import { readSandboxConfig } from '../../../deploy/publication-sandbox/sandbox.mjs';
import { grantSandboxPublisher } from '../../../deploy/publication-sandbox/publisher-db.mjs';
import { runMigrationSession } from '../../../scripts/migrate-postgres.mjs';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const sandboxId = process.env.PUBLICATION_QUEUE_SANDBOX_ID;
test('isolated queue is scope-bound, immutable, one-shot, and separated by role',
  { skip: !sandboxId && 'Requires an explicitly selected isolated publication sandbox.' }, async () => {
    const config=readSandboxConfig(sandboxId);
    const connect=(user,password)=>new pg.Client({host:'127.0.0.1',port:config.ports.postgres,database:'publication_sandbox',user,password});
    const migration=connect('pub_migration',config.credentials.dbMigration);
    const app=connect('pub_app',config.credentials.dbApp);
    const publisher=connect('pub_publisher',config.credentials.dbPublisher);
    await migration.connect();
    try {
      await runMigrationSession(migration);
      await grantSandboxPublisher(sandboxId);
      await app.connect(); await publisher.connect();
      const permissions=await migration.query(`select
        has_table_privilege('pub_app','public.publication_requests','INSERT') app_insert,
        has_table_privilege('pub_publisher','public.publication_requests','UPDATE') publisher_update,
        has_function_privilege('pub_app','public.rag_claim_publication_request(uuid)','EXECUTE') app_claim,
        has_function_privilege('pub_publisher','public.rag_enqueue_publication_request(uuid,text,text,text,text,bytea,bytea,jsonb)','EXECUTE') publisher_enqueue`);
      assert.deepEqual(permissions.rows[0],{app_insert:false,publisher_update:false,app_claim:false,publisher_enqueue:false});
      const suffix=randomUUID(); const scope={tenantId:`queue-t-${suffix}`,corpusId:`queue-c-${suffix}`,documentId:`queue-d-${suffix}`};
      await migration.query('insert into public.tenants(id,name) values($1,$2)',[scope.tenantId,'queue test']);
      await migration.query("insert into public.corpora(tenant_id,id,name,source_kind) values($1,$2,$3,'test')",[scope.tenantId,scope.corpusId,'queue test']);
      const {preparePublicationAsset}=await import('./publication-asset-store.ts');
      const {PublicationRequestQueue}=await import('./publication-request-queue.ts');
      const asset=preparePublicationAsset({...scope,sourceBytes:Buffer.from('raw'),sourceIdentityBytes:Buffer.from('parsed'),
        originalName:'x.txt',contentType:'text/plain',sourceKind:'text',embedding:{model:'m',revision:'1',dimension:2,indexSchema:'milvus-publication/v1'},
        splitter:{name:'text',revision:'1',chunkSize:10,chunkOverlap:0},chunks:[{chunkIndex:0,content:'hello',trustLevel:'trusted',embedding:[0.1,0.2]}]});
      const appQueue=new PublicationRequestQueue({query:(sql,values)=>app.query(sql,values)});
      const pubQueue=new PublicationRequestQueue({query:(sql,values)=>publisher.query(sql,values)});
      const id=randomUUID();
      await appQueue.enqueue(id,asset); await appQueue.enqueue(id,asset);
      assert.equal(await appQueue.state(id,scope),'queued');
      assert.equal(await appQueue.state(id,{...scope,tenantId:'other'}),'not_observed');
      const operationId=randomUUID();
      const claimed=await pubQueue.claim(operationId);
      assert.equal(claimed.requestId,id); assert.equal(claimed.asset.manifestDigest,asset.manifestDigest);
      assert.equal(await appQueue.state(id,scope),'claimed');
      assert.equal((await pubQueue.inspectClaim(operationId)).requestId,id);
      assert.ok((await pubQueue.listClaims(null,100)).some(item => item.requestId===id && item.operationId===operationId));
      assert.equal((await appQueue.result(id,scope)).currentlyActive,false);
      assert.equal((await appQueue.result(id,scope)).attemptState,null);
      assert.equal(await appQueue.result(id,{...scope,tenantId:'other'}),undefined);
      const {PostgresPublicationIntentStore}=await import('./publication-runtime-publisher-intent.ts');
      const {PostgresDocumentPublicationStore}=await import('./publication-control-cas.ts');
      const pubDb={query:(sql,values)=>publisher.query(sql,values)};
      const intent={...scope,operationId,contentVersion:asset.contentVersion,manifestDigest:asset.manifestDigest,
        physicalCollection:`rag_publication_${randomUUID().replaceAll('-','')}`};
      await new PostgresPublicationIntentStore(pubDb).prepare(intent);
      const candidate=await new PostgresDocumentPublicationStore(pubDb).begin({...intent,idempotencyKey:operationId,requiredProviders:['milvus','elasticsearch']});
      assert.equal((await appQueue.result(id,scope)).attemptState,'queued');
      // Synthetic status tests projection logic only; no provider was sealed.
      await migration.query("update public.document_publication_attempts set status='failed' where tenant_id=$1 and corpus_id=$2 and document_id=$3 and generation=$4",[scope.tenantId,scope.corpusId,scope.documentId,candidate.generation]);
      assert.equal((await appQueue.result(id,scope)).attemptState,'failed');
      assert.equal((await appQueue.result(id,scope)).currentlyActive,false);
      await migration.query("update public.document_publication_attempts set status='published' where tenant_id=$1 and corpus_id=$2 and document_id=$3 and generation=$4",[scope.tenantId,scope.corpusId,scope.documentId,candidate.generation]);
      await migration.query('update public.document_publication_heads set active_generation=$4,revision=revision+1 where tenant_id=$1 and corpus_id=$2 and document_id=$3',[scope.tenantId,scope.corpusId,scope.documentId,candidate.generation]);
      assert.equal((await appQueue.result(id,scope)).currentlyActive,true);
      await migration.query('update public.document_publication_heads set active_generation=null,revoked=true,revision=revision+1 where tenant_id=$1 and corpus_id=$2 and document_id=$3',[scope.tenantId,scope.corpusId,scope.documentId]);
      assert.equal((await appQueue.result(id,scope)).currentlyActive,false);
      await assert.rejects(pubQueue.claim(operationId));
      await assert.rejects(pubQueue.claim(randomUUID()), {code:'PUBLICATION_CLAIM_UNKNOWN'});
      await assert.rejects(app.query('select * from public.rag_claim_publication_request($1)',[randomUUID()]));
      await assert.rejects(publisher.query('update public.publication_requests set state=$1',[ 'queued' ]));
      const altered=preparePublicationAsset({...scope,sourceBytes:Buffer.from('different'),sourceIdentityBytes:Buffer.from('parsed'),
        originalName:'x.txt',contentType:'text/plain',sourceKind:'text',embedding:{model:'m',revision:'1',dimension:2,indexSchema:'milvus-publication/v1'},
        splitter:{name:'text',revision:'1',chunkSize:10,chunkOverlap:0},chunks:[{chunkIndex:0,content:'hello',trustLevel:'trusted',embedding:[0.1,0.2]}]});
      await assert.rejects(appQueue.enqueue(id,altered));
      // The first transaction has a row lock but has not committed its claim.
      // SKIP LOCKED lets the second call return zero rows even though the same
      // operation may soon become the owner of a real request.
      const secondPublisher=connect('pub_publisher',config.credentials.dbPublisher);
      await secondPublisher.connect();
      try {
        const raceId=randomUUID(); const raceOperation=randomUUID();
        await appQueue.enqueue(raceId,asset);
        await publisher.query('begin');
        try {
          const pending=await pubQueue.claim(raceOperation);
          assert.equal(pending.requestId,raceId);
          const other=new PublicationRequestQueue({query:(sql,values)=>secondPublisher.query(sql,values)});
          await assert.rejects(other.claim(raceOperation), error => error.code==='PUBLICATION_CLAIM_UNKNOWN' && error.operationId===raceOperation);
          assert.equal(await other.inspectClaim(raceOperation),undefined);
          await publisher.query('commit');
          assert.equal((await other.inspectClaim(raceOperation)).requestId,raceId);
          await assert.rejects(other.claim(raceOperation));
        } catch (error) { await publisher.query('rollback'); throw error; }
      } finally { await secondPublisher.end(); }
    } finally { await app.end().catch(()=>{}); await publisher.end().catch(()=>{}); await migration.end(); }
  });

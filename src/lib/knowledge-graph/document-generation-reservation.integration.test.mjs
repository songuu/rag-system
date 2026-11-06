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
const sandboxId = process.env.PUBLICATION_GRAPH_SANDBOX_ID;
test('graph dispatch is durably reserved once under a valid publication lease', { skip: !sandboxId }, async () => {
  const config = readSandboxConfig(sandboxId);
  const make = (user, password) => new pg.Client({ host:'127.0.0.1', port:config.ports.postgres, database:'publication_sandbox', user, password });
  const migration=make('pub_migration',config.credentials.dbMigration), publisher=make('pub_publisher',config.credentials.dbPublisher);
  await migration.connect();
  try {
    await runMigrationSession(migration); await grantSandboxPublisher(sandboxId); await publisher.connect();
    const perms = await migration.query(`select
      has_function_privilege('pub_app','public.rag_reserve_document_graph(text,text,text,bigint,bigint,uuid,text,text,text)','EXECUTE') as app,
      has_function_privilege('pub_publisher','public.rag_reserve_document_graph(text,text,text,bigint,bigint,uuid,text,text,text)','EXECUTE') as publisher,
      has_table_privilege('pub_publisher','public.document_graph_dispatches','INSERT,UPDATE,DELETE,TRUNCATE') as direct`);
    assert.deepEqual(perms.rows[0], { app:false,publisher:true,direct:false });
    const suffix=randomUUID().replaceAll('-','');
    const scope={tenantId:`gt-${suffix}`,corpusId:`gc-${suffix}`,documentId:`gd-${suffix}`};
    const contentVersion=`sha256:${'a'.repeat(64)}`, manifestDigest=`sha256:${'b'.repeat(64)}`;
    await migration.query('insert into public.tenants(id,name) values($1,$2)',[scope.tenantId,'Graph test']);
    await migration.query("insert into public.corpora(tenant_id,id,name,source_kind) values($1,$2,$3,'test')",[scope.tenantId,scope.corpusId,'Graph test']);
    const {PostgresDocumentPublicationStore}=await import('../documents/publication-control-cas.ts');
    const {reserveDocumentGraphDispatch,stageReservedDocumentGraph}=await import('./document-generation-reservation.ts');
    const {createDocumentGraphIdentity}=await import('./document-generation.ts');
    const {expectedDocumentGraphEdges}=await import('./document-generation-edges.ts');
    const db={query:(sql,values)=>publisher.query(sql,values)}, control=new PostgresDocumentPublicationStore(db);
    const candidate=await control.begin({...scope,idempotencyKey:randomUUID(),contentVersion,manifestDigest,
      physicalCollection:`rag_publication_${suffix}`,requiredProviders:['milvus','elasticsearch']});
    const attempt=await control.claim(candidate);
    const identity={...scope,generation:attempt.generation,contentVersion,manifestDigest};
    const graph=createDocumentGraphIdentity(identity).graphVersion;
    const args=[scope.tenantId,scope.corpusId,scope.documentId,attempt.generation,attempt.revision,attempt.leaseToken,graph,contentVersion,manifestDigest];
    for (let index=0;index<args.length;index++) {
      const invalid=[...args]; invalid[index]=null;
      await assert.rejects(publisher.query('select public.rag_reserve_document_graph($1,$2,$3,$4::bigint,$5::bigint,$6::uuid,$7,$8,$9)',invalid), e=>e.code==='22023');
    }
    await assert.rejects(reserveDocumentGraphDispatch(db,{...attempt,leaseToken:randomUUID()},identity));
    const snapshot={tenantId:scope.tenantId,corpusId:scope.corpusId,graphVersion:graph,graphId:'graph',status:'staging',
      artifactDigest:`sha256:${'c'.repeat(64)}`,createdAt:'2024-01-01T00:00:00.000Z',
      documents:[{documentId:scope.documentId,documentVersion:contentVersion,trustLevel:'reviewed'}],passages:[],entities:[],claims:[],communities:[]};
    const retrievalScope={tenantId:scope.tenantId,corpusId:scope.corpusId,enforceIsolation:true,allowedTrustLevels:['reviewed']};
    let writes=0;
    // A caller transaction rollback must not roll back the private connection's reserve.
    await publisher.query('begin');
    const result=await stageReservedDocumentGraph({host:'127.0.0.1',port:config.ports.postgres,database:'publication_sandbox',
      user:'pub_publisher',password:config.credentials.dbPublisher},attempt,identity,retrievalScope,snapshot,
      {stageSnapshot:async()=>{writes++;return snapshot;},getSnapshot:async()=>snapshot},async()=>expectedDocumentGraphEdges(snapshot));
    await publisher.query('rollback');
    assert.equal(writes,1);
    assert.match(result.graphVersion,/^doc-generation-[a-f0-9]{64}$/);
    await assert.rejects(reserveDocumentGraphDispatch(db,attempt,identity));
    await control.abandon(attempt);
    await assert.rejects(reserveDocumentGraphDispatch(db,attempt,identity));
    const count=await migration.query('select count(*)::integer as n from public.document_graph_dispatches where tenant_id=$1',[scope.tenantId]);
    assert.equal(count.rows[0].n,1);
    // Hold the publication head lock until the private reservation statement
    // times out. No Neo4j dispatch is allowed after an uncertain DB result.
    const next=await control.begin({...scope,idempotencyKey:randomUUID(),contentVersion,manifestDigest,
      physicalCollection:`rag_publication_${randomUUID().replaceAll('-','')}`,requiredProviders:['milvus','elasticsearch']});
    const nextAttempt=await control.claim(next), nextIdentity={...identity,generation:nextAttempt.generation};
    const nextSnapshot={...snapshot,graphVersion:createDocumentGraphIdentity(nextIdentity).graphVersion};
    await migration.query('begin');
    try {
      await migration.query('select 1 from public.document_publication_heads where tenant_id=$1 and corpus_id=$2 and document_id=$3 for update',
        [scope.tenantId,scope.corpusId,scope.documentId]);
      await assert.rejects(stageReservedDocumentGraph({host:'127.0.0.1',port:config.ports.postgres,database:'publication_sandbox',
        user:'pub_publisher',password:config.credentials.dbPublisher},nextAttempt,nextIdentity,retrievalScope,nextSnapshot,
        {stageSnapshot:async()=>{writes++;return nextSnapshot;},getSnapshot:async()=>nextSnapshot},async()=>expectedDocumentGraphEdges(nextSnapshot)),
      error=>error.code==='DOCUMENT_GRAPH_UNKNOWN');
      assert.equal(writes,1);
    } finally { await migration.query('rollback'); }
    await control.abandon(nextAttempt);
    const third=await control.begin({...scope,idempotencyKey:randomUUID(),contentVersion,manifestDigest,
      physicalCollection:`rag_publication_${randomUUID().replaceAll('-','')}`,requiredProviders:['milvus','elasticsearch']});
    const thirdAttempt=await control.claim(third), thirdIdentity={...identity,generation:thirdAttempt.generation};
    const thirdSnapshot={...snapshot,graphVersion:createDocumentGraphIdentity(thirdIdentity).graphVersion};
    const originalEnd=pg.Client.prototype.end; const privateClients=new Set();
    pg.Client.prototype.end=function () { privateClients.add(this); return new Promise(()=>{}); };
    try {
      await assert.rejects(stageReservedDocumentGraph({host:'127.0.0.1',port:config.ports.postgres,database:'publication_sandbox',
        user:'pub_publisher',password:config.credentials.dbPublisher},thirdAttempt,thirdIdentity,retrievalScope,thirdSnapshot,
        {stageSnapshot:async()=>{writes++;return thirdSnapshot;},getSnapshot:async()=>thirdSnapshot},async()=>expectedDocumentGraphEdges(thirdSnapshot)),
      error=>error.code==='DOCUMENT_GRAPH_UNKNOWN'&&error.identity.graphVersion===thirdSnapshot.graphVersion);
      assert.equal(writes,1);
    } finally {
      pg.Client.prototype.end=originalEnd;
      for (const privateClient of privateClients) await originalEnd.call(privateClient);
    }
    await assert.rejects(reserveDocumentGraphDispatch(db,thirdAttempt,thirdIdentity));
  } finally { await publisher.end().catch(()=>{}); await migration.end(); }
});

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {registerHooks} from 'node:module';
import test from 'node:test';
import pg from 'pg';
import {readFileSync,realpathSync,lstatSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {runMigrationSession} from '../../../scripts/migrate-postgres.mjs';
import {readSandboxConfig} from '../../../deploy/publication-sandbox/sandbox.mjs';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e?.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!s.endsWith('.ts'))return n(s+'.ts',c);throw e;}}});
const sandbox=process.env.PUBLICATION_GRAPH_SANDBOX_ID;
test('real private Neo4j publisher verifies the asset graph and records lease-bound third-provider seal',{skip:!sandbox,timeout:120000},async()=>{
 assert.match(sandbox,/^[a-f0-9]{24}$/);
 const root=fileURLToPath(new URL('../../../deploy/publication-sandbox/runtime/',import.meta.url)),folder=resolve(root,sandbox);
 assert.equal(dirname(folder),resolve(root));assert.equal(lstatSync(folder).isSymbolicLink(),false);assert.equal(realpathSync(folder),folder);
 // Resolve current published ports; Docker may reassign ephemeral host ports
 // after a daemon restart, while the persisted state still lists old ports.
 const state=JSON.parse(readFileSync(resolve(folder,'state.json'),'utf8'));
 assert.equal(state.id,sandbox);
 const cfg=readSandboxConfig(sandbox);
 const database=`publication_unified_${randomUUID().replaceAll('-','').slice(0,24)}`;
 const admin=new pg.Client({host:'127.0.0.1',port:cfg.ports.postgres,database:'publication_sandbox',user:'sandbox_admin',password:cfg.credentials.postgresAdmin});
 await admin.connect();await admin.query(`create database ${database} owner pub_migration`);
 const local=(user,password)=>({host:'127.0.0.1',port:cfg.ports.postgres,database,user,password});
 const migration=new pg.Client(local('pub_migration',cfg.credentials.dbMigration)),publisher=new pg.Client(local('pub_publisher',cfg.credentials.dbPublisher)),app=new pg.Client(local('pub_app',cfg.credentials.dbApp));
 await migration.connect();let graph;
 try{
  await runMigrationSession(migration,{appRole:'pub_app'});
  console.log(JSON.stringify({sandbox,database,fixture:'private-graph-publication'}));
  for(const signature of ['rag_publication_control(text,text,text,text,jsonb)',
   'rag_stage_publication_asset(text,text,text,bigint,bigint,uuid,text,text,text,bytea,bytea,jsonb)',
   'rag_read_staged_publication_asset(text,text,text,bigint,bigint,uuid,text)',
   'rag_reserve_document_graph(text,text,text,bigint,bigint,uuid,text,text,text)',
   'rag_publish_document_generation(text,text,text,bigint,bigint,uuid,text,text)'])await migration.query(`grant execute on function public.${signature} to pub_publisher`);
  await migration.query('grant execute on function public.rag_record_document_graph_seal(text,text,text,bigint,bigint,uuid,text,text,text,text) to pub_publisher');
  await migration.query('grant execute on function public.rag_record_document_graph_seal(text,text,text,bigint,bigint,uuid,text,text,text,text,text) to pub_publisher');
  await migration.query('grant execute on function public.rag_read_document_graph_view(text,text,text[]) to pub_app');
  await migration.query('grant execute on function public.rag_read_document_graph_snapshot(text,text,text,text[]) to pub_app');
  await publisher.connect();await app.connect();
  const {preparePublicationAsset,PostgresPublicationAssetStore}=await import('../documents/publication-asset-store.ts');
  const {PostgresDocumentPublicationStore}=await import('../documents/publication-control-cas.ts');
  const {TrustedDocumentGraphPublisher,recordDocumentGraphPublicationSeal}=await import('./document-graph-publication.ts');
  const suffix=randomUUID().replaceAll('-',''),scope={tenantId:`nt-${suffix}`,corpusId:`nc-${suffix}`,documentId:`nd-${suffix}`};
  await migration.query('insert into public.tenants(id,name) values($1,$2)',[scope.tenantId,'Neo4j seal fixture']);
  await migration.query("insert into public.corpora(tenant_id,id,name,source_kind) values($1,$2,$3,'test')",[scope.tenantId,scope.corpusId,'Neo4j seal fixture']);
  const asset=preparePublicationAsset({...scope,sourceBytes:Buffer.from('Alice Acme'),sourceIdentityBytes:Buffer.from('Alice Acme'),originalName:'a.txt',contentType:'text/plain',sourceKind:'text',embedding:{model:'m',revision:'r',dimension:2,indexSchema:'milvus-publication/v1'},splitter:{name:'recursive',revision:'v1',chunkSize:400,chunkOverlap:40},chunks:[{chunkIndex:0,content:'Alice Acme',trustLevel:'reviewed',startOffset:0,endOffset:10,source:'a.txt',page:1,embedding:[.25,-.5],metadata:{}}]});
  const control=new PostgresDocumentPublicationStore(publisher);
  const candidate=await control.begin({...scope,idempotencyKey:randomUUID(),contentVersion:asset.contentVersion,manifestDigest:asset.manifestDigest,physicalCollection:`rag_publication_${suffix}`,requiredProviders:['milvus','elasticsearch','neo4j']});
  const attempt=await control.claim(candidate,300000);await new PostgresPublicationAssetStore(publisher).stage(attempt,asset);
  graph=new TrustedDocumentGraphPublisher({uri:`bolt://127.0.0.1:${cfg.ports.neo4j}`,username:'neo4j',password:cfg.credentials.neo4j});
  const check=()=>control.renew(attempt,300000);
  const seal=await graph.stage(local('pub_publisher',cfg.credentials.dbPublisher),attempt,check);
  assert.match(seal.graphVersion,/^doc-generation-[a-f0-9]{64}$/);
  await assert.rejects(recordDocumentGraphPublicationSeal(publisher,attempt,{...seal}),/private verifier/);
  // Synthetic ES/Milvus rows exercise only the SQL third-provider gate. The
  // parent end-to-end suite verifies actual ES/Milvus backend sealing.
  const {materializePublicationManifests}=await import('../documents/publication-publisher.ts');
  const manifests=materializePublicationManifests({...scope,enforceIsolation:true,allowedTrustLevels:['reviewed']},attempt,asset);
  const indexName=`codex-generation-seal-${suffix}`,indexUuid=`uuid_${suffix}`;
  await migration.query(`insert into public.elasticsearch_publication_operations(operation_id,tenant_id,corpus_id,document_id,generation,revision,
    manifest_digest,physical_collection,content_version,index_name,owner_marker,state,index_uuid)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'bound',$12)`,[randomUUID(),scope.tenantId,scope.corpusId,scope.documentId,attempt.generation,attempt.revision,
      attempt.manifestDigest,attempt.physicalCollection,asset.contentVersion,indexName,'a'.repeat(64),indexUuid]);
  for(const provider of ['milvus','elasticsearch'])await migration.query(`insert into public.document_publication_provider_seals
    (tenant_id,corpus_id,document_id,generation,provider,manifest_digest,resource_name,resource_id,verification_profile,configuration_digest,evidence_digest,provider_manifest_json,provider_manifest_digest)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[scope.tenantId,scope.corpusId,scope.documentId,attempt.generation,provider,asset.manifestDigest,
      provider==='milvus'?attempt.physicalCollection:indexName,provider==='milvus'?'123':indexUuid,
      provider==='milvus'?'milvus-exclusive-strong-v1':'elasticsearch-write-block-pit-v1','sha256:'+'b'.repeat(64),'sha256:'+'c'.repeat(64),
      provider==='milvus'?manifests.milvusManifestJson:manifests.elasticsearchManifestJson,'sha256:'+'d'.repeat(64)]);
  const publishSql='select public.rag_publish_document_generation($1,$2,$3,$4::bigint,$5::bigint,$6::uuid,$7,$8) as result';
  const publishArgs=[scope.tenantId,scope.corpusId,scope.documentId,attempt.generation,attempt.revision,attempt.leaseToken,attempt.physicalCollection,attempt.manifestDigest];
  await assert.rejects(publisher.query(publishSql,publishArgs),e=>e.code==='P0001'&&/Neo4j seal/.test(e.message));
  const args=[scope.tenantId,scope.corpusId,scope.documentId,attempt.generation,attempt.revision,attempt.leaseToken,seal.graphVersion,seal.configurationDigest,seal.evidenceDigest,seal.manifestJson];
  await publisher.query('select public.rag_record_document_graph_seal($1,$2,$3,$4::bigint,$5::bigint,$6::uuid,$7,$8,$9,$10)',args);
  await assert.rejects(publisher.query(publishSql,publishArgs),e=>e.code==='P0001'&&/graph snapshot/.test(e.message));
  await assert.rejects(publisher.query('select public.rag_record_document_graph_seal($1,$2,$3,$4::bigint,$5::bigint,$6::uuid,$7,$8,$9,$10,$11)',[...args,seal.snapshotJson+' ']),e=>e.code==='P0001');
  await recordDocumentGraphPublicationSeal(publisher,attempt,seal);
  for(let i=0;i<args.length;i++){const bad=[...args];bad[i]=null;await assert.rejects(publisher.query('select public.rag_record_document_graph_seal($1,$2,$3,$4::bigint,$5::bigint,$6::uuid,$7,$8,$9,$10)',bad),e=>e.code==='22023');}
  await assert.rejects(app.query('select public.rag_record_document_graph_seal($1,$2,$3,$4::bigint,$5::bigint,$6::uuid,$7,$8,$9,$10)',args),e=>e.code==='42501');
  await assert.rejects(app.query('select public.rag_record_document_graph_seal($1,$2,$3,$4::bigint,$5::bigint,$6::uuid,$7,$8,$9,$10,$11)',[...args,seal.snapshotJson]),e=>e.code==='42501');
  await assert.rejects(publisher.query('delete from public.document_graph_publication_seals where graph_version=$1',[seal.graphVersion]),e=>e.code==='42501');
  const saved=await migration.query('select graph_version,graph_manifest_json from public.document_graph_publication_seals where graph_version=$1',[seal.graphVersion]);
  assert.equal(saved.rows.length,1);assert.equal(saved.rows[0].graph_manifest_json,seal.manifestJson);
  await assert.rejects(graph.stage(local('pub_publisher',cfg.credentials.dbPublisher),attempt,check),e=>e.code==='DOCUMENT_GRAPH_UNKNOWN');
  const published=await publisher.query(publishSql,publishArgs);assert.equal(published.rows[0].result.generation,attempt.generation);
  const sourceView=await app.query('select public.rag_read_publication_view($1,$2,$3::text[]) as result',[scope.tenantId,scope.corpusId,['reviewed']]);
  assert.equal(sourceView.rows[0].result.documents[0].byteSize,Buffer.byteLength('Alice Acme'));
  assert.ok(Number.isFinite(Date.parse(sourceView.rows[0].result.documents[0].createdAt)));
  assert.ok(Date.parse(sourceView.rows[0].result.documents[0].updatedAt)>=Date.parse(sourceView.rows[0].result.documents[0].createdAt));
  assert.deepEqual((await app.query('select public.rag_read_publication_view($1,$2,$3::text[]) as result',['other',scope.corpusId,['reviewed']])).rows[0].result.documents,[]);
  assert.deepEqual((await app.query('select public.rag_read_publication_view($1,$2,$3::text[]) as result',[scope.tenantId,scope.corpusId,['external']])).rows[0].result.documents,[]);
  const view=await app.query('select public.rag_read_document_graph_view($1,$2,$3::text[]) as result',[scope.tenantId,scope.corpusId,['reviewed']]);
  assert.equal(view.rows[0].result[0].graphVersion,seal.graphVersion);
  const {readPublishedDocumentGraph}=await import('./document-graph-reader.ts');
  const graphView=await readPublishedDocumentGraph({...scope,enforceIsolation:true,allowedTrustLevels:['reviewed']},scope.documentId,app);
  assert.equal(graphView.entities.length,2);assert.equal(graphView.passages[0].content,'Alice Acme');
  assert.equal(await readPublishedDocumentGraph({...scope,enforceIsolation:true,allowedTrustLevels:['external']},scope.documentId,app),null);
  assert.deepEqual((await app.query('select public.rag_read_document_graph_view($1,$2,$3::text[]) as result',['other',scope.corpusId,['reviewed']])).rows[0].result,[]);
  await control.revoke({...scope,expectedRevision:published.rows[0].result.revision});
  assert.deepEqual((await app.query('select public.rag_read_document_graph_view($1,$2,$3::text[]) as result',[scope.tenantId,scope.corpusId,['reviewed']])).rows[0].result,[]);
 }finally{await Promise.allSettled([graph?.close(),publisher.end(),app.end(),migration.end(),admin.end()]);}
});

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

registerHooks({resolve(specifier,context,next){try{return next(specifier,context);}catch(error){
  if(error?.code==='ERR_MODULE_NOT_FOUND'&&specifier.startsWith('.')&&!specifier.endsWith('.ts'))return next(`${specifier}.ts`,context);
  throw error;
}}});

function sandboxConfig(){
  const sandboxPath=resolve('deploy/publication-sandbox/runtime',process.env.PUBLICATION_READ_SANDBOX_ID);
  const state=JSON.parse(readFileSync(resolve(sandboxPath,'state.json'),'utf8'));
  assert.equal(state.id,process.env.PUBLICATION_READ_SANDBOX_ID);
  for(const value of Object.values(state.ports))assert.equal(Number.isInteger(value)&&value>0&&value<65536,true);
  const database=state.database??'publication_sandbox';assert.match(database,/^[a-z0-9_]{1,63}$/);
  return {path:sandboxPath,ports:state.ports,database,credentials:JSON.parse(readFileSync(resolve(sandboxPath,'credentials.json'),'utf8'))};
}

test('minimum application role can read published views and submit queue requests without legacy controls',{
  skip:!/^[a-f0-9]{24}$/.test(process.env.PUBLICATION_READ_SANDBOX_ID??''),timeout:30000,
},async()=>{
  const {default:pg}=await import('pg');
  const {assertPublicationReaderPostgresCapability,assertPublicationQueuePostgresCapability}=await import('./publication-reader-capability.ts');
  const cfg=sandboxConfig();
  const app=new pg.Client({host:'127.0.0.1',port:cfg.ports.postgres,user:'pub_app',password:cfg.credentials.dbApp,database:cfg.database,connectionTimeoutMillis:10000,query_timeout:10000});
  await app.connect();
  try{await assertPublicationReaderPostgresCapability(app);await assertPublicationQueuePostgresCapability(app);}
  catch(error){
    const funcs=await app.query(`select p.proname,pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE') as allowed
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=any($1::text[]) order by p.proname`,[['rag_read_publication_view','rag_read_publication_source','rag_claim_publication_request','rag_record_publication_seal','rag_publish_document_generation','rag_publication_control','rag_stage_publication_asset','rag_elasticsearch_publication_operation']]);
    const tables=await app.query(`select c.relname,pg_catalog.has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as table_rights,
      pg_catalog.has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') as column_rights,pg_catalog.pg_has_role(current_user,c.relowner,'MEMBER') as owner
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
      and c.relkind='r' and (c.relname like '%publication%' or c.relname='document_graph_dispatches') order by c.relname`);
    console.info(JSON.stringify({functionCapabilities:funcs.rows,tableCapabilities:tables.rows}));throw error;
  }
  finally{await app.end();}
});

test('private reader runtime searches a previously published synthetic fixture without backend writes',{
  skip:process.env.PUBLICATION_READ_ALLOW_SEARCH!=='1'||!/^[a-f0-9]{24}$/.test(process.env.PUBLICATION_READ_SANDBOX_ID??''),timeout:180000,
},async(t)=>{
  const {default:pg}=await import('pg');
  const {searchPublishedDocuments,closePublicationReaderClients}=await import('./publication-search-runtime.ts');
  const {closePostgresPool}=await import('../postgres/client.ts');
  const {createRetrievalScope}=await import('../security/retrieval-scope.ts');
  const cfg=sandboxConfig();
  t.diagnostic('Isolated connection metadata resolved.');
  const migration=new pg.Client({host:'127.0.0.1',port:cfg.ports.postgres,user:'pub_migration',password:cfg.credentials.dbMigration,database:cfg.database,connectionTimeoutMillis:10000,query_timeout:10000});
  await migration.connect();
  const prior={DATABASE_URL:process.env.DATABASE_URL,POSTGRES_URL:process.env.POSTGRES_URL,POSTGRES_SSL_MODE:process.env.POSTGRES_SSL_MODE};
  try{
    // Read-only fixture selection; this test never claims a queued request.
    const found=await migration.query(`select h.tenant_id,h.corpus_id,h.document_id
      from public.document_publication_heads h join public.tenants t on t.id=h.tenant_id
      where h.active_generation is not null and not h.revoked and t.name=any($1::text[])
      order by h.updated_at desc limit 1`,[['Worker test','Trusted publisher test']]);
    assert.equal(found.rows.length,1,'requires an already-published synthetic fixture');
    t.diagnostic('Published synthetic scope resolved.');
    const row=found.rows[0];
    process.env.DATABASE_URL=`postgresql://pub_app:${cfg.credentials.dbApp}@127.0.0.1:${cfg.ports.postgres}/${cfg.database}`;
    delete process.env.POSTGRES_URL;process.env.POSTGRES_SSL_MODE='disable';
    const scope=createRetrievalScope({tenantId:row.tenant_id,corpusId:row.corpus_id,enforceIsolation:true});
    const result=await searchPublishedDocuments({scope,query:'body',strategy:'keyword',topK:100,documentId:row.document_id},{
      ELASTICSEARCH_URL:`https://127.0.0.1:${cfg.ports.elasticsearch}`,ELASTICSEARCH_USERNAME:'pub_reader',ELASTICSEARCH_PASSWORD:cfg.credentials.esReader,
      ELASTICSEARCH_CA_CERT_PATH:`${cfg.path}/tls.crt`,MILVUS_LOCAL_ADDRESS:`127.0.0.1:${cfg.ports.milvus}`,MILVUS_TOKEN:`pub_reader:${cfg.credentials.milvusReader}`,
    });
    assert.equal(result.diagnostics.status,'published-view');
    assert.equal(result.evidence.length>0,true,'synthetic body must be searchable');
    assert.equal(result.evidence.every(item=>item.tenantId===row.tenant_id&&item.corpusId===row.corpus_id&&item.documentId===row.document_id),true);
    const before=await migration.query('select count(*)::text as n from public.document_publication_attempts');
    const empty=await searchPublishedDocuments({scope:createRetrievalScope({tenantId:row.tenant_id,corpusId:`missing-${row.corpus_id}`.slice(0,128),enforceIsolation:true}),query:'body',strategy:'keyword',topK:1},{
      ELASTICSEARCH_URL:`https://127.0.0.1:${cfg.ports.elasticsearch}`,ELASTICSEARCH_USERNAME:'pub_reader',ELASTICSEARCH_PASSWORD:cfg.credentials.esReader,
      ELASTICSEARCH_CA_CERT_PATH:`${cfg.path}/tls.crt`,MILVUS_LOCAL_ADDRESS:`127.0.0.1:${cfg.ports.milvus}`,MILVUS_TOKEN:`pub_reader:${cfg.credentials.milvusReader}`,
    });
    assert.equal(empty.evidence.length,0);
    const after=await migration.query('select count(*)::text as n from public.document_publication_attempts');
    assert.equal(after.rows[0].n,before.rows[0].n);
  }catch(error){
    t.diagnostic(`Read-only runtime failure phase: ${error?.phase??'fixture'}`);
    throw error;
  }
  finally{
    for(const [key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    await closePublicationReaderClients();await closePostgresPool();await migration.end();
  }
});

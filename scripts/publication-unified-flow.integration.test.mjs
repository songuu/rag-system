import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

test('authenticated upload publishes to all three backends and is searchable', {
  skip: process.env.PUBLICATION_UNIFIED_FLOW !== '1', timeout: 300000,
}, async () => {
  const { default: pg } = await import('pg');
  const { NextRequest } = await import('next/server');
  const { readSandboxConfig } = await import('../deploy/publication-sandbox/sandbox.mjs');
  const { runPublicationOnce } = await import('./publication-worker.mjs');
  const { TrustedPublicationService } = await import('../src/lib/documents/publication-trusted-service.ts');
  const config = readSandboxConfig('372b94728dedfdab252e037f');
  if (!config.database?.startsWith('publication_unified_')) throw new Error('Dedicated unified test database required.');
  const owner = new pg.Client({ host:'127.0.0.1',port:config.ports.postgres,database:config.database,
    user:'pub_migration',password:config.credentials.dbMigration });
  await owner.connect();
  const suffix=randomUUID().replaceAll('-',''); const requestId=randomUUID();
  const scope={tenantId:`flow-t-${suffix}`,corpusId:`flow-c-${suffix}`,documentId:`upload:${requestId}`};
  writeFileSync(join(config.path,`unified-flow-${suffix}.json`),JSON.stringify({...scope,requestId,database:config.database}),{flag:'wx',mode:0o600});
  try {
    assert.equal((await owner.query("select count(*)::int as n from public.publication_requests where state='queued'")).rows[0].n,0,
      'this test must exclusively own the dedicated queue');
    await owner.query('insert into public.tenants(id,name) values($1,$2)',[scope.tenantId,'Unified flow fixture']);
    await owner.query("insert into public.corpora(tenant_id,id,name,source_kind) values($1,$2,$3,'integration')",[scope.tenantId,scope.corpusId,'Unified flow fixture']);
    const token=randomUUID();
    Object.assign(process.env,{NODE_ENV:'development',RAG_ACCESS_MODE:'single-tenant-token',RAG_SINGLE_TENANT_ROLE:'owner',
      RAG_SINGLE_TENANT_TOKEN:token,RAG_DEFAULT_TENANT_ID:scope.tenantId,RAG_DEFAULT_CORPUS_ID:scope.corpusId,
      RAG_PERSISTENCE_BACKEND:'postgres',DATABASE_URL:`postgresql://pub_app:${config.credentials.dbApp}@127.0.0.1:${config.ports.postgres}/${config.database}`,
      POSTGRES_SSL_MODE:'disable',RAG_UNIFIED_PUBLICATION_MODE:'active',RAG_UNIFIED_PUBLICATION_ACCEPT_REQUESTS:'true',
      EMBEDDING_PROVIDER:'ollama',OLLAMA_BASE_URL:'http://127.0.0.1:11434',OLLAMA_EMBEDDING_MODEL:'nomic-embed-text',
      ELASTICSEARCH_URL:`https://127.0.0.1:${config.ports.elasticsearch}`,ELASTICSEARCH_USERNAME:'pub_reader',ELASTICSEARCH_PASSWORD:config.credentials.esReader,
      ELASTICSEARCH_CA_CERT_PATH:join(config.path,'tls.crt'),MILVUS_LOCAL_ADDRESS:`127.0.0.1:${config.ports.milvus}`,MILVUS_TOKEN:`pub_reader:${config.credentials.milvusReader}`});
    delete process.env.POSTGRES_URL;
    const {POST,GET}=await import('../src/app/api/documents/publications/route.ts');
    const content=`Alice alice Acme 企业统一知识库测试 ${suffix}。`;
    const response=await POST(new NextRequest('http://127.0.0.1/api/documents/publications',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
      body:JSON.stringify({requestId,filename:'unified.txt',contentType:'text/plain',contentBase64:Buffer.from(content).toString('base64')})}));
    const accepted=await response.json();assert.equal(response.status,202,JSON.stringify(accepted));
    let operationId;
    await runPublicationOnce(config.id,{loadSandbox:()=>config,persistOperation:async(path,id)=>{
      writeFileSync(join(path,`unified-operation-${id}.json`),JSON.stringify({operationId:id,requestId}),{flag:'wx',mode:0o600});
    },reportOperation:id=>{operationId=id;},createService:c=>new TrustedPublicationService(c)});
    const statusResponse=await GET(new NextRequest(`http://127.0.0.1/api/documents/publications?requestId=${requestId}&documentId=${encodeURIComponent(scope.documentId)}`,{headers:{authorization:`Bearer ${token}`}}));
    const status=await statusResponse.json();assert.equal(status.status.currentlyActive,true,JSON.stringify(status));
    const seals=await owner.query(`select a.required_providers, g.graph_version from public.document_publication_attempts a
      join public.document_graph_publication_seals g using(tenant_id,corpus_id,document_id,generation)
      where a.tenant_id=$1 and a.corpus_id=$2 and a.document_id=$3`,[scope.tenantId,scope.corpusId,scope.documentId]);
    assert.deepEqual([...seals.rows[0].required_providers].sort(),['elasticsearch','milvus','neo4j']);
    assert.ok(seals.rows[0].graph_version);assert.ok(operationId);
    const {POST:search}=await import('../src/app/api/document-search/route.ts');
    for(const strategy of ['keyword','semantic','hybrid']) {
      const result=await search(new NextRequest('http://127.0.0.1/api/document-search',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({query:'Alice Acme',strategy,topK:5})}));
      const body=await result.json();assert.equal(result.status,200,JSON.stringify(body));
      assert.ok(JSON.stringify(body).includes(scope.documentId),`${strategy} must return the published document`);
    }
  } finally { await owner.end(); const {closePostgresPool}=await import('../src/lib/postgres/client.ts'); await closePostgresPool(); }
});

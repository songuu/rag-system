import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test, { afterEach } from 'node:test';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const asModule = source => ({ shortCircuit:true, url:'data:text/javascript,'+encodeURIComponent(source) });
globalThis.publicationSearchCalls=[];
globalThis.publicationIssuedView=Object.freeze({digest:'issued-view',tenantId:'tenant-a',corpusId:'corpus-a',documents:[]});
globalThis.publicationSearchResult={viewDigest:'issued-view',ranking:[{documentId:'doc-a',generation:'2',chunkId:'chunk-a',score:0.9,denseRank:1}],documents:[{documentId:'doc-a',generation:'2',sources:[{chunkId:'chunk-a',source:'a.pdf'}],originalName:'a.pdf',dense:[{id:'chunk-a',document_id:'doc-a',document_version:'version-a',content:'content',trust_level:'external',chunk_index:0,score:0.9}],lexical:[]}],productionAuthorized:false};
const mocks={
  '@elastic/elasticsearch': `export class Client { constructor(config){globalThis.publicationSearchCalls.push(['es',config]);} async close(){globalThis.publicationSearchCalls.push(['es-close']);if(globalThis.publicationEsCloseFailure)throw globalThis.publicationEsCloseFailure;} security={authenticate:async()=>{globalThis.publicationSearchCalls.push(['es-auth']);if(globalThis.publicationAuthFailure)throw globalThis.publicationAuthFailure;return {username:'pub_reader'};},getUserPrivileges:async()=>{globalThis.publicationSearchCalls.push(['es-privileges']);if(globalThis.publicationPrivilegesWait)await globalThis.publicationPrivilegesWait;return {cluster:globalThis.publicationElevatedPrivileges?['all']:[],global:[],applications:[],run_as:[],indices:[{names:['codex-generation-seal-*','rag-publication-*'],privileges:['read','view_index_metadata']} ]};}}; }`,
  '@zilliz/milvus2-sdk-node': `export class MilvusClient {constructor(config){globalThis.publicationSearchCalls.push(['milvus',config]);if(globalThis.publicationMilvusConstructionFailure)throw globalThis.publicationMilvusConstructionFailure;this.connectPromise=Promise.resolve();}async hasCollection(){globalThis.publicationSearchCalls.push(['milvus-probe']);return {status:{error_code:'Success'}};}async closeConnection(){globalThis.publicationSearchCalls.push(['milvus-close']);}}`,
};
registerHooks({resolve(specifier,context,next){
  if(mocks[specifier])return asModule(mocks[specifier]);
  if(specifier==='../postgres/client')return asModule(`export function getPostgresClient(){return {query:async()=>({rows:[]})};}`);
  if(specifier==='./publication-reader-capability')return asModule(`export async function assertPublicationReaderPostgresCapability(){globalThis.publicationSearchCalls.push(['pg-capability']);if(globalThis.publicationCapabilityWait)await globalThis.publicationCapabilityWait;}`);
  if(specifier==='./publication-embedding')return asModule(`export async function resolvePublicationEmbedding(input){globalThis.publicationSearchCalls.push(['embedding',input]);return {config:{model:input.model,revision:input.revision,dimension:input.dimension,indexSchema:'milvus-publication/v1'},embedQuery:async()=>[1,0]};}`);
  if(specifier==='./publication-retrieval')return asModule(`export async function retrievePublicationCorpus(input,onIssuedView){globalThis.publicationSearchCalls.push(['retrieve',input]);if(!globalThis.publicationSuppressIssuedView)onIssuedView?.(globalThis.publicationIssuedView);if(globalThis.publicationRetrievalWait)await globalThis.publicationRetrievalWait;await input.embedding({model:'alias',revision:'sha256:revision',dimension:2,indexSchema:'milvus-publication/v1'},'query');return globalThis.publicationSearchResult;}`);
  if(specifier.startsWith('.')){const url=new URL(specifier,context.parentURL);if(!existsSync(url)&&existsSync(new URL(url.href+'.ts')))return next(url.href+'.ts',context);}
  return next(specifier,context);
}});
const {searchPublishedDocuments,searchPublishedDocumentsForAnswer,resolvePublicationReaderConfig,closePublicationReaderClients,retryFailedPublicationReaderClosures}=await import('./publication-search-runtime.ts');
afterEach(async()=>{delete globalThis.publicationElevatedPrivileges;await closePublicationReaderClients?.();});
const config={ELASTICSEARCH_URL:'https://127.0.0.1:9200',ELASTICSEARCH_USERNAME:'pub_reader',ELASTICSEARCH_PASSWORD:'secret',ELASTICSEARCH_CA_FINGERPRINT:'a'.repeat(64),MILVUS_LOCAL_ADDRESS:'127.0.0.1:19530',MILVUS_TOKEN:'pub_reader:secret'};
const request={scope:{tenantId:'tenant-a',corpusId:'corpus-a',allowedTrustLevels:['external'],enforceIsolation:true},query:'query',strategy:'semantic',topK:100};

test('unified search privately constructs readers and returns only issued-view ranked evidence',async()=>{
  globalThis.publicationSearchCalls=[];
  const result=await searchPublishedDocuments(request,config);
  assert.equal(result.evidence[0].documentId,'doc-a');
  assert.equal(result.evidence[0].documentVersion,'version-a');
  assert.equal(result.evidence[0].retrievalScore,0.9);
  assert.equal(result.diagnostics.viewDigest,'issued-view');
  const calls=globalThis.publicationSearchCalls;
  assert.equal(calls.find(c=>c[0]==='milvus')[1].maxRetries,0);
  assert.equal(calls.find(c=>c[0]==='es')[1].maxRetries,0);
  assert.equal(calls.filter(c=>c[0]==='embedding').length,1);
  assert.deepEqual(calls.find(c=>c[0]==='embedding')[1].scope,request.scope);
  assert.equal(calls.filter(c=>c[0]==='es-close').length,0);
  assert.equal(calls.filter(c=>c[0]==='milvus-close').length,0);
});

test('sequential and concurrent searches reuse transports but repeat every authority check',async()=>{
  globalThis.publicationSearchCalls=[];
  await searchPublishedDocuments(request,config);
  await Promise.all([searchPublishedDocuments(request,config),searchPublishedDocuments(request,config)]);
  const count=name=>globalThis.publicationSearchCalls.filter(call=>call[0]===name).length;
  assert.equal(count('es'),1);assert.equal(count('milvus'),1);
  for(const name of ['pg-capability','es-auth','es-privileges','milvus-probe','retrieve'])assert.equal(count(name),3,name);
});

test('answer search returns the same issued view after one authority pass without changing public search JSON', async () => {
  globalThis.publicationSearchCalls=[];
  const answer=await searchPublishedDocumentsForAnswer({...request,view:{digest:'forged'}},config);
  assert.equal(answer.view,globalThis.publicationIssuedView);
  assert.equal(answer.view.digest,answer.result.diagnostics.viewDigest);
  assert.equal(globalThis.publicationSearchCalls.filter(call=>call[0]==='pg-capability').length,1);
  assert.equal(globalThis.publicationSearchCalls.filter(call=>call[0]==='retrieve').length,1);
  assert.equal('view' in answer.result,false);
  const publicResult=await searchPublishedDocuments(request,config);
  assert.deepEqual(Object.keys(publicResult).sort(),['diagnostics','evidence']);
});

test('answer search fails closed when no matching issued view is available', async () => {
  const original=globalThis.publicationIssuedView;
  try {
    globalThis.publicationSuppressIssuedView=true;
    await assert.rejects(searchPublishedDocumentsForAnswer(request,config),error=>error.code==='PUBLICATION_READ_UNAVAILABLE');
    delete globalThis.publicationSuppressIssuedView;
    globalThis.publicationIssuedView={...original,digest:'changed'};
    await assert.rejects(searchPublishedDocumentsForAnswer(request,config),error=>error.code==='PUBLICATION_READ_UNAVAILABLE');
  } finally { delete globalThis.publicationSuppressIssuedView;globalThis.publicationIssuedView=original; }
});

test('answer search never returns a captured view after cancellation', async () => {
  let release;globalThis.publicationRetrievalWait=new Promise(resolve=>{release=resolve;});
  const controller=new AbortController();
  const pending=searchPublishedDocumentsForAnswer({...request,signal:controller.signal},config);
  try {
    await new Promise(resolve=>setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending,error=>error.code==='PUBLICATION_READ_UNAVAILABLE');
  } finally { release();delete globalThis.publicationRetrievalWait;await new Promise(resolve=>setImmediate(resolve)); }
});

test('credentials and TLS content rotation construct new readers instead of reusing old transports',async()=>{
  globalThis.publicationSearchCalls=[];
  const folder=await mkdtemp(join(tmpdir(),'publication-reader-ca-'));
  const caPath=join(folder,'ca.pem');
  try{
    await writeFile(caPath,'first certificate');
    const withCa={...config,ELASTICSEARCH_CA_CERT_PATH:caPath};
    await searchPublishedDocuments(request,withCa);
    await searchPublishedDocuments(request,{...withCa,ELASTICSEARCH_PASSWORD:'rotated'});
    await writeFile(caPath,'second certificate');
    await searchPublishedDocuments(request,withCa);
    assert.equal(globalThis.publicationSearchCalls.filter(call=>call[0]==='es').length,3);
    assert.deepEqual(globalThis.publicationSearchCalls.filter(call=>call[0]==='es').map(call=>call[1].tls.ca),
      ['first certificate','first certificate','second certificate']);
  }finally{await unlink(caPath).catch(error=>{if(error.code!=='ENOENT')throw error;});await rmdir(folder);}
});

test('a reused reader rejects changed privileges before retrieval and is retired',async()=>{
  globalThis.publicationSearchCalls=[];
  await searchPublishedDocuments(request,config);
  globalThis.publicationElevatedPrivileges=true;
  await assert.rejects(searchPublishedDocuments(request,config),error=>error.phase==='reader-capability');
  assert.equal(globalThis.publicationSearchCalls.filter(call=>call[0]==='retrieve').length,1);
  delete globalThis.publicationElevatedPrivileges;
  await searchPublishedDocuments(request,config);
  assert.equal(globalThis.publicationSearchCalls.filter(call=>call[0]==='es').length,2);
});

test('cancelling an in-flight search never closes a client leased by another request',async()=>{
  globalThis.publicationSearchCalls=[];
  let release;globalThis.publicationRetrievalWait=new Promise(resolve=>{release=resolve;});
  const controller=new AbortController();
  const cancelled=searchPublishedDocuments({...request,signal:controller.signal},config);
  const other=searchPublishedDocuments(request,config);
  try{
    await new Promise(resolve=>setImmediate(resolve));controller.abort();
    await assert.rejects(cancelled,error=>error.code==='PUBLICATION_READ_UNAVAILABLE');
    assert.equal(globalThis.publicationSearchCalls.filter(call=>call[0]==='es-close').length,0);
    release();await other;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(globalThis.publicationSearchCalls.filter(call=>call[0]==='es-close').length,1);
    assert.equal(globalThis.publicationSearchCalls.filter(call=>call[0]==='milvus-close').length,1);
  }finally{release();delete globalThis.publicationRetrievalWait;await other.catch(()=>{});}
});

test('reader configuration rejects privileged identities, insecure ES, remote Milvus and missing TLS validation',()=>{
  for(const bad of [{ELASTICSEARCH_USERNAME:'elastic'},{ELASTICSEARCH_URL:'http://127.0.0.1:9200'},{ELASTICSEARCH_CA_FINGERPRINT:''},{MILVUS_TOKEN:'root:secret'},{MILVUS_LOCAL_ADDRESS:'remote.example:19530'}]){
    assert.throws(()=>resolvePublicationReaderConfig({...config,...bad}),error=>error.code==='PUBLICATION_READ_UNAVAILABLE');
  }
});

test('pre-cancelled search does no backend IO',async()=>{
  globalThis.publicationSearchCalls=[];
  const controller=new AbortController();controller.abort();
  await assert.rejects(searchPublishedDocuments({...request,signal:controller.signal},config));
  assert.deepEqual(globalThis.publicationSearchCalls,[]);
});

test('ranked result with no verified provider evidence fails closed',async()=>{
  const prior=globalThis.publicationSearchResult;
  globalThis.publicationSearchResult={...prior,ranking:[{documentId:'doc-a',generation:'2',chunkId:'missing',score:1}]};
  try{await assert.rejects(searchPublishedDocuments(request,config),/unavailable/i);}finally{globalThis.publicationSearchResult=prior;}
});

test('cancellation of a hanging authority check cannot start late backend queries',async()=>{
  let release;globalThis.publicationCapabilityWait=new Promise(resolve=>{release=resolve;});
  globalThis.publicationSearchCalls=[];const controller=new AbortController();
  const pending=searchPublishedDocuments({...request,signal:controller.signal},config);
  await new Promise(resolve=>setImmediate(resolve));controller.abort();
  await assert.rejects(pending,error=>error.code==='PUBLICATION_READ_UNAVAILABLE');
  release();await new Promise(resolve=>setImmediate(resolve));
  delete globalThis.publicationCapabilityWait;
  assert.deepEqual(globalThis.publicationSearchCalls.map(call=>call[0]),['pg-capability']);
});

test('failed authentication retains its client until a sibling privilege RPC settles',async()=>{
  globalThis.publicationSearchCalls=[];
  const failure=new Error('fixture auth failure');globalThis.publicationAuthFailure=failure;
  let release;globalThis.publicationPrivilegesWait=new Promise(resolve=>{release=resolve;});
  const pending=searchPublishedDocuments(request,config);
  let settled=false;void pending.then(()=>{settled=true;},()=>{settled=true;});
  try{
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false);
    assert.equal(globalThis.publicationSearchCalls.filter(call=>call[0]==='es-close').length,0);
    assert.equal(globalThis.publicationSearchCalls.filter(call=>call[0]==='retrieve').length,0);
    release();await assert.rejects(pending,error=>error.cause===failure);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(globalThis.publicationSearchCalls.filter(call=>call[0]==='es-close').length,1);
  }finally{release();delete globalThis.publicationAuthFailure;delete globalThis.publicationPrivilegesWait;await pending.catch(()=>{});}
});

test('a partial construction remains tracked if its surviving ES transport fails to close',async()=>{
  globalThis.publicationSearchCalls=[];
  globalThis.publicationMilvusConstructionFailure=new Error('fixture constructor failure');
  globalThis.publicationEsCloseFailure=new Error('fixture close failure');
  try{
    await assert.rejects(searchPublishedDocuments(request,config),error=>error.phase==='reader-construction');
    await assert.rejects(closePublicationReaderClients(),/cleanup failed/i);
    assert.equal(globalThis.publicationSearchCalls.filter(call=>call[0]==='es-close').length,1);
    assert.equal(globalThis.publicationSearchCalls.filter(call=>call[0]==='milvus-close').length,0);
    delete globalThis.publicationEsCloseFailure;
    await retryFailedPublicationReaderClosures();
    assert.equal(globalThis.publicationSearchCalls.filter(call=>call[0]==='es-close').length,2);
  }finally{
    delete globalThis.publicationEsCloseFailure;delete globalThis.publicationMilvusConstructionFailure;
    await retryFailedPublicationReaderClosures();
  }
});

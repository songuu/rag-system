import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mocks = {
  '../document-pipeline': `export const PIPELINE_WORK_LIMITS={maxChunksPerDocument:1000};
    export async function loadDocument(bytes,opts){globalThis.uploadLoad++;if(globalThis.uploadLoadGate)await globalThis.uploadLoadGate; return {content:bytes.toString(),metadata:{source:opts.filename,type:'text'}};}
    export async function splitDocument(doc){return [{id:'chunk',content:doc.content,metadata:{...doc.metadata,chunkIndex:0,startOffset:0,endOffset:globalThis.uploadBadOffset?999:doc.content.length}}];}
    export async function generateEmbeddings(chunks){return chunks.map(x=>({...x,embedding:[0.1,0.2]}));}`,
  './publication-embedding': `export async function resolvePublicationEmbedding(){if(globalThis.uploadModelError)throw new Error('Model identity is unavailable');return {config:{model:'rag-publication-'+ 'a'.repeat(64)+':latest',revision:'sha256:'+ 'b'.repeat(64),dimension:2,indexSchema:'milvus-publication/v1'},async embedDocuments(texts){globalThis.uploadEmbedding++;return texts.map(()=>[0.1,0.2]);}};}`,
  './publication-queue-ingest': `export class PublicationEnqueueUnknownError extends Error { constructor(requestId){super();this.requestId=requestId;} } export async function enqueuePipelinePublication(id,input,client){ globalThis.uploadPrepared={id,input,client}; return {status:'accepted',requestId:id,documentId:input.documentId};}`,
  './publication-request-queue': `export class PublicationRequestQueue { async state(){if(globalThis.uploadStateGate)await globalThis.uploadStateGate;return globalThis.uploadQueueState || 'not_observed';} }`,
};
registerHooks({resolve(specifier,context,next){if(mocks[specifier]) return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(mocks[specifier])};
  if(specifier.startsWith('.') && context.parentURL?.startsWith('file:')) { const target=new URL(specifier+'.ts',context.parentURL); if(existsSync(fileURLToPath(target))) return next(target.href,context); }
  return next(specifier,context);}});
const {enqueueUploadedPublication}=await import('./publication-upload.ts');
const id='7c4c948a-c77d-4bb1-a702-27949fc7bf99';
const input={requestId:id,filename:'a.txt',contentType:'text/plain',contentBase64:'YQ=='};
function reset(){globalThis.uploadLoad=0;globalThis.uploadEmbedding=0;globalThis.uploadPrepared=undefined;globalThis.uploadQueueState=undefined;globalThis.uploadModelError=false;globalThis.uploadStateGate=undefined;globalThis.uploadLoadGate=undefined;globalThis.uploadBadOffset=false;}
const settled=()=>new Promise(resolve=>setImmediate(resolve));
test('immutable model is used for a reachable accepted upload',async()=>{
  reset();const result=await enqueueUploadedPublication(input,{tenantId:'tenant',corpusId:'corpus'},{});
  assert.equal(result.status,'accepted');assert.equal(globalThis.uploadLoad,1);assert.equal(globalThis.uploadEmbedding,1);
  assert.match(globalThis.uploadPrepared.input.embedding.model,/^rag-publication-/);
  assert.equal(globalThis.uploadPrepared.input.embedding.revision,'sha256:'+ 'b'.repeat(64));
});
test('unavailable verified model fails before parsing or enqueue',async()=>{
  reset();globalThis.uploadModelError=true;
  globalThis.uploadLoad=0;
  globalThis.uploadPrepared=undefined;
  await assert.rejects(enqueueUploadedPublication(input,{tenantId:'tenant',corpusId:'corpus'},{}),/Model identity/);
  assert.equal(globalThis.uploadLoad,0); assert.equal(globalThis.uploadPrepared,undefined);
});
test('rejects forged scope, invalid encodings and unsafe names before parsing',async()=>{
  reset();
  for (const input of [
    {requestId:id,filename:'a.txt',contentType:'text/plain',contentBase64:'YQ==',tenantId:'other'},
    {requestId:id,filename:'../a.txt',contentType:'text/plain',contentBase64:'YQ=='},
    {requestId:id,filename:'a.txt',contentType:'text/plain',contentBase64:'YQ='},
    {filename:'a.txt',contentType:'text/plain',contentBase64:'YQ=='},
  ]) await assert.rejects(enqueueUploadedPublication(input,{tenantId:'t',corpusId:'c'},{}),/Invalid publication/);
  assert.equal(globalThis.uploadLoad,0);
});
test('existing request conflicts before model or parser work',async()=>{
  reset();globalThis.uploadQueueState='queued';
  await assert.rejects(enqueueUploadedPublication(input,{tenantId:'t',corpusId:'c'},{}),e=>e.status===409);
  assert.equal(globalThis.uploadLoad,0);assert.equal(globalThis.uploadEmbedding,0);
});
test('unverifiable chunk offsets cannot enqueue a graph-incompatible asset',async()=>{
  reset();globalThis.uploadBadOffset=true;
  await assert.rejects(enqueueUploadedPublication(input,{tenantId:'t',corpusId:'c'},{}),/offset/);
  assert.equal(globalThis.uploadPrepared,undefined);
});
test('cancelled hanging state query retains its slot and never starts late parsing',async()=>{
  reset();let release;globalThis.uploadStateGate=new Promise(resolve=>{release=resolve;});
  const controller=new AbortController();const pending=enqueueUploadedPublication(input,{tenantId:'t',corpusId:'c'},{},controller.signal);
  controller.abort();await assert.rejects(pending,e=>e.requestId===id);
  await assert.rejects(enqueueUploadedPublication(input,{tenantId:'t',corpusId:'c'},{}),e=>e.status===429);
  release();await settled();assert.equal(globalThis.uploadLoad,0);assert.equal(globalThis.uploadPrepared,undefined);
  reset();assert.equal((await enqueueUploadedPublication(input,{tenantId:'t',corpusId:'c'},{})).status,'accepted');
});
test('parser timeout returns unknown, keeps slot until late parser exits, and never embeds or enqueues',async()=>{
  reset();let release;globalThis.uploadLoadGate=new Promise(resolve=>{release=resolve;});
  await assert.rejects(enqueueUploadedPublication(input,{tenantId:'t',corpusId:'c'},{},undefined,5),e=>e.requestId===id);
  await assert.rejects(enqueueUploadedPublication(input,{tenantId:'t',corpusId:'c'},{}),e=>e.status===429);
  release();await settled();assert.equal(globalThis.uploadEmbedding,0);assert.equal(globalThis.uploadPrepared,undefined);
  reset();assert.equal((await enqueueUploadedPublication(input,{tenantId:'t',corpusId:'c'},{})).status,'accepted');
});

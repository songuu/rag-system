import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const mocks = {
  '@/lib/postgres/client': `export function getPostgresClient(){ return globalThis.publicationStatusClient; }`,
  '@/lib/documents/publication-reader-capability': `export async function assertPublicationQueuePostgresCapability(){ globalThis.publicationStatusCalls.push('capability'); }`,
  '@/lib/documents/publication-request-queue': `export class PublicationRequestQueue { async result(id,scope){ globalThis.publicationStatusCalls.push([id,scope]); return globalThis.publicationStatusResult; } }`,
  '@/lib/security/error-redaction': `export function redactErrorForLog(){ return {}; }`,
  '@/lib/security/request-validation': `export class RequestValidationError extends Error{}; export async function readJsonObjectWithLimit(request){ return request.json(); }`,
  '@/lib/documents/publication-upload': `export async function enqueueUploadedPublication(input,ctx,client){ globalThis.publicationStatusCalls.push([input,ctx,client]); return {status:'accepted',requestId:'accepted'}; }`,
  '@/lib/documents/publication-queue-ingest': `export class PublicationEnqueueUnknownError extends Error { constructor(requestId){super();this.requestId=requestId;this.code='PUBLICATION_ENQUEUE_UNKNOWN';} }`,
  '@/lib/security/request-context': `export class RagSecurityError extends Error { constructor(){ super();this.status=403; } toResponseBody(){return {error:{code:'FORBIDDEN'}}} }
    export async function resolveRagSecurityContext(request,opts){ globalThis.publicationStatusCalls.push(opts); if(globalThis.publicationStatusDenied) throw new RagSecurityError(); return {tenantId:'server-tenant',corpusId:'server-corpus'}; }`,
};
registerHooks({ resolve(specifier,context,next) {
  if(mocks[specifier]) return { shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(mocks[specifier]) };
  if(specifier==='next/server') return next('next/server.js',context);
  return next(specifier,context);
} });
const { GET, POST } = await import('./route.ts');
const id='7c4c948a-c77d-4bb1-a702-27949fc7bf99';
function setup() { globalThis.publicationStatusCalls=[];globalThis.publicationStatusClient={};globalThis.publicationStatusDenied=false;globalThis.publicationStatusResult=undefined;process.env.RAG_UNIFIED_PUBLICATION_MODE='active';process.env.RAG_UNIFIED_PUBLICATION_ACCEPT_REQUESTS='true'; }
function request(query=`requestId=${id}&documentId=doc`) { return new Request(`http://localhost/api/documents/publications?${query}`); }

test('status authenticates for ingest and uses server-derived scope; absent result remains unknown',async()=>{
  setup(); const response=await GET(request('requestId='+id+'&documentId=doc&tenantId=attacker'));
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual((await response.json()).status,{state:'unknown',backendVerified:false});
  assert.equal(globalThis.publicationStatusCalls[0].capability,'ingest');
  assert.deepEqual(globalThis.publicationStatusCalls[2],[id,{tenantId:'server-tenant',corpusId:'server-corpus',documentId:'doc'}]);
});
test('control plane active status is not represented as backend verification',async()=>{
  setup();globalThis.publicationStatusResult={queueState:'claimed',attemptState:'published',currentlyActive:true,generation:'2',headRevision:'3',operationId:'secret'};
  const body=await (await GET(request())).json();assert.deepEqual(body.status,{queueState:'claimed',attemptState:'published',currentlyActive:true,generation:'2',headRevision:'3',backendVerified:false});
});
test('rejects ambiguous ids and denies unauthorized callers before reading',async()=>{
  setup();assert.equal((await GET(request(`requestId=${id}&requestId=${id}&documentId=doc`))).status,400);
  assert.equal(globalThis.publicationStatusCalls.length,1);
  setup();globalThis.publicationStatusDenied=true;assert.equal((await GET(request())).status,403);assert.equal(globalThis.publicationStatusCalls.length,1);
});
test('database unavailability fails closed',async()=>{
  setup();globalThis.publicationStatusClient=null;assert.equal((await GET(request())).status,503);
});
test('enqueue authenticates before input and reports accepted rather than published',async()=>{
  setup(); const response=await POST(new Request('http://localhost/api/documents/publications',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({filename:'a.txt',contentBase64:'YQ==',contentType:'text/plain'})}));
  assert.equal(response.status,202); assert.equal((await response.json()).status,'accepted');
  assert.equal(globalThis.publicationStatusCalls[0].capability,'ingest');
  assert.equal(globalThis.publicationStatusCalls[2][1].tenantId,'server-tenant');
});
test('enqueue refuses unauthorized callers before queue access',async()=>{
  setup(); globalThis.publicationStatusDenied=true;
  const response=await POST(new Request('http://localhost/api/documents/publications',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}));
  assert.equal(response.status,403); assert.equal(globalThis.publicationStatusCalls.length,1);
});
test('enqueue remains disabled when unified acceptance is not enabled',async()=>{
  setup(); delete process.env.RAG_UNIFIED_PUBLICATION_ACCEPT_REQUESTS;
  const response=await POST(new Request('http://localhost/api/documents/publications',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}));
  assert.equal(response.status,503); assert.equal(globalThis.publicationStatusCalls.length,1);
});

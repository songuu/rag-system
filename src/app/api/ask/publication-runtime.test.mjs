import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const mocks={
  '@/lib/postgres/client':`export function getPostgresClient(){return {};}`,
  '@/lib/documents/publication-reader-capability':`export async function assertPublicationReaderPostgresCapability(){globalThis.publicationInitialChecks++;}`,
  '@/lib/documents/publication-view':`export async function readPublicationView(){globalThis.publicationInitialChecks++;return {digest:'issued',documents:[{embedding:{model:'pinned-model'}}]};} export async function assertPublicationViewCurrent(){globalThis.publicationViewChecks++;if(globalThis.publicationViewChanged)throw new Error('changed');}`,
  '@/lib/documents/publication-search-runtime':`export async function searchPublishedDocuments(input){globalThis.publicationSearchInput=input;if(globalThis.publicationSearchError)throw new Error('unavailable');return {evidence:globalThis.publicationEvidence,diagnostics:{viewDigest:globalThis.publicationDigest||'issued'}};} export async function searchPublishedDocumentsForAnswer(input){return {view:{digest:'issued',documents:[{embedding:{model:'pinned-model'}}]},result:await searchPublishedDocuments(input)};}`,
  '@/lib/model-config':`export function createLLM(_name,options){globalThis.publicationModelCalls++;globalThis.publicationModelOptions=options;return {async invoke(messages,invokeOptions){globalThis.publicationInvokeSignal=invokeOptions?.signal;globalThis.publicationMessages=messages;if(globalThis.publicationOnGenerate)globalThis.publicationOnGenerate();return {content:'资料说明知识库已发布。[1]',response_metadata:{done_reason:globalThis.publicationStopReason||'stop'}};}};}`,
  '@/lib/rag/citations/publication-runtime':`export async function issuePublishedAnswerCitations(){return {status:'available',items:[]};}`,
  './runtime':`export async function invokeGenerationWithDeadline(input){return input.invoke(input.signal||new AbortController().signal);}`,
};
const root=path.resolve('src');
registerHooks({resolve(s,c,next){if(mocks[s])return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(mocks[s])};
  if(s==='next/server')return next('next/server.js',c);
  if(s.startsWith('@/'))return next(pathToFileURL(path.join(root,s.slice(2)+'.ts')).href,c);
  if(s.startsWith('.')&&c.parentURL?.startsWith('file:')){const u=new URL(s+'.ts',c.parentURL);if(existsSync(fileURLToPath(u)))return next(u.href,c);}return next(s,c);}});
const {executePublishedAsk}=await import('./publication-runtime.ts');
const prepared={requestId:'request',securityContext:{tenantId:'tenant',corpusId:'corpus',actorId:'actor',role:'owner',enforceIsolation:true,accessMode:'single-tenant-token'},input:{question:'知识库如何发布？',executionMode:'sync',topK:5,llmModel:'test-model',embeddingModel:'mutable-tag'}};
const evidence={id:'chunk',tenantId:'tenant',corpusId:'corpus',documentId:'doc',documentVersion:'v1',trustLevel:'external',content:'知识库通过统一版本发布。',source:'a.txt',laneId:'document-search',retrievalScore:1,metadata:{chunkIndex:0}};
function reset(){globalThis.publicationEvidence=[evidence];globalThis.publicationDigest=undefined;globalThis.publicationSearchError=false;globalThis.publicationViewChanged=false;globalThis.publicationModelCalls=0;globalThis.publicationViewChecks=0;globalThis.publicationOnGenerate=undefined;globalThis.publicationStopReason=undefined;}

test('published generation binds its deadline signal to transport and limits output',async()=>{reset();await executePublishedAsk(new Request('http://local'),prepared);assert.equal(globalThis.publicationModelOptions.requestSignal,globalThis.publicationInvokeSignal);assert.ok(globalThis.publicationModelOptions.requestSignal instanceof AbortSignal);assert.equal(globalThis.publicationModelOptions.maxTokens,1024);});
test('published ask reuses the retrieval-issued view without a duplicate authority read', async () => {
  reset();globalThis.publicationInitialChecks=0;
  const body=await(await executePublishedAsk(new Request('http://local'),prepared)).json();
  assert.equal(globalThis.publicationInitialChecks,0);
  assert.equal(globalThis.publicationViewChecks,2,'both generation and citation fences remain');
  assert.equal(body.publicationViewDigest,'issued');
  assert.equal('view' in body,false,'the internal authorization view must not become HTTP payload');
});
test('published generation fails explicitly on output truncation',async()=>{reset();globalThis.publicationStopReason='length';await assert.rejects(executePublishedAsk(new Request('http://local'),prepared),e=>e.code==='RAG_GENERATION_OUTPUT_LIMIT');});
test('published ask uses authorized hybrid evidence and the existing grounded answer prompt',async()=>{reset();const response=await executePublishedAsk(new Request('http://local',{signal:new AbortController().signal}),prepared);const body=await response.json();assert.equal(body.success,true);assert.equal(body.evidence[0].id,'chunk');assert.equal(body.models.embedding,'pinned-model');assert.equal(globalThis.publicationSearchInput.scope.tenantId,'tenant');assert.equal(globalThis.publicationSearchInput.strategy,'hybrid');assert.equal(globalThis.publicationModelCalls,1);assert.ok(globalThis.publicationMessages.some(m=>m.content.includes(evidence.content)));assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(globalThis.publicationViewChecks,2);});
test('no evidence abstains without invoking a model',async()=>{reset();globalThis.publicationEvidence=[];const body=await(await executePublishedAsk(new Request('http://local'),prepared)).json();assert.match(body.answer,/无法回答/);assert.equal(globalThis.publicationModelCalls,0);});
test('view changes during retrieval or generation fail closed',async()=>{reset();globalThis.publicationDigest='different';await assert.rejects(executePublishedAsk(new Request('http://local'),prepared),e=>e.code==='PUBLICATION_VIEW_CHANGED');assert.equal(globalThis.publicationModelCalls,0);reset();globalThis.publicationOnGenerate=()=>{globalThis.publicationViewChanged=true;};await assert.rejects(executePublishedAsk(new Request('http://local'),prepared),/changed/);});
test('unavailable published retrieval never invokes generation and old durable tasks stay gated',async()=>{reset();globalThis.publicationSearchError=true;await assert.rejects(executePublishedAsk(new Request('http://local'),prepared),/unavailable/);assert.equal(globalThis.publicationModelCalls,0);await assert.rejects(executePublishedAsk(new Request('http://local'),{...prepared,input:{...prepared.input,executionMode:'durable'}}),e=>e.code==='PUBLICATION_READ_UNAVAILABLE');});

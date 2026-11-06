import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const modules={
  './prepared-request':`export const resolveAskRequestId=()=> 'request';export async function prepareAskRequest(){return {requestId:'request',input:{question:'知识库中企业统一发布的步骤是什么？',executionMode:'sync',llmModel:'test',embeddingModel:'mutable-tag',storageBackend:'milvus',conversationHistory:[]},securityContext:{tenantId:'tenant',corpusId:'corpus'},body:{}};}`,
  '@/lib/rag/answer-processing':`export function createDirectConversationReply(){return null;}`,
  '@/lib/rag/conversation-chat':`export async function replyToConversation(){return null;}`,
  '@/lib/rag/mixed-conversation-answer':`export function splitMixedIdentityQuestion(){return null;}`,
  '@/lib/rag/core/cancellation':`export class RagRequestAbortedError extends Error{}; export function throwIfRagRequestAborted(signal){signal?.throwIfAborted();}`,
  '@/lib/security/request-context':`export class RagSecurityError extends Error{}`,
  '@/lib/security/request-validation':`export class RequestValidationError extends Error{};export function resolveRuntimeEmbeddingProvider(){return 'ollama';}export function resolveRuntimeEmbeddingModel(){throw new Error('Published requests must use their pinned identity');}export function publicErrorPayload(){return {status:500,body:{error:{code:'ERROR',message:'error'}}};}`,
  '@/lib/security/unified-publication-write-guard':`export function getUnifiedPublicationWriteBlock(){return {code:'BLOCK',status:503,message:'legacy blocked'};}`,
  '@/lib/ollama-readiness':`export async function warmOllamaEmbeddingModel(){throw new Error('legacy embedding warmup must not execute');}`,
  './runtime':`throw new Error('legacy runtime must not load');`,
  './publication-runtime':`export async function executePublishedAsk(request,prepared){globalThis.publishedEntryCalls++;return Response.json({success:true,answer:'published',question:prepared.input.question});}`,
};
registerHooks({resolve(s,c,n){if(modules[s])return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(modules[s])};if(s==='next/server')return n('next/server.js',c);try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!s.endsWith('.ts'))return n(s+'.ts',c);throw e;}}});
const {POST}=await import('./route.ts');
test('active knowledge requests use only the published answer executor',async()=>{const before=process.env.RAG_UNIFIED_PUBLICATION_MODE;process.env.RAG_UNIFIED_PUBLICATION_MODE='active';globalThis.publishedEntryCalls=0;try{const response=await POST(new Request('http://local/api/ask',{method:'POST'}));assert.equal(response.status,200);assert.equal((await response.json()).answer,'published');assert.equal(globalThis.publishedEntryCalls,1);}finally{if(before===undefined)delete process.env.RAG_UNIFIED_PUBLICATION_MODE;else process.env.RAG_UNIFIED_PUBLICATION_MODE=before;}});

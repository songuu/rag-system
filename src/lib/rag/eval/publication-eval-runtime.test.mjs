import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(s,c,next) { try { return next(s,c); } catch(e) {
  if(e.code==='ERR_MODULE_NOT_FOUND' && s.startsWith('.') && !s.endsWith('.ts')) return next(s+'.ts',c); throw e;
} } });
const { createPublicationEvalRuntime } = await import('./publication-eval-runtime.ts');
const {observeProviderInvocation,readAskProviderUsage}=await import('../core/provider-usage-observer.ts');
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture() {
  const embeddingDigest = 'b'.repeat(64), llmDigest = 'a'.repeat(64);
  const embeddingName = 'rag-publication-' + embeddingDigest + ':latest';
  const version = '0.15.1';
  const embeddingRevision = 'sha256:' + hash(JSON.stringify({ schema:'ollama-publication/v1',
    digest:embeddingDigest,runtimeVersion:version,numCtx:8192,truncate:false }));
  const env = { RAG_UNIFIED_PUBLICATION_MODE:'active',MODEL_PROVIDER:'ollama',EMBEDDING_PROVIDER:'ollama',
    RAG_ACCESS_MODE:'single-tenant-token',RAG_DEFAULT_TENANT_ID:'t',RAG_DEFAULT_CORPUS_ID:'c',
    RAG_SINGLE_TENANT_TOKEN:'PRIVATE_TEST_TOKEN',RAG_SEMANTIC_ROUTER:'off',OLLAMA_BASE_URL:'http://127.0.0.1:11434',
    OLLAMA_NUM_CTX:'16384' };
  const view = { tenantId:'t',corpusId:'c',allowedTrustLevels:['trusted','reviewed','external'],
    digest:'sha256:'+'c'.repeat(64),documents:[{documentId:'doc',collection:'col',collectionId:'col-id',
      indexName:'idx',indexUuid:'idx-id',embedding:{model:embeddingName,revision:embeddingRevision,dimension:1024,indexSchema:'milvus-publication/v1'}}] };
  const files = { 'src/app/api/ask/route.ts':'export const route = 1;',
    'src/lib/rag/retrieval/ask-route-contract.ts':'prompt content',
    'src/lib/rag/eval/metrics.ts':'ignored eval source','src/lib/rag/core/kernel.test.mjs':'ignored test',
    'package.json':'{}','pnpm-lock.yaml':'lockfileVersion: 9' };
  let calls=0, reads=0, postCalls=0;
  const tags = {models:[{name:'model:latest',digest:llmDigest},{name:embeddingName,digest:embeddingDigest}]};
  const ports = { env:()=>env, listSourceFiles:async()=>Object.keys(files),
    readSourceFile:async name=>Buffer.from(files[name]),
    readView:async scope=>{reads++;assert.equal(scope.enforceIsolation,true);return structuredClone(view);},
    fetch:async (url,options)=>{calls++; assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
      assert.ok(options.signal instanceof AbortSignal);assert.equal(options.headers,undefined);
      if(String(url).endsWith('/api/tags'))return Response.json(tags);
      assert.ok(String(url).endsWith('/api/version'));return Response.json({version});},
    post:async request=>{postCalls++;assert.equal(request.headers.get('authorization'),'Bearer PRIVATE_TEST_TOKEN');
      assert.equal(request.constructor.name,'NextRequest'); assert.ok(request.signal instanceof AbortSignal);
      const body=await request.json();assert.equal(body.executionMode,'sync');assert.equal(body.storageBackend,'milvus');
      assert.equal(body.question,'What is policy?');assert.equal(body.corpusId,'c');
      assert.equal(body.securityContext,undefined);assert.equal(body.scope,undefined);
      return Response.json({success:true});},
  };
  const options = {projectRoot:process.cwd(),model:'model',topK:3};
  const input = {question:'What is policy?',scope:{tenantId:'t',corpusId:'c',allowedTrustLevels:['trusted','reviewed','external']},
    topK:3,similarityThreshold:0,llmModel:'model',embeddingModel:embeddingName};
  return {options,ports,env,view,files,tags,input,get calls(){return calls;},get reads(){return reads;},get postCalls(){return postCalls;}};
}

test('construction has no IO and observation binds real source, snapshot and installed model identities',async()=>{
  const f=fixture();const runtime=createPublicationEvalRuntime(f.options,f.ports);
  assert.equal(f.calls,0);assert.equal(f.reads,0);
  const config=await runtime.observeRuntime();
  assert.equal(config.model.revision,'sha256:'+'a'.repeat(64));
  assert.equal(config.model.parameters.numCtx,16384);assert.equal(config.model.parameters.temperature,0.7);
  assert.equal(config.model.parameters.maxRetries,0);assert.equal(config.model.parameters.providerVersion,'0.15.1');
  assert.equal(config.embedding.revision,f.view.documents[0].embedding.revision);
  assert.equal(config.embedding.dimensions,1024);assert.equal(config.index.revision,f.view.digest);
  assert.equal(config.retrieval.similarityThreshold,0);assert.equal(config.context.maxTokens,4000);
  assert.equal(config.cache.mode,'disabled');assert.equal(config.rerank.enabled,false);
  assert.match(config.implementationSha256,/^[a-f0-9]{64}$/);assert.equal(config.promptSha256,hash('prompt content'));
  assert.equal(JSON.stringify(config).includes('PRIVATE_TEST_TOKEN'),false);
  assert.equal(f.calls,2);
});

test('each observation rereads source, credentials, publication view and model inventory',async()=>{
  const f=fixture(), runtime=createPublicationEvalRuntime(f.options,f.ports);
  const first=await runtime.observeRuntime();
  f.files['src/lib/rag/eval/metrics.ts']='eval change'; f.files['src/lib/rag/core/kernel.test.mjs']='test change';
  assert.equal((await runtime.observeRuntime()).implementationSha256,first.implementationSha256);
  f.files['src/lib/runtime-added.ts']='new runtime';
  assert.notEqual((await runtime.observeRuntime()).implementationSha256,first.implementationSha256);
  f.env.RAG_SINGLE_TENANT_TOKEN='SECOND_PRIVATE_TOKEN';
  assert.notEqual((await runtime.observeRuntime()).model.parameters.environmentSha256,first.model.parameters.environmentSha256);
  f.view.digest='sha256:'+'d'.repeat(64);
  assert.notEqual((await runtime.observeRuntime()).index.revision,first.index.revision);
  f.tags.models[0].digest='e'.repeat(64);
  assert.notEqual((await runtime.observeRuntime()).model.revision,first.model.revision);
});

test('legacy modes, cloud providers, remote endpoints and fictitious thresholds fail before IO',async()=>{
  for(const mutate of [f=>{f.env.RAG_UNIFIED_PUBLICATION_MODE='off';},f=>{f.env.MODEL_PROVIDER='openai';},
    f=>{f.env.EMBEDDING_PROVIDER='siliconflow';},f=>{f.env.OLLAMA_BASE_URL='https://provider.example';},
    f=>{f.env.OLLAMA_BASE_URL='http://user:secret@127.0.0.1:11434';},
    f=>{f.env.OLLAMA_BASE_URL='http://127.0.0.1:11434/private';},f=>{f.options.similarityThreshold=0.5;}]) {
    const f=fixture();mutate(f);
    await assert.rejects(async()=>createPublicationEvalRuntime(f.options,f.ports).observeRuntime());
    assert.equal(f.calls,0);assert.equal(f.reads,0);
  }
});

test('unknown, mixed, missing or changed published embedding identities never pass observation',async()=>{
  for(const mutate of [f=>{f.view.documents=[];},f=>{f.view.documents.push({...structuredClone(f.view.documents[0]),documentId:'other',embedding:{...f.view.documents[0].embedding,dimension:768}});},
    f=>{f.view.documents[0].embedding.model='arbitrary-tag';},f=>{f.view.documents[0].embedding.revision='unknown';},
    f=>{f.tags.models[1].digest='f'.repeat(64);},f=>{f.tags.models.pop();},
    f=>{f.tags.models.push(structuredClone(f.tags.models[0]));},f=>{f.view.tenantId='foreign';}]) {
    const f=fixture();mutate(f);
    await assert.rejects(createPublicationEvalRuntime(f.options,f.ports).observeRuntime());assert.equal(f.postCalls,0);
  }
});

test('real authentication precedes snapshot reads and secret-bearing failures are redacted',async()=>{
  const f=fixture();f.env.RAG_EVAL_TOKEN='WRONG_PRIVATE_TOKEN';
  await assert.rejects(createPublicationEvalRuntime(f.options,f.ports).observeRuntime(),e=>
    e.message.startsWith('[publication-eval runtime]')&&!e.message.includes('PRIVATE'));
  assert.equal(f.reads,0);assert.equal(f.calls,0);
  const other=fixture();other.ports.fetch=async()=>{throw Error('PRIVATE_CONNECTION_WITH_TOKEN');};
  await assert.rejects(createPublicationEvalRuntime(other.options,other.ports).observeRuntime(),e=>!e.message.includes('PRIVATE_CONNECTION'));
});

test('invoke enters actual NextRequest POST path with authenticated headers and fixed config only',async()=>{
  const f=fixture(),runtime=createPublicationEvalRuntime(f.options,f.ports);
  assert.equal((await runtime.invokeAsk(f.input)).ok,true);assert.equal(f.postCalls,1);
  for(const mutate of [i=>{i.scope.tenantId='other';},i=>{i.scope.allowedTrustLevels=['reviewed'];},
    i=>{i.embeddingModel='other';},i=>{i.topK=9;},i=>{i.similarityThreshold=0.5;},i=>{i.llmModel='other';}]) {
    const input=structuredClone(f.input);mutate(input);await assert.rejects(runtime.invokeAsk(input));
  }
  assert.equal(f.postCalls,1);
});

test('semantic routing model digest is independently pinned when the actual entry may use it',async()=>{
  const f=fixture();delete f.env.RAG_SEMANTIC_ROUTER;f.env.FAST_LLM_MODEL='router';
  await assert.rejects(createPublicationEvalRuntime(f.options,f.ports).observeRuntime());
  f.tags.models.push({name:'router:latest',digest:'e'.repeat(64)});
  const config=await createPublicationEvalRuntime(f.options,f.ports).observeRuntime();
  assert.deepEqual(config.model.parameters.routingModel,{name:'router',revision:'sha256:'+'e'.repeat(64)});
});

test('optional evaluation judge identity is pinned without invoking its model',async()=>{
  const f=fixture();f.options.judgeModel='judge';
  await assert.rejects(createPublicationEvalRuntime(f.options,f.ports).observeRuntime());
  f.tags.models.push({name:'judge:latest',digest:'f'.repeat(64)});
  const runtime=createPublicationEvalRuntime(f.options,f.ports);
  const first=await runtime.observeRuntime();
  assert.deepEqual(first.model.parameters.evalJudge,{name:'judge',revision:'sha256:'+'f'.repeat(64)});
  f.tags.models.at(-1).digest='e'.repeat(64);
  const second=await runtime.observeRuntime();
  assert.notEqual(second.model.parameters.evalJudge.revision,first.model.parameters.evalJudge.revision);
  assert.equal(f.postCalls,0);
});

test('runtime associates actual provider observations only with the real Ask response',async()=>{
  const f=fixture(), expected=Response.json({success:true,answer:'ok'});
  f.ports.post=async()=>{
    await observeProviderInvocation('generation',async()=>({usage_metadata:{input_tokens:11,output_tokens:2}}));
    await observeProviderInvocation('embedding',async()=>Response.json({embeddings:[[1]]}));
    return expected;
  };
  const runtime=createPublicationEvalRuntime(f.options,f.ports);
  const response=await runtime.invokeAsk(f.input);
  assert.equal(response,expected);
  const usage=readAskProviderUsage(response);
  assert.deepEqual(usage.calls,{generation:1,embedding:1,rerank:0});
  assert.deepEqual(usage.tokens,{measurement:'provider',inputTokens:11,outputTokens:2});
  assert.equal(f.calls,2);
  assert.deepEqual(await response.json(),{success:true,answer:'ok'});
});

test('cancelled and noncooperative operations stop within deadline and cannot dispatch Ask',async()=>{
  const f=fixture();const abort=new AbortController();abort.abort('PRIVATE_ABORT_REASON');
  await assert.rejects(createPublicationEvalRuntime({...f.options,signal:abort.signal},f.ports).observeRuntime(),e=>!e.message.includes('PRIVATE'));
  assert.equal(f.reads,0);
  const stuck=fixture();stuck.ports.readView=async()=>new Promise(()=>{});stuck.ports.timeoutMs=10;
  await assert.rejects(createPublicationEvalRuntime(stuck.options,stuck.ports).invokeAsk(stuck.input),/deadline|timed out/);
  assert.equal(stuck.postCalls,0);
});

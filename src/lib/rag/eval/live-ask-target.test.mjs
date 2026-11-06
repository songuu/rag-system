import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(s,c,next) { try { return next(s,c); } catch(e) { if(e.code==='ERR_MODULE_NOT_FOUND' && s.startsWith('.') && !s.endsWith('.ts')) return next(s+'.ts',c); throw e; } } });
const { createLiveAskEvalTarget } = await import('./live-ask-target.ts');
const { createExperimentContract } = await import('./experiment-contract.ts');
const { captureAskProviderUsage,observeProviderInvocation }=await import('../core/provider-usage-observer.ts');
async function fixture() {
  const dataset = JSON.parse(await readFile(new URL('./fixtures/e1b-canonical-v2.json', import.meta.url)));
  dataset.cases.forEach(item => { item.tags = ['human-reviewed']; if (item.expectedAnswer) item.expectedAnswer.referenceAnswer = item.expectedAnswer.requiredFacts.map(fact => fact[0]).join(' '); }); // Synthetic input, confined to this test.
  const configuration = { implementationSha256:'a'.repeat(64), promptSha256:'b'.repeat(64),
    model:{provider:'ollama',name:'m',revision:'d1',parameters:{temperature:0.7}},
    embedding:{provider:'ollama',name:'e',revision:'d2',dimensions:1024}, index:{id:'idx',revision:'view1'},
    retrieval:{topK:3,similarityThreshold:0},rerank:{enabled:false,provider:'none',model:'none',revision:'none',topN:3},
    context:{maxTokens:4000},cache:{mode:'disabled',identity:'none'} };
  const experiment = createExperimentContract(dataset,{review:{reviewer:'synthetic-test-only',reviewedAt:'2026-01-01T00:00:00Z'},configuration});
  const doc=dataset.corpus.find(item=>item.evidenceId===dataset.cases[0].goldEvidence[0].evidenceId);
  const evidence={...doc,id:doc.evidenceId,laneId:'document-search',retrievalScore:0.9};
  const payload={success:true,answer:'v1 [1]',traceId:'test-live-1',publicationViewDigest:'view1',models:{llm:'m',embedding:'e'},evidence:[evidence],laneExecutions:[],
    retrievalDetails:{searchTime:1,llmTime:1,searchResults:[{document:{id:doc.evidenceId,content:doc.content,metadata:{source:doc.source,documentId:doc.documentId,documentVersion:doc.documentVersion}}}],contextPacking:{includedEvidenceIds:[doc.evidenceId]}}};
  return {dataset,configuration,experiment,payload,doc,input:{evalCase:{query:dataset.cases[0].query,scope:dataset.cases[0].scope},corpus:dataset.corpus,topK:3}};
}
test('calls real Ask transport with only query/scope/config and preserves missing observations',async()=>{
  const f=await fixture(); let calls=0;
  const target=createLiveAskEvalTarget({dataset:f.dataset,experiment:f.experiment,observeRuntime:async()=>f.configuration,
    invokeAsk:async input=>{calls++;assert.equal('goldEvidence' in input,false);return Response.json(f.payload);}});
  const r=await target.run(f.input);assert.equal(calls,1);assert.deepEqual(r.retrievalStages.candidates,[f.doc.evidenceId]);
  assert.equal(r.retrievalStages.reranked,undefined);assert.equal(r.usage.costMeasurement,'unavailable');
  assert.equal(r.observation.calls,'unavailable');assert.equal(r.observation.citations,'reference-only');
  assert.equal(r.citations[0].evidenceId,f.doc.evidenceId);
});
test('fails before dispatch on configuration drift and stops later dispatches',async()=>{
  const f=await fixture();let calls=0; const changed=structuredClone(f.configuration);changed.model.revision='changed';
  const target=createLiveAskEvalTarget({dataset:f.dataset,experiment:f.experiment,observeRuntime:async()=>changed,invokeAsk:async()=>{calls++;return Response.json(f.payload);}});
  await assert.rejects(target.run(f.input),/configuration/i);await assert.rejects(target.run(f.input),/halted/i);assert.equal(calls,0);
});
test('rejects corpus, model and publication drift without returning a successful measurement',async()=>{
  for(const change of [p=>{p.publicationViewDigest='changed';},p=>{p.models.llm='other';},p=>{p.evidence[0].content='altered';},p=>{p.retrievalDetails.searchResults[0].document.id='unknown';}]){
    const f=await fixture();change(f.payload);
    const target=createLiveAskEvalTarget({dataset:f.dataset,experiment:f.experiment,observeRuntime:async()=>f.configuration,invokeAsk:async()=>Response.json(f.payload)});
    await assert.rejects(target.run(f.input));
  }
});
test('response failure never leaks response body and snapshot changes after dispatch invalidate result',async()=>{
  const f=await fixture();let n=0;
  const target=createLiveAskEvalTarget({dataset:f.dataset,experiment:f.experiment,observeRuntime:async()=>n++ ? {...f.configuration,promptSha256:'c'.repeat(64)}:f.configuration,invokeAsk:async()=>Response.json(f.payload)});
  await assert.rejects(target.run(f.input),/configuration/i);
  const failed=createLiveAskEvalTarget({dataset:f.dataset,experiment:f.experiment,observeRuntime:async()=>f.configuration,invokeAsk:async()=>new Response('SECRET',{status:500})});
  await assert.rejects(failed.run(f.input), e=>/500/.test(e.message)&&!e.message.includes('SECRET'));
});
test('legitimate context prefix is retained as served text without exposing omitted evidence',async()=>{
  const f=await fixture();const prefix=f.payload.evidence[0].content.slice(0,10);
  f.payload.evidence[0].content=prefix;f.payload.evidence[0].metadata={contextTruncated:true};
  const target=createLiveAskEvalTarget({dataset:f.dataset,experiment:f.experiment,observeRuntime:async()=>f.configuration,invokeAsk:async()=>Response.json(f.payload)});
  const result=await target.run(f.input);assert.equal(result.evidence[0].content,prefix);
  assert.deepEqual(result.evidence[0].servedSpan,{startOffset:0,endOffset:10});
});
test('post-execution version checks do not inflate request latency',async()=>{
  const f=await fixture();let time=0,reads=0;
  const target=createLiveAskEvalTarget({dataset:f.dataset,experiment:f.experiment,now:()=>time,
    observeRuntime:async()=>{if(reads++)time+=1000;return f.configuration;},invokeAsk:async()=>{time+=20;return Response.json(f.payload);}});
  const result=await target.run(f.input);assert.equal(result.usage.totalLatencyMs,20);
});
test('uses request-local observed provider tokens and calls while keeping evaluation overhead separate',async()=>{
  const f=await fixture();delete f.payload.retrievalDetails.searchTime;delete f.payload.retrievalDetails.llmTime;
  const target=createLiveAskEvalTarget({dataset:f.dataset,experiment:f.experiment,observeRuntime:async()=>f.configuration,
    invokeAsk:async()=>{
      await new Promise(resolve=>setTimeout(resolve,20)); // Simulated independent preflight.
      return captureAskProviderUsage(async()=>{
        await observeProviderInvocation('generation',async()=>({usage_metadata:{input_tokens:12,output_tokens:4}}));
        return Response.json(f.payload);
      });
    }});
  const result=await target.run(f.input);
  assert.equal(result.usage.tokenMeasurement,'provider');assert.equal(result.usage.inputTokens,12);
  assert.equal(result.usage.generationCalls,1);assert.equal(result.observation.calls,'provider');
  assert.equal(result.usageObservation.calls.embedding,0);
});

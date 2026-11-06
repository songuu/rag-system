import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseLiveEvalArguments,runLiveRagEval} from './run-live-rag-eval.mjs';
test('CLI validates flags before accessing any runtime',async()=>{
  assert.throws(()=>parseLiveEvalArguments(['--top-k','-1']));
  assert.throws(()=>parseLiveEvalArguments(['--freeze','--validate-only']));
  assert.throws(()=>parseLiveEvalArguments(['--unknown']));
  assert.throws(()=>parseLiveEvalArguments(['--model','m','--model','m']));
  assert.deepEqual(await runLiveRagEval(['--help'],{loadRuntime:()=>{throw Error('must not call');}}),{help:true});
});
test('validate-only needs no infrastructure and output preflight prevents expensive dispatch',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'rag-live-cli-'));
  try {
    const dataset=JSON.parse(await readFile(new URL('../src/lib/rag/eval/fixtures/e1b-canonical-v2.json',import.meta.url)));
    const input=path.join(dir,'dataset.json'),output=path.join(dir,'existing.json');
    await writeFile(input,JSON.stringify(dataset));await writeFile(output,'preserve');let calls=0;
    await assert.rejects(runLiveRagEval(['--dataset',input,'--output',output],{loadRuntime:async()=>{calls++;}}),/exists/);
    assert.equal(calls,0);assert.equal(await readFile(output,'utf8'),'preserve');
    await assert.rejects(runLiveRagEval(['--validate-only','--dataset',input,'--contract',output],{loadRuntime:async()=>{calls++;}}));
    assert.equal(calls,0);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('freeze, validate and run exercise the complete CLI lifecycle without using real services',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'rag-live-lifecycle-'));
  try {
    const dataset=JSON.parse(await readFile(new URL('../src/lib/rag/eval/fixtures/e1b-canonical-v2.json',import.meta.url)));
    dataset.cases.forEach(item=>{item.tags=['human-reviewed'];if(item.expectedAnswer)item.expectedAnswer.referenceAnswer=item.expectedAnswer.requiredFacts.map(fact=>fact[0]).join(' ');});
    const configuration={implementationSha256:'a'.repeat(64),promptSha256:'b'.repeat(64),model:{provider:'ollama',name:'m',revision:'r1',parameters:{}},
      embedding:{provider:'ollama',name:'e',revision:'r2',dimensions:1024},index:{id:'idx',revision:'view'},retrieval:{topK:3,similarityThreshold:0},
      rerank:{enabled:false,provider:'none',model:'none',revision:'none',topN:3},context:{maxTokens:4000},cache:{mode:'disabled',identity:'none'}};
    const input=path.join(dir,'data.json'),review=path.join(dir,'review.json'),contract=path.join(dir,'contract.json'),output=path.join(dir,'run.json');
    await writeFile(input,JSON.stringify(dataset));await writeFile(review,JSON.stringify({reviewer:'synthetic-test-only',reviewedAt:'2026-01-01T00:00:00Z'}));
    const doc=dataset.corpus.find(item=>item.evidenceId===dataset.cases[0].goldEvidence[0].evidenceId);
    const payload={success:true,answer:'test [1]',traceId:'test-trace',models:{llm:'m',embedding:'e'},publicationViewDigest:'view',
      evidence:[{...doc,id:doc.evidenceId,laneId:'document-search',retrievalScore:1}],laneExecutions:[],
      retrievalDetails:{searchResults:[{document:{id:doc.evidenceId,content:doc.content,metadata:{source:doc.source,documentId:doc.documentId,documentVersion:doc.documentVersion}}}],contextPacking:{includedEvidenceIds:[doc.evidenceId]}}};
    let dispatches=0;
    const runtime={observeRuntime:async()=>configuration,invokeAsk:async()=>{dispatches++;return Response.json(payload);}};
    const deps={loadRuntime:async()=>runtime};
    const frozen=await runLiveRagEval(['--freeze','--dataset',input,'--review',review,'--model','m','--top-k','3','--output',contract],deps);
    assert.equal(frozen.frozen,true);assert.equal(dispatches,0);
    await runLiveRagEval(['--validate-only','--dataset',input,'--contract',contract],{loadRuntime:()=>{throw Error('no IO');}});
    const result=await runLiveRagEval(['--dataset',input,'--contract',contract,'--output',output],deps);
    assert.equal(result.failed,0);assert.equal(dispatches,dataset.cases.length);
    const report=JSON.parse(await readFile(output,'utf8'));assert.match(report.configuration.evaluatorImplementationSha256,/^[a-f0-9]{64}$/);
    let reads=0;
    const driftRuntime={...runtime,observeRuntime:async()=>reads++>=2*dataset.cases.length ? {...configuration,promptSha256:'c'.repeat(64)}:configuration};
    await assert.rejects(runLiveRagEval(['--dataset',input,'--contract',contract,'--output',path.join(dir,'invalid.json')],{loadRuntime:async()=>driftRuntime}),/changed during assessment/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

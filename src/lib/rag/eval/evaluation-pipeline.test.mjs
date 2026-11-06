import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(s,c,next) { try { return next(s,c); } catch(e) { if(e.code==='ERR_MODULE_NOT_FOUND' && s.startsWith('.') && !s.endsWith('.ts')) return next(s+'.ts',c); throw e; } } });
const { runRagEval } = await import('./runner.ts');
const { createRagEvalDatasetHash,parseRagEvalDataset } = await import('./dataset.ts');
const { parseRagEvalArtifact,compareRagEvalReports } = await import('./report-presentation.ts');
function fixture() {
  const dataset={schemaVersion:'rag-eval-dataset/v1',datasetId:'stage-test',datasetVersion:'1',corpus:[{evidenceId:'a',documentId:'d',source:'a',content:'退款期限30天'}],
    cases:[{id:'q',query:'退款期限？',tags:[],goldEvidence:[{evidenceId:'a',relevance:3,spans:[{startOffset:0,endOffset:7}]}],requiredEvidenceGroups:[['a']],expectedAbstain:false,expectedAnswer:{requiredFacts:[['30天']]}}]};
  const result={answer:'退款期限不是30天，而是60天。',abstained:false,evidence:[{...dataset.corpus[0],score:1}],citations:[{evidenceId:'a',startOffset:0,endOffset:7}],
    usage:{retrievalLatencyMs:1,generationLatencyMs:2,totalLatencyMs:3,embeddingCalls:0,generationCalls:0,tokenMeasurement:'unavailable',costMeasurement:'unavailable'},
    retrievalStages:{candidates:['a'],context:['a']},observation:{citations:'reference-only',calls:'unavailable',disposition:'unavailable'},
    usageObservation:{tokens:{measurement:'unavailable'},calls:{},latencyMs:{total:3,retrieval:1,generation:2}}};
  return {dataset,result,target:{id:'fixture-pipeline',run:async()=>result}};
}
test('runner retains independent stage and quality assessment through report import',async()=>{
  const f=fixture(); const sidecar={schemaVersion:'rag-eval-quality/v1',datasetSha256:createRagEvalDatasetHash(parseRagEvalDataset(f.dataset)),cases:{q:{facts:[{id:'refund',label:'退款期限',kind:'number',expected:30,unit:'天'}]}}};
  const report=await runRagEval(f.dataset,f.target,{topK:3,assessment:{sidecar}});
  assert.equal(report.cases[0].retrievalStages.context.requiredEvidenceComplete,true);
  assert.equal(report.cases[0].retrievalStages.reranked,null);
  assert.equal(report.cases[0].quality.structuredFacts[0].status,'incorrect');
  assert.equal(report.cases[0].citations.coverage,null);
  const imported=parseRagEvalArtifact(JSON.stringify(report)).reports[0];
  assert.deepEqual(imported.cases[0].retrievalStages,report.cases[0].retrievalStages);
  assert.deepEqual(imported.cases[0].quality,report.cases[0].quality);
  assert.deepEqual(imported.cases[0].usageObservation,report.cases[0].usageObservation);
  assert.equal(imported.summary.calls.generationTotal,null);
  assert.equal(imported.summary.measurements.calls.generation.value,null);
});
test('new stage metrics appear in paired comparisons while assessment changes block gains',async()=>{
  const f=fixture();const base=await runRagEval(f.dataset,f.target,{topK:3,evaluatorImplementationSha256:'a'.repeat(64)});
  const candidate=structuredClone(base);candidate.runId='candidate';candidate.cases[0].retrievalStages.candidates.ndcgAtK=0.5;
  const comparison=compareRagEvalReports(base,candidate);
  assert.equal(comparison.metrics.find(item=>item.id==='candidates-ndcg').delta,-0.5);
  candidate.configuration.evaluatorImplementationSha256='b'.repeat(64);
  assert.ok(compareRagEvalReports(base,candidate).issues.some(issue=>issue.includes('评测器')));
  candidate.configuration=structuredClone(base.configuration);
  candidate.configuration.assessment={annotationsSha256:'c'.repeat(64),contextSha256:'d'.repeat(64),judge:null};
  assert.ok(compareRagEvalReports(base,candidate).issues.some(issue=>issue.includes('评分标注')));
});
test('unobserved abstention never becomes a zero in paired metrics',async()=>{
  const f=fixture();f.result.observation.disposition='structured';
  const base=await runRagEval(f.dataset,f.target,{topK:3,evaluatorImplementationSha256:'a'.repeat(64)});
  const candidate=structuredClone(base);candidate.runId='candidate';candidate.cases[0].answerMetrics.abstainCorrect=null;
  const metric=compareRagEvalReports(base,candidate).metrics.find(item=>item.id==='abstain');
  assert.equal(metric.delta,null);assert.match(metric.note,/覆盖/);
});
test('wrong sidecar binding fails before a target call; stages cannot cite unknown evidence',async()=>{
  const f=fixture();let calls=0;f.target.run=async()=>{calls++;return f.result;};
  await assert.rejects(runRagEval(f.dataset,f.target,{assessment:{sidecar:{schemaVersion:'rag-eval-quality/v1',datasetSha256:'0'.repeat(64),cases:{}}}}));
  assert.equal(calls,0);f.result.retrievalStages.candidates=['unknown'];
  const report=await runRagEval(f.dataset,f.target);assert.equal(report.cases[0].status,'failed');
});
test('invalid pricing and contradictory sidecar decisions fail before any expensive target call',async()=>{
  const f=fixture();let calls=0;f.target.run=async()=>{calls++;return f.result;};
  await assert.rejects(runRagEval(f.dataset,f.target,{usagePricing:{inputUsdPerMillion:-1,outputUsdPerMillion:1,version:'p1'}}));
  await assert.rejects(runRagEval(f.dataset,f.target,{assessment:{sidecar:{schemaVersion:'rag-eval-quality/v1',
    datasetSha256:createRagEvalDatasetHash(parseRagEvalDataset(f.dataset)),cases:{q:{expectedDisposition:'abstain'}}}}}));
  assert.equal(calls,0);
});

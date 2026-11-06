import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
const virtual='file:///mirofish-context-dependencies.mjs';
registerHooks({resolve(specifier,context,next){
 if(context.parentURL?.endsWith('/report-context.ts')&&['./simulation-runner','./request-scope','./project-graph'].includes(specifier))return{url:virtual,shortCircuit:true};
 try{return next(specifier,context);}catch(error){if(error?.code==='ERR_MODULE_NOT_FOUND'&&specifier.startsWith('.')&&!specifier.endsWith('.ts'))return next(specifier+'.ts',context);throw error;}
},load(url,context,next){if(url===virtual)return{format:'module',source:'export const loadSimulationSnapshot=(...args)=>globalThis.__contextFixture.snapshot(...args);export const getScopedMiroFishProjectStore=(scope)=>({get:(id)=>globalThis.__contextFixture.project(id,scope)});export const loadAuthorizedProjectGraph=(...args)=>globalThis.__contextFixture.graph(...args);',shortCircuit:true};return next(url,context);}});
const {loadMiroFishReportContext,reportContextIdentity}=await import('./report-context.ts');
const scope={tenantId:'tenant-a',corpusId:'corpus-a'};
const identity={...scope,documentId:'graph-a',documentVersion:'v1',trustLevel:'external',graphGeneration:'gen-a'};
const publicIdentity={documentId:'graph-a',documentVersion:'v1',trustLevel:'external',graphGeneration:'gen-a'};
function fixture(bound=publicIdentity){globalThis.__contextFixture={async snapshot(id,received){assert.deepEqual(received,scope);return{info:{project_id:'project-a',simulation_id:id,current_round:1,status:'completed'},sourceGraphIdentity:bound,posts:[],timeline:[],projection:{enabled:true,status:'complete',runId:'run-a',committedEventSequence:2}};},async project(id,received){assert.equal(id,'project-a');assert.deepEqual(received,scope);return{id,graph_id:'graph-a',graph_identity:publicIdentity,simulation_requirement:'policy'};},async graph(project,received){assert.deepEqual(received,scope);return{identity,authority:'rev1',graph:{graph_id:'graph-a',nodes:[],edges:[]}};}};}
test('context accepts scoped native public identity and rejects mismatched or revoked source',async()=>{
 try{
 fixture();const context=await loadMiroFishReportContext('sim-a',scope);assert.equal(context.graph.graph_id,'graph-a');assert.equal(context.identity.tenantId,'tenant-a');
 const second=structuredClone(context);second.snapshot.projection.runId='run-b';assert.notEqual(reportContextIdentity(context),reportContextIdentity(second));
 for(const changed of [{documentVersion:'v2'},{graphGeneration:'wrong'},{tenantId:'foreign'},{corpusId:'foreign'}]){fixture({...publicIdentity,...changed});await assert.rejects(loadMiroFishReportContext('sim-a',scope),error=>error.code==='MIROFISH_REPORT_SOURCE_CHANGED');}
 fixture();globalThis.__contextFixture.graph=async()=>null;await assert.rejects(loadMiroFishReportContext('sim-a',scope),error=>error.code==='MIROFISH_REPORT_SOURCE_UNAVAILABLE');
 fixture(null);await assert.rejects(loadMiroFishReportContext('sim-a',scope),error=>error.code==='MIROFISH_REPORT_SOURCE_UNBOUND');
 }finally{delete globalThis.__contextFixture;}
});
test('historical run selects its durable source even after current project graph changes or resets',async()=>{
 try {
  for(const current of [{graph_id:'graph-new',graph_identity:{...publicIdentity,documentId:'graph-new',documentVersion:'new'}},{}]) {
   fixture();globalThis.__contextFixture.project=async()=>({id:'project-a',simulation_requirement:'policy',...current});
   globalThis.__contextFixture.graph=async(selector,received)=>{assert.deepEqual(received,scope);assert.equal(selector.graph_id,'graph-a');assert.deepEqual(selector.graph_identity,publicIdentity);return{identity,authority:'rev1',graph:{graph_id:'graph-a',nodes:[],edges:[]}};};
   const context=await loadMiroFishReportContext('sim-a',scope);assert.equal(context.graph.graph_id,'graph-a');
  }
  fixture();const base=globalThis.__contextFixture.snapshot;globalThis.__contextFixture.snapshot=async(...args)=>({...await base(...args),scenario:{requirement:'original frozen scenario'}});
  globalThis.__contextFixture.project=async()=>({id:'project-a',graph_id:'graph-new',simulation_requirement:'new scenario'});
  assert.equal((await loadMiroFishReportContext('sim-a',scope)).requirement,'original frozen scenario');
 }finally{delete globalThis.__contextFixture;}
});

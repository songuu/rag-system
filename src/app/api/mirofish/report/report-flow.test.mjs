import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import test, { after } from 'node:test';
registerHooks({resolve(specifier,context,next){
 if(specifier==='next/server')return next('next/server.js',context);
 if(specifier.startsWith('@/'))return next(pathToFileURL(path.resolve('src',specifier.slice(2)+'.ts')).href,context);
 try{return next(specifier,context);}catch(error){if(error?.code==='ERR_MODULE_NOT_FOUND'&&specifier.startsWith('.')&&!specifier.endsWith('.ts'))return next(specifier+'.ts',context);throw error;}
}});
const {MiroFishReportRuntime}=await import('../../../../lib/mirofish/report-runtime.ts');
const {MiroFishInteractionRuntime}=await import('../../../../lib/mirofish/interaction-runtime.ts');
const {NextRequest}=await import('next/server');
const factoryUrls={report:'file:///mirofish-report-test-factory.mjs',interview:'file:///mirofish-interview-test-factory.mjs'};
registerHooks({resolve(specifier,context,next){
 if(specifier==='@/lib/mirofish/report-runtime')return {url:factoryUrls.report,shortCircuit:true};
 if(specifier==='@/lib/mirofish/interaction-runtime')return {url:factoryUrls.interview,shortCircuit:true};return next(specifier,context);
},load(url,context,next){
 if(url===factoryUrls.report)return {format:'module',source:'export const getMiroFishReportRuntime=(scope,override)=>globalThis.__reportRouteFactory(scope,override)',shortCircuit:true};
 if(url===factoryUrls.interview)return {format:'module',source:'export const getMiroFishInteractionRuntime=(scope,override)=>globalThis.__interviewRouteFactory(scope,override)',shortCircuit:true};return next(url,context);
}});
const collection=await import('./route.ts');const detail=await import('./[id]/route.ts');
const chat=await import('../interaction/chat/route.ts');const interview=await import('../interaction/interview/route.ts');
const keys=['RAG_ACCESS_MODE','RAG_SINGLE_TENANT_TOKEN','RAG_SINGLE_TENANT_ROLE','RAG_SINGLE_TENANT_ACTOR_ID','RAG_DEFAULT_TENANT_ID','RAG_DEFAULT_CORPUS_ID'];
const old=new Map(keys.map(key=>[key,process.env[key]]));
function configure(role='owner'){Object.assign(process.env,{RAG_ACCESS_MODE:'single-tenant-token',RAG_SINGLE_TENANT_TOKEN:'test-token',RAG_SINGLE_TENANT_ROLE:role,RAG_SINGLE_TENANT_ACTOR_ID:'actor-a',RAG_DEFAULT_TENANT_ID:'tenant-a',RAG_DEFAULT_CORPUS_ID:'corpus-a'});}
after(()=>{for(const[key,value]of old){if(value===undefined)delete process.env[key];else process.env[key]=value;}delete globalThis.__reportRouteFactory;delete globalThis.__interviewRouteFactory;});
function storage(){const data=new Map();return{async read(k,id){return structuredClone(data.get(k+id)??null)},async write(k,id,v){data.set(k+id,structuredClone(v))},async list(k){return [...data].filter(([key])=>key.startsWith(k)).map(([,v])=>structuredClone(v))},async delete(k,id){return data.delete(k+id)}};}
const profiles=['Alice','Bob'].map(name=>({entity_id:name,entity_name:name,full_name:name,entity_type:'PERSON',background:'policy participant',personality_traits:[],viewpoints:{},speaking_style:'plain'}));
const context={projectId:'project-a',requirement:'policy',authority:'rev1',identity:{tenantId:'tenant-a',corpusId:'corpus-a',documentId:'graph-a',documentVersion:'v1',trustLevel:'external'},graph:{graph_id:'graph-a',node_count:2,edge_count:1,nodes:profiles.map(p=>({uuid:p.entity_id,name:p.entity_name,labels:['PERSON'],summary:'policy participant',attributes:{}})),edges:[{uuid:'edge-a',name:'SUPPORTS',fact:'Alice supports policy',source_node_uuid:'Alice',target_node_uuid:'Bob',source_node_name:'Alice',target_node_name:'Bob',attributes:{}}]},snapshot:{info:{simulation_id:'sim-a',project_id:'project-a',status:'completed',current_round:1,config:{platforms:['twitter','reddit']},agent_profiles:profiles},posts:[],timeline:[],memory:{Alice:{observations:['Alice remembers policy'],recentActionIds:[]}}}};
const output=value=>({text:JSON.stringify(value),stopReason:'stop',usage:{measurement:'unavailable'}});
function setup(){configure();let turn=0;let modelCalls=0;const store=storage();const scopes=[];
 const model={async complete(request){modelCalls++;if(request.operation.endsWith('outline'))return output({title:'Policy report',summary:'Evidence',sections:[{title:'Analysis',type:'overview'}]});if(request.operation==='mirofish.interaction.interview-memory')return output({answer:'I remember the policy',sentiment:'positive',confidence:.8,platform_answers:{twitter:'Policy answer'}});if(request.operation.includes('section'))return ++turn<=3?output({action:'tool',name:'quick_search',parameters:{query:'policy'}}):output({action:'final',content:'Alice supports policy.'});return output({action:'final',content:'According to the report.'});}};
 const report=new MiroFishReportRuntime({store,loadContext:async()=>context,model});const actor=new MiroFishInteractionRuntime({store,loadSnapshot:async()=>context.snapshot,model});
 globalThis.__reportRouteFactory=scope=>{scopes.push(scope);return report;};globalThis.__interviewRouteFactory=scope=>{scopes.push(scope);return actor;};
 return {report,actor,scopes,get modelCalls(){return modelCalls}};
}
function request(suffix='',body,auth=true){return new NextRequest('http://localhost/api/mirofish/'+suffix,{method:body===undefined?'GET':'POST',headers:{...(auth?{Authorization:'Bearer test-token'}:{}),'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});}
test('report routes run persisted pipeline, restore by simulation, expose incremental logs and gate download',async()=>{
 const state=setup();const started=await collection.POST(request('report',{simulation_id:'sim-a',project_id:'project-a'}));assert.equal(started.status,200);const {report_id}=await started.json();await state.report.wait(report_id);
 const params={params:Promise.resolve({id:report_id})};const response=await detail.GET(request('report/'+report_id),params);const data=await response.json();assert.equal(data.report.status,'completed');assert.equal(data.report.sections.length,1);
 assert(state.scopes.every(value=>value.tenantId==='tenant-a'&&value.corpusId==='corpus-a'));
 const restored=await collection.GET(request('report?action=by-simulation&simulation_id=sim-a'));assert.equal((await restored.json()).report_id,report_id);
 const log=await detail.GET(request('report/'+report_id+'?action=agent-log&from_line=2'),params);const logs=await log.json();assert(logs.logs.every(event=>event.sequence>2));assert(logs.logs.some(event=>event.action==='tool_result'));
 const download=await detail.GET(request('report/'+report_id+'?action=download'),params);assert.match(await download.text(),/Alice supports policy/);
 const invalid=await detail.GET(request('report/'+report_id+'?action=section&index=-1'),params);assert.equal(invalid.status,400);
 const answer=await chat.POST(request('interaction/chat',{report_id,question:'What happened?'}));assert.equal(answer.status,200);assert((await answer.json()).sources.some(source=>source.kind==='report'));
 const history=await chat.GET(request('interaction/chat?report_id='+report_id));assert.equal((await history.json()).messages.length,2);
});
test('request routes reject unauthorized writes, endpoint overrides, and oversized inputs before model work',async()=>{
 const state=setup();configure('viewer');assert.equal((await collection.POST(request('report',{simulation_id:'sim-a'}))).status,403);
 assert.equal((await collection.GET(request('report',undefined,false))).status,401);configure();
 const invalid=await chat.POST(request('interaction/chat',{report_id:'rpt-a',question:'x',modelOverride:{provider:'custom',modelName:'x',baseUrl:'http://private/'}}));assert.equal(invalid.status,400);assert.equal((await invalid.json()).code,'MIROFISH_HTTP_MODEL_OVERRIDE_FORBIDDEN');
 const large=await interview.POST(request('interaction/interview',{simulation_id:'sim-a',agent_id:'Alice',question:'x'.repeat(70000)}));assert.equal(large.status,413);assert.equal(state.modelCalls,0);
});
test('single, subset and questionnaire interviews use actual agent memory and retain individual history',async()=>{
 const state=setup();
 const single=await interview.POST(request('interaction/interview',{simulation_id:'sim-a',agent_id:'Alice',question:'What do you remember?'}));assert.equal(single.status,200);assert.equal((await single.json()).response.agent_id,'Alice');
 const subset=await interview.POST(request('interaction/interview',{simulation_id:'sim-a',agent_ids:['Bob'],question:'What changed?'}));assert.deepEqual((await subset.json()).responses.map(value=>value.agent_id),['Bob']);
 const questionnaire=await interview.POST(request('interaction/interview',{simulation_id:'sim-a',interviews:[{agent_id:'Alice',prompt:'Explain policy'},{agent_id:'Bob',prompt:'Your view?'}]}));assert.equal((await questionnaire.json()).responses.length,2);
 const history=await interview.GET(request('interaction/interview?action=history&simulation_id=sim-a&agent_id=Alice'));const retained=await history.json();assert.equal(retained.messages.length,4);assert.equal(retained.responses[0].platform_answers.twitter,'Policy answer');
 const before=state.modelCalls;const invalid=await interview.POST(request('interaction/interview',{simulation_id:'sim-a',interviews:[{agent_id:'Alice',prompt:'Valid'},{agent_id:'unknown',prompt:'Invalid'}]}));assert.equal(invalid.status,404);assert.equal(state.modelCalls,before);
});
test('report collection cannot disclose title or summary after the evidence epoch changes',async()=>{
 const state=setup();const started=await collection.POST(request('report',{simulation_id:'sim-a'}));const {report_id}=await started.json();await state.report.wait(report_id);
 try {context.authority='revoked';const response=await collection.GET(request('report'));assert.equal(response.status,200);const payload=await response.json();assert.deepEqual(payload.reports,[]);assert.doesNotMatch(JSON.stringify(payload),/Policy report|Alice supports policy/);}
 finally{context.authority='rev1';}
});

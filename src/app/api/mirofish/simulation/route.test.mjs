import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import test from 'node:test';
const virtual='file:///mirofish-simulation-api-fixtures.mjs';
const mocks=new Set(['request-scope','simulation-runner','project-graph','simulation-preparation','runtime-store','simulation-api-response','model-override']);
registerHooks({resolve(specifier,context,next){
 if(specifier.startsWith('@/lib/mirofish/')&&mocks.has(specifier.split('/').at(-1)))return {url:virtual,shortCircuit:true};
 if(specifier==='next/server')return next('next/server.js',context);
 if(specifier.startsWith('@/'))return next(pathToFileURL(path.resolve('src',specifier.slice(2)+'.ts')).href,context);
 try{return next(specifier,context);}catch(error){if(error.code==='ERR_MODULE_NOT_FOUND'&&specifier.startsWith('.')&&!specifier.endsWith('.ts'))return next(specifier+'.ts',context);throw error;}
},load(url,context,next){if(url===virtual)return {format:'module',shortCircuit:true,source:`
 const f=()=>globalThis.__simulationApiFixture;
 export const resolveMiroFishRequestScope=(request,capability)=>f().resolve(request,capability);
 export const getScopedMiroFishProjectStore=scope=>({get:id=>f().project(id,scope),update:async()=>({})});
 export const loadAuthorizedProjectGraph=(...args)=>f().source(...args);
 export const getSimulationRunner=scope=>{f().runnerScope=scope;return f().runner;};
 export const isSimulationSnapshotSourceAuthorized=(...args)=>f().visible(...args);
 export const getMiroFishRuntimeStore=scope=>({list:async()=>f().reports});
 export const startSimulationPreparation=(input,dependencies)=>f().prepare(input,dependencies);
 export const readSimulationPreparation=async()=>null;
 export const validateHttpModelOverride=value=>value;
 export const validatePersistedModelOverride=value=>value;
 export const getHttpModelOverrideErrorResponse=()=>null;
 export const simulationApiError=(error)=>Response.json({success:false,code:error.message},{status:error.status||409});
 `};return next(url,context);}});
const management=await import('./route.ts');const detail=await import('./[id]/route.ts');const preparation=await import('./prepare/route.ts');
const scope={tenantId:'tenant-a',corpusId:'corpus-a'};
const identity={...scope,documentId:'graph-a',documentVersion:'v1',trustLevel:'external',graphGeneration:'generation-a'};
const profile={entity_id:'agent-a',entity_name:'Alice',full_name:'Alice',entity_type:'Person',personality_traits:[],viewpoints:{},typical_posts:[],background:'facts',speaking_style:'brief',social_media_style:'brief',generated_at:'2026-11-05'};
function fixture(){const project={id:'project-a',graph_id:'graph-a',prepare_id:'prepare-a',agent_profiles:[profile],simulation_config:{round_count:2}};const snapshot={schemaVersion:1,engine:'local-native',sourceGraphIdentity:identity,info:{simulation_id:'sim-a',project_id:project.id,status:'completed',config:{round_count:2},agent_profiles:[profile]},posts:[],actions:[],timeline:[],memory:{},projection:{enabled:false,status:'idle',committedEventSequence:0,projectedEventSequence:0}};
 const f={reports:[],async resolve(_request,capability){f.capability=capability;return {scope};},async project(id,received){assert.equal(id,project.id);assert.deepEqual(received,scope);return project;},async source(){return {identity,authority:'revision-a',graph:{graph_id:'graph-a',nodes:[{uuid:'agent-a',name:'Alice',labels:['Person'],summary:'facts',attributes:{}}],edges:[]}};},async visible(){return true;},runner:{async ensureLoaded(){return true;},getSnapshot(){return snapshot;},get(){return snapshot.info;},async listPersisted(){return [snapshot];},getPosts(){return [];},async launch(){return {...snapshot.info,status:'running'};},async create(config,profiles,_model,received){f.created={config,profiles,received};return {...snapshot.info,config};}},async prepare(input,dependencies){f.prepared={input,dependencies};return {id:'prepjob-a',status:'processing'};},snapshot,storedProject:project};globalThis.__simulationApiFixture=f;return f;}
const request=(url,body)=>new Request('http://localhost/api/mirofish/simulation'+url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
const params={params:Promise.resolve({id:'sim-a'})};
test('simulation create pins authorized source UUIDs, respects edited config and uses request scope',async()=>{const f=fixture();const response=await management.POST(request('',{project_id:'project-a',prepare_id:'prepare-a',config:{round_count:7},profiles:[profile]}));assert.equal(response.status,200);assert.equal(f.capability,'ingest');assert.deepEqual(f.runnerScope,scope);assert.equal(f.created.config.round_count,7);assert.deepEqual(f.created.received,identity);
 const denied=await management.POST(request('',{project_id:'project-a',profiles:[{...profile,entity_id:'foreign-agent'}]}));assert.equal(denied.status,409);});
test('snapshot/export reads fail closed for revoked sources and missing scoped snapshots',async()=>{const f=fixture();f.visible=async()=>false;assert.equal((await detail.GET(request('/sim-a?action=snapshot'),params)).status,409);f.runner.ensureLoaded=async()=>false;assert.equal((await detail.GET(request('/sim-a?action=snapshot'),params)).status,404);});
test('simulation create upgrades saved legacy name IDs against the authorized graph and keeps policy references',async()=>{const f=fixture();f.storedProject.agent_profiles=[{...profile,entity_id:'Alice'}];const response=await management.POST(request('',{project_id:'project-a',prepare_id:'prepare-a',config:{round_count:3,policy:{agents:{Alice:{activity_level:.5}},events:[{id:'opening',round:0,agent_id:'Alice',content:'keep',topics:[]}]}}}));assert.equal(response.status,200);assert.equal(f.created.profiles[0].entity_id,'agent-a');assert.equal(f.created.profiles[0].background,profile.background);assert.equal(f.created.config.policy.events[0].agent_id,'agent-a');assert.equal(f.created.config.policy.agents['agent-a'].activity_level,.5);assert.equal(f.created.config.round_count,3);});
test('legacy names cannot select between different authorized graph UUIDs with the same name',async()=>{const f=fixture();f.storedProject.agent_profiles=[{...profile,entity_id:'Alice'}];const source=await f.source();source.graph.nodes.push({...source.graph.nodes[0],uuid:'agent-b'});f.source=async()=>source;const response=await management.POST(request('',{project_id:'project-a',prepare_id:'prepare-a'}));assert.equal(response.status,409);assert.equal(f.created,undefined);});
test('start reports admission errors and never claims a rejected worker started',async()=>{const f=fixture();f.runner.launch=async()=>{throw new Error('SIMULATION_ALREADY_RUNNING');};const response=await detail.POST(request('/sim-a',{action:'start'}),params);assert.equal(response.status,409);assert.equal((await response.json()).code,'SIMULATION_ALREADY_RUNNING');});
test('history joins reports by both simulation and project, with latest completed first',async()=>{const f=fixture();f.reports=[{report_id:'r-other',project_id:'other',simulation_id:'sim-a',status:'completed',updated_at:'z'},{report_id:'r-new',project_id:'project-a',simulation_id:'sim-a',status:'generating',updated_at:'z'},{report_id:'r-complete',project_id:'project-a',simulation_id:'sim-a',status:'completed',updated_at:'a'}];const response=await management.GET(request('?projectId=project-a'));const payload=await response.json();assert.equal(payload.simulations[0].report_id,'r-complete');assert.deepEqual(payload.simulations[0].report_ids,['r-complete','r-new']);});
test('asynchronous preparation ignores client graph nodes and exposes a persisted task consumer',async()=>{const f=fixture();const response=await preparation.POST(request('/prepare',{project_id:'project-a',graphNodes:[{uuid:'forged-node'}],selectedEntityIds:['agent-a'],async:true,autoConfig:true,language:'en'}));assert.equal(response.status,202);assert.equal((await response.json()).taskId,'prepjob-a');assert.deepEqual(f.prepared.input.graphNodes.map(node=>node.uuid),['agent-a']);assert.deepEqual(f.prepared.dependencies.sourceGraphIdentity,identity);assert.equal(f.prepared.dependencies.language,'en');});
test('platform profile download is a real attachment from the authorized snapshot',async()=>{fixture();const response=await detail.GET(request('/sim-a?action=export&format=twitter-csv'),params);assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/twitter-csv-sim-a.csv/);assert.match(await response.text(),/user_id.*name.*username.*user_char.*description/);});

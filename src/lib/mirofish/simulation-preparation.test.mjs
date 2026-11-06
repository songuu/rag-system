import assert from 'node:assert/strict';import {registerHooks} from 'node:module';import test from 'node:test';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!s.endsWith('.ts'))return n(`${s}.ts`,c);throw e;}}});
const {startSimulationPreparation,readSimulationPreparation}=await import('./simulation-preparation.ts');
const {MemoryMiroFishRuntimeStore}=await import('./runtime-store.ts');
test('asynchronous preparation persists stage progress, final result and project before completion',async()=>{
 const scope={tenantId:'prepare-test',corpusId:'test'};const store=new MemoryMiroFishRuntimeStore(scope);const writes=[];
 const project={id:'project',simulation_requirement:'scenario',texts:[],status:'created',current_step:0};
 const input={project,graphNodes:[{uuid:'uuid-one',name:'Alice',labels:['Person'],summary:'facts',attributes:{}}]};
 const profile={entity_id:'uuid-one',entity_name:'Alice',entity_type:'Person',background:'facts'};
 const job=await startSimulationPreparation(input,{scope,store,projectStore:{async update(id,patch){writes.push({id,patch});return {...project,...patch};}},serviceDependencies:{async generateProfiles(){return [profile];}}});
 assert.equal(job.status,'processing');let completed;
 for(let i=0;i<50;i++){completed=await readSimulationPreparation(job.id,{scope,store});if(completed.status!=='processing')break;await new Promise(r=>setImmediate(r));}
 assert.equal(completed.status,'completed');assert.equal(completed.result.profiles[0].entity_id,'uuid-one');assert.equal(writes.length,2);assert.equal(writes[0].patch.prepare_task_id,job.id);assert.equal(writes[1].patch.prepare_id,completed.result.prepare_id);
});
test('failure to durably register the project task never launches an unreachable preparation worker',async()=>{const scope={tenantId:'prepare-register-failure',corpusId:'test'};const store=new MemoryMiroFishRuntimeStore(scope);let calls=0;await assert.rejects(startSimulationPreparation({project:{id:'project-b',texts:[],simulation_requirement:'test'},graphNodes:[{uuid:'agent-b',name:'Bob',labels:['Person']}]},{scope,store,projectStore:{async update(){throw new Error('write failed');}},serviceDependencies:{async generateProfiles(){calls++;return [];}}}),/write failed/);assert.equal(calls,0);const jobs=await store.list('prepare',{projectId:'project-b'});assert.equal(jobs[0].status,'failed');assert.equal(jobs[0].errorCode,'PREPARE_REGISTRATION_FAILED');});

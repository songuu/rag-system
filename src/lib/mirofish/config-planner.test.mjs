import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';
registerHooks({resolve(specifier,context,next){try{return next(specifier,context);}catch(error){if(error.code==='ERR_MODULE_NOT_FOUND'&&specifier.startsWith('.')&&!specifier.endsWith('.ts'))return next(`${specifier}.ts`,context);throw error;}}});
const {planSimulationConfiguration}=await import('./config-planner.ts');
test('scenario planner binds generated seeds and activity to real graph agent UUIDs',async()=>{
 const config=await planSimulationConfiguration({requirement:'policy reaction',profiles:[{entity_id:'uuid-one',entity_name:'Alice',entity_type:'Person',background:'Participant'}]}, {invoke:async()=>JSON.stringify({seed_topics:['policy'],policy:{agents:{'uuid-one':{active_hours:[9],activity_level:.2}},events:[{id:'seed',round:0,agent_id:'uuid-one',content:'A fictional initial statement',topics:['policy']}]}})});
 assert.deepEqual(config.seed_topics,['policy']);assert.equal(config.policy.agents['uuid-one'].activity_level,.2);assert.equal(config.policy.events[0].agent_id,'uuid-one');
});
test('planner rejects invented agent references instead of silently remapping authors',async()=>{
 await assert.rejects(planSimulationConfiguration({requirement:'scenario',profiles:[{entity_id:'uuid-one',entity_name:'Alice',entity_type:'Person',background:''}]},{invoke:async()=>JSON.stringify({policy:{events:[{id:'seed',agent_id:'invented',content:'content'}]}})}),/UNKNOWN_AGENT/);
});

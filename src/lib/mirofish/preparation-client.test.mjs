import assert from 'node:assert/strict';import test from 'node:test';
const {adoptPreparationTask}=await import('./preparation-client.ts');
test('a running preparation remains reachable when parent persistence fails',async()=>{let taskId,failed=false;await adoptPreparationTask('prepjob-a',{onTask:id=>taskId=id,async persist(id){assert.equal(taskId,id);throw new Error('temporary save failure');},onPersistenceError(){failed=true;}});assert.equal(taskId,'prepjob-a');assert.equal(failed,true);});

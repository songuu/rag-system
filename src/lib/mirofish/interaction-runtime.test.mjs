import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const { MiroFishInteractionRuntime } = await import('./interaction-runtime.ts');
const snapshot = { info: { simulation_id: 'sim-a', project_id: 'project-a', status: 'completed', config: { platforms: ['twitter', 'reddit'] },
  agent_profiles: ['Alice', 'Bob'].map(name => ({ entity_id: name, entity_name: name, full_name: name, entity_type: 'PERSON',
    background: 'participant', personality_traits: [], viewpoints: {}, speaking_style: 'plain' })) },
  posts: [{ id: 'post-a', author_id: 'Alice', author_name: 'Alice', platform: 'twitter', content: 'I promised to help Bob' }], timeline: [],
  memory: { Alice: { observations: ['Alice promised to help Bob'], recentActionIds: ['action-a'] } },
  actions: [{ agentId: 'Alice', id: 'action-a', type: 'reply', content: 'help Bob' }],
};
function store() { const data = new Map(); return {
  async read(kind, id) { return structuredClone(data.get(`${kind}:${id}`) ?? null); }, async write(kind, id, value) { data.set(`${kind}:${id}`, structuredClone(value)); },
  async list() { return [...data.values()]; }, async delete(kind, id) { return data.delete(`${kind}:${id}`); },
}; }
test('real interview runtime carries actor memory, actions and persistent history without mixing actors', async () => {
  const requests = [];
  const storage = store();
  const client = { async complete(request) {
    requests.push(request);
    return { text: JSON.stringify({ answer: `Answer ${requests.length}`, sentiment: 'positive', confidence: 0.8,
      platform_answers: { twitter: 'Twitter answer', reddit: 'Reddit answer', fake: 'must not escape' } }), stopReason: 'stop', usage: { measurement: 'unavailable' } };
  } };
  const make = () => new MiroFishInteractionRuntime({ store: storage, loadSnapshot: async () => snapshot, model: client });
  await make().askMany({ simulationId: 'sim-a', agentIds: ['Alice'], question: 'What did you promise?' });
  await make().askMany({ simulationId: 'sim-a', agentIds: ['Alice'], question: 'Can you explain the previous answer?' });
  const retained = await make().history('sim-a', 'Alice');
  assert(retained.messages.at(-1).sources.some(source => source.kind === 'memory' && source.id === 'Alice'));
  const [bob] = await make().askMany({ simulationId: 'sim-a', agentIds: ['Bob'], question: 'What happened?' });
  assert.match(requests[0].messages[0].content, /Alice promised to help Bob/);
  assert.match(requests[0].messages[0].content, /action-a/);
  assert(requests[1].messages.some(message => message.content === 'Answer 1'));
  assert(!requests[2].messages.some(message => message.content === 'Answer 1'));
  assert(!requests[2].messages[0].content.includes('Alice promised'));
  assert.deepEqual(Object.keys(bob.platform_answers).sort(), ['reddit', 'twitter']);
  assert.equal((await make().history('sim-a', 'Alice')).messages.length, 4);
  assert.equal(await make().history('sim-a', 'Alice', 'different-user'), null);
});
test('subset interviews validate every actor before invoking the model and are bounded', async () => {
  let calls = 0;
  const runtime = new MiroFishInteractionRuntime({ store: store(), loadSnapshot: async () => snapshot,
    model: { async complete() { calls++; throw new Error('should not run'); } } });
  await assert.rejects(runtime.askMany({ simulationId: 'sim-a', agentIds: ['Alice', 'foreign'], question: 'question' }), error => error.status === 404);
  await assert.rejects(runtime.askMany({ simulationId: 'sim-a', agentIds: [], question: 'question' }), error => error.status === 400);
  assert.equal(calls, 0);
});
test('explicit simulation restart isolates the same agent conversation from the prior run', async () => {
 const storage=store();let current={...structuredClone(snapshot),projection:{enabled:false,status:'idle',runId:'first'}};const requests=[];
 const runtime=new MiroFishInteractionRuntime({store:storage,loadSnapshot:async()=>current,model:{async complete(request){requests.push(request);return {text:JSON.stringify({answer:'Only this run',sentiment:'neutral',confidence:.5}),stopReason:'stop',usage:{measurement:'unavailable'}};}}});
 await runtime.askMany({simulationId:'sim-a',agentIds:['Alice'],question:'First run question'});
 assert.equal((await runtime.history('sim-a','Alice')).messages.length,2);
 current={...current,projection:{enabled:false,status:'idle',runId:'second'}};
 assert.equal(await runtime.history('sim-a','Alice'),null);
 await runtime.askMany({simulationId:'sim-a',agentIds:['Alice'],question:'New run question'});
 assert(!requests[1].messages.some(message=>message.content==='First run question'));
 assert.equal((await runtime.history('sim-a','Alice')).messages.length,2);
});

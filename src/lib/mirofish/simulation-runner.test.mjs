import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) { try { return next(specifier, context); } catch (error) {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context); throw error;
} } });
const { SimulationRunner } = await import('./simulation-runner.ts');
const { MemoryMiroFishRuntimeStore } = await import('./runtime-store.ts');
const { buildSimulationConfig } = await import('./config-normalizer.ts');
const profile = { entity_id: 'agent-a', entity_name: 'Alice', entity_type: 'Person', full_name: 'Alice', personality_traits: [], typical_posts: [], viewpoints: {}, background: '', speaking_style: '', social_media_style: '', generated_at: '2026-11-05T08:00:00Z' };
function fixture(name, dependencies = {}) {
  const scope = { tenantId: `runner-${name}`, corpusId: 'test' };
  const store = new MemoryMiroFishRuntimeStore(scope);
  const rounds = [];
  const createEngine = () => ({ async executeRound(_profiles, config, round) { rounds.push(round); return [{ id: `post-${round}`, simulation_id: config.simulation_id, platform: 'twitter', round, author_id: profile.entity_id, author_name: 'Alice', author_type: 'Person', action: 'post', content: `round ${round}`, likes: 0, replies_count: 0, reposts: 0, sentiment: 'neutral', topics: ['policy'], timestamp: new Date().toISOString() }]; } });
  const runner = new SimulationRunner({ store, scope, createEngine, ...dependencies });
  const config = buildSimulationConfig({ round_count: 3, time_interval: 0 }, { projectId: 'project', simulationId: `sim-${name}`, profileCount: 1 });
  return { runner, store, rounds, config, scope, createEngine };
}
test('completed snapshots and history survive a fresh runner without credentials', async () => {
  const f = fixture('restore');
  await f.runner.create(f.config, [profile], { provider: 'ollama', modelName: 'test', apiKey: 'never-store', baseUrl: 'http://private.invalid' });
  await f.runner.start(f.config.simulation_id);
  const saved = await f.store.read('simulation', f.config.simulation_id);
  assert.equal(saved.info.status, 'completed'); assert.equal(saved.actions.length, 3);
  assert.equal(saved.memory['agent-a'].recentActionIds.length, 3);
  assert.doesNotMatch(JSON.stringify(saved), /never-store|private.invalid|apiKey|baseUrl/);
  const second = new SimulationRunner({ store: f.store, scope: f.scope, createEngine: f.createEngine });
  assert.equal(await second.ensureLoaded(f.config.simulation_id), true);
  assert.equal(second.getSnapshot(f.config.simulation_id).posts.length, 3);
  assert.equal((await second.listPersisted('project')).length, 1);
});
test('interrupted running state restores paused and resumes after the committed round', async () => {
  const f = fixture('resume'); await f.runner.create(f.config, [profile]);
  const saved = await f.store.read('simulation', f.config.simulation_id);
  saved.info.status = 'running'; saved.info.current_round = 1;
  await f.store.write('simulation', f.config.simulation_id, saved);
  const second = new SimulationRunner({ store: f.store, scope: f.scope, createEngine: f.createEngine });
  await second.ensureLoaded(f.config.simulation_id);
  assert.equal(second.get(f.config.simulation_id).status, 'paused');
  await second.start(f.config.simulation_id, 'resume');
  assert.deepEqual(f.rounds, [2,3]);
});
test('completion waits for optional graph memory projection and persists its cursor', async () => {
  let release; let began;
  const pending = new Promise(resolve => { began = resolve; });
  const f = fixture('barrier', { memoryPort: { async project(_scope, _id, events) { if (events.at(-1).sequence === 3) { began(); await new Promise(resolve => { release = resolve; }); } return events.at(-1).sequence; } } });
  f.config.policy.graph_memory_enabled = true;
  await f.runner.create(f.config, [profile]);
  const running = f.runner.start(f.config.simulation_id);
  await pending;
  assert.equal(f.runner.get(f.config.simulation_id).status, 'finalizing');
  release(); await running;
  const snapshot = f.runner.getSnapshot(f.config.simulation_id);
  assert.equal(snapshot.projection.status, 'complete');
  assert.equal(snapshot.projection.projectedEventSequence, 3);
  assert.equal(snapshot.info.status, 'completed');
});
test('multi-instance execution is refused before a native run starts', async () => {
  const f = fixture('multi'); await f.runner.create(f.config, [profile]);
  const previous = process.env.RAG_MIROFISH_SIMULATION_MULTI_INSTANCE;
  process.env.RAG_MIROFISH_SIMULATION_MULTI_INSTANCE = 'true';
  try { await assert.rejects(f.runner.start(f.config.simulation_id), /MULTI_INSTANCE/); }
  finally { if (previous === undefined) delete process.env.RAG_MIROFISH_SIMULATION_MULTI_INSTANCE; else process.env.RAG_MIROFISH_SIMULATION_MULTI_INSTANCE = previous; }
  assert.equal(f.rounds.length, 0);
});
test('source revocation between generation and commit rejects the round and its graph projection',async()=>{
 let calls=0;const f=fixture('revoked',{validateSource:async()=>++calls<3});await f.runner.create(f.config,[profile]);
 await f.runner.start(f.config.simulation_id);const snapshot=f.runner.getSnapshot(f.config.simulation_id);
 assert.equal(snapshot.info.status,'failed');assert.equal(snapshot.info.current_round,0);assert.equal(snapshot.actions.length,0);assert.equal(snapshot.projection.committedEventSequence,0);
});
test('restart uses a new isolated graph memory run namespace',async()=>{
 const namespaces=[];const f=fixture('restart',{memoryPort:{async project(_scope,_id,events,runId){namespaces.push(runId);return events.at(-1).sequence;}}});f.config.policy.graph_memory_enabled=true;
 await f.runner.create(f.config,[profile]);await f.runner.start(f.config.simulation_id);const first=f.runner.getSnapshot(f.config.simulation_id).projection.runId;
 await f.runner.start(f.config.simulation_id,'restart');const second=f.runner.getSnapshot(f.config.simulation_id).projection.runId;
 assert.notEqual(first,second);assert.ok(namespaces.includes(first));assert.ok(namespaces.includes(second));assert.equal(f.runner.getSnapshot(f.config.simulation_id).actions.length,3);
});
test('manual stop drains graph memory to a terminal cursor and preserves report-ready results',async()=>{
 let began;const waiting=new Promise(resolve=>began=resolve);
 const f=fixture('stop',{createEngine:()=>({async executeRound(_profiles,config,round,_posts,{signal}){if(round===1)return [{id:'first',simulation_id:config.simulation_id,platform:'twitter',round,author_id:profile.entity_id,author_name:'Alice',author_type:'Person',action:'post',content:'first',likes:0,replies_count:0,reposts:0,sentiment:'neutral',topics:[],timestamp:new Date().toISOString()}];began();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}}),memoryPort:{async project(_scope,_id,events){return events.at(-1).sequence;}}});
 f.config.policy.graph_memory_enabled=true;await f.runner.create(f.config,[profile]);const run=f.runner.start(f.config.simulation_id);await waiting;await f.runner.stop(f.config.simulation_id);await run;
 const snapshot=f.runner.getSnapshot(f.config.simulation_id);assert.equal(snapshot.info.status,'stopped');assert.equal(snapshot.info.current_round,1);assert.equal(snapshot.projection.status,'complete');assert.equal(snapshot.projection.projectedEventSequence,snapshot.projection.committedEventSequence);
});
test('stop requested while finalizing cannot be overwritten by completed',async()=>{
 let began,release;const waiting=new Promise(resolve=>began=resolve);const f=fixture('stop-finalizing',{memoryPort:{async project(_scope,_id,events){if(events.at(-1).sequence===3){began();await new Promise(resolve=>release=resolve);}return events.at(-1).sequence;}}});
 f.config.policy.graph_memory_enabled=true;await f.runner.create(f.config,[profile]);const run=f.runner.start(f.config.simulation_id);await waiting;assert.equal(f.runner.get(f.config.simulation_id).status,'finalizing');const stopped=f.runner.stop(f.config.simulation_id);release();await stopped;await run;assert.equal(f.runner.get(f.config.simulation_id).status,'stopped');assert.equal(f.runner.getSnapshot(f.config.simulation_id).projection.status,'complete');
});
test('run scenario and source filenames are immutable even when the project input later changes',async()=>{const f=fixture('scenario');const scenario={requirement:'original requirement',seedFiles:[{filename:'original.md',size:10}]};await f.runner.create(f.config,[profile],undefined,undefined,scenario);scenario.requirement='changed';scenario.seedFiles[0].filename='changed.md';const saved=await f.store.read('simulation',f.config.simulation_id);assert.equal(saved.scenario.requirement,'original requirement');assert.equal(saved.scenario.seedFiles[0].filename,'original.md');});

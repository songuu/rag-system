import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const { MiroFishReportRuntime } = await import('./report-runtime.ts');
const { ReportTools } = await import('./report-tools.ts');
const context = {
  projectId: 'project-a', requirement: '政策变化会如何影响讨论', authority: 'source-revision-1',
  identity: { tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'graph-a', documentVersion: 'v1', trustLevel: 'external' },
  graph: { graph_id: 'graph-a', node_count: 2, edge_count: 2,
    nodes: ['Alice', 'Bob'].map(name => ({ uuid: name, name, labels: ['PERSON'], summary: `${name} discusses policy`, attributes: {} })),
    edges: [{ uuid: 'current', name: 'SUPPORTS', fact: 'Alice supports policy', source_node_uuid: 'Alice', target_node_uuid: 'Bob', source_node_name: 'Alice', target_node_name: 'Bob', attributes: {}, episodes: [] },
      { uuid: 'historical', name: 'OPPOSES', fact: 'Bob opposed policy before the change', source_node_uuid: 'Bob', target_node_uuid: 'Alice', source_node_name: 'Bob', target_node_name: 'Alice', invalid_at: '2026-01-01', attributes: {}, episodes: [] }],
  },
  snapshot: { info: { simulation_id: 'sim-a', project_id: 'project-a', status: 'completed', current_round: 1,
      config: { platforms: ['twitter', 'reddit'], seed_topics: ['policy'] },
      agent_profiles: ['Alice', 'Bob'].map(name => ({ entity_id: name, entity_name: name, entity_type: 'PERSON', full_name: name, background: 'policy participant', personality_traits: [], viewpoints: {}, speaking_style: 'plain' })) },
    posts: [{ id: 'post-a', author_id: 'Alice', author_name: 'Alice', platform: 'twitter', content: 'I support the policy', sentiment: 'positive', topics: ['policy'], action: 'post' }],
    timeline: [], memory: { Alice: { observations: ['Alice promised to explain policy to Bob'], recentActionIds: ['action-a'] } },
    actions: [{ agentId: 'Alice', id: 'action-a', content: 'explained policy', platform: 'twitter' }],
    projection: { enabled: true, status: 'complete' },
  },
};
function memoryStore() {
  const values = new Map();
  return { async read(kind, id) { return structuredClone(values.get(`${kind}:${id}`) ?? null); },
    async write(kind, id, value) { values.set(`${kind}:${id}`, structuredClone(value)); },
    async list(kind) { return [...values].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => structuredClone(value)); },
    async delete(kind, id) { return values.delete(`${kind}:${id}`); } };
}
const result = text => ({ text: JSON.stringify(text), stopReason: 'stop', usage: { measurement: 'unavailable' } });
function model() {
  let turns = 0;
  return { async complete(request) {
    if (request.operation.endsWith('.outline')) return result({ title: 'Policy forecast', summary: 'Based on the simulation', sections: [{ title: 'Participants', type: 'overview' }] });
    if (request.operation.includes('subqueries')) return result({ queries: ['policy', 'Alice'] });
    if (request.operation.includes('section')) {
      const toolNames = ['quick_search', 'panorama_search', 'insight_forge'];
      return turns++ < 3 ? result({ action: 'tool', name: toolNames[turns - 1], parameters: { query: 'policy' } })
        : result({ action: 'final', content: 'Alice supports policy, while Bob previously opposed it.' });
    }
    return result({ action: 'final', content: 'The source is the recorded policy discussion.' });
  } };
}
test('real report runtime plans, executes graph tools, persists sections/events, and survives a new runtime', async () => {
  const store = memoryStore();
  const runtime = new MiroFishReportRuntime({ store, loadContext: async () => structuredClone(context), model: model() });
  const started = await runtime.start({ simulationId: 'sim-a', projectId: 'project-a' });
  await runtime.wait(started.report_id);
  const restored = new MiroFishReportRuntime({ store, loadContext: async () => structuredClone(context), model: model() });
  const report = await restored.get(started.report_id);
  assert.equal(report.status, 'completed');
  assert.equal(report.outline.title, 'Policy forecast');
  assert.match(report.markdown_content, /Alice supports policy/);
  assert.equal(report.events.filter(event => event.action === 'tool_result').length, 3);
  assert(report.events.some(event => event.details?.result?.sources.some(source => source.id === 'current')));
  assert.equal((await restored.start({ simulationId: 'sim-a' })).report_id, report.report_id, 'completed reports are reused unless force is explicit');
});
test('panorama preserves temporal facts and graph tools cap results without inventing sources', async () => {
  const tools = new ReportTools({ context, model: model(), assertCurrent: async () => {} });
  const result = await tools.execute('panorama_search', { query: 'policy', include_expired: true });
  assert.equal(result.data.active_facts.length, 1);
  assert.equal(result.data.historical_facts.length, 1);
  assert(result.sources.every(source => ['current', 'historical', 'action-a', 'post-a'].includes(source.id)));
  assert.equal(result.data.evidence_scopes.simulation_timeline, 'recorded_simulation_actions');
  assert.equal(result.data.simulation_timeline[0].id, 'action-a');
  await assert.rejects(tools.execute('quick_search', { query: 'x'.repeat(2001) }), error => error.status === 400);
});
test('running simulations and uncommitted graph projection cannot start a report', async () => {
  for (const change of [value => { value.snapshot.info.status = 'running'; }, value => { value.snapshot.projection.status = 'pending'; }]) {
    const invalid = structuredClone(context); change(invalid);
    const runtime = new MiroFishReportRuntime({ store: memoryStore(), loadContext: async () => invalid, model: model() });
    await assert.rejects(runtime.start({ simulationId: 'sim-a' }), error => error.code === 'MIROFISH_REPORT_SIMULATION_NOT_READY');
  }
});
test('provider failures are durable failed states and never expose provider secrets', async () => {
  const runtime = new MiroFishReportRuntime({ store: memoryStore(), loadContext: async () => context,
    model: { async complete() { throw new Error('private input api_key=sk-secret'); } } });
  const started = await runtime.start({ simulationId: 'sim-a' });
  await runtime.wait(started.report_id);
  const failed = await runtime.get(started.report_id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.recoverable, true);
  assert.doesNotMatch(JSON.stringify(failed), /sk-secret|private input/);
});

test('report chat executes real tools, persists provenance, serializes actor history and rejects changed evidence', async () => {
  const storage = memoryStore();
  let current = structuredClone(context);
  const initial = new MiroFishReportRuntime({ store: storage, loadContext: async () => current, model: model() });
  const started = await initial.start({ simulationId: 'sim-a' });
  await initial.wait(started.report_id);
  let calls = 0; const prompts = [];
  const chat = new MiroFishReportRuntime({ store: storage, loadContext: async () => current,
    model: { async complete(request) { prompts.push(request); const turn = calls++ % 3; return turn < 2 ? result({ action: 'tool', name: turn === 0 ? 'quick_search' : 'panorama_search', parameters: { query: 'policy' } })
      : result({ action: 'final', content: 'Alice supports the policy.' }); } } });
  const answers = await Promise.all([chat.chat(started.report_id, 'Who supports policy?', 'actor-a'), chat.chat(started.report_id, 'Explain again', 'actor-a')]);
  assert.equal(answers[0].tool_calls[0].name, 'quick_search');
  assert(answers[0].sources.some(source => source.id === 'current'));
  const history = await chat.history(started.report_id, 'actor-a');
  assert.equal(history.length, 4);
  assert(history[1].sources.some(source => source.id === 'current'));
  assert.deepEqual(history[1].sources, answers[0].sources, 'persisted provenance must exactly match the deduplicated chat response');
  assert(prompts[3].messages.some(message => message.content === 'Who supports policy?'));
  assert.equal((await chat.history(started.report_id, 'actor-b')).length, 0);
  current.authority = 'revoked-and-replaced';
  await assert.rejects(chat.getAuthorized(started.report_id), error => error.code === 'MIROFISH_REPORT_SOURCE_CHANGED');
  await assert.rejects(chat.chat(started.report_id, 'Try stale evidence'), error => error.code === 'MIROFISH_REPORT_SOURCE_CHANGED');
});
test('partially completed chapters resume without rewriting prior evidence', async () => {
  const storage = memoryStore(); let phase = 0; let tool = 0;
  const client = { async complete(request) {
    if (request.operation.endsWith('outline')) return result({ title: 'Two chapters', summary: 'evidence', sections: [{ title: 'First', type: 'overview' }, { title: 'Second', type: 'prediction' }] });
    if (phase === 0 && tool >= 4) throw new Error('provider unavailable secret');
    return tool++ % 4 < 3 ? result({ action: 'tool', name: 'quick_search', parameters: { query: 'policy' } }) : result({ action: 'final', content: phase === 0 ? 'First retained chapter' : 'Second recovered chapter' });
  } };
  const runtime = new MiroFishReportRuntime({ store: storage, loadContext: async () => context, model: client });
  const started = await runtime.start({ simulationId: 'sim-a' }); await runtime.wait(started.report_id);
  const failed = await runtime.get(started.report_id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.sections.length, 1);
  phase = 1; tool = 0;
  await runtime.start({ simulationId: 'sim-a', resumeReportId: started.report_id }); await runtime.wait(started.report_id);
  const resumed = await runtime.get(started.report_id);
  assert.equal(resumed.status, 'completed'); assert.equal(resumed.sections.length, 2);
  assert.equal(resumed.sections[0].content, 'First retained chapter');
  assert.equal(resumed.sections[1].content, 'Second recovered chapter');
});
test('fake observations cannot become a successful empty chapter and tool loops remain bounded', async () => {
  let calls = 0;
  const client = { async complete(request) {
    calls++;
    return request.operation.endsWith('outline') ? result({ title: 'Report', summary: 'summary', sections: [{ title: 'Chapter', type: 'overview' }] })
      : result({ action: 'final', content: '<observation>fabricated content</observation>' });
  } };
  const runtime = new MiroFishReportRuntime({ store: memoryStore(), loadContext: async () => context, model: client });
  const started = await runtime.start({ simulationId: 'sim-a' }); await runtime.wait(started.report_id);
  const failed = await runtime.get(started.report_id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.sections.length, 0);
  assert.equal(calls, 7);
});
test('real interview tool selects actual profiles, preserves quotes and produces a synthesis', async () => {
  const observed = [];
  const tool = new ReportTools({ context, assertCurrent: async () => {}, interview: async (ids, question) => {
    observed.push({ ids, question });
    return ids.map(id => ({ agent_id: id, agent_name: id, answer: 'My actual recorded opinion', platform_answers: { twitter: 'I support policy' } }));
  }, model: { async complete(request) { return request.operation.endsWith('interview-plan')
    ? result({ agent_ids: ['invented', 'Alice'], questions: ['What changed?'], reasoning: 'Relevant participant' }) : result({ summary: 'Alice supports policy based on her recorded account.' }); } } });
  const answer = await tool.execute('interview_agents', { interview_topic: 'policy', max_agents: 2 });
  assert.deepEqual(observed[0].ids, ['Alice']);
  assert.match(observed[0].question, /What changed/);
  assert.equal(answer.data.interviews[0].key_quotes[0], 'My actual recorded opinion');
  assert.match(answer.data.interview_summary, /Alice supports/);
  assert.equal(answer.sources[0].id, 'Alice');
});

test('report registration revalidates source inside the shared project reset lock', async () => {
 const {withMiroFishProjectLock}=await import('./project-lifecycle.ts');
 const storage=memoryStore();let release;let entered;const held=new Promise(resolve=>{release=resolve});const acquired=new Promise(resolve=>{entered=resolve});let reset=false;
 const blocker=withMiroFishProjectLock({tenantId:'tenant-a',corpusId:'corpus-a'},'project-a',async()=>{entered();await held;reset=true;});await acquired;
 const runtime=new MiroFishReportRuntime({store:storage,loadContext:async()=>{if(reset)throw new Error('source cleared by reset');return context;},model:model()});
 const starting=runtime.start({simulationId:'sim-a'});
 await new Promise(resolve=>setTimeout(resolve,0));assert.equal((await storage.list('report')).length,0);
 release();await blocker;await assert.rejects(starting,/source cleared by reset/);assert.equal((await storage.list('report')).length,0);
});
test('a restart orphan is immediately recoverable and cannot block new work as a fake active task',async()=>{
 const storage=memoryStore();const runtime=new MiroFishReportRuntime({store:storage,loadContext:async()=>context,model:model()});const started=await runtime.start({simulationId:'sim-a'});await runtime.wait(started.report_id);
 const stored=await runtime.get(started.report_id);stored.status='generating';stored.stage='generating';stored.updated_at=new Date().toISOString();await storage.write('report',started.report_id,stored);
 const fresh=new MiroFishReportRuntime({store:storage,loadContext:async()=>context,model:model()});const recovered=await fresh.get(started.report_id);assert.equal(recovered.status,'failed');assert.equal(recovered.error_code,'MIROFISH_REPORT_INTERRUPTED');assert.equal(recovered.recoverable,true);
});
test('a stale report does not hide valid reports from a later simulation epoch',async()=>{
 const storage=memoryStore();let current=structuredClone(context);const runtime=new MiroFishReportRuntime({store:storage,loadContext:async()=>current,model:model()});
 const started=await runtime.start({simulationId:'sim-a'});await runtime.wait(started.report_id);const old=await runtime.get(started.report_id);
 current.projection={};current.authority='later-run';const next={...old,report_id:'report-later',source_authority:(await import('./report-context.ts')).reportContextIdentity(current),created_at:new Date().toISOString()};await storage.write('report',next.report_id,next);
 assert.deepEqual((await runtime.listAuthorized()).map(value=>value.report_id),['report-later']);
 await assert.rejects(runtime.getAuthorized(old.report_id),error=>error.code==='MIROFISH_REPORT_SOURCE_CHANGED');
});
test('wrapped provider admission failures keep actionable stable codes without leaking causes',async()=>{
 const {TextModelError}=await import('../models/text-model.ts');
 for(const [causeCode,expected] of [['PROVIDER_QUEUE_TIMEOUT','MIROFISH_REPORT_MODEL_QUEUE_TIMEOUT'],['PROVIDER_QUEUE_FULL','MIROFISH_REPORT_MODEL_BUSY'],['ETIMEDOUT','MIROFISH_REPORT_MODEL_TIMEOUT']]){
  const cause=Object.assign(new Error('api_key=sk-private raw model prompt'),{code:causeCode});const runtime=new MiroFishReportRuntime({store:memoryStore(),loadContext:async()=>context,model:{async complete(){throw new TextModelError('MODEL_INVOCATION_FAILED','mirofish.report.section',{cause});}}});
  const started=await runtime.start({simulationId:'sim-a'});await runtime.wait(started.report_id);const failed=await runtime.get(started.report_id);assert.equal(failed.error_code,expected);assert.doesNotMatch(JSON.stringify(failed),/sk-private|raw model prompt|api_key/);
 }
});

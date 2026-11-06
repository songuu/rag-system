import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { loadMiroFishWorkspace } = await import('./workspace-client.ts');
const json = body => new Response(JSON.stringify({ success: true, ...body }), { headers: { 'content-type': 'application/json' } });
const graph = { graph_id: 'graph-current', nodes: [], edges: [], node_count: 0, edge_count: 0 };
const currentIdentity = { documentId: 'graph-current', documentVersion: 'version-a', trustLevel: 'external' };
const project = { id: 'project-a', status: 'graph_built', current_step: 1, texts: [], graph_id: graph.graph_id, graph_data: graph,
  simulation_id: 'sim-current', report_id: 'report-current', agent_profiles: [] };

test('workspace uses the selected historical run without overwriting the project current run', async () => {
  const calls = [];
  const fetchMock = async url => {
    calls.push(url);
    if (url.includes('/project/')) return json({ project });
    if (url.includes('/graph?')) return json({ graph });
    return json({ snapshot: { info: { simulation_id: 'sim-old', config: { project_id: 'project-a' }, status: 'completed', agent_profiles: [{ entity_id: 'historical-agent' }] }, sourceGraphIdentity: currentIdentity,
      scenario: { requirement: 'Original scenario', seedFiles: [{ filename: 'original.md', size: 10 }] }, posts: [], timeline: [] } });
  };
  const result = await loadMiroFishWorkspace('project-a', { simulationId: 'sim-old', step: 3 }, fetchMock);
  assert.equal(result.simulationId, 'sim-old');
  assert.equal(result.reportId, null);
  assert.equal(result.project.simulation_id, 'sim-current');
  assert.equal(result.profiles[0].entity_id, 'historical-agent');
  assert.equal(result.project.simulation_requirement, 'Original scenario');
  assert.equal(result.project.seed_files[0].filename, 'original.md');
  assert.equal(result.currentStep, 3);
  assert(calls.every(url => !url.includes('report-current')));
  const initial = await loadMiroFishWorkspace('project-a', { simulationId: 'sim-old', step: 0 }, fetchMock);
  assert.equal(initial.currentStep, 2, 'historical links cannot mount editable graph/preparation stages');
});

test('workspace reauthorizes cached graph state and recovers its exact legacy identity', async () => {
  const result = await loadMiroFishWorkspace('project-a', {}, async url => url.includes('/project/')
    ? json({ project: { ...project, simulation_id: null, report_id: null } })
    : json({ graph, documentVersion: 'current-version', trustLevel: 'external', graphGeneration: 'generation-a' }));
  assert.equal(result.graphIdentity.documentVersion, 'current-version');
  await assert.rejects(loadMiroFishWorkspace('project-a', {}, async url => url.includes('/project/')
    ? json({ project: { ...project, simulation_id: null, report_id: null } })
    : new Response(JSON.stringify({ success: false, error: '来源已撤销' }), { status: 409 })), /撤销/);
});

test('report deep links resolve their own run and source graph identity', async () => {
  let graphRequest;
  const identity = { documentId: 'graph-old', documentVersion: 'old-version', trustLevel: 'external', graphGeneration: 'old-generation' };
  const result = await loadMiroFishWorkspace('project-a', { reportId: 'report-old', step: 4 }, async url => {
    if (url.includes('/project/')) return json({ project });
    if (url.includes('/report/')) return json({ report: { report_id: 'report-old', simulation_id: 'sim-old', status: 'completed' } });
    if (url.includes('/simulation/')) return json({ snapshot: { info: { simulation_id: 'sim-old', config: { project_id: 'project-a' }, status: 'completed', agent_profiles: [] }, sourceGraphIdentity: identity } });
    graphRequest = new URL(url, 'http://localhost');
    return json({ graph: { ...graph, graph_id: 'graph-old' } });
  });
  assert.equal(result.simulationId, 'sim-old');
  assert.equal(result.currentStep, 4);
  assert.equal(result.graphData.graph_id, 'graph-old');
  assert.equal(graphRequest.searchParams.get('documentVersion'), 'old-version');
  assert.equal(graphRequest.searchParams.get('graphGeneration'), 'old-generation');
});

test('workspace refuses foreign runs and report/run mismatches before attaching their content', async () => {
  await assert.rejects(loadMiroFishWorkspace('project-a', { simulationId: 'foreign', step: 2 }, async url => url.includes('/project/')
    ? json({ project }) : json({ snapshot: { info: { simulation_id: 'foreign', config: { project_id: 'project-b' }, status: 'completed' } } })), /项目/);
  await assert.rejects(loadMiroFishWorkspace('project-a', { simulationId: 'sim-a', reportId: 'report-b' }, async url => url.includes('/project/')
    ? json({ project }) : json({ report: { report_id: 'report-b', simulation_id: 'sim-b', status: 'completed' } })), /运行/);
});

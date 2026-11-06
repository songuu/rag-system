import assert from 'node:assert/strict';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
const lib = pathToFileURL(path.resolve('src/lib')).href;
const fakeSources = new Map([
  [`${lib}/mirofish/standalone-graph-runtime.ts`, `
    export const usesDurableStandaloneGraphBuilds=()=>true;
    export async function enqueueStandaloneGraphBuild(input,scope,previous){globalThis.__durableRoute.inputs.push({input,scope,previous});return globalThis.__durableRoute.taskId;}
    export async function readStandaloneGraphTask(id,scope){globalThis.__durableRoute.reads.push({id,scope});return scope.corpusId==='foreign'?null:globalThis.__durableRoute.status;}
  `],
  [`${lib}/mirofish/standalone-graph-worker.ts`, `export function wakeStandaloneGraphBuild(id,scope){if(globalThis.__durableRoute.project.graph_task_id!==id)throw Error('woke before project save');globalThis.__durableRoute.wakes.push({id,scope});}`],
  [`${lib}/mirofish/request-scope.ts`, `export function getScopedMiroFishProjectStore(){return {get:async()=>globalThis.__durableRoute.project,update:async(id,patch)=>Object.assign(globalThis.__durableRoute.project,patch)}}`],
  [`${lib}/mirofish/graph-artifact-runtime.ts`, `export function getMiroFishGraphArtifactRuntime(){return {backend:'neo4j',trustLevel:'external',store:{coordination:'shared',gcExpired:async()=>0}}}`],
  [`${lib}/mirofish/graph-builder.ts`, `export class MiroFishGraphOntologyValidationError extends Error{}; export const normalizeMiroFishGraphOntology=x=>x; export const createPublicGraphProjection=x=>x;
    export class MiroFishGraphBuilder{async buildGraphAsync(_body,_p,_m,id){globalThis.__durableRoute.nativeBuilds++;return id;}}`],
  [`${lib}/security/request-context.ts`, `export class RagSecurityError extends Error{}; export async function resolveRagSecurityContext(request){return {tenantId:'tenant-test',corpusId:request.headers.get('x-rag-corpus-id')||'corpus-test',actorId:'owner',role:'owner',enforceIsolation:true,requestId:'durable-route-test'}}`],
]);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/server') return next('next/server.js', context);
    if (specifier.startsWith('@/')) return next(pathToFileURL(path.resolve('src', `${specifier.slice(2)}.ts`)).href, context);
    try { return next(specifier, context); } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
      throw error;
    }
  },
  load(url, context, next) { return fakeSources.has(url) ? { format: 'module', shortCircuit: true, source: fakeSources.get(url) } : next(url, context); },
});
const { GET, POST } = await import('./route.ts');
function fixture() {
  const taskId = 'task_44444444-4444-4444-8444-444444444444';
  return globalThis.__durableRoute = { taskId, status: { success: true, status: 'processing', progress: 55, message: '恢复中' },
    inputs: [], reads: [], wakes: [], nativeBuilds: 0,
    project: { id: 'proj_11111111-1111-4111-8111-111111111111', graph_task_id: taskId } };
}
test('status restores a scoped durable task after the process-local task manager was lost', async () => {
  const f = fixture();
  const response = await GET(new Request(`http://localhost/rag-api/mirofish/graph?action=status&taskId=${f.taskId}`));
  assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.status, 'processing'); assert.equal(body.progress, 55);
  assert.equal(f.wakes.length, 1); assert.equal(f.reads[0].scope.corpusId, 'corpus-test');
});
test('durable fallback never reveals a foreign corpus task', async () => {
  const f = fixture();
  const response = await GET(new Request(`http://localhost/rag-api/mirofish/graph?action=status&taskId=${f.taskId}`, { headers: { 'x-rag-corpus-id': 'foreign' } }));
  assert.equal(response.status, 404); assert.equal(f.wakes.length, 0);
});
test('project graph submission saves the durable job before waking its worker and never starts an ephemeral copy', async () => {
  const f = fixture(); f.project.graph_task_id = null;
  const response = await POST(new Request('http://localhost/rag-api/mirofish/graph', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: f.project.id, text: 'Alice works at Example.', ontology: { entity_types: [], edge_types: [] }, chunkSize: 600, chunkOverlap: 50 }) }));
  assert.equal(response.status, 200); const body = await response.json();
  assert.equal(body.taskId, f.taskId); assert.equal(f.project.graph_task_id, f.taskId);
  assert.equal(f.nativeBuilds, 0); assert.equal(f.inputs.length, 1); assert.equal(f.wakes.length, 1);
});

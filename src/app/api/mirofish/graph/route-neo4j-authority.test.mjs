import assert from 'node:assert/strict';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';

const authorityUrl = pathToFileURL(path.resolve('src/lib/knowledge-graph/query-authority.ts')).href;
const fixtureModule = `export function getMiroFishGraphArtifactRuntime() { return globalThis.legacyGraphFixture.runtime; }`;
const authorityModule = `
  export { withAuthorizedGraphSnapshots } from ${JSON.stringify(authorityUrl)};
  export function getGraphQueryAuthorityClient() { return {}; }
  export function readGraphQueryAuthority(...args) { return globalThis.legacyGraphFixture.readAuthority(...args); }
  export function readGraphQueryAuthorities(...args) { return globalThis.legacyGraphFixture.readAuthorities(...args); }
`;
const dataUrl = code => `data:text/javascript,${encodeURIComponent(code)}`;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@/lib/mirofish/graph-artifact-runtime') return { url: dataUrl(fixtureModule), shortCircuit: true };
  if (specifier === '@/lib/knowledge-graph/query-authority') return { url: dataUrl(authorityModule), shortCircuit: true };
  if (specifier === 'next/server') return next('next/server.js', context);
  if (specifier.startsWith('@/')) return next(pathToFileURL(path.resolve('src', `${specifier.slice(2)}.ts`)).href, context);
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) {
      return next(`${specifier}.ts`, context);
    }
    throw error;
  }
} });
const previousEnv = Object.fromEntries(['RAG_ACCESS_MODE', 'RAG_SINGLE_TENANT_TOKEN', 'RAG_SINGLE_TENANT_ROLE',
  'RAG_SINGLE_TENANT_ACTOR_ID', 'RAG_DEFAULT_TENANT_ID', 'RAG_DEFAULT_CORPUS_ID'].map(key => [key, process.env[key]]));
Object.assign(process.env, { RAG_ACCESS_MODE: 'single-tenant-token', RAG_SINGLE_TENANT_TOKEN: 'graph-secret',
  RAG_SINGLE_TENANT_ROLE: 'owner', RAG_SINGLE_TENANT_ACTOR_ID: 'actor-a', RAG_DEFAULT_TENANT_ID: 'tenant-a',
  RAG_DEFAULT_CORPUS_ID: 'corpus-a' });
after(() => { for (const [key, value] of Object.entries(previousEnv)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} delete globalThis.legacyGraphFixture; });
const { NextRequest } = await import('next/server');
const { GET } = await import('./route.ts');
const { getTaskManager } = await import('@/lib/mirofish/task-manager');
const { createMiroFishGraphTaskScopeMetadata } = await import('@/lib/mirofish/graph-api-scope');
const identity = { tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'doc', documentVersion: 'v1', trustLevel: 'external' };
const descriptor = { identity, graphName: 'doc graph', nodeCount: 0, edgeCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z' };
const active = { identity, revision: 1 };
const request = action => new NextRequest(`http://localhost/api/mirofish/graph?action=${action}`, {
  headers: { authorization: 'Bearer graph-secret' },
});

function configureFixture() {
  let loads = 0;
  const fixture = globalThis.legacyGraphFixture = {
    runtime: { backend: 'neo4j', store: {
      list: async () => [descriptor], getActive: async () => active, gcExpired: async () => {},
      get: async () => { loads++; return { graph: { graph_id: 'doc', nodes: [], edges: [], node_count: 0, edge_count: 0 } }; },
    } },
    readAuthority: async () => 'stable', readAuthorities: async (_client, _scope, identities) => identities.map(() => 'stable'),
    loads: () => loads,
  };
  return fixture;
}

test('Neo4j data fails closed before loading disabled document and detects mid-read revocation', async () => {
  const fixture = configureFixture();
  fixture.readAuthority = async () => null;
  assert.equal((await GET(request('data&graphId=doc'))).status, 404);
  assert.equal(fixture.loads(), 0);
  let calls = 0;
  fixture.readAuthority = async () => ++calls === 1 ? 'old' : null;
  assert.equal((await GET(request('data&graphId=doc'))).status, 409);
  assert.equal(fixture.loads(), 1);
});

test('exact document identity reads the requested generation directly without scanning snapshots', async () => {
  const fixture = configureFixture();
  const generation = '19b0d243-b625-4eba-85aa-f42fda97355a';
  fixture.runtime.store.list = async () => { throw new Error('must not scan'); };
  let loaded;
  fixture.runtime.store.get = async actual => { loaded = actual; return { graph: { graph_id: 'doc', nodes: [], edges: [], node_count: 0, edge_count: 0 } }; };
  assert.equal((await GET(request(`data&graphId=doc&documentVersion=v1&trustLevel=external&graphGeneration=${generation}`))).status, 200);
  assert.equal(loaded.graphGeneration, generation);
  assert.equal((await GET(request('data&graphId=doc&documentVersion=v1&trustLevel=external'))).status, 200);
  assert.equal(loaded.graphGeneration, undefined);
});

test('Neo4j list omits revoked source and refuses a change during listing', async () => {
  const fixture = configureFixture();
  fixture.readAuthorities = async (_client, _scope, identities) => identities.map(() => null);
  const hidden = await GET(request('list'));
  assert.equal(hidden.status, 200);
  assert.deepEqual((await hidden.json()).graphs, []);
  let calls = 0;
  fixture.readAuthorities = async (_client, _scope, identities) => identities.map(() => ++calls <= 2 ? 'old' : null);
  assert.equal((await GET(request('list'))).status, 409);
});

test('Neo4j cannot expose legacy task graphs without a document identity', async t => {
  const fixture = configureFixture();
  fixture.runtime.store.list = async () => [];
  fixture.runtime.store.getActive = async () => ({ identity: null, revision: 0 });
  const manager = getTaskManager();
  const task = manager.createTask('graph_build', createMiroFishGraphTaskScopeMetadata({
    tenantId: 'tenant-a', corpusId: 'corpus-a', actorId: 'actor-a', enforceIsolation: true,
  }));
  t.after(() => manager.deleteTask(task));
  manager.completeTask(task, { graphId: 'legacy', graphData: { graph_id: 'legacy', nodes: [], edges: [], node_count: 0, edge_count: 0 } });
  assert.equal((await GET(request('data&graphId=legacy'))).status, 404);
  const list = await GET(request('list'));
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).graphs, []);
});

test('unified mode blocks legacy graph reads after authentication and before storage', async () => {
  const old = process.env.RAG_UNIFIED_PUBLICATION_MODE;
  process.env.RAG_UNIFIED_PUBLICATION_MODE = 'active';
  try {
    const fixture = configureFixture();
    fixture.runtime.store.list = async () => { throw new Error('graph storage must not be read'); };
    assert.equal((await GET(new NextRequest('http://localhost/api/mirofish/graph?action=list'))).status, 401);
    const response = await GET(request('list'));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'PUBLICATION_LEGACY_WRITE_UNAVAILABLE');
    assert.equal(fixture.loads(), 0);
  } finally {
    if (old === undefined) delete process.env.RAG_UNIFIED_PUBLICATION_MODE;
    else process.env.RAG_UNIFIED_PUBLICATION_MODE = old;
  }
});

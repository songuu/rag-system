import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { types as utilTypes } from 'node:util';

const require = createRequire(import.meta.url);
const workspace = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const isWithin = (root, filename) => {
  const relative = path.relative(root, filename);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

const observableErrorCodes = new Set(['ERR_ASSERTION', 'ETIMEDOUT', 'EPERM', 'EBUSY', 'EACCES', 'ENOENT', 'ENOTDIR', 'ENOTEMPTY', 'EIO']);
const reportObservation = (t, phase, outcome, error) => {
  // Diagnostics must neither invoke an error getter nor replace the original
  // failure with a logging error. Never print compiler text or filesystem paths.
  try {
    const descriptor = outcome === 'failure' && utilTypes.isNativeError(error)
      ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    const code = typeof descriptor?.value === 'string' && observableErrorCodes.has(descriptor.value)
      ? descriptor.value : 'UNCLASSIFIED';
    t.diagnostic(JSON.stringify({ graphArtifactTracing: { phase, outcome, ...(outcome === 'failure' ? { code } : {}) } }));
  } catch { /* Observation cannot alter the test's exception or cleanup behavior. */ }
};

// The complete actual class must be compiled: a hand-picked path expression can
// miss tracing introduced by another method reachable from the same store.
test('Turbopack keeps the actual graph artifact store runtime files private for default and custom roots', { timeout: 30000 }, async (t) => {
  let phase = 'fixture-create';
  try {
    const fixture = fs.realpathSync(fs.mkdtempSync(path.join(workspace, '.tmp-graph-artifact-trace-')));
    phase = 'fixture-owner';
    const marker = `synthetic-graph-artifact-tracing-v1:${randomUUID()}`;
    const markerPath = path.join(fixture, '.fixture-owner');
    fs.writeFileSync(markerPath, marker);
    t.after(() => {
      let cleanupPhase = 'cleanup-ownership';
      try {
        assert.equal(fs.lstatSync(fixture).isSymbolicLink(), false);
        const resolved = fs.realpathSync(fixture);
        assert.equal(path.dirname(resolved), workspace);
        assert.ok(path.basename(resolved).startsWith('.tmp-graph-artifact-trace-'));
        assert.equal(fs.lstatSync(markerPath).isSymbolicLink(), false);
        assert.equal(fs.readFileSync(markerPath, 'utf8'), marker);
        // This exact new synthetic directory is the only recursive cleanup target.
        cleanupPhase = 'cleanup-remove';
        fs.rmSync(resolved, { recursive: true, force: true });
        reportObservation(t, cleanupPhase, 'complete');
      } catch (error) {
        reportObservation(t, cleanupPhase, 'failure', error);
        throw error;
      }
    });
    const write = (relative, content) => {
      const filename = path.resolve(fixture, relative);
      assert.ok(isWithin(fixture, filename));
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, content);
    };
    phase = 'source-read';
    const sourcePath = path.join(workspace, 'src/lib/mirofish/graph-artifact-store.ts');
    const scopePath = path.join(workspace, 'src/lib/security/retrieval-scope.ts');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const scopeSource = fs.readFileSync(scopePath, 'utf8');
    const identity = { tenantId: 'synthetic-tenant', corpusId: 'synthetic-corpus', documentId: 'synthetic-document', documentVersion: 'synthetic-v1', trustLevel: 'reviewed' };
    const graph = {
      graph_id: identity.documentId, artifact_version: 'mirofish-graph-v2',
      nodes: [], edges: [], passages: [], node_count: 0, edge_count: 0,
    };
    const sourceUrl = pathToFileURL(sourcePath).href;
    phase = 'artifact-validation';
    const hook = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (context.parentURL === sourceUrl && specifier === '../security/retrieval-scope') {
          return nextResolve(`${specifier}.ts`, context);
        }
        return nextResolve(specifier, context);
      },
    });
    try {
      const { createMiroFishGraphArtifact } = await import(sourceUrl);
      // Compiling an invalid payload could leave the intended store.put unreachable.
      assert.doesNotThrow(() => createMiroFishGraphArtifact({ identity, graph }),
        'the compiled write route must receive a valid actual graph artifact');
    } finally {
      hook.deregister();
    }
    phase = 'fixture-write';
    write('package.json', JSON.stringify({
      name: 'synthetic-graph-artifact-tracing-repro', private: true,
      dependencies: {
        next: require('next/package.json').version,
        react: require('react/package.json').version,
        'react-dom': require('react-dom/package.json').version,
      },
    }));
    write('next.config.mjs', `export default ${JSON.stringify({
    distDir: '.build', turbopack: { root: workspace }, outputFileTracingRoot: workspace,
  })};\n`);
    write('private-decoy.txt', 'SYNTHETIC PRIVATE TRACE CANARY\n');
    write('private-source.ts', 'export const syntheticPrivateSource = true;\n');
    write('data/context-sessions/safe-id.json', '{"synthetic":true}\n');
    write('assets/public-fixture.txt', 'SYNTHETIC PUBLIC BUILD ASSET\n');
    for (const rootMode of ['default', 'custom']) {
      const route = `graph-${rootMode}`;
      const routeDirectory = path.join(fixture, 'app/api', route);
      const importPath = (filename) => path.relative(routeDirectory, filename).replaceAll('\\', '/');
      write(`app/api/${route}/route.js`, `import path from 'node:path';
import { FileMiroFishGraphArtifactStore, createMiroFishGraphArtifact } from ${JSON.stringify(importPath(sourcePath))};
import { createRetrievalScope } from ${JSON.stringify(importPath(scopePath))};
export const dynamic = 'force-dynamic';
const identity = ${JSON.stringify(identity)};
const scope = createRetrievalScope({ tenantId: identity.tenantId, corpusId: identity.corpusId, allowedTrustLevels: ['reviewed'], enforceIsolation: true });
const createStore = () => new FileMiroFishGraphArtifactStore(${rootMode === 'default' ? '' : "path.join(process.cwd(), 'uploads', 'synthetic-custom-graphs')"});
export async function GET() {
  const store = createStore();
  return Response.json({ artifact: await store.get(identity, scope), entries: await store.list(scope), active: await store.getActive(scope) });
}
export async function POST() {
  const store = createStore();
  const artifact = createMiroFishGraphArtifact({ identity, graph: ${JSON.stringify(graph)} });
  return Response.json(await store.put(artifact));
}\n`);
    }
    write('app/api/public-asset-control/route.js', `import { readFile } from 'node:fs/promises';
import path from 'node:path';
export const dynamic = 'force-dynamic';
export async function GET() { return new Response(await readFile(path.join(process.cwd(), 'assets', 'public-fixture.txt'))); }\n`);
    const startedAt = new Date().toISOString();
    const environment = {};
    for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP']) {
      if (process.env[key] !== undefined) environment[key] = process.env[key];
    }
    phase = 'compiler';
    const build = spawnSync(process.execPath, [require.resolve('next/dist/bin/next'), 'build', fixture], {
      cwd: fixture, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024,
      env: {
        ...environment, NODE_ENV: 'production', DATABASE_URL: '', POSTGRES_URL: '', RAG_RELEASE_DIR: '',
        NEXT_TELEMETRY_DISABLED: '1', LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false', COREPACK_ENABLE_NETWORK: '0',
      },
    });
    t.diagnostic(JSON.stringify({
      startedAt, endedAt: new Date().toISOString(), sourceSha: sha(source), scopeSourceSha: sha(scopeSource),
      buildStatus: build.status, buildError: build.error?.code ?? null, childPid: build.pid ?? null,
      nextStageSeen: (build.stdout ?? '').includes('Next.js'), compiledStageSeen: (build.stdout ?? '').includes('Compiled successfully'),
      stdoutSha: sha(build.stdout ?? ''), stderrSha: sha(build.stderr ?? ''),
    }));
    phase = 'compiler-result';
    assert.equal(build.error, undefined, 'synthetic compiler must finish within the existing budget');
    assert.equal(build.status, 0, 'synthetic compiler must finish before inspecting traces');
    const traced = (route) => {
      const filename = path.join(fixture, '.build/server/app/api', route, 'route.js.nft.json');
      const { files } = JSON.parse(fs.readFileSync(filename, 'utf8'));
      assert.ok(Array.isArray(files) && files.every((entry) => typeof entry === 'string' && !entry.includes('\0')));
      return new Set(files.map((entry) => path.resolve(path.dirname(filename), entry)));
    };
    phase = 'trace-positive-control';
    assert.equal(traced('public-asset-control').has(path.join(fixture, 'assets/public-fixture.txt')), true,
      'an unrelated explicit public build asset must remain traceable');
    phase = 'trace-scope';
    const scopeRoutes = ['graph-default', 'graph-custom'].map((route) => {
      const current = traced(route);
      return {
        route, count: current.size,
        rootCanary: current.has(path.join(fixture, 'private-decoy.txt')),
        sourceCanary: current.has(path.join(fixture, 'private-source.ts')),
        sessionCanary: current.has(path.join(fixture, 'data/context-sessions/safe-id.json')),
        workspacePrivateSessions: [...current].filter((filename) => isWithin(path.join(workspace, 'data/context-sessions'), filename)).length,
      };
    });
    t.diagnostic(JSON.stringify({ scopeRoutes }));
    phase = 'trace-privacy';
    for (const route of scopeRoutes) {
      assert.equal(route.rootCanary, false, `${route.route} must not trace unrelated private project files`);
      assert.equal(route.sourceCanary, false, `${route.route} must not trace private sources`);
      assert.equal(route.sessionCanary, false, `${route.route} must not trace private runtime sessions`);
      assert.equal(route.workspacePrivateSessions, 0, `${route.route} must not trace workspace private sessions`);
    }
  } catch (error) {
    reportObservation(t, phase, 'failure', error);
    throw error;
  }
});

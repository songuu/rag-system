import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./graph-artifact-tracing.integration.test.mjs', import.meta.url));
const secret = 'SYNTHETIC_PRIVATE_GRAPH_DIAGNOSTIC';

// Exercise the entire real integration test with inert in-memory dependencies.
// No compiler, fixture filesystem, workspace data or model is touched here.
async function executeObservationFixture() {
  const { SourceTextModule, SyntheticModule, createContext } = await import('node:vm');
  const fs = await import('node:fs');
  const path = (await import('node:path')).default;
  const { pathToFileURL } = await import('node:url');
  const [filename, scenario] = process.argv.slice(1);
  const secret = 'SYNTHETIC_PRIVATE_GRAPH_DIAGNOSTIC';
  const source = fs.readFileSync(filename, 'utf8');
  const diagnostics = [];
  const writes = new Map();
  const operations = [];
  const calls = { errorReads: 0, spawn: 0, buildTimeout: null, testTimeout: null, rm: 0, import: 0, deregister: 0 };
  const injected = new Error(secret);
  if (scenario.startsWith('cleanup-remove-')) {
    const code = scenario.slice('cleanup-remove-'.length);
    if (code === 'getter') Object.defineProperty(injected, 'code', { get() { calls.errorReads += 1; throw new Error(secret); } });
    else injected.code = code === 'secret' ? secret : code;
  }
  const proxy = new Proxy({}, {
    get() { calls.errorReads += 1; throw new Error(secret); },
    getOwnPropertyDescriptor() { calls.errorReads += 1; throw new Error(secret); },
    getPrototypeOf() { calls.errorReads += 1; throw new Error(secret); },
  });
  let workspace;
  let fixture;
  let callback;
  let cleanup;
  let bodyError;
  let cleanupError;
  const contextProcess = { execPath: process.execPath, env: { PATH: 'SYNTHETIC_PATH', SYNTHETIC_PRIVATE_ENV: secret } };
  const fakeFs = {
    realpathSync(value) { workspace ??= value; return value; },
    mkdtempSync(prefix) { if (scenario === 'fixture-create') throw injected; fixture = `${prefix}synthetic`; return fixture; },
    writeFileSync(value, content) {
      if (scenario === 'fixture-owner' && value.endsWith('.fixture-owner')) throw injected;
      if (scenario === 'fixture-write' && value.endsWith('package.json')) throw injected;
      writes.set(value, content);
    },
    mkdirSync() {},
    lstatSync(value) { return { isSymbolicLink: () => scenario === 'cleanup-ownership-link' && value === fixture }; },
    readFileSync(value) {
      if (value.endsWith('graph-artifact-store.ts') || value.endsWith('retrieval-scope.ts')) {
        if (scenario === 'source-read') throw injected;
        return '// inert synthetic source; never compiled';
      }
      if (value.endsWith('.fixture-owner')) return scenario === 'cleanup-ownership-marker' ? secret : writes.get(value);
      if (value.endsWith('route.js.nft.json')) {
        if (scenario === 'trace-read') throw injected;
        if (scenario === 'trace-json') return '{invalid synthetic JSON';
        if (scenario === 'trace-shape') return JSON.stringify({ files: [null] });
        const route = path.basename(path.dirname(value));
        if (scenario === 'trace-scope' && route !== 'public-asset-control') throw injected;
        const targets = route === 'public-asset-control'
          ? scenario === 'positive-control' ? [] : [path.join(fixture, 'assets/public-fixture.txt')]
          : scenario === 'private-canary' ? [path.join(fixture, 'private-decoy.txt')] : [];
        return JSON.stringify({ files: targets.map((target) => path.relative(path.dirname(value), target)) });
      }
      throw new Error('Unexpected synthetic read.');
    },
    rmSync(value, options) {
      calls.rm += 1;
      operations.push('remove');
      if (value !== fixture || options.recursive !== true || options.force !== true) throw new Error('Unexpected synthetic cleanup.');
      if (scenario === 'cleanup-remove-proxy') throw proxy;
      if (scenario.startsWith('cleanup-remove-')) throw injected;
    },
  };
  const fakeRequire = () => ({ version: '0.0.0-synthetic' });
  fakeRequire.resolve = () => '/synthetic/next-script';
  const fakeModules = {
    createRequire: () => fakeRequire,
    registerHooks: () => ({ deregister() { calls.deregister += 1; if (scenario === 'hook-deregister') throw injected; } }),
  };
  const fakeSpawn = (_command, _arguments, options) => {
    calls.spawn += 1;
    calls.buildTimeout = options.timeout;
    if (scenario === 'compiler-spawn') throw injected;
    return { status: scenario === 'compiler-status' ? 1 : 0, error: scenario === 'compiler-error' ? injected : undefined, pid: 12345, stdout: 'Next.js\nCompiled successfully', stderr: '' };
  };
  const mocks = new Map([
    ['node:fs', fakeFs], ['node:module', fakeModules], ['node:child_process', { spawnSync: fakeSpawn }],
    ['node:test', { default: (_name, options, run) => { calls.testTimeout = options.timeout; callback = run; } }],
  ]);
  const context = createContext({ process: contextProcess, console });
  const actual = new SourceTextModule(source, {
    context, identifier: pathToFileURL(filename).href,
    initializeImportMeta(meta) { meta.url = pathToFileURL(filename).href; },
    async importModuleDynamically() {
      calls.import += 1;
      if (scenario === 'artifact-import') throw injected;
      const artifact = new SyntheticModule(['createMiroFishGraphArtifact'], function () {
        this.setExport('createMiroFishGraphArtifact', () => { if (scenario === 'artifact-invalid') throw injected; return {}; });
      }, { context });
      await artifact.link(() => {});
      await artifact.evaluate();
      return artifact;
    },
  });
  await actual.link(async (specifier) => {
    const exports = mocks.get(specifier) ?? await import(specifier);
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await actual.evaluate();
  const t = {
    after(run) { cleanup = run; },
    diagnostic(value) { if (scenario === 'diagnostic-throws') throw injected; diagnostics.push(JSON.parse(value)); },
  };
  try { await callback(t); } catch (error) { bodyError = error; }
  if (cleanup) {
    try { await cleanup(); } catch (error) { cleanupError = error; }
  }
  console.log(JSON.stringify({
    calls, diagnostics, operations, bodyFailed: bodyError !== undefined, cleanupFailed: cleanupError !== undefined,
    bodyIdentity: bodyError === injected, cleanupIdentity: cleanupError === injected || cleanupError === proxy,
  }));
}

function runObservation(scenario) {
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', `(${executeObservationFixture.toString()})()`, script, scenario], {
    encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, new RegExp(`${secret}|Bearer|data/context-sessions|graph-artifact-trace-synthetic`));
  return JSON.parse(result.stdout.trim());
}

test('graph tracing observation preserves the real test and compiler budgets without real execution', { timeout: 15000 }, () => {
  const f = runObservation('success');
  assert.equal(f.bodyFailed, false);
  assert.equal(f.cleanupFailed, false);
  assert.equal(f.calls.buildTimeout, 20000);
  assert.equal(f.calls.testTimeout, 30000);
  assert.equal(f.calls.spawn, 1);
  assert.equal(f.calls.import, 1);
  assert.equal(f.calls.deregister, 1);
  assert.equal(f.calls.rm, 1);
  assert.ok(f.diagnostics.some((value) => value.graphArtifactTracing?.phase === 'cleanup-remove' && value.graphArtifactTracing.outcome === 'complete'));
});

for (const [scenario, phase, identity] of [
  ['fixture-create', 'fixture-create', true], ['fixture-owner', 'fixture-owner', true],
  ['source-read', 'source-read', true], ['artifact-import', 'artifact-validation', true],
  ['artifact-invalid', 'artifact-validation', false], ['hook-deregister', 'artifact-validation', true],
  ['fixture-write', 'fixture-write', true],
  ['compiler-spawn', 'compiler', true], ['compiler-error', 'compiler-result', false], ['compiler-status', 'compiler-result', false],
  ['trace-read', 'trace-positive-control', true], ['trace-json', 'trace-positive-control', false],
  ['trace-shape', 'trace-positive-control', false], ['positive-control', 'trace-positive-control', false],
  ['trace-scope', 'trace-scope', true],
  ['private-canary', 'trace-privacy', false],
]) {
  test(`complete graph tracing test reports ${scenario} without replacing its error`, { timeout: 15000 }, () => {
    const f = runObservation(scenario);
    assert.equal(f.bodyFailed, true);
    assert.equal(f.bodyIdentity, identity);
    assert.equal(f.cleanupFailed, false);
    assert.equal(f.calls.errorReads, 0);
    assert.ok(f.diagnostics.some((value) => value.graphArtifactTracing?.phase === phase && value.graphArtifactTracing.outcome === 'failure'));
  });
}

for (const [scenario, phase, code, identity] of [
  ['cleanup-ownership-link', 'cleanup-ownership', 'ERR_ASSERTION', false],
  ['cleanup-ownership-marker', 'cleanup-ownership', 'ERR_ASSERTION', false],
  ['cleanup-remove-EPERM', 'cleanup-remove', 'EPERM', true], ['cleanup-remove-EBUSY', 'cleanup-remove', 'EBUSY', true],
  ['cleanup-remove-EACCES', 'cleanup-remove', 'EACCES', true], ['cleanup-remove-secret', 'cleanup-remove', 'UNCLASSIFIED', true],
  ['cleanup-remove-ENOTEMPTY', 'cleanup-remove', 'ENOTEMPTY', true],
  ['cleanup-remove-getter', 'cleanup-remove', 'UNCLASSIFIED', true], ['cleanup-remove-proxy', 'cleanup-remove', 'UNCLASSIFIED', true],
]) {
  test(`complete graph tracing hook reports ${scenario} using only closed evidence`, { timeout: 15000 }, () => {
    const f = runObservation(scenario);
    assert.equal(f.bodyFailed, false);
    assert.equal(f.cleanupFailed, true);
    assert.equal(f.cleanupIdentity, identity);
    assert.equal(f.calls.errorReads, 0);
    assert.deepEqual(f.diagnostics.filter((value) => value.graphArtifactTracing?.outcome === 'failure'), [
      { graphArtifactTracing: { phase, outcome: 'failure', code } },
    ]);
    assert.equal(f.calls.rm, phase === 'cleanup-remove' ? 1 : 0);
  });
}

test('diagnostic failure cannot replace the original body error or break owned cleanup', { timeout: 15000 }, () => {
  const f = runObservation('diagnostic-throws');
  assert.equal(f.bodyFailed, true);
  assert.equal(f.bodyIdentity, true);
  assert.equal(f.cleanupFailed, false);
  assert.equal(f.calls.rm, 1);
  assert.equal(f.calls.errorReads, 0);
});


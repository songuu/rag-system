import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('./check-standalone-traces.mjs', import.meta.url));
const requiredRoutes = ['document-search', 'ask', 'pipeline', 'mirofish/graph'];

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'rag-standalone-trace-policy-'));
  const owner = randomUUID();
  fs.writeFileSync(path.join(root, '.fixture-owner'), owner, { flag: 'wx' });
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('rag-standalone-trace-policy-'));
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    assert.equal(path.relative(root, fs.realpathSync(root)), '');
    assert.equal(fs.readFileSync(path.join(root, '.fixture-owner'), 'utf8'), owner);
    fs.rmSync(root, { recursive: true });
  });
  const writeTrace = (route, files) => {
    const file = path.join(root, '.next/server/app/api', route, 'route.js.nft.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, files }));
    return file;
  };
  for (const route of requiredRoutes) writeTrace(route, []);
  fs.mkdirSync(path.join(root, '.next/standalone'), { recursive: true });
  return {
    root, writeTrace,
    run: () => spawnSync(process.execPath, [guard], {
      cwd: root, env: { ...process.env, STATIC_EXPORT: '' }, encoding: 'utf8',
      timeout: 8000, maxBuffer: 1024 * 1024, windowsHide: true,
    }),
  };
}

function rejected(result, message) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.match(result.stderr, message);
}

test('clean traces and deliberately public assets remain allowed', (t) => {
  const f = fixture(t);
  const trace = f.writeTrace('other', []);
  const publicAsset = path.join(f.root, 'public/example.png');
  f.writeTrace('other', [path.relative(path.dirname(trace), publicAsset)]);
  const result = f.run();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Standalone trace guard passed/);
});

test('existing raw-source policy still rejects forbidden source files', (t) => {
  const f = fixture(t);
  f.writeTrace('ask', ['../../../../../../src/lib/rag/core/private.ts']);
  rejected(f.run(), /raw source\/test files/);
});

test('private session references in any route are rejected without printing identifiers', (t) => {
  const f = fixture(t);
  const trace = f.writeTrace('previously-unchecked', []);
  const privateFile = path.join(f.root, 'data/context-sessions/SYNTHETIC_PRIVATE_ID.json');
  f.writeTrace('previously-unchecked', [path.relative(path.dirname(trace), privateFile)]);
  const result = f.run();
  rejected(result, /private session references/);
  assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_PRIVATE_ID/);
});

test('Windows separators and directory-only private references are rejected', (t) => {
  const f = fixture(t);
  const trace = f.writeTrace('other', []);
  const reference = path.relative(path.dirname(trace), path.join(f.root, 'data/context-sessions'));
  f.writeTrace('other', [reference.replaceAll(path.sep, '\\')]);
  rejected(f.run(), /private session references/);
});

test('actual packaged private state is rejected and is never modified', (t) => {
  const f = fixture(t);
  const privateFile = path.join(f.root, '.next/standalone/data/context-sessions/SYNTHETIC_PRIVATE_ID.json');
  fs.mkdirSync(path.dirname(privateFile), { recursive: true });
  fs.writeFileSync(privateFile, 'SYNTHETIC_PRIVATE_CONTENT');
  const result = f.run();
  rejected(result, /packaged private session state/);
  assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_PRIVATE_ID|SYNTHETIC_PRIVATE_CONTENT/);
  assert.equal(fs.readFileSync(privateFile, 'utf8'), 'SYNTHETIC_PRIVATE_CONTENT');
});

test('malformed entries in other manifests fail closed', (t) => {
  const f = fixture(t);
  f.writeTrace('other', [null]);
  rejected(f.run(), /Invalid standalone trace metadata/);
});

test('a linked trace subtree fails closed without reading its target', (t) => {
  const f = fixture(t);
  const target = path.join(f.root, 'synthetic-link-target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'route.js.nft.json'), 'SYNTHETIC_INVALID_JSON');
  fs.symlinkSync(target, path.join(f.root, '.next/server/app/api/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = f.run();
  rejected(result, /Unsafe standalone trace path/);
  assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_INVALID_JSON/);
});

test('a linked artifact data parent is rejected without enumerating its target', (t) => {
  const f = fixture(t);
  const target = path.join(f.root, 'synthetic-data-target');
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(f.root, '.next/standalone/data'), process.platform === 'win32' ? 'junction' : 'dir');
  rejected(f.run(), /Unsafe standalone trace path/);
});

test('private references cannot disclose identifiers through overlapping source rules', (t) => {
  const f = fixture(t);
  const trace = f.writeTrace('ask', []);
  const target = path.join(f.root, 'data/context-sessions/SYNTHETIC_PRIVATE_ID/src/lib/rag/core/secret.ts');
  f.writeTrace('ask', [path.relative(path.dirname(trace), target)]);
  const result = f.run();
  rejected(result, /private session references/);
  assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_PRIVATE_ID/);
});

test('private references through directory aliases are rejected using metadata only', (t) => {
  const f = fixture(t);
  const privateRoot = path.join(f.root, 'data/context-sessions');
  fs.mkdirSync(privateRoot, { recursive: true });
  fs.writeFileSync(path.join(privateRoot, 'SYNTHETIC_PRIVATE_ID.json'), 'SYNTHETIC_PRIVATE_CONTENT');
  fs.symlinkSync(privateRoot, path.join(f.root, 'session-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const trace = f.writeTrace('other', []);
  f.writeTrace('other', [path.relative(path.dirname(trace), path.join(f.root, 'session-alias/SYNTHETIC_PRIVATE_ID.json'))]);
  const result = f.run();
  rejected(result, /private session references/);
  assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_PRIVATE_ID|SYNTHETIC_PRIVATE_CONTENT/);
});

test('root-level server runtime manifests are included in the private-data policy', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, '.next/next-server.js.nft.json'), JSON.stringify({
    files: ['../data/context-sessions/SYNTHETIC_PRIVATE_ID.json'],
  }));
  const result = f.run();
  rejected(result, /private session references/);
  assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_PRIVATE_ID/);
});

test('ordinary dependency aliases remain allowed', (t) => {
  const f = fixture(t);
  const target = path.join(f.root, 'synthetic-dependency');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'entry.js'), 'export const synthetic = true;');
  fs.mkdirSync(path.join(f.root, 'node_modules'));
  fs.symlinkSync(target, path.join(f.root, 'node_modules/synthetic-package'), process.platform === 'win32' ? 'junction' : 'dir');
  const trace = f.writeTrace('other', []);
  f.writeTrace('other', [path.relative(path.dirname(trace), path.join(f.root, 'node_modules/synthetic-package/entry.js'))]);
  const result = f.run();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

for (const kind of ['lowercase-dotenv', 'uppercase-dotenv', 'linked-data-parent', 'dangling-session-link', 'linked-server-entry', 'linked-manifest-parent']) {
  test(`runtime checker refuses ${kind} before starting a child`, { timeout: 15000 }, (t) => {
    const f = fixture(t);
    const artifact = path.join(f.root, '.next/standalone');
    fs.mkdirSync(path.join(artifact, '.next'));
    fs.writeFileSync(path.join(artifact, '.next/BUILD_ID'), 'synthetic-build-id');
    fs.writeFileSync(path.join(artifact, '.next/routes-manifest.json'), JSON.stringify({ basePath: '', rewrites: [] }));
    // Even an old, bypassed preflight can execute only this owned inert stub.
    fs.writeFileSync(path.join(artifact, 'server.js'), "require('node:fs').writeFileSync('SYNTHETIC_START_MARKER', 'started');\n");
    if (kind === 'linked-data-parent') {
      const target = path.join(f.root, 'synthetic-empty-data');
      fs.mkdirSync(target);
      fs.symlinkSync(target, path.join(artifact, 'data'), process.platform === 'win32' ? 'junction' : 'dir');
    } else if (kind === 'dangling-session-link') {
      fs.mkdirSync(path.join(artifact, 'data'));
      fs.symlinkSync(path.join(f.root, 'synthetic-missing-data'), path.join(artifact, 'data/context-sessions'), process.platform === 'win32' ? 'junction' : 'dir');
    } else if (kind === 'linked-server-entry') {
      const target = path.join(f.root, 'synthetic-entry');
      fs.mkdirSync(target);
      fs.renameSync(path.join(artifact, 'server.js'), path.join(target, 'server.js'));
      // A junction can be created on Windows without file-symlink privileges.
      fs.symlinkSync(target, path.join(artifact, 'server.js'), process.platform === 'win32' ? 'junction' : 'dir');
    } else if (kind === 'linked-manifest-parent') {
      const target = path.join(f.root, 'synthetic-build-metadata');
      fs.renameSync(path.join(artifact, '.next'), target);
      fs.symlinkSync(target, path.join(artifact, '.next'), process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      fs.writeFileSync(path.join(artifact, kind === 'uppercase-dotenv' ? '.ENV.LOCAL' : '.env.local'), 'SYNTHETIC_ONLY=true');
    }
    const script = path.join(f.root, 'scripts/check-context-management-runtime.mjs');
    fs.mkdirSync(path.dirname(script));
    fs.copyFileSync(new URL('./check-context-management-runtime.mjs', import.meta.url), script);
    const result = spawnSync(process.execPath, [script], {
      cwd: f.root, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout.trim());
    assert.deepEqual(report.failure, { stage: 'preflight', code: 'ERR_ASSERTION' });
    assert.equal(report.completed, 0);
    assert.equal(report.prefixCount, 0);
    assert.equal(report.serverClosed, false);
    assert.equal(fs.existsSync(path.join(artifact, 'SYNTHETIC_START_MARKER')), false);
  });
}

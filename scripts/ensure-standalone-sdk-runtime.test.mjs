import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { copyRuntimeTrace } from './ensure-standalone-sdk-runtime.mjs';

test('copies native dependency files and portable directory aliases; rejects escaped traces', async () => {
  const fixture = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sdk-artifact-')));
  const source = path.join(fixture, 'source', 'node_modules');
  const artifact = path.join(fixture, 'artifact', 'node_modules');
  try {
    await mkdir(path.join(source, '.pnpm', 'fixture', 'pkg'), { recursive: true });
    await mkdir(artifact, { recursive: true });
    await writeFile(path.join(source, '.pnpm', 'fixture', 'pkg', 'index.cjs'), 'module.exports = 42;');
    await symlink(path.join('.pnpm', 'fixture', 'pkg'), path.join(source, 'pkg'), 'dir');
    const files = ['node_modules/.pnpm/fixture/pkg/index.cjs', 'node_modules/pkg', 'node_modules/pkg/index.cjs'];
    assert.equal((await copyRuntimeTrace(source, artifact, files)).copied, 1);
    assert.equal(await readFile(path.join(artifact, 'pkg', 'index.cjs'), 'utf8'), 'module.exports = 42;');
    assert.equal((await copyRuntimeTrace(source, artifact, files)).copied, 1);
    await assert.rejects(copyRuntimeTrace(source, artifact, ['node_modules/../../secret']), /outside node_modules/);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

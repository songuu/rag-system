import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanStandaloneOutput, normalizeStandaloneLinks } from './normalize-standalone-links.mjs';

test('repairs Windows file-kind links pointing at package directories, preserving relative targets', async t => {
  const temporaryRoot = path.resolve(os.tmpdir());
  const fixture = await mkdtemp(path.join(temporaryRoot, 'rag-standalone-links-'));
  t.after(async () => {
    assert.ok(fixture.startsWith(temporaryRoot + path.sep));
    await rm(fixture, { recursive: true, force: true });
  });
  const artifact = path.join(fixture, 'standalone');
  await mkdir(path.join(artifact, 'packages', 'react'), { recursive: true });
  await writeFile(path.join(artifact, 'packages', 'react', 'index.js'), 'module.exports = {};');
  const link = path.join(artifact, 'react');
  await symlink(path.join('packages', 'react'), link, 'file');
  const result = await normalizeStandaloneLinks(artifact);
  assert.equal(result.repaired, process.platform === 'win32' ? 1 : 0);
  assert.equal(await realpath(link), await realpath(path.join(artifact, 'packages', 'react')));
  assert.ok(!path.isAbsolute(await readlink(link)));
  assert.equal((await normalizeStandaloneLinks(artifact)).repaired, 0);
});

test('rejects links escaping the artifact without touching their targets', async t => {
  const temporaryRoot = path.resolve(os.tmpdir());
  const fixture = await mkdtemp(path.join(temporaryRoot, 'rag-standalone-boundary-'));
  t.after(async () => {
    assert.ok(fixture.startsWith(temporaryRoot + path.sep));
    await rm(fixture, { recursive: true, force: true });
  });
  const artifact = path.join(fixture, 'standalone');
  await mkdir(artifact);
  await mkdir(path.join(fixture, 'outside'));
  await symlink('../outside', path.join(artifact, 'escape'), 'dir');
  await assert.rejects(normalizeStandaloneLinks(artifact), /outside.*artifact/i);
  assert.equal(await readlink(path.join(artifact, 'escape')), '..' + path.sep + 'outside');
});

test('rebases approved workspace package links into the copied artifact and cleans only build output', async t => {
  const temporaryRoot = path.resolve(os.tmpdir());
  const fixture = await mkdtemp(path.join(temporaryRoot, 'rag-standalone-package-'));
  t.after(async () => { assert.ok(fixture.startsWith(temporaryRoot + path.sep)); await rm(fixture, { recursive: true, force: true }); });
  const artifact = path.join(fixture, 'standalone');
  await mkdir(path.join(artifact, 'node_modules', 'fixture-package'), { recursive: true });
  await mkdir(path.join(fixture, 'node_modules', 'fixture-package'), { recursive: true });
  await symlink('../node_modules/fixture-package', path.join(artifact, 'external-package'), 'dir');
  assert.equal((await normalizeStandaloneLinks(artifact, { sourceNodeModules: path.join(fixture, 'node_modules') })).repaired, 1);
  assert.equal(await realpath(path.join(artifact, 'external-package')), await realpath(path.join(artifact, 'node_modules', 'fixture-package')));
  await mkdir(path.join(fixture, '.next', 'standalone'), { recursive: true });
  await writeFile(path.join(fixture, '.next', 'standalone', 'stale.js'), 'stale');
  await cleanStandaloneOutput(fixture);
  await assert.rejects(realpath(path.join(fixture, '.next', 'standalone')), { code: 'ENOENT' });
  assert.equal(await realpath(path.join(fixture, 'node_modules', 'fixture-package')),
    path.join(await realpath(fixture), 'node_modules', 'fixture-package'));
});

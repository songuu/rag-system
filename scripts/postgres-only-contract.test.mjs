import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..');
const FORBIDDEN_VENDOR = ['supa', 'base'].join('');
const FORBIDDEN_MANAGED_API_MARKERS = [
  ['/rest', '/v1'].join(''),
  ['/auth', '/v1'].join(''),
  ['/storage', '/v1'].join(''),
  ['service', '_role'].join(''),
  ['anon', '_key'].join(''),
];

function listRepositoryFiles() {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8' }
  ).split('\0').filter(Boolean);
}

test('repository persistence surface is PostgreSQL-only', async () => {
  const violations = [];

  for (const relativePath of listRepositoryFiles()) {
    let contents;
    try {
      contents = await readFile(path.join(REPOSITORY_ROOT, relativePath));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }

    if (relativePath.toLowerCase().includes(FORBIDDEN_VENDOR)) {
      violations.push(`${relativePath} (path)`);
      continue;
    }

    const normalizedContents = contents.toString('utf8').toLowerCase();
    if (
      normalizedContents.includes(FORBIDDEN_VENDOR)
      || FORBIDDEN_MANAGED_API_MARKERS.some(marker => normalizedContents.includes(marker))
    ) {
      violations.push(`${relativePath} (content)`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Non-PostgreSQL persistence vendor references remain:\n${violations.join('\n')}`
  );
});

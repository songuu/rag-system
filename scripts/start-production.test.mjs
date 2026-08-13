import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('package production start uses the PostgreSQL-validating runtime bootstrap', () => {
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const launcher = readFileSync(path.join(root, 'scripts', 'start-production.cjs'), 'utf8');

  assert.equal(packageJson.scripts.start, 'node scripts/start-production.cjs');
  assert.match(launcher, /RAG_RUNTIME_ENV_SOURCE\s*=\s*['"]process['"]/);
  assert.match(launcher, /\.next['"],\s*['"]standalone['"],\s*['"]server\.js['"]/);
  assert.match(launcher, /run-rag-system\.cjs/);
});

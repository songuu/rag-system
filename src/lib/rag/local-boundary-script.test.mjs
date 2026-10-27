import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { scripts } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
const files = [
  'src/lib/rag/local-boundary-script.test.mjs',
  'src/lib/rag/non-ui-type-boundaries.test.mjs',
  'src/components/rag-ui-type-boundaries.test.mjs',
  'src/lib/embedding-config.test.mjs',
  'src/lib/contextual-retrieval.test.mjs',
  'src/lib/rag/core/durable-error-diagnostic.test.mjs',
  'src/lib/rag/core/durable-error-io-diagnostic.test.mjs',
  'scripts/private-runtime-data-config.test.mjs',
  'src/app/api/ask/durable-bounded-response-diagnostic.test.mjs',
  'docs/reports/.diagnostics/run-normal-rag-regression.test.mjs',
];

test('local boundary regression script includes every offline suite with a finite native timeout', () => {
  assert.deepEqual(scripts['test:rag-local-boundaries']?.split(/\s+/), [
    'node', '--test', '--test-timeout=30000', ...files,
  ]);
});

test('wave1 runs local boundary regressions without removing or reordering existing gates', () => {
  const commands = scripts['test:rag-wave1'].split(' && ');
  assert.equal(commands[0], 'pnpm test:rag-local-boundaries');
  assert.deepEqual(commands.slice(1), [
    'pnpm test:rag-kernel', 'pnpm rag:eval:e1b', 'pnpm rag:eval:matrix', 'pnpm rag:eval:contracts',
  ]);
});

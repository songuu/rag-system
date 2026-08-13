import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '..', '..');

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

test('container starts through the runtime environment allowlist', () => {
  const dockerfile = read('Dockerfile');

  assert.match(dockerfile, /COPY --from=builder .*run-rag-system\.cjs/);
  assert.match(dockerfile, /RAG_RUNTIME_ENV_SOURCE="process"/);
  assert.match(dockerfile, /RAG_RUNTIME_SERVER="\/app\/server\.js"/);
  assert.match(dockerfile, /CMD \["node", "run-rag-system\.cjs"\]/);
});

test('container healthcheck exercises PostgreSQL readiness', () => {
  const dockerfile = read('Dockerfile');
  const healthcheck = dockerfile.match(/HEALTHCHECK[\s\S]*?(?=\n\nCMD)/)?.[0];

  assert.ok(healthcheck);
  assert.match(healthcheck, /\/api\/health'/);
  assert.doesNotMatch(healthcheck, /\/api\/health\/live/);
});

test('compose never exposes infrastructure-only PostgreSQL values to the app', () => {
  const baseCompose = read('docker-compose.yml');
  const baseAppBlock = baseCompose.match(/(?:^|\n)  app:\n(?<body>[\s\S]*?)(?=\n  [A-Za-z0-9_-]+:|\nvolumes:|$)/)?.groups?.body;
  assert.ok(baseAppBlock);
  assert.match(baseAppBlock, /^\s{6}POSTGRES_MIGRATION_URL:\s*["']{2}\s*$/m);
  assert.match(baseAppBlock, /^\s{6}POSTGRES_PASSWORD:\s*["']{2}\s*$/m);

  for (const relativePath of [
    'docker-compose.yml',
    'docker-compose.local.yml',
    'docker-compose.cloud.yml',
  ]) {
    const compose = read(relativePath);
    const appBlock = compose.match(/(?:^|\n)  app:\n(?<body>[\s\S]*?)(?=\n  [A-Za-z0-9_-]+:|\nvolumes:|$)/)?.groups?.body;
    assert.ok(appBlock, `${relativePath} must define the app service`);
    for (const key of ['POSTGRES_MIGRATION_URL', 'POSTGRES_PASSWORD']) {
      const assignment = appBlock.match(new RegExp(`^\\s{6}${key}:\\s*(.*)$`, 'm'));
      if (assignment) assert.match(assignment[1], /^(?:""|'')\s*$/);
    }
  }
});

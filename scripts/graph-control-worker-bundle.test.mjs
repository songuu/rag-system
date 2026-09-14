import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('production image contains an executable graph control worker bundle', () => {
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8');

  assert.equal(packageJson.scripts['graph:control-worker'], 'tsx scripts/graph-control-worker-entry.ts');
  assert.equal(
    packageJson.scripts['graph:control-worker:local'],
    'node --env-file=.env.local --import tsx scripts/graph-control-worker-entry.ts'
  );
  assert.match(packageJson.scripts['graph:control-worker:build'], /esbuild scripts\/graph-control-worker-entry\.ts/);
  assert.match(packageJson.scripts['graph:control-worker:build'], /--bundle/);
  assert.match(packageJson.scripts['graph:control-worker:build'], /--format=cjs/);
  assert.doesNotMatch(packageJson.scripts['graph:control-worker:build'], /--packages=external/);
  assert.match(packageJson.scripts['graph:control-worker:build'], /\.next\/graph-control-worker\.cjs/);
  assert.match(dockerfile, /RUN pnpm graph:control-worker:build/);
  assert.match(dockerfile, /COPY --from=builder .*graph-control-worker\.cjs \.\/graph-control-worker\.cjs/);
});

test('compose deploys the control worker with PostgreSQL and Neo4j connectivity', () => {
  const baseCompose = readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  const localCompose = readFileSync(path.join(root, 'docker-compose.local.yml'), 'utf8');
  const cloudCompose = readFileSync(path.join(root, 'docker-compose.cloud.yml'), 'utf8');

  assert.match(baseCompose, /graph-control-worker:\r?\n[\s\S]*?command: \["node", "graph-control-worker\.cjs"\]/);
  assert.match(baseCompose, /graph-control-worker:\r?\n[\s\S]*?healthcheck:\r?\n\s+disable: true/);
  assert.match(localCompose, /graph-control-worker:\r?\n[\s\S]*?DATABASE_URL: postgresql:\/\//);
  assert.match(localCompose, /graph-control-worker:\r?\n[\s\S]*?NEO4J_URI:/);
  assert.match(localCompose, /graph-control-worker:\r?\n[\s\S]*?RAG_GRAPH_BUILD_EXECUTOR: \$\{RAG_GRAPH_BUILD_EXECUTOR:-local\}/);
  assert.match(localCompose, /graph-control-worker:\r?\n[\s\S]*?MILVUS_LOCAL_ADDRESS: milvus:19530/);
  assert.match(localCompose, /graph-control-worker:\r?\n[\s\S]*?OLLAMA_BASE_URL:/);
  assert.match(cloudCompose, /graph-control-worker:\r?\n[\s\S]*?POSTGRES_URL:/);
  assert.match(cloudCompose, /graph-control-worker:\r?\n[\s\S]*?NEO4J_URI:/);
  assert.match(cloudCompose, /graph-control-worker:\r?\n\s+profiles: \["graph-control"\]/);
  assert.match(cloudCompose, /graph-control-worker:\r?\n[\s\S]*?RAG_GRAPH_PUBLICATION_WEBHOOK_URL:/);
  assert.match(cloudCompose, /graph-control-worker:\r?\n[\s\S]*?RAG_GRAPH_BUILD_WEBHOOK_URL:/);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});

test('graph:import starts from the locked tsx runtime and documents dry-run default', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['graph:import'], 'tsx scripts/import-mirofish-artifacts.ts');
  assert.equal(packageJson.devDependencies.tsx, '4.20.5');
  const result = spawnSync(process.execPath, [
    path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(root, 'scripts', 'import-mirofish-artifacts.ts'),
    '--help',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Default: dry-run only/i);
  assert.match(result.stdout, /--apply: write staged snapshots/i);
});

test('dry-run never initializes or mutates the Neo4j schema', async () => {
  const {
    assertApplyControlPlaneConfigured,
    shouldInitializeSchema,
  } = await import('./import-mirofish-artifacts.ts');
  assert.equal(shouldInitializeSchema(false), false);
  assert.equal(shouldInitializeSchema(true), true);
  assert.doesNotThrow(() => assertApplyControlPlaneConfigured(false, {}));
  assert.throws(
    () => assertApplyControlPlaneConfigured(true, {
      NODE_ENV: 'development',
      RAG_PERSISTENCE_BACKEND: 'local',
    }),
    /requires the PostgreSQL graph publication control plane/i
  );
  assert.throws(
    () => assertApplyControlPlaneConfigured(true, {
      NODE_ENV: 'development',
      RAG_PERSISTENCE_BACKEND: 'postgres',
      RAG_DEFAULT_TENANT_ID: 'tenant-a',
      RAG_DEFAULT_CORPUS_ID: 'corpus-a',
    }),
    /requires DATABASE_URL/i
  );
  assert.doesNotThrow(() => assertApplyControlPlaneConfigured(true, {
    NODE_ENV: 'development',
    RAG_PERSISTENCE_BACKEND: 'postgres',
    DATABASE_URL: 'postgresql://app:secret@127.0.0.1:5432/rag',
    RAG_DEFAULT_TENANT_ID: 'tenant-a',
    RAG_DEFAULT_CORPUS_ID: 'corpus-a',
  }));
});

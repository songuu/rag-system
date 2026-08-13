import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.join(scriptDirectory, 'render-host-env-defaults.py');
const python = process.platform === 'win32' ? 'python' : 'python3';

test('host defaults use neutral scope names and never render PostgreSQL secrets', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rag-system-host-defaults-'));
  const example = path.join(root, '.env.container.example');

  try {
    writeFileSync(
      example,
      [
        'HOSTNAME=0.0.0.0',
        'RAG_DEFAULT_TENANT_ID=container-tenant',
        'RAG_DEFAULT_CORPUS_ID=container-corpus',
        'RAG_SINGLE_TENANT_TOKEN=replace-me',
        'DATABASE_URL=postgresql://user:database-secret@postgres:5432/rag_system',
        'POSTGRES_URL=postgresql://user:alias-secret@postgres:5432/rag_system',
        'POSTGRES_MIGRATION_URL=postgresql://owner:migration-secret@postgres:5432/rag_system',
        'POSTGRES_PASSWORD=infrastructure-secret',
        'UNLISTED_FILE_SECRET=unlisted-secret',
      ].join('\n') + '\n',
      'utf8'
    );

    const result = spawnSync(python, [renderer, example], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^HOSTNAME='127\.0\.0\.1'$/m);
    assert.match(result.stdout, /^RAG_DEFAULT_TENANT_ID='songuu-production'$/m);
    assert.match(result.stdout, /^RAG_DEFAULT_CORPUS_ID='default'$/m);
    assert.doesNotMatch(result.stdout, /DATABASE_URL|POSTGRES_URL|POSTGRES_MIGRATION_URL|POSTGRES_PASSWORD|UNLISTED_FILE_SECRET|database-secret|alias-secret|migration-secret|infrastructure-secret|unlisted-secret|replace-me/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

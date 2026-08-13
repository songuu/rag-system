import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(scriptDirectory, 'run-rag-system.sh');
const windowsGitBash = 'C:/Apps/Git/bin/bash.exe';
const bash = process.platform === 'win32' ? windowsGitBash : 'bash';
const skip = process.platform === 'win32' && !existsSync(windowsGitBash);

function runWithEnvironment(lines, runtimeAssertions = 'exit 0') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rag-system-shell-runtime-'));
  const defaults = path.join(root, '.env.defaults');
  const environment = path.join(root, '.env.prod');
  const server = path.join(root, 'server.js');

  try {
    writeFileSync(defaults, "NODE_ENV='production'\n", 'utf8');
    writeFileSync(server, `${runtimeAssertions}\n`, 'utf8');
    writeFileSync(
      environment,
      [
        "RAG_ACCESS_MODE='single-tenant-token'",
        "RAG_SINGLE_TENANT_TOKEN='test-only-long-random-token'",
        ...lines,
      ].join('\n') + '\n',
      'utf8'
    );

    return spawnSync(bash, [runner], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RAG_DEFAULTS_FILE: defaults,
        RAG_ENV_FILE: environment,
        RAG_RUNTIME_NODE: bash,
        RAG_RUNTIME_SERVER: server,
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('shell runner rejects PostgreSQL persistence without a connection URL', { skip }, () => {
  const result = runWithEnvironment([
    "RAG_PERSISTENCE_BACKEND='postgres'",
    "RAG_DEFAULT_TENANT_ID='songuu-production'",
    "RAG_DEFAULT_CORPUS_ID='default'",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_URL or POSTGRES_URL is required/);
});

test('shell runner defaults production persistence to PostgreSQL and fails without a URL', { skip }, () => {
  const result = runWithEnvironment([
    "RAG_DEFAULT_TENANT_ID='songuu-production'",
    "RAG_DEFAULT_CORPUS_ID='default'",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_URL or POSTGRES_URL is required/);
});

test('shell runner rejects explicit local persistence in production', { skip }, () => {
  const result = runWithEnvironment([
    "RAG_PERSISTENCE_BACKEND='local'",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Production RAG persistence must use postgres/);
});

test('shell runner rejects dual-write persistence in production', { skip }, () => {
  const result = runWithEnvironment([
    "RAG_PERSISTENCE_BACKEND='dual-write'",
    "DATABASE_URL='postgresql:\/\/user:database-secret@127.0.0.1:5432/rag_system'",
    "RAG_DEFAULT_TENANT_ID='songuu-production'",
    "RAG_DEFAULT_CORPUS_ID='default'",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Production RAG persistence must use postgres/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /database-secret/);
});

test('shell runner rejects PostgreSQL persistence without canonical scope', { skip }, () => {
  const result = runWithEnvironment([
    "RAG_PERSISTENCE_BACKEND='postgres'",
    "DATABASE_URL='postgresql:\/\/user:database-secret@127.0.0.1:5432/rag_system'",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Valid RAG_DEFAULT_TENANT_ID and RAG_DEFAULT_CORPUS_ID are required/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /database-secret/);
});

test('shell runner rejects a non-PostgreSQL URL without leaking it', { skip }, () => {
  const result = runWithEnvironment([
    "RAG_PERSISTENCE_BACKEND='postgres'",
    "POSTGRES_URL='https:\/\/user:database-secret@db.example.invalid/rag_system'",
    "RAG_DEFAULT_TENANT_ID='songuu-production'",
    "RAG_DEFAULT_CORPUS_ID='default'",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must use the postgres or postgresql URL scheme/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /database-secret/);
});

test('shell runner rejects conflicting PostgreSQL aliases without leaking either URL', { skip }, () => {
  const result = runWithEnvironment([
    "RAG_PERSISTENCE_BACKEND='postgres'",
    "DATABASE_URL='postgres:\/\/user:first-secret@127.0.0.1:5432/rag_system'",
    "POSTGRES_URL='postgresql:\/\/user:second-secret@127.0.0.1:5432/rag_system'",
    "RAG_DEFAULT_TENANT_ID='songuu-production'",
    "RAG_DEFAULT_CORPUS_ID='default'",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must match when both are configured/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /first-secret|second-secret/);
});

test('shell runner rejects malformed tenant or corpus scope', { skip }, () => {
  const result = runWithEnvironment([
    "RAG_PERSISTENCE_BACKEND='postgres'",
    "POSTGRES_URL='postgresql:\/\/user:database-secret@127.0.0.1:5432/rag_system'",
    "RAG_DEFAULT_TENANT_ID='_unsafe'",
    "RAG_DEFAULT_CORPUS_ID='default'",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Valid RAG_DEFAULT_TENANT_ID and RAG_DEFAULT_CORPUS_ID are required/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /database-secret/);
});

test('shell runner accepts PostgreSQL persistence with URL and canonical scope', { skip }, () => {
  const result = runWithEnvironment([
    "RAG_PERSISTENCE_BACKEND='postgres'",
    "DATABASE_URL='  postgresql:\/\/user:database-secret@127.0.0.1:5432/rag_system  '",
    "POSTGRES_URL='postgresql:\/\/user:database-secret@127.0.0.1:5432/rag_system'",
    "RAG_DEFAULT_TENANT_ID='songuu-production:primary'",
    "RAG_DEFAULT_CORPUS_ID='default.v1'",
  ], [
    'test "$RAG_PERSISTENCE_BACKEND" = "postgres"',
    'test "$DATABASE_URL" = "postgresql://user:database-secret@127.0.0.1:5432/rag_system"',
    'test "$POSTGRES_URL" = "$DATABASE_URL"',
  ].join('\n'));

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /database-secret/);
});

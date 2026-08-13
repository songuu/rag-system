import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));

test('release gates pm2 save on full readiness after liveness', () => {
  const script = readFileSync(path.join(directory, 'release-host.sh'), 'utf8');
  const liveGate = script.indexOf('RAG release failed liveness');
  const readyProbe = script.indexOf('ready=$(curl --max-time 5 -fsS "$READY_URL")');
  const readyGate = script.indexOf('RAG release failed readiness');
  const save = script.lastIndexOf('pm2 save');

  assert.ok(liveGate >= 0);
  assert.ok(readyProbe > liveGate);
  assert.ok(readyGate > readyProbe);
  assert.ok(save > readyGate);
});

test('environment reload verifies readiness before updating last-known-good', () => {
  const script = readFileSync(path.join(directory, 'reload-rag-system-env.sh'), 'utf8');
  const readyGate = script.indexOf('if ! ready="$(wait_for_readiness)"');
  const lastGoodWrite = script.indexOf('cp -a "$ENV_FILE" "${LAST_GOOD_FILE}.next.$$"');

  assert.ok(readyGate >= 0);
  assert.ok(lastGoodWrite > readyGate);
  assert.match(script, /rollback "readiness did not recover" 1/);
});

test('first host release defaults to PostgreSQL and requires its runtime scope', () => {
  const release = readFileSync(path.join(directory, 'release-host.sh'), 'utf8');
  const reload = readFileSync(path.join(directory, 'reload-rag-system-env.sh'), 'utf8');
  const runner = readFileSync(path.join(directory, 'run-rag-system.sh'), 'utf8');

  assert.match(release, /^RAG_PERSISTENCE_BACKEND=postgres$/m);
  assert.doesNotMatch(release, /^RAG_PERSISTENCE_BACKEND=local$/m);
  for (const script of [release, reload, runner]) {
    assert.match(script, /validate_postgres_persistence\(\)/);
    assert.match(script, /DATABASE_URL or POSTGRES_URL is required/);
    assert.match(script, /must use the postgres or postgresql URL scheme/);
    assert.match(script, /must match when both are configured/);
    assert.match(script, /\^\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{0,127\}\$/);
    assert.match(script, /Production RAG persistence must use postgres/);
    assert.doesNotMatch(script, /postgres\|dual-write/);
  }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));

test('release gates pm2 save on full readiness after liveness', () => {
  const script = readFileSync(path.join(directory, 'release-host.sh'), 'utf8');
  const liveGate = script.indexOf('if ! live="$(wait_for_liveness)"');
  const readyProbe = script.indexOf('if ! ready="$(wait_for_readiness)"');
  const readyGate = script.indexOf('RAG release failed readiness', readyProbe);
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

test('host release provisions PostgreSQL before validating production persistence', () => {
  const script = readFileSync(path.join(directory, 'release-host.sh'), 'utf8');
  const environmentCreation = script.indexOf('if [[ ! -f "$ENV_FILE" ]]');
  const reloadLock = script.indexOf('flock 9');
  const environmentSnapshot = script.indexOf('  snapshot_database_environment\n');
  const provision = script.indexOf('"$POSTGRES_PROVISIONER" "$ENV_FILE" "$POSTGRES_MIGRATION_ENV_FILE"');
  const persistenceValidation = script.indexOf('Production RAG environment has incomplete persistence/provider configuration');

  assert.ok(reloadLock >= 0);
  assert.ok(environmentCreation > reloadLock);
  assert.ok(environmentSnapshot > environmentCreation);
  assert.ok(provision > environmentSnapshot);
  assert.ok(environmentCreation >= 0);
  assert.ok(persistenceValidation > provision);
  assert.match(script, /RAG_POSTGRES_PROVISIONER:-/);
  assert.match(script, /RAG_POSTGRES_MIGRATION_ENV_FILE:-/);
  assert.match(script, /RAG_ENV_RELOAD_LOCK_HELD:-0/);
  assert.match(script, /if \[\[ "\$ENV_RELOAD_LOCK_HELD" = "0" \]\]; then[\s\S]*flock 9/);
});

test('host release migrates a complete PostgreSQL artifact before atomic cutover', () => {
  const script = readFileSync(path.join(directory, 'release-host.sh'), 'utf8');
  const extract = script.indexOf('tar --no-same-owner --no-same-permissions -xzf "$ARTIFACT" -C "$release"');
  const artifactValidation = script.indexOf('Extracted release is missing PostgreSQL migration assets');
  const migrate = script.indexOf('node scripts/migrate-postgres.mjs');
  const cutover = script.indexOf('mv -Tf "$next_link" "$ROOT/current"');

  assert.ok(extract >= 0);
  assert.ok(artifactValidation > extract);
  assert.ok(migrate > artifactValidation);
  assert.ok(cutover > migrate);
  assert.match(script, /db\/postgres\/bootstrap\.sql/);
  assert.match(script, /db\/postgres\/migrations\/\*\.sql/);
  assert.match(script, /scripts\/migrate-postgres\.mjs/);
  assert.match(script, /scripts\/backfill-local-postgres\.mjs/);
  assert.match(script, /tar --no-same-owner --no-same-permissions -xzf "\$ARTIFACT" -C "\$release"/);
  assert.match(script, /chown -R root:root -- "\$release"/);
  assert.match(script, /chmod -R go-w -- "\$release"/);
  assert.match(script, /Release artifact contains an unsafe file type or symbolic link/);
});

test('migration-only credentials are scoped to migration and backfill subprocesses', () => {
  const script = readFileSync(path.join(directory, 'release-host.sh'), 'utf8');
  const migrationSource = '. "$POSTGRES_MIGRATION_ENV_FILE"';
  const migration = script.indexOf('node scripts/migrate-postgres.mjs');
  const backfillFunction = script.match(/run_local_backfill\(\) \{[\s\S]*?\n\}/);
  const sourceOffsets = [...script.matchAll(/\. "\$POSTGRES_MIGRATION_ENV_FILE"/g)]
    .map((match) => match.index ?? -1);

  assert.ok(migration >= 0);
  assert.ok(backfillFunction);
  assert.equal(sourceOffsets.length, 2);
  assert.ok(sourceOffsets.some((offset) => offset < migration));
  assert.ok(backfillFunction[0].includes(migrationSource));
});

test('legacy local uploads are fenced, transactionally backfilled, and verified before cutover', () => {
  const script = readFileSync(path.join(directory, 'release-host.sh'), 'utf8');
  const migrate = script.indexOf('node scripts/migrate-postgres.mjs');
  const legacyGate = script.indexOf('if [[ "$legacy_local_runtime" = true ]]');
  const resetReceipt = script.indexOf('run_local_backfill --reset-receipt', legacyGate);
  const check = script.indexOf('run_local_backfill --check');
  const apply = script.indexOf('run_local_backfill --apply', check);
  const readback = script.indexOf('run_local_backfill --check', apply);
  const cutover = script.indexOf('mv -Tf "$next_link" "$ROOT/current"');
  const fenceFunction = script.match(/fence_previous_process\(\) \{[\s\S]*?\n\}/);

  assert.ok(legacyGate > migrate);
  assert.ok(resetReceipt > legacyGate);
  assert.ok(check > resetReceipt);
  assert.ok(apply > check);
  assert.ok(readback > apply);
  assert.ok(cutover > readback);
  assert.ok(fenceFunction);
  assert.match(fenceFunction[0], /if ! pm2 delete rag-system/);
  assert.match(fenceFunction[0], /wait_for_rag_runtime_shutdown/);
  assert.match(script, /pm2_entry_exists\(\)/);
  assert.match(script, /pm2 jlist/);
  assert.match(script, /wait_for_rag_runtime_shutdown\(\)/);
  assert.match(script, /is_rag_port_reachable/);
  assert.match(script, /curl --connect-timeout 1 --max-time 1 -fsS/);
  assert.match(script, /old_process_fenced=true/);
  assert.match(script, /resume_previous_process_after_backfill_failure/);
  assert.match(script, /test "\$\{RAG_PERSISTENCE_BACKEND:-local\}" = "local"/);
  assert.match(script, /Local upload backfill failed before release cutover/);
  assert.match(script, /Local upload backfill readback failed before release cutover/);
});

test('failed release restores the previous database environment before reloading the previous app', () => {
  const script = readFileSync(path.join(directory, 'release-host.sh'), 'utf8');
  const rollback = script.match(/rollback\(\) \{[\s\S]*?\n\}/);

  assert.ok(rollback);
  const restore = rollback[0].indexOf('restore_database_environment');
  const symlink = rollback[0].indexOf('mv -Tf "$rollback_link" "$ROOT/current"');
  const reload = rollback[0].indexOf('reload_rag_process');
  const verify = rollback[0].indexOf('wait_for_readiness');
  assert.ok(restore >= 0);
  assert.ok(symlink > restore);
  assert.ok(reload > symlink);
  assert.ok(verify > reload);
  assert.match(script, /trap release_exit_trap EXIT/);
  assert.match(script, /release_committed=true[\s\S]*trap - EXIT/);
});

test('host defaults participate in the atomic release environment snapshot', () => {
  const script = readFileSync(path.join(directory, 'release-host.sh'), 'utf8');
  const snapshotFunction = script.match(/snapshot_database_environment\(\) \{[\s\S]*?\n\}/);
  const restoreFunction = script.match(/restore_database_environment\(\) \{[\s\S]*?\n\}/);
  const atomicRestoreFunction = script.match(/restore_or_remove_environment_file\(\) \{[\s\S]*?\n\}/);
  const render = script.indexOf('python3 "$DEFAULTS_RENDERER" "$DEFAULTS_EXAMPLE"');
  const snapshotBeforeRender = script.lastIndexOf('snapshot_database_environment', render);

  assert.ok(snapshotFunction);
  assert.ok(restoreFunction);
  assert.ok(atomicRestoreFunction);
  assert.ok(snapshotBeforeRender >= 0);
  assert.ok(snapshotBeforeRender < render);
  assert.match(snapshotFunction[0], /defaults_snapshot=.*mktemp/);
  assert.match(snapshotFunction[0], /defaults_existed_before_release=true/);
  assert.match(restoreFunction[0], /"\$DEFAULTS_FILE" "\$defaults_snapshot" "\$defaults_existed_before_release"/);
  assert.match(atomicRestoreFunction[0], /mv -f -- "\$stage" "\$target"/);
  assert.match(atomicRestoreFunction[0], /rm -f -- "\$target"/);
});

test('optional post-release gate is path constrained and participates in rollback', () => {
  const script = readFileSync(path.join(directory, 'release-host.sh'), 'utf8');
  const ready = script.indexOf('if ! ready="$(wait_for_readiness)"');
  const verify = script.indexOf('run_post_release_gate verify "$release" "$previous"');
  const save = script.lastIndexOf('pm2 save');
  const commit = script.indexOf('release_committed=true');
  const rollback = script.match(/rollback\(\) \{[\s\S]*?\n\}/);

  assert.ok(ready >= 0);
  assert.ok(verify > ready);
  assert.ok(save > verify);
  assert.ok(commit > save);
  assert.ok(rollback);
  assert.match(script, /RAG_POST_RELEASE_GATE:-/);
  assert.match(script, /RAG_RELEASE_GATE_ROOT:-/);
  assert.match(script, /readlink -f -- "\$POST_RELEASE_GATE"/);
  assert.match(script, /Post-release gate must be contained by its verified root/);
  assert.match(script, /Post-release gate must be a direct child of its verified root/);
  assert.match(script, /! -user root -o ! -group root -o -perm \/022/);
  assert.match(rollback[0], /run_post_release_gate rollback "\$previous" "\$release"/);
});

test('failed first release removes only its own current link and PM2 process', () => {
  const script = readFileSync(path.join(directory, 'release-host.sh'), 'utf8');
  const rollback = script.match(/rollback\(\) \{[\s\S]*?\n\}/);

  assert.ok(rollback);
  assert.match(rollback[0], /current_target="\$\(readlink -f "\$ROOT\/current" 2>\/dev\/null \|\| true\)"/);
  assert.match(rollback[0], /\[\[ "\$current_target" = "\$release" \]\]/);
  assert.match(rollback[0], /rm -f -- "\$ROOT\/current"/);
  assert.match(rollback[0], /if ! pm2 delete rag-system/);
  assert.match(rollback[0], /if ! wait_for_rag_runtime_shutdown; then[\s\S]*rollback_failed=1/);
});

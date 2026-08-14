import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const provisioner = path.join(directory, 'provision-postgres-host.sh');
const windowsGitBash = 'C:/Apps/Git/bin/bash.exe';
const bash = process.platform === 'win32' ? windowsGitBash : 'bash';
const skip = process.platform === 'win32' && !existsSync(windowsGitBash);
const ownerPassword = 'a'.repeat(64);
const appPassword = 'b'.repeat(64);
const adminPassword = 'c'.repeat(64);

function createFixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'rag-postgres-provision-'));
  const root = path.join(temp, 'rag-system');
  const shared = path.join(root, 'shared');
  const bin = path.join(temp, 'bin');
  const fakeState = path.join(temp, 'fake-state');
  mkdirSync(shared, { recursive: true });
  mkdirSync(bin);
  mkdirSync(fakeState);
  chmodSync(root, 0o755);
  chmodSync(shared, 0o755);

  writeExecutable(path.join(bin, 'openssl'), `#!/usr/bin/env bash
set -euo pipefail
count_file="$FAKE_STATE/openssl-count"
count=0
[[ ! -f "$count_file" ]] || count=$(cat "$count_file")
count=$((count + 1))
printf '%s' "$count" > "$count_file"
case "$count" in
  1) printf '%s\\n' '${ownerPassword}' ;;
  2) printf '%s\\n' '${appPassword}' ;;
  *) printf '%s\\n' '${adminPassword}' ;;
esac
`);

  writeExecutable(path.join(bin, 'flock'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_STATE/flock-calls"
[[ ! -f "$FAKE_STATE/fail-flock" ]]
`);

  writeExecutable(path.join(bin, 'ss'), `#!/usr/bin/env bash
set -euo pipefail
if [[ -f "$FAKE_STATE/port-conflict" ]]; then
  printf '%s\\n' 'LISTEN 0 128 127.0.0.1:25432 0.0.0.0:*'
fi
`);

  writeExecutable(path.join(bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_STATE/docker-calls"
command_name="\${1:-}"
shift || true
case "$command_name" in
  info)
    exit 0
    ;;
  container)
    [[ "\${1:-}" = inspect ]] || exit 91
    [[ -f "$FAKE_STATE/container" ]]
    ;;
  inspect)
    template=""
    if [[ "\${1:-}" = --format ]]; then
      template="$2"
      shift 2
    fi
    state=$(cat "$FAKE_STATE/container")
    if [[ "$state" = conflict ]]; then
      case "$template" in
        *com.songuu.rag-system.postgres*) printf '%s\\n' 'foreign' ;;
        *Config.Image*) printf '%s\\n' 'redis:7' ;;
        *) printf '%s\\n' 'invalid' ;;
      esac
      exit 0
    fi
    case "$template" in
      *com.songuu.rag-system.postgres*) printf '%s\\n' 'managed-v2' ;;
      *POSTGRES_USER=postgres*) printf '%s\\n' 'postgres' ;;
      *POSTGRES_DB=rag_system*) printf '%s\\n' 'rag_system' ;;
      *Config.Image*) printf '%s\\n' 'postgres:17-bookworm@sha256:9b18b78397054fce88a9552e9d5a3ad5bb7fd258c5b3cc1c5028e46373d6ea8f' ;;
      *Mounts*) printf '%s\\n' 'rag-system-postgres-data' ;;
      *PortBindings*)
        printf '%s\\n' '127.0.0.1|25432'
        [[ ! -f "$FAKE_STATE/multiple-bindings" ]] || printf '%s\\n' '0.0.0.0|25432'
        ;;
      *RestartPolicy*) printf '%s\\n' 'unless-stopped' ;;
      *State.Running*) printf '%s\\n' 'true' ;;
      *) exit 92 ;;
    esac
    ;;
  volume)
    case "\${1:-}" in
      inspect) [[ -f "$FAKE_STATE/volume" ]] ;;
      create) : > "$FAKE_STATE/volume"; printf '%s\\n' 'rag-system-postgres-data' ;;
      *) exit 93 ;;
    esac
    ;;
  run)
    [[ ! -f "$FAKE_STATE/fail-run" ]] || exit 1
    previous=''
    for argument in "$@"; do
      if [[ "$previous" = --env-file ]]; then
        cp "$argument" "$FAKE_STATE/container-env"
      fi
      previous="$argument"
    done
    : > "$FAKE_STATE/container"
    printf '%s\\n' 'fake-container-id'
    ;;
  start)
    printf '%s\\n' 'rag-system-postgres'
    ;;
  exec)
    if [[ " $* " = *' pg_isready '* ]]; then
      [[ ! -f "$FAKE_STATE/fail-ready" ]]
      exit
    fi
    if [[ " $* " = *' psql '* ]]; then
      input=$(cat)
      printf '%s' "$input" > "$FAKE_STATE/psql-input"
      [[ ! -f "$FAKE_STATE/fail-psql" ]]
      exit
    fi
    exit 94
    ;;
  *) exit 95 ;;
esac
`);

  const runtime = path.join(shared, '.env.prod');
  const migration = path.join(shared, '.env.postgres-migration');
  return { temp, root, shared, bin, fakeState, runtime, migration };
}

function writeExecutable(filename, contents) {
  writeFileSync(filename, contents, 'utf8');
  chmodSync(filename, 0o700);
}

function writeSecretFile(filename, contents) {
  writeFileSync(filename, contents, 'utf8');
  chmodSync(filename, 0o600);
}

function runProvisioner(fixture) {
  return spawnSync(
    bash,
    [
      '--noprofile',
      '--norc',
      '-c',
      'PATH="$1:$PATH"; export PATH; exec "$2" "$3" "$4"',
      'postgres-provision-test',
      fixture.bin,
      provisioner,
      fixture.runtime,
      fixture.migration,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        RAG_POSTGRES_ROOT: fixture.root,
        FAKE_STATE: fixture.fakeState,
        RAG_POSTGRES_READY_ATTEMPTS: '2',
        RAG_POSTGRES_READY_INTERVAL: '0',
      },
    }
  );
}

function assertMode(filename, expected) {
  if (process.platform !== 'win32') {
    assert.equal(statSync(filename).mode & 0o777, expected);
  }
}

test('provisions a dedicated PostgreSQL container and separate runtime and migration secrets', { skip }, () => {
  const fixture = createFixture();
  try {
    const result = runProvisioner(fixture);

    assert.equal(result.status, 0, result.stderr);
    const runtime = readFileSync(fixture.runtime, 'utf8');
    const migration = readFileSync(fixture.migration, 'utf8');
    const calls = readFileSync(path.join(fixture.fakeState, 'docker-calls'), 'utf8');
    const containerEnvironment = readFileSync(path.join(fixture.fakeState, 'container-env'), 'utf8');
    const credentialState = readFileSync(path.join(fixture.shared, '.postgres-host', 'credentials.env'), 'utf8');
    assert.match(runtime, /^RAG_PERSISTENCE_BACKEND='postgres'$/m);
    assert.match(runtime, new RegExp(`^POSTGRES_URL='postgresql://rag_app:${appPassword}@127\\.0\\.0\\.1:25432/rag_system'$`, 'm'));
    assert.match(runtime, /^POSTGRES_SSL_MODE='disable'$/m);
    assert.match(runtime, /^RAG_DEFAULT_TENANT_ID='songuu-production'$/m);
    assert.match(runtime, /^RAG_DEFAULT_CORPUS_ID='default'$/m);
    assert.doesNotMatch(runtime, /POSTGRES_MIGRATION_URL|rag_owner/);
    assert.match(migration, new RegExp(`^POSTGRES_MIGRATION_URL='postgresql://rag_owner:${ownerPassword}@127\\.0\\.0\\.1:25432/rag_system'$`, 'm'));
    assert.match(migration, /^POSTGRES_APP_ROLE='rag_app'$/m);
    assert.doesNotMatch(migration, new RegExp(`${appPassword}|${adminPassword}`));
    assert.match(containerEnvironment, /^POSTGRES_USER=postgres$/m);
    assert.match(containerEnvironment, new RegExp(`^POSTGRES_PASSWORD=${adminPassword}$`, 'm'));
    assert.doesNotMatch(containerEnvironment, new RegExp(`${ownerPassword}|${appPassword}`));
    assert.equal(credentialState, [
      `OWNER_PASSWORD=${ownerPassword}`,
      `APP_PASSWORD=${appPassword}`,
      `ADMIN_PASSWORD=${adminPassword}`,
      '',
    ].join('\n'));
    assert.match(calls, /--name rag-system-postgres/);
    assert.match(calls, /127\.0\.0\.1:25432:5432/);
    assert.match(calls, /rag-system-postgres-data:\/var\/lib\/postgresql\/data/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}\n${calls}`, new RegExp(`${ownerPassword}|${appPassword}|${adminPassword}`));
    const roleSql = readFileSync(path.join(fixture.fakeState, 'psql-input'), 'utf8');
    assert.match(calls, /exec -i rag-system-postgres psql .*--username postgres/);
    assert.match(roleSql, /CREATE ROLE rag_owner WITH LOGIN/);
    assert.match(roleSql, /ALTER ROLE rag_owner WITH LOGIN PASSWORD '[a-f0-9]+' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT NOBYPASSRLS/);
    assert.match(roleSql, /ALTER ROLE rag_app WITH LOGIN PASSWORD '[a-f0-9]+' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT NOBYPASSRLS/);
    assert.match(roleSql, /ALTER DATABASE rag_system OWNER TO rag_owner/);
    assert.match(roleSql, /ALTER SCHEMA public OWNER TO rag_owner/);
    assert.match(roleSql, /GRANT rag_app TO rag_owner WITH ADMIN TRUE, SET FALSE, INHERIT FALSE/);
    assert.match(roleSql, /pg_auth_members membership/);
    assert.match(roleSql, /NOT rolcreaterole/);
    assert.match(roleSql, /ALTER ROLE postgres WITH LOGIN PASSWORD/);
    assert.doesNotMatch(roleSql, /ALTER ROLE rag_owner[^;]*\bCREATEROLE\b/);
    assert.match(roleSql, /^BEGIN;[\s\S]*COMMIT;$/);
    assert.match(readFileSync(path.join(fixture.fakeState, 'flock-calls'), 'utf8'), /^-n [0-9]+$/m);
    const provisionerSource = readFileSync(provisioner, 'utf8');
    assert.match(provisionerSource, /3<<< "\$managed_runtime_url"/);
    assert.doesNotMatch(provisionerSource, /bash "\$RUNTIME_ENV" "\$managed_runtime_url"/);
    assertMode(fixture.runtime, 0o600);
    assertMode(fixture.migration, 0o600);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('atomically cuts over an eligible PostgreSQL placeholder and is idempotent', { skip }, () => {
  const fixture = createFixture();
  try {
    writeSecretFile(fixture.runtime, [
      '# keep this comment',
      "UNRELATED_SETTING='preserved'",
      "RAG_PERSISTENCE_BACKEND='postgres'",
      "RAG_DEFAULT_TENANT_ID='songuu-production'",
      "RAG_DEFAULT_CORPUS_ID='default'",
      '',
    ].join('\n'));

    const first = runProvisioner(fixture);
    assert.equal(first.status, 0, first.stderr);
    const firstRuntime = readFileSync(fixture.runtime, 'utf8');
    const firstMigration = readFileSync(fixture.migration, 'utf8');
    const second = runProvisioner(fixture);

    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(fixture.runtime, 'utf8'), firstRuntime);
    assert.equal(readFileSync(fixture.migration, 'utf8'), firstMigration);
    assert.match(firstRuntime, /^# keep this comment$/m);
    assert.match(firstRuntime, /^UNRELATED_SETTING='preserved'$/m);
    assert.equal((firstRuntime.match(/^POSTGRES_URL=/gm) ?? []).length, 1);
    assert.equal((firstRuntime.match(/^RAG_PERSISTENCE_BACKEND=/gm) ?? []).length, 1);
    assert.equal((firstRuntime.match(/^# BEGIN managed PostgreSQL host$/gm) ?? []).length, 1);
    assert.equal(readFileSync(path.join(fixture.fakeState, 'openssl-count'), 'utf8'), '3');
    const calls = readFileSync(path.join(fixture.fakeState, 'docker-calls'), 'utf8');
    assert.equal((calls.match(/^run /gm) ?? []).length, 1);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('does not overwrite environment files when database role setup fails', { skip }, () => {
  const fixture = createFixture();
  try {
    const originalRuntime = "RAG_PERSISTENCE_BACKEND='local'\nKEEP='runtime'\n";
    const originalMigration = "KEEP='migration'\n";
    writeSecretFile(fixture.runtime, originalRuntime);
    writeSecretFile(fixture.migration, originalMigration);
    writeFileSync(path.join(fixture.fakeState, 'fail-psql'), '1');

    const result = runProvisioner(fixture);

    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(fixture.runtime, 'utf8'), originalRuntime);
    assert.equal(readFileSync(fixture.migration, 'utf8'), originalMigration);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(`${ownerPassword}|${appPassword}|${adminPassword}`));

    rmSync(path.join(fixture.fakeState, 'fail-psql'));
    const retry = runProvisioner(fixture);
    assert.equal(retry.status, 0, retry.stderr);
    assert.match(readFileSync(fixture.runtime, 'utf8'), /^RAG_PERSISTENCE_BACKEND='postgres'$/m);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('rejects a conflicting same-name container without replacing the runtime environment', { skip }, () => {
  const fixture = createFixture();
  try {
    const originalRuntime = "KEEP='runtime'\n";
    writeSecretFile(fixture.runtime, originalRuntime);
    writeFileSync(path.join(fixture.fakeState, 'container'), 'conflict');

    const result = runProvisioner(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /conflicts with the managed PostgreSQL contract/);
    assert.equal(readFileSync(fixture.runtime, 'utf8'), originalRuntime);
    assert.equal(existsSync(fixture.migration), false);
    assert.doesNotMatch(readFileSync(path.join(fixture.fakeState, 'docker-calls'), 'utf8'), /^rm |^volume rm /m);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('rejects a listener on the dedicated host port without deleting external state', { skip }, () => {
  const fixture = createFixture();
  try {
    const originalRuntime = "KEEP='runtime'\n";
    writeSecretFile(fixture.runtime, originalRuntime);
    writeFileSync(path.join(fixture.fakeState, 'port-conflict'), '1');

    const result = runProvisioner(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Host port 25432 is already in use/);
    assert.equal(readFileSync(fixture.runtime, 'utf8'), originalRuntime);
    assert.equal(existsSync(fixture.migration), false);
    assert.equal(existsSync(path.join(fixture.shared, '.postgres-host', 'credentials.env')), false);
    const callsPath = path.join(fixture.fakeState, 'docker-calls');
    if (existsSync(callsPath)) {
      assert.doesNotMatch(readFileSync(callsPath, 'utf8'), /^run |^rm |^volume rm /m);
    }
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('does not mint credentials that could make an unrelated existing volume adoptable', { skip }, () => {
  const fixture = createFixture();
  try {
    writeFileSync(path.join(fixture.fakeState, 'volume'), 'unmanaged-existing-volume');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = runProvisioner(fixture);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /exists without its protected credential state/);
      assert.equal(existsSync(path.join(fixture.shared, '.postgres-host', 'credentials.env')), false);
      assert.equal(existsSync(fixture.runtime), false);
      assert.equal(existsSync(fixture.migration), false);
    }
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('rejects environment files outside the protected shared directory', { skip }, () => {
  const fixture = createFixture();
  try {
    fixture.runtime = path.join(fixture.root, '.env.prod');
    const originalRuntime = "KEEP='outside'\n";
    writeSecretFile(fixture.runtime, originalRuntime);

    const result = runProvisioner(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /direct children of the protected shared directory/);
    assert.equal(readFileSync(fixture.runtime, 'utf8'), originalRuntime);
    assert.equal(existsSync(fixture.migration), false);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('rejects incomplete or repeated managed environment blocks before Docker side effects', { skip }, () => {
  for (const contents of [
    "KEEP='runtime'\n# BEGIN managed PostgreSQL host\nPOSTGRES_URL='broken'\n",
    [
      '# BEGIN managed PostgreSQL host',
      "POSTGRES_URL='first'",
      '# END managed PostgreSQL host',
      '# BEGIN managed PostgreSQL host',
      "POSTGRES_URL='second'",
      '# END managed PostgreSQL host',
      '',
    ].join('\n'),
    [
      "POSTGRES_URL='shadowed-outside-marker'",
      '# BEGIN managed PostgreSQL host',
      "RAG_PERSISTENCE_BACKEND='postgres'",
      '# END managed PostgreSQL host',
      '',
    ].join('\n'),
  ]) {
    const fixture = createFixture();
    try {
      writeSecretFile(fixture.runtime, contents);

      const result = runProvisioner(fixture);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /managed PostgreSQL block is incomplete, repeated, or shadowed/);
      assert.equal(readFileSync(fixture.runtime, 'utf8'), contents);
      assert.equal(existsSync(fixture.migration), false);
      assert.equal(existsSync(path.join(fixture.fakeState, 'docker-calls')), false);
    } finally {
      rmSync(fixture.temp, { recursive: true, force: true });
    }
  }
});

test('rejects external database URLs, custom scopes, and unsupported cutover backends before Docker', { skip }, () => {
  for (const contents of [
    [
      "RAG_PERSISTENCE_BACKEND='postgres'",
      "POSTGRES_URL='postgresql://external:secret@db.example.invalid/rag_system'",
      "RAG_DEFAULT_TENANT_ID='songuu-production'",
      "RAG_DEFAULT_CORPUS_ID='default'",
      '',
    ].join('\n'),
    [
      "RAG_PERSISTENCE_BACKEND='postgres'",
      "RAG_DEFAULT_TENANT_ID='custom-tenant'",
      "RAG_DEFAULT_CORPUS_ID='default'",
      '',
    ].join('\n'),
    "RAG_PERSISTENCE_BACKEND='dual-write'\n",
  ]) {
    const fixture = createFixture();
    try {
      writeSecretFile(fixture.runtime, contents);

      const result = runProvisioner(fixture);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /not eligible for managed PostgreSQL cutover/);
      assert.equal(readFileSync(fixture.runtime, 'utf8'), contents);
      assert.equal(existsSync(fixture.migration), false);
      assert.equal(existsSync(path.join(fixture.fakeState, 'docker-calls')), false);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /external:secret|custom-tenant/);
    } finally {
      rmSync(fixture.temp, { recursive: true, force: true });
    }
  }
});

test('rejects drift inside a managed runtime without touching Docker or environment files', { skip }, () => {
  const fixture = createFixture();
  try {
    const first = runProvisioner(fixture);
    assert.equal(first.status, 0, first.stderr);
    const baseline = readFileSync(fixture.runtime, 'utf8');
    const drifted = baseline.replace(
      "POSTGRES_URL='postgresql://rag_app:",
      "POSTGRES_URL='postgresql://drifted:"
    );
    writeSecretFile(fixture.runtime, drifted);
    const callsBefore = readFileSync(path.join(fixture.fakeState, 'docker-calls'), 'utf8');

    const result = runProvisioner(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime configuration has drifted/);
    assert.equal(readFileSync(fixture.runtime, 'utf8'), drifted);
    assert.equal(readFileSync(path.join(fixture.fakeState, 'docker-calls'), 'utf8'), callsBefore);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(`${ownerPassword}|${appPassword}|${adminPassword}`));
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('uses a non-stale fd lock and can retry after lock contention', { skip }, () => {
  const fixture = createFixture();
  try {
    writeFileSync(path.join(fixture.fakeState, 'fail-flock'), '1');

    const blocked = runProvisioner(fixture);

    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /provisioning process is already active/);
    assert.equal(existsSync(path.join(fixture.fakeState, 'docker-calls')), false);

    rmSync(path.join(fixture.fakeState, 'fail-flock'));
    const retry = runProvisioner(fixture);
    assert.equal(retry.status, 0, retry.stderr);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('rejects a managed container with an additional public port binding', { skip }, () => {
  const fixture = createFixture();
  try {
    const first = runProvisioner(fixture);
    assert.equal(first.status, 0, first.stderr);
    writeFileSync(path.join(fixture.fakeState, 'multiple-bindings'), '1');
    const runtime = readFileSync(fixture.runtime, 'utf8');

    const result = runProvisioner(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /conflicts with the managed PostgreSQL contract/);
    assert.equal(readFileSync(fixture.runtime, 'utf8'), runtime);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

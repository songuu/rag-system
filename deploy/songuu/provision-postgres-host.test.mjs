import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
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
const retiredVendorPrefix = ['SUPA', 'BASE_'].join('');

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
printf '%s\\n' "$*" >> "$FAKE_STATE/openssl-calls"
case "\${1:-}" in
  rand)
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
    ;;
  genpkey|req|x509|pkey)
    output=''
    previous=''
    for argument in "$@"; do
      if [[ "$previous" = -out ]]; then output="$argument"; fi
      if [[ "$previous" = -extfile ]]; then cp "$argument" "$FAKE_STATE/server-ext"; fi
      previous="$argument"
    done
    if [[ -n "$output" ]]; then
      if [[ " $* " = *' -pubout '* || " $* " = *' -pubkey '* ]]; then
        printf '%s\\n' 'fake-public-key' > "$output"
      else
        printf '%s\\n' "fake-openssl-\${1}" > "$output"
      fi
    fi
    ;;
  verify) exit 0 ;;
  *) exit 96 ;;
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

  writeExecutable(path.join(bin, 'chown'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_STATE/chown-calls"
`);

  writeExecutable(path.join(bin, 'sync'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_STATE/sync-calls"
[[ ! -f "$FAKE_STATE/fail-sync" ]]
`);

  writeExecutable(path.join(bin, 'rm'), `#!/usr/bin/env bash
set -euo pipefail
if [[ -f "$FAKE_STATE/fail-snapshot-cleanup" && " $* " = *public-cutover-snapshot* ]]; then
  exit 1
fi
if [[ -f "$FAKE_STATE/fail-marker-cleanup" && " $* " = *public-cutover.pending* ]]; then
  exit 1
fi
exec /usr/bin/rm "$@"
`);

  writeExecutable(path.join(bin, 'mv'), `#!/usr/bin/env bash
set -euo pipefail
destination="\${!#}"
if [[ -f "$FAKE_STATE/fail-activate-runtime-mv" && "$destination" = */shared/.env.prod ]]; then
  exit 1
fi
exec /usr/bin/mv "$@"
`);

  writeExecutable(path.join(bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_STATE/docker-calls"
command_name="\${1:-}"
shift || true

state_file_for_name() {
  case "$1" in
    rag-system-postgres) printf '%s\\n' "$FAKE_STATE/container" ;;
    rag-system-postgres-loopback-backup) printf '%s\\n' "$FAKE_STATE/backup-container" ;;
    *) return 1 ;;
  esac
}

case "$command_name" in
  info)
    exit 0
    ;;
  container)
    [[ "\${1:-}" = inspect ]] || exit 91
    file=$(state_file_for_name "\${2:-}") || exit 1
    [[ -f "$file" ]]
    ;;
  inspect)
    template=""
    if [[ "\${1:-}" = --format ]]; then
      template="$2"
      shift 2
    fi
    name="\${1:-}"
    file=$(state_file_for_name "$name") || exit 1
    [[ -f "$file" ]] || exit 1
    state=$(cat "$file")
    if [[ "$state" = conflict ]]; then
      case "$template" in
        *com.songuu.rag-system.postgres*) printf '%s\\n' 'foreign' ;;
        *Config.Image*) printf '%s\\n' 'redis:7' ;;
        *) printf '%s\\n' 'invalid' ;;
      esac
      exit 0
    fi
    case "$template" in
      *com.songuu.rag-system.postgres*) printf '%s\\n' "$state" ;;
      *POSTGRES_USER=postgres*) printf '%s\\n' 'postgres' ;;
      *POSTGRES_DB=rag_system*) printf '%s\\n' 'rag_system' ;;
      *Config.Image*) printf '%s\\n' 'postgres:17-bookworm@sha256:9b18b78397054fce88a9552e9d5a3ad5bb7fd258c5b3cc1c5028e46373d6ea8f' ;;
      *'len .Mounts'*)
        [[ "$state" = managed-v3 ]] && printf '%s\\n' '2' || printf '%s\\n' '1'
        ;;
      *'/run/rag-system-postgresql'*)
        [[ "$state" = managed-v3 ]] && printf 'bind|%s\\n' "$(cat "$FAKE_STATE/socket-source")"
        ;;
      *Mounts*) printf '%s\\n' 'rag-system-postgres-data' ;;
      *PortBindings*)
        if [[ "$state" = managed-v3 ]]; then
          printf '%s\\n' '0.0.0.0|25432'
          [[ ! -f "$FAKE_STATE/multiple-bindings" ]] || printf '%s\\n' '127.0.0.1|25432'
        else
          printf '%s\\n' '127.0.0.1|25432'
          [[ ! -f "$FAKE_STATE/multiple-bindings" ]] || printf '%s\\n' '0.0.0.0|25432'
        fi
        ;;
      *RestartPolicy*) printf '%s\\n' 'unless-stopped' ;;
      *'json .Config.Healthcheck.Test'*)
        if [[ "$state" = managed-v3 ]]; then
          printf '%s\\n' '["CMD-SHELL","pg_isready --host=/run/rag-system-postgresql -U postgres -d rag_system"]'
        else
          printf '%s\\n' '["CMD-SHELL","pg_isready -U postgres -d rag_system"]'
        fi
        ;;
      *HostConfig.MemorySwap*) [[ "$state" = managed-v3 ]] && printf '%s\\n' '1073741824' || printf '%s\\n' '0' ;;
      *HostConfig.Memory*) [[ "$state" = managed-v3 ]] && printf '%s\\n' '1073741824' || printf '%s\\n' '0' ;;
      *HostConfig.NanoCpus*) [[ "$state" = managed-v3 ]] && printf '%s\\n' '1500000000' || printf '%s\\n' '0' ;;
      *HostConfig.ShmSize*) [[ "$state" = managed-v3 ]] && printf '%s\\n' '268435456' || printf '%s\\n' '67108864' ;;
      *'LogConfig.Type'*) printf '%s\\n' 'json-file' ;;
      *'max-size'*) [[ "$state" = managed-v3 ]] && printf '%s\\n' '20m' ;;
      *'max-file'*) [[ "$state" = managed-v3 ]] && printf '%s\\n' '3' ;;
      *State.Running*)
        stopped_file="$file.stopped"
        [[ ! -f "$stopped_file" ]] && printf '%s\\n' 'true' || printf '%s\\n' 'false'
        ;;
      *NetworkSettings.Networks*) printf '%s\\n' '172.17.0.1' ;;
      *'json .Config.Cmd'*)
        if [[ -f "$FAKE_STATE/command-drift" ]]; then
          printf '%s\\n' '["postgres"]'
        elif [[ "$state" = managed-v3 ]]; then
          printf '%s\\n' '["postgres","-c","listen_addresses=*","-c","ssl=on","-c","ssl_min_protocol_version=TLSv1.3","-c","ssl_cert_file=/var/lib/postgresql/data/rag-tls/server.crt","-c","ssl_key_file=/var/lib/postgresql/data/rag-tls/server.key","-c","ssl_ca_file=/var/lib/postgresql/data/rag-tls/ca.crt","-c","password_encryption=scram-sha-256","-c","authentication_timeout=10s","-c","hba_file=/var/lib/postgresql/data/rag-tls/pg_hba.conf","-c","unix_socket_directories=/run/rag-system-postgresql","-c","unix_socket_permissions=0700"]'
        else
          printf '%s\\n' '["postgres"]'
        fi
        ;;
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
    is_public=false
    name=''
    label=''
    previous=''
    for argument in "$@"; do
      if [[ "$previous" = --env-file ]]; then
        cp "$argument" "$FAKE_STATE/container-env"
      fi
      if [[ "$previous" = --name ]]; then name="$argument"; fi
      if [[ "$previous" = --label ]]; then label="$argument"; fi
      if [[ "$previous" = --publish && "$argument" = '0.0.0.0:25432:5432' ]]; then is_public=true; fi
      if [[ "$previous" = --volume && "$argument" = *':/run/rag-system-postgresql' ]]; then
        printf '%s' "\${argument%:/run/rag-system-postgresql}" > "$FAKE_STATE/socket-source"
      fi
      previous="$argument"
    done
    [[ "$name" = rag-system-postgres ]] || exit 97
    if [[ "$is_public" = true ]]; then
      [[ ! -f "$FAKE_STATE/fail-public-run" ]] || exit 1
      [[ "$label" = 'com.songuu.rag-system.postgres=managed-v3' ]] || exit 98
      printf '%s' 'managed-v3' > "$FAKE_STATE/container"
    else
      printf '%s' 'managed-v2' > "$FAKE_STATE/container"
    fi
    printf '%s\\n' 'fake-container-id'
    ;;
  start)
    file=$(state_file_for_name "\${1:-}") || exit 1
    rm -f -- "$file.stopped"
    printf '%s\\n' "\${1:-}"
    ;;
  stop)
    file=$(state_file_for_name "\${1:-}") || exit 1
    [[ -f "$file" ]] || exit 1
    : > "$file.stopped"
    if [[ -f "$FAKE_STATE/kill-after-legacy-stop" ]]; then
      kill -KILL "$PPID"
      exit 137
    fi
    printf '%s\\n' "\${1:-}"
    ;;
  rename)
    old_file=$(state_file_for_name "\${1:-}") || exit 1
    new_file=$(state_file_for_name "\${2:-}") || exit 1
    [[ -f "$old_file" && ! -f "$new_file" ]] || exit 1
    mv "$old_file" "$new_file"
    if [[ -f "$old_file.stopped" ]]; then mv "$old_file.stopped" "$new_file.stopped"; fi
    ;;
  rm)
    name="\${!#}"
    file=$(state_file_for_name "$name") || exit 1
    if [[ "$name" = rag-system-postgres-loopback-backup && -f "$FAKE_STATE/fail-backup-rm" ]]; then
      exit 1
    fi
    if [[ "$name" = rag-system-postgres-loopback-backup && -f "$FAKE_STATE/fail-backup-rm-after-delete" ]]; then
      rm -f -- "$file" "$file.stopped"
      exit 1
    fi
    rm -f -- "$file" "$file.stopped"
    ;;
  cp)
    source_file="\${1:-}"
    destination="\${2:-}"
    destination_name="\${destination##*/}"
    cp "$source_file" "$FAKE_STATE/copied-$destination_name"
    if [[ "$destination_name" = pg_hba.conf.next ]]; then
      count_file="$FAKE_STATE/hba-copy-count"
      count=0
      [[ ! -f "$count_file" ]] || count=$(cat "$count_file")
      count=$((count + 1))
      printf '%s' "$count" > "$count_file"
      cp "$source_file" "$FAKE_STATE/copied-pg_hba.conf.next-$count"
    fi
    ;;
  exec)
    if [[ " $* " = *' pg_isready '* ]]; then
      [[ ! -f "$FAKE_STATE/fail-ready" ]]
      exit
    fi
    if [[ " $* " = *'id -u'* && " $* " = *'id -g'* ]]; then
      printf '%s\\n' '999:999'
      exit
    fi
    if [[ " $* " = *' psql '* ]]; then
      input=$(cat)
      printf '%s\\n' "$input" >> "$FAKE_STATE/psql-input"
      [[ ! -f "$FAKE_STATE/fail-psql" ]]
      exit
    fi
    exit 0
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

function runProvisionerAction(fixture, action) {
  return spawnSync(
    bash,
    [
      '--noprofile',
      '--norc',
      '-c',
      // CI checks repository scripts out as 0644; production grants execute permission after upload.
      'PATH="$1:$PATH"; export PATH; exec "$BASH" "$2" "$3" "$4"',
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
        RAG_POSTGRES_PUBLIC_HOST: fixture.publicHost ?? 'db.songuu.test',
        RAG_POSTGRES_CUTOVER_ACTION: action,
        RAG_POSTGRES_CUTOVER_TOKEN: fixture.cutoverToken ?? 'release-test-001',
      },
    }
  );
}

function runProvisioner(fixture) {
  if (fixture.singleAction) {
    return runProvisionerAction(fixture, fixture.singleAction);
  }
  const prepared = runProvisionerAction(fixture, 'prepare');
  if (prepared.status !== 0) return prepared;
  const activated = runProvisionerAction(fixture, 'activate');
  if (activated.status !== 0) {
    return {
      ...activated,
      stdout: `${prepared.stdout}${activated.stdout}`,
      stderr: `${prepared.stderr}${activated.stderr}`,
    };
  }
  const finalized = runProvisionerAction(fixture, 'finalize');
  return {
    ...finalized,
    stdout: `${prepared.stdout}${activated.stdout}${finalized.stdout}`,
    stderr: `${prepared.stderr}${activated.stderr}${finalized.stderr}`,
  };
}

test('requires an explicit valid public PostgreSQL host before Docker side effects', { skip }, () => {
  for (const publicHost of ['', 'https://db.songuu.test', 'db.songuu.test:25432', 'bad host']) {
    const fixture = createFixture();
    fixture.publicHost = publicHost;
    try {
      const result = runProvisioner(fixture);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /RAG_POSTGRES_PUBLIC_HOST/);
      assert.equal(existsSync(path.join(fixture.fakeState, 'docker-calls')), false);
      assert.equal(existsSync(path.join(fixture.shared, '.postgres-host', 'credentials.env')), false);
    } finally {
      rmSync(fixture.temp, { recursive: true, force: true });
    }
  }
});

test('publishes PostgreSQL with TLS and SCRAM while keeping host-local DSNs', { skip }, () => {
  const fixture = createFixture();
  try {
    const result = runProvisioner(fixture);

    assert.equal(result.status, 0, result.stderr);
    const runtime = readFileSync(fixture.runtime, 'utf8');
    const migration = readFileSync(fixture.migration, 'utf8');
    const calls = readFileSync(path.join(fixture.fakeState, 'docker-calls'), 'utf8');
    assert.match(runtime, new RegExp(`^POSTGRES_URL='postgresql://rag_app:${appPassword}@127\\.0\\.0\\.1:25432/rag_system'$`, 'm'));
    assert.match(runtime, /^POSTGRES_SSL_MODE='require'$/m);
    assert.match(migration, new RegExp(`^POSTGRES_MIGRATION_URL='postgresql://rag_owner:${ownerPassword}@/rag_system\\?host=%2F`, 'm'));
    assert.doesNotMatch(migration, /127\.0\.0\.1:25432/);
    assert.match(migration, /^POSTGRES_SSL_MODE='disable'$/m);
    assert.match(calls, /--publish 0\.0\.0\.0:25432:5432/);
    assert.match(calls, /--label com\.songuu\.rag-system\.postgres=managed-v3/);
    assert.match(calls, /listen_addresses=\*/);
    assert.match(calls, /ssl=on/);
    assert.match(calls, /password_encryption=scram-sha-256/);
    assert.match(calls, /hba_file=\/var\/lib\/postgresql\/data\/rag-tls\/pg_hba\.conf/);
    assert.match(calls, /--health-cmd pg_isready --host=\/run\/rag-system-postgresql -U postgres -d rag_system/);
    assert.match(calls, /--memory 1g --memory-swap 1g --cpus 1\.5 --shm-size 256m/);
    assert.match(calls, /--log-driver json-file --log-opt max-size=20m --log-opt max-file=3/);
    const initialHba = readFileSync(path.join(fixture.fakeState, 'copied-pg_hba.conf.next-1'), 'utf8');
    const hba = readFileSync(path.join(fixture.fakeState, 'copied-pg_hba.conf.next'), 'utf8');
    assert.match(hba, /^local\s+all\s+postgres\s+peer$/m);
    assert.match(hba, /^local\s+rag_system\s+rag_owner\s+scram-sha-256$/m);
    assert.doesNotMatch(initialHba, /^hostnossl\s+rag_system\s+rag_app\s+/m);
    assert.doesNotMatch(hba, /^hostnossl\s+rag_system\s+rag_app\s+/m);
    assert.match(hba, /^hostnossl\s+all\s+all\s+0\.0\.0\.0\/0\s+reject$/m);
    assert.match(hba, /^hostssl\s+rag_system\s+rag_app\s+0\.0\.0\.0\/0\s+scram-sha-256$/m);
    assert.match(hba, /^hostssl\s+all\s+all\s+0\.0\.0\.0\/0\s+reject$/m);
    assert.match(hba, /^hostnossl\s+all\s+all\s+::0\/0\s+reject$/m);
    assert.match(hba, /^hostssl\s+rag_system\s+rag_app\s+::0\/0\s+scram-sha-256$/m);
    assert.match(hba, /^hostssl\s+all\s+all\s+::0\/0\s+reject$/m);
    assert.doesNotMatch(hba, /^host(?:ssl|nossl)?\s+\S+\s+(?:rag_owner|postgres)\s+\S+\s+(?!reject)/m);
    assert.doesNotMatch(hba, /^host\s+all\s+all\s+all\s+scram-sha-256$/m);
    const firstHbaCopy = calls.indexOf('pg_hba.conf.next');
    const firstPublicRun = calls.indexOf('run -d --name rag-system-postgres --label com.songuu.rag-system.postgres=managed-v3');
    assert.ok(firstHbaCopy >= 0 && firstHbaCopy < firstPublicRun, 'HBA must be in PGDATA before the public listener starts');

    const stateDir = path.join(fixture.shared, '.postgres-host');
    const tlsDir = path.join(stateDir, 'tls');
    const ca = path.join(tlsDir, 'ca.crt');
    const externalEnv = path.join(tlsDir, 'rag-app-client.env');
    assert.equal(existsSync(ca), true);
    assert.equal(existsSync(path.join(tlsDir, 'ca.key')), true);
    assert.equal(existsSync(path.join(tlsDir, 'server.crt')), true);
    assert.equal(existsSync(path.join(tlsDir, 'server.key')), true);
    assert.equal(readFileSync(path.join(tlsDir, 'public-host'), 'utf8'), 'db.songuu.test\n');
    assert.match(readFileSync(path.join(fixture.fakeState, 'server-ext'), 'utf8'), /^subjectAltName=DNS:db\.songuu\.test$/m);
    const opensslCalls = readFileSync(path.join(fixture.fakeState, 'openssl-calls'), 'utf8');
    assert.match(opensslCalls, /verify .* -verify_hostname db\.songuu\.test /);
    assert.match(opensslCalls, /x509 .* -checkend 2592000/);
    assert.match(opensslCalls, /x509 .*ca\.crt.* -checkend 77760000/);
    assert.match(opensslCalls, /pkey .*server\.key -pubout/);
    const client = readFileSync(externalEnv, 'utf8');
    assert.match(client, /^PGHOST='db\.songuu\.test'$/m);
    assert.match(client, /^PGPORT='25432'$/m);
    assert.match(client, /^PGDATABASE='rag_system'$/m);
    assert.match(client, /^PGUSER='rag_app'$/m);
    assert.match(client, new RegExp(`^PGPASSWORD='${appPassword}'$`, 'm'));
    assert.match(client, /^PGSSLMODE='verify-full'$/m);
    assert.match(client, /^PGSSLROOTCERT='\/.*\/shared\/\.postgres-host\/tls\/ca\.crt'$/m);
    assert.equal(client.trim().split(/\r?\n/).length, 7);
    assert.doesNotMatch(client, /rag_owner|postgresql:\/\/postgres:/);
    assertMode(externalEnv, 0o600);
    assertMode(path.join(tlsDir, 'ca.key'), 0o600);
    assert.match(result.stdout, /External PostgreSQL client environment:/);
    assert.match(result.stdout, /TLS CA certificate:/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}\n${calls}`, new RegExp(`${ownerPassword}|${appPassword}|${adminPassword}`));
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('keeps one exact gateway plaintext rule only while a managed-v2 SSL-disabled app is still running', { skip }, () => {
  const fixture = createFixture();
  try {
    const stateDir = path.join(fixture.shared, '.postgres-host');
    mkdirSync(stateDir, { recursive: true });
    chmodSync(stateDir, 0o700);
    writeSecretFile(path.join(stateDir, 'credentials.env'), [
      `OWNER_PASSWORD=${ownerPassword}`,
      `APP_PASSWORD=${appPassword}`,
      `ADMIN_PASSWORD=${adminPassword}`,
      '',
    ].join('\n'));
    writeSecretFile(fixture.runtime, [
      '# BEGIN managed PostgreSQL host',
      "RAG_PERSISTENCE_BACKEND='postgres'",
      `DATABASE_URL='postgresql://rag_app:${appPassword}@127.0.0.1:25432/rag_system'`,
      `POSTGRES_URL='postgresql://rag_app:${appPassword}@127.0.0.1:25432/rag_system'`,
      "POSTGRES_SSL_MODE='disable'",
      "RAG_DEFAULT_TENANT_ID='songuu-production'",
      "RAG_DEFAULT_CORPUS_ID='default'",
      '# END managed PostgreSQL host',
      '',
    ].join('\n'));
    writeFileSync(path.join(fixture.fakeState, 'container'), 'managed-v2');
    writeFileSync(path.join(fixture.fakeState, 'volume'), '1');

    const prepared = runProvisionerAction(fixture, 'prepare');
    assert.equal(prepared.status, 0, prepared.stderr);
    const temporaryHba = readFileSync(path.join(fixture.fakeState, 'copied-pg_hba.conf.next'), 'utf8');
    assert.match(temporaryHba, /^hostnossl\s+rag_system\s+rag_app\s+172\.17\.0\.1\/32\s+scram-sha-256$/m);
    assert.match(readFileSync(path.join(stateDir, 'public-cutover.pending'), 'utf8'), /^hba=temporary$/m);

    const activated = runProvisionerAction(fixture, 'activate');
    assert.equal(activated.status, 0, activated.stderr);
    const finalized = runProvisionerAction(fixture, 'finalize');
    assert.equal(finalized.status, 0, finalized.stderr);
    const strictHba = readFileSync(path.join(fixture.fakeState, 'copied-pg_hba.conf.next'), 'utf8');
    assert.doesNotMatch(strictHba, /^hostnossl\s+rag_system\s+rag_app\s+/m);
    assert.match(strictHba, /^hostnossl\s+all\s+all\s+0\.0\.0\.0\/0\s+reject$/m);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('keeps prepare reversible and restores the loopback container without touching the named volume', { skip }, () => {
  const fixture = createFixture();
  try {
    const originalRuntime = "KEEP='runtime-before-public-cutover'\n";
    writeSecretFile(fixture.runtime, originalRuntime);

    const prepared = runProvisionerAction(fixture, 'prepare');
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(readFileSync(fixture.runtime, 'utf8'), originalRuntime);
    assert.equal(existsSync(fixture.migration), false);
    assert.equal(readFileSync(path.join(fixture.fakeState, 'container'), 'utf8'), 'managed-v3');
    assert.equal(readFileSync(path.join(fixture.fakeState, 'backup-container'), 'utf8'), 'managed-v2');
    assert.equal(readFileSync(path.join(fixture.shared, '.postgres-host', 'public-cutover.pending'), 'utf8'), 'kind=legacy\nhost=db.songuu.test\nstate=prepared\ntoken=release-test-001\nhba=strict\n');
    assert.equal(existsSync(path.join(fixture.shared, '.postgres-host', 'tls', 'rag-app-client.env')), true);

    const rolledBack = runProvisionerAction(fixture, 'rollback');
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.equal(readFileSync(path.join(fixture.fakeState, 'container'), 'utf8'), 'managed-v2');
    assert.equal(existsSync(path.join(fixture.fakeState, 'backup-container')), false);
    assert.equal(existsSync(path.join(fixture.fakeState, 'volume')), true);
    assert.equal(readFileSync(fixture.runtime, 'utf8'), originalRuntime);
    assert.equal(existsSync(fixture.migration), false);
    assert.equal(existsSync(path.join(fixture.shared, '.postgres-host', 'public-cutover.pending')), false);
    assert.equal(existsSync(path.join(fixture.shared, '.postgres-host', 'tls', 'rag-app-client.env')), false);
    const calls = readFileSync(path.join(fixture.fakeState, 'docker-calls'), 'utf8');
    assert.match(calls, /rm --force rag-system-postgres/);
    assert.match(calls, /rename rag-system-postgres-loopback-backup rag-system-postgres/);
    assert.doesNotMatch(calls, /volume rm/);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('activates only after prepare, finalizes only after release success, and verifies the strict public contract', { skip }, () => {
  const fixture = createFixture();
  try {
    const retiredCommit = runProvisionerAction(fixture, 'commit');
    assert.notEqual(retiredCommit.status, 0);
    assert.match(retiredCommit.stderr, /commit is retired/);
    const missingPrepare = runProvisionerAction(fixture, 'activate');
    assert.notEqual(missingPrepare.status, 0);
    assert.match(missingPrepare.stderr, /requires a successful prepare/);

    const prepared = runProvisionerAction(fixture, 'prepare');
    assert.equal(prepared.status, 0, prepared.stderr);
    const prematureVerify = runProvisionerAction(fixture, 'verify');
    assert.notEqual(prematureVerify.status, 0);
    assert.match(prematureVerify.stderr, /still rollback-capable/);

    const activated = runProvisionerAction(fixture, 'activate');
    assert.equal(activated.status, 0, activated.stderr);
    const activatedAgain = runProvisionerAction(fixture, 'activate');
    assert.equal(activatedAgain.status, 0, activatedAgain.stderr);
    const pendingFile = path.join(fixture.shared, '.postgres-host', 'public-cutover.pending');
    const snapshotDir = path.join(fixture.shared, '.postgres-host', 'public-cutover-snapshot');
    assert.match(readFileSync(pendingFile, 'utf8'), /^state=activated$/m);
    assert.equal(existsSync(snapshotDir), true);
    assert.equal(existsSync(path.join(fixture.fakeState, 'backup-container')), true);
    assert.match(readFileSync(fixture.runtime, 'utf8'), /^POSTGRES_SSL_MODE='require'$/m);
    const noDowngrade = runProvisionerAction(fixture, 'prepare');
    assert.notEqual(noDowngrade.status, 0);
    assert.match(noDowngrade.stderr, /cannot downgrade/);

    const finalized = runProvisionerAction(fixture, 'finalize');
    assert.equal(finalized.status, 0, finalized.stderr);
    assert.equal(existsSync(path.join(fixture.fakeState, 'backup-container')), false);
    assert.equal(existsSync(pendingFile), false);
    assert.equal(existsSync(snapshotDir), false);

    const verified = runProvisionerAction(fixture, 'verify');
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /Finalized public PostgreSQL configuration verified/);
    const calls = readFileSync(path.join(fixture.fakeState, 'docker-calls'), 'utf8');
    assert.equal((calls.match(/^run /gm) ?? []).length, 2);
    assert.match(readFileSync(path.join(fixture.fakeState, 'sync-calls'), 'utf8'), /public-cutover\.next/);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('restores the legacy container when the public candidate cannot start', { skip }, () => {
  const fixture = createFixture();
  try {
    writeFileSync(path.join(fixture.fakeState, 'fail-public-run'), '1');
    const result = runProvisionerAction(fixture, 'prepare');

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /loopback container was restored/);
    assert.equal(readFileSync(path.join(fixture.fakeState, 'container'), 'utf8'), 'managed-v2');
    assert.equal(existsSync(path.join(fixture.fakeState, 'backup-container')), false);
    assert.equal(existsSync(path.join(fixture.fakeState, 'volume')), true);
    assert.equal(existsSync(fixture.runtime), false);
    assert.equal(existsSync(fixture.migration), false);
    assert.doesNotMatch(readFileSync(path.join(fixture.fakeState, 'docker-calls'), 'utf8'), /volume rm/);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('restarts a legacy container when prepare is killed after stop but before rename', { skip }, () => {
  const fixture = createFixture();
  try {
    writeFileSync(path.join(fixture.fakeState, 'kill-after-legacy-stop'), '1');
    const interrupted = runProvisionerAction(fixture, 'prepare');
    assert.notEqual(interrupted.status, 0);
    assert.equal(readFileSync(path.join(fixture.fakeState, 'container'), 'utf8'), 'managed-v2');
    assert.equal(existsSync(path.join(fixture.fakeState, 'container.stopped')), true);
    assert.equal(existsSync(path.join(fixture.fakeState, 'backup-container')), false);
    assert.equal(existsSync(path.join(fixture.shared, '.postgres-host', 'public-cutover-snapshot')), true);
    assert.equal(
      readdirSync(path.join(fixture.shared, '.postgres-host')).some(name => name.startsWith('.container-env.')),
      false
    );
    rmSync(path.join(fixture.fakeState, 'kill-after-legacy-stop'), { force: true });
    const rolledBack = runProvisionerAction(fixture, 'rollback');
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.equal(existsSync(path.join(fixture.fakeState, 'container.stopped')), false);
    assert.equal(existsSync(path.join(fixture.shared, '.postgres-host', 'public-cutover-snapshot')), false);
    const calls = readFileSync(path.join(fixture.fakeState, 'docker-calls'), 'utf8');
    assert.match(calls, /start rag-system-postgres/);
    assert.match(calls, /exec rag-system-postgres pg_isready -q -U postgres -d rag_system/);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('restores pre-cutover environments when activate fails after a partial environment publish', { skip }, () => {
  const fixture = createFixture();
  try {
    const originalRuntime = "KEEP='old-runtime'\n";
    const originalMigration = "KEEP='old-migration'\n";
    writeSecretFile(fixture.runtime, originalRuntime);
    writeSecretFile(fixture.migration, originalMigration);
    const prepared = runProvisionerAction(fixture, 'prepare');
    assert.equal(prepared.status, 0, prepared.stderr);

    writeFileSync(path.join(fixture.fakeState, 'fail-activate-runtime-mv'), '1');
    const failedActivate = runProvisionerAction(fixture, 'activate');
    assert.notEqual(failedActivate.status, 0);
    assert.notEqual(readFileSync(fixture.migration, 'utf8'), originalMigration);

    rmSync(path.join(fixture.fakeState, 'fail-activate-runtime-mv'));
    const rolledBack = runProvisionerAction(fixture, 'rollback');
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.equal(readFileSync(fixture.runtime, 'utf8'), originalRuntime);
    assert.equal(readFileSync(fixture.migration, 'utf8'), originalMigration);
    assert.equal(readFileSync(path.join(fixture.fakeState, 'container'), 'utf8'), 'managed-v2');
    assert.equal(existsSync(path.join(fixture.fakeState, 'backup-container')), false);
    assert.equal(existsSync(path.join(fixture.shared, '.postgres-host', 'public-cutover-snapshot')), false);
    assert.equal(existsSync(path.join(fixture.shared, '.postgres-host', 'public-cutover.pending')), false);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('rejects a partial cutover snapshot before creating credentials or changing container topology', { skip }, () => {
  const fixture = createFixture();
  try {
    const stateDir = path.join(fixture.shared, '.postgres-host');
    const snapshotDir = path.join(stateDir, 'public-cutover-snapshot');
    mkdirSync(snapshotDir, { recursive: true });
    chmodSync(stateDir, 0o700);
    chmodSync(snapshotDir, 0o700);
    writeSecretFile(path.join(snapshotDir, 'manifest'), 'version=2\ntoken=release-test-001\n');
    writeSecretFile(path.join(snapshotDir, 'runtime.env.absent'), '');

    const result = runProvisionerAction(fixture, 'prepare');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exactly one state for migration\.env/);
    assert.equal(existsSync(path.join(stateDir, 'credentials.env')), false);
    const calls = readFileSync(path.join(fixture.fakeState, 'docker-calls'), 'utf8');
    assert.doesNotMatch(calls, /^run |^stop |^rename |^rm /m);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('retains activated rollback state when strict finalize verification fails', { skip }, () => {
  const fixture = createFixture();
  try {
    const prepared = runProvisionerAction(fixture, 'prepare');
    assert.equal(prepared.status, 0, prepared.stderr);
    const activated = runProvisionerAction(fixture, 'activate');
    assert.equal(activated.status, 0, activated.stderr);
    const pendingFile = path.join(fixture.shared, '.postgres-host', 'public-cutover.pending');
    const snapshotDir = path.join(fixture.shared, '.postgres-host', 'public-cutover-snapshot');
    writeFileSync(path.join(fixture.fakeState, 'fail-psql'), '1');
    const failedFinalize = runProvisionerAction(fixture, 'finalize');
    assert.notEqual(failedFinalize.status, 0);
    assert.match(readFileSync(pendingFile, 'utf8'), /^state=activated$/m);
    assert.equal(existsSync(pendingFile), true);
    assert.equal(existsSync(snapshotDir), true);
    assert.equal(existsSync(path.join(fixture.fakeState, 'backup-container')), true);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('keeps finalizing rollback-capable when Docker confirms backup removal failed', { skip }, () => {
  const fixture = createFixture();
  try {
    assert.equal(runProvisionerAction(fixture, 'prepare').status, 0);
    assert.equal(runProvisionerAction(fixture, 'activate').status, 0);
    writeFileSync(path.join(fixture.fakeState, 'fail-backup-rm'), '1');

    const failedFinalize = runProvisionerAction(fixture, 'finalize');
    assert.notEqual(failedFinalize.status, 0);
    const pendingFile = path.join(fixture.shared, '.postgres-host', 'public-cutover.pending');
    assert.match(readFileSync(pendingFile, 'utf8'), /^state=finalizing$/m);
    assert.equal(existsSync(path.join(fixture.fakeState, 'backup-container')), true);

    rmSync(path.join(fixture.fakeState, 'fail-backup-rm'));
    const rolledBack = runProvisionerAction(fixture, 'rollback');
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.equal(readFileSync(path.join(fixture.fakeState, 'container'), 'utf8'), 'managed-v2');
    assert.equal(existsSync(pendingFile), false);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('treats an absent backup after the finalizing receipt as committed and lets verify finish cleanup', { skip }, () => {
  const fixture = createFixture();
  try {
    assert.equal(runProvisionerAction(fixture, 'prepare').status, 0);
    assert.equal(runProvisionerAction(fixture, 'activate').status, 0);
    writeFileSync(path.join(fixture.fakeState, 'fail-backup-rm-after-delete'), '1');
    writeFileSync(path.join(fixture.fakeState, 'fail-snapshot-cleanup'), '1');

    const finalized = runProvisionerAction(fixture, 'finalize');
    assert.equal(finalized.status, 0, finalized.stderr);
    assert.match(finalized.stderr, /treating cutover as committed/);
    assert.match(finalized.stderr, /cleanup remains pending/);
    const pendingFile = path.join(fixture.shared, '.postgres-host', 'public-cutover.pending');
    const snapshotDir = path.join(fixture.shared, '.postgres-host', 'public-cutover-snapshot');
    assert.match(readFileSync(pendingFile, 'utf8'), /^state=finalized$/m);
    assert.equal(existsSync(snapshotDir), true);
    assert.equal(existsSync(path.join(fixture.fakeState, 'backup-container')), false);

    const refusedRollback = runProvisionerAction(fixture, 'rollback');
    assert.equal(refusedRollback.status, 0, refusedRollback.stderr);
    assert.match(refusedRollback.stdout, /already committed/);
    assert.equal(readFileSync(path.join(fixture.fakeState, 'container'), 'utf8'), 'managed-v3');
    assert.match(readFileSync(fixture.runtime, 'utf8'), /^POSTGRES_SSL_MODE='require'$/m);

    rmSync(path.join(fixture.fakeState, 'fail-snapshot-cleanup'));
    const verified = runProvisionerAction(fixture, 'verify');
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(existsSync(pendingFile), false);
    assert.equal(existsSync(snapshotDir), false);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('binds prepare, activate, finalize, and rollback to one exact release token', { skip }, () => {
  const fixture = createFixture();
  try {
    fixture.cutoverToken = 'release-owner-a';
    const prepared = runProvisionerAction(fixture, 'prepare');
    assert.equal(prepared.status, 0, prepared.stderr);
    const preparedAgain = runProvisionerAction(fixture, 'prepare');
    assert.equal(preparedAgain.status, 0, preparedAgain.stderr);

    fixture.cutoverToken = 'release-owner-b';
    for (const action of ['prepare', 'activate', 'finalize', 'rollback']) {
      const rejected = runProvisionerAction(fixture, action);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /does not own/);
    }
    assert.equal(readFileSync(path.join(fixture.fakeState, 'container'), 'utf8'), 'managed-v3');
    assert.equal(existsSync(path.join(fixture.fakeState, 'backup-container')), true);

    rmSync(path.join(fixture.fakeState, 'container'));
    const foreignRecovery = runProvisionerAction(fixture, 'rollback');
    assert.notEqual(foreignRecovery.status, 0);
    assert.match(foreignRecovery.stderr, /does not own/);
    assert.equal(existsSync(path.join(fixture.fakeState, 'container')), false);
    assert.equal(existsSync(path.join(fixture.fakeState, 'backup-container')), true);

    fixture.cutoverToken = 'release-owner-a';
    const recoveredPrepare = runProvisionerAction(fixture, 'prepare');
    assert.equal(recoveredPrepare.status, 0, recoveredPrepare.stderr);
    assert.equal(readFileSync(path.join(fixture.fakeState, 'container'), 'utf8'), 'managed-v3');
    const rolledBack = runProvisionerAction(fixture, 'rollback');
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    const rolledBackAgain = runProvisionerAction(fixture, 'rollback');
    assert.equal(rolledBackAgain.status, 0, rolledBackAgain.stderr);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

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
    assert.match(runtime, /^POSTGRES_SSL_MODE='require'$/m);
    assert.match(runtime, /^RAG_DEFAULT_TENANT_ID='songuu-production'$/m);
    assert.match(runtime, /^RAG_DEFAULT_CORPUS_ID='default'$/m);
    assert.doesNotMatch(runtime, /POSTGRES_MIGRATION_URL|rag_owner/);
    assert.match(migration, new RegExp(`^POSTGRES_MIGRATION_URL='postgresql://rag_owner:${ownerPassword}@/rag_system\\?host=%2F`, 'm'));
    assert.doesNotMatch(migration, /127\.0\.0\.1:25432/);
    assert.match(migration, /^POSTGRES_SSL_MODE='disable'$/m);
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
    assert.match(calls, /exec --user postgres -i rag-system-postgres psql .*--username postgres/);
    assert.match(roleSql, /CREATE ROLE rag_owner WITH LOGIN/);
    assert.match(roleSql, /ALTER ROLE rag_owner WITH LOGIN PASSWORD '[a-f0-9]+' CONNECTION LIMIT 5 NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT NOBYPASSRLS/);
    assert.match(roleSql, /ALTER ROLE rag_app WITH LOGIN PASSWORD '[a-f0-9]+' CONNECTION LIMIT 40 NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT NOBYPASSRLS/);
    assert.match(roleSql, /ALTER DATABASE rag_system OWNER TO rag_owner/);
    assert.match(roleSql, /ALTER SCHEMA public OWNER TO rag_owner/);
    assert.match(roleSql, /GRANT rag_app TO rag_owner WITH ADMIN TRUE, SET FALSE, INHERIT FALSE/);
    assert.match(roleSql, /pg_auth_members membership/);
    assert.match(roleSql, /member_role\.rolname = 'rag_app'/);
    assert.match(roleSql, /database = ARRAY\['rag_system'\] AND user_name = ARRAY\['rag_app'\]/);
    assert.doesNotMatch(roleSql, /database @> ARRAY/);
    assert.match(roleSql, /NOT rolcreaterole/);
    assert.match(roleSql, /ALTER ROLE postgres WITH LOGIN PASSWORD/);
    assert.doesNotMatch(roleSql, /ALTER ROLE rag_owner[^;]*\bCREATEROLE\b/);
    assert.match(roleSql, /BEGIN;[\s\S]*SET LOCAL password_encryption = 'scram-sha-256';[\s\S]*COMMIT;/);
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
      `${retiredVendorPrefix}URL='https://retired.invalid'`,
      `${retiredVendorPrefix}${['SERVICE', 'ROLE', 'KEY'].join('_')}='retired-secret'`,
      `${retiredVendorPrefix}DEFAULT_TENANT_ID='retired-tenant'`,
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
    assert.doesNotMatch(firstRuntime, new RegExp(`^${retiredVendorPrefix}`, 'm'));
    assert.doesNotMatch(`${first.stdout}\n${first.stderr}`, /retired-secret/);
    assert.equal((firstRuntime.match(/^POSTGRES_URL=/gm) ?? []).length, 1);
    assert.equal((firstRuntime.match(/^RAG_PERSISTENCE_BACKEND=/gm) ?? []).length, 1);
    assert.equal((firstRuntime.match(/^# BEGIN managed PostgreSQL host$/gm) ?? []).length, 1);
    assert.equal(readFileSync(path.join(fixture.fakeState, 'openssl-count'), 'utf8'), '3');
    const calls = readFileSync(path.join(fixture.fakeState, 'docker-calls'), 'utf8');
    assert.equal((calls.match(/^run /gm) ?? []).length, 2);
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

test('fails closed when managed runtime state survives but its named data volume is missing', { skip }, () => {
  const fixture = createFixture();
  try {
    const stateDir = path.join(fixture.shared, '.postgres-host');
    mkdirSync(stateDir, { recursive: true });
    chmodSync(stateDir, 0o700);
    writeSecretFile(path.join(stateDir, 'credentials.env'), [
      `OWNER_PASSWORD=${ownerPassword}`,
      `APP_PASSWORD=${appPassword}`,
      `ADMIN_PASSWORD=${adminPassword}`,
      '',
    ].join('\n'));
    const managedRuntime = [
      '# BEGIN managed PostgreSQL host',
      "RAG_PERSISTENCE_BACKEND='postgres'",
      `DATABASE_URL='postgresql://rag_app:${appPassword}@127.0.0.1:25432/rag_system'`,
      `POSTGRES_URL='postgresql://rag_app:${appPassword}@127.0.0.1:25432/rag_system'`,
      "POSTGRES_SSL_MODE='require'",
      "RAG_DEFAULT_TENANT_ID='songuu-production'",
      "RAG_DEFAULT_CORPUS_ID='default'",
      '# END managed PostgreSQL host',
      '',
    ].join('\n');
    writeSecretFile(fixture.runtime, managedRuntime);

    const result = runProvisionerAction(fixture, 'prepare');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /without its named data volume/);
    assert.equal(readFileSync(fixture.runtime, 'utf8'), managedRuntime);
    const calls = readFileSync(path.join(fixture.fakeState, 'docker-calls'), 'utf8');
    assert.doesNotMatch(calls, /^volume create |^run /m);
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

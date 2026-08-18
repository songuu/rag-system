#!/usr/bin/env bash
# Provision the dedicated PostgreSQL service used by the songuu.top RAG host.
# This script owns only its labelled container, named volume, and protected
# files. It intentionally never deletes infrastructure during error recovery.
set -euo pipefail

usage() {
  echo 'usage: provision-postgres-host.sh <runtime-env-file> <migration-env-file>' >&2
  exit 2
}

die() {
  echo "$1" >&2
  exit 2
}

[[ "$#" -eq 2 ]] || usage

normalize_path() {
  local value="$1"
  if command -v cygpath >/dev/null 2>&1 && [[ "$value" =~ ^[A-Za-z]:[\\/] ]]; then
    cygpath -u "$value"
  else
    printf '%s\n' "$value"
  fi
}

readonly ROOT="$(normalize_path "${RAG_POSTGRES_ROOT:-/opt/rag-system}")"
readonly RUNTIME_ENV="$(normalize_path "$1")"
readonly MIGRATION_ENV="$(normalize_path "$2")"
readonly SHARED="$ROOT/shared"
readonly STATE_DIR="$SHARED/.postgres-host"
readonly CREDENTIALS_FILE="$STATE_DIR/credentials.env"
readonly LOCK_FILE="$STATE_DIR/provision.lock"
readonly TLS_DIR="$STATE_DIR/tls"
readonly CA_KEY_FILE="$TLS_DIR/ca.key"
readonly CA_CERT_FILE="$TLS_DIR/ca.crt"
readonly SERVER_KEY_FILE="$TLS_DIR/server.key"
readonly SERVER_CERT_FILE="$TLS_DIR/server.crt"
readonly PUBLIC_HOST_FILE="$TLS_DIR/public-host"
readonly PUBLIC_CLIENT_ENV="$TLS_DIR/rag-app-client.env"
readonly SOCKET_DIR="$STATE_DIR/socket"
readonly CUTOVER_PENDING_FILE="$STATE_DIR/public-cutover.pending"
readonly CUTOVER_SNAPSHOT_DIR="$STATE_DIR/public-cutover-snapshot"

readonly CONTAINER_NAME='rag-system-postgres'
readonly CONTAINER_BACKUP_NAME='rag-system-postgres-loopback-backup'
readonly LEGACY_CONTAINER_LABEL_VALUE='managed-v2'
readonly CONTAINER_LABEL_VALUE='managed-v3'
readonly LEGACY_CONTAINER_LABEL="com.songuu.rag-system.postgres=$LEGACY_CONTAINER_LABEL_VALUE"
readonly CONTAINER_LABEL="com.songuu.rag-system.postgres=$CONTAINER_LABEL_VALUE"
readonly CONTAINER_IMAGE='postgres:17-bookworm@sha256:9b18b78397054fce88a9552e9d5a3ad5bb7fd258c5b3cc1c5028e46373d6ea8f'
readonly VOLUME_NAME='rag-system-postgres-data'
readonly LOCAL_HOST_ADDRESS='127.0.0.1'
readonly PUBLIC_HOST_ADDRESS='0.0.0.0'
readonly HOST_PORT='25432'
readonly CONTAINER_PORT='5432'
readonly PUBLIC_MEMORY='1g'
readonly PUBLIC_MEMORY_BYTES='1073741824'
readonly PUBLIC_CPUS='1.5'
readonly PUBLIC_NANO_CPUS='1500000000'
readonly PUBLIC_SHM_SIZE='256m'
readonly PUBLIC_SHM_BYTES='268435456'
readonly PUBLIC_LOG_MAX_SIZE='20m'
readonly PUBLIC_LOG_MAX_FILE='3'
readonly DATABASE_NAME='rag_system'
readonly ADMIN_ROLE='postgres'
readonly OWNER_ROLE='rag_owner'
readonly APP_ROLE='rag_app'
readonly DEFAULT_TENANT='songuu-production'
readonly DEFAULT_CORPUS='default'
readonly READY_ATTEMPTS="${RAG_POSTGRES_READY_ATTEMPTS:-60}"
readonly READY_INTERVAL="${RAG_POSTGRES_READY_INTERVAL:-1}"
readonly PUBLIC_HOST="${RAG_POSTGRES_PUBLIC_HOST:-}"
readonly CUTOVER_ACTION="${RAG_POSTGRES_CUTOVER_ACTION:-prepare}"
readonly CUTOVER_TOKEN="${RAG_POSTGRES_CUTOVER_TOKEN:-}"
readonly CONTAINER_TLS_DIR='/var/lib/postgresql/data/rag-tls'
readonly CONTAINER_HBA_FILE="$CONTAINER_TLS_DIR/pg_hba.conf"
readonly CONTAINER_SOCKET_DIR='/run/rag-system-postgresql'
readonly EXPECTED_PUBLIC_COMMAND='["postgres","-c","listen_addresses=*","-c","ssl=on","-c","ssl_min_protocol_version=TLSv1.3","-c","ssl_cert_file=/var/lib/postgresql/data/rag-tls/server.crt","-c","ssl_key_file=/var/lib/postgresql/data/rag-tls/server.key","-c","ssl_ca_file=/var/lib/postgresql/data/rag-tls/ca.crt","-c","password_encryption=scram-sha-256","-c","authentication_timeout=10s","-c","hba_file=/var/lib/postgresql/data/rag-tls/pg_hba.conf","-c","unix_socket_directories=/run/rag-system-postgresql","-c","unix_socket_permissions=0700"]'

windows_posix_runtime=false
case "$(uname -s)" in
  MINGW*|MSYS*) windows_posix_runtime=true ;;
esac

case "$CUTOVER_ACTION" in
  prepare|activate|finalize|rollback|verify) ;;
  commit) die 'RAG_POSTGRES_CUTOVER_ACTION=commit is retired; use activate followed by finalize' ;;
  *) die 'RAG_POSTGRES_CUTOVER_ACTION must be prepare, activate, finalize, rollback, or verify' ;;
esac
if [[ "$CUTOVER_ACTION" != verify ]]; then
  [[ "$CUTOVER_TOKEN" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]] \
    || die 'RAG_POSTGRES_CUTOVER_TOKEN must be 1-128 safe release-token characters'
fi

runtime_stage=''
migration_stage=''
container_env_stage=''
credentials_stage=''
tls_stage=''
hba_stage=''
client_env_stage=''
cutover_stage=''
snapshot_stage=''

cleanup() {
  [[ -z "$runtime_stage" || ! -e "$runtime_stage" ]] || rm -f -- "$runtime_stage"
  [[ -z "$migration_stage" || ! -e "$migration_stage" ]] || rm -f -- "$migration_stage"
  [[ -z "$container_env_stage" || ! -e "$container_env_stage" ]] || rm -f -- "$container_env_stage"
  [[ -z "$credentials_stage" || ! -e "$credentials_stage" ]] || rm -f -- "$credentials_stage"
  [[ -z "$hba_stage" || ! -e "$hba_stage" ]] || rm -f -- "$hba_stage"
  [[ -z "$client_env_stage" || ! -e "$client_env_stage" ]] || rm -f -- "$client_env_stage"
  [[ -z "$cutover_stage" || ! -e "$cutover_stage" ]] || rm -f -- "$cutover_stage"
  [[ -z "$snapshot_stage" || ! -e "$snapshot_stage" ]] || rm -rf -- "$snapshot_stage"
  [[ -z "$tls_stage" || ! -e "$tls_stage" ]] || rm -rf -- "$tls_stage"
}
trap cleanup EXIT

for command_name in docker openssl ss awk grep stat id mktemp flock cmp chown sync wc tr; do
  command -v "$command_name" >/dev/null 2>&1 || die "Required command is unavailable: $command_name"
done

[[ "$ROOT" = /* && "$ROOT" != / ]] || die 'RAG_POSTGRES_ROOT must be a safe absolute path'
[[ -d "$ROOT" && ! -L "$ROOT" ]] || die 'RAG PostgreSQL root must be an existing non-symlink directory'
[[ -d "$SHARED" && ! -L "$SHARED" ]] || die 'RAG PostgreSQL shared directory must be an existing non-symlink directory'

root_physical="$(cd -- "$ROOT" && pwd -P)"
shared_physical="$(cd -- "$SHARED" && pwd -P)"
[[ "$root_physical" = "$ROOT" ]] || die 'RAG PostgreSQL root must not traverse symbolic links'
[[ "$shared_physical" = "$SHARED" ]] || die 'RAG PostgreSQL shared directory must not traverse symbolic links'

assert_secure_directory() {
  local directory="$1"
  local owner mode mode_value
  owner="$(stat -c '%u' -- "$directory")"
  mode="$(stat -c '%a' -- "$directory")"
  [[ "$owner" = "$(id -u)" ]] || die "Protected directory is not owned by the current user: $directory"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "Protected directory has an unreadable mode: $directory"
  [[ "$windows_posix_runtime" = true ]] && return 0
  mode_value=$((8#$mode))
  (( (mode_value & 0022) == 0 )) || die "Protected directory must not be group/world writable: $directory"
}

assert_safe_environment_path() {
  local filename="$1"
  local parent base physical_parent
  [[ "$filename" = /* && "$filename" != */ ]] || die 'Environment paths must be absolute file paths'
  parent="$(dirname -- "$filename")"
  base="$(basename -- "$filename")"
  [[ "$base" =~ ^[.A-Za-z0-9_-]+$ ]] || die 'Environment filename contains unsafe characters'
  [[ -d "$parent" && ! -L "$parent" ]] || die 'Environment parent must be an existing non-symlink directory'
  physical_parent="$(cd -- "$parent" && pwd -P)"
  [[ "$physical_parent" = "$SHARED" ]] || die 'Environment files must be direct children of the protected shared directory'
  if [[ -e "$filename" || -L "$filename" ]]; then
    [[ -f "$filename" && ! -L "$filename" ]] || die 'Environment file must be a regular non-symlink file'
    assert_secure_file "$filename"
  fi
}

assert_secure_file() {
  local filename="$1"
  local owner mode mode_value
  owner="$(stat -c '%u' -- "$filename")"
  mode="$(stat -c '%a' -- "$filename")"
  [[ "$owner" = "$(id -u)" ]] || die "Protected file is not owned by the current user: $filename"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "Protected file has an unreadable mode: $filename"
  [[ "$windows_posix_runtime" = true ]] && return 0
  mode_value=$((8#$mode))
  (( (mode_value & 0077) == 0 )) || die "Protected file must be readable only by its owner: $filename"
}

is_ipv4_address() {
  local value="$1"
  local octet
  local -a octets
  [[ "$value" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  IFS='.' read -r -a octets <<< "$value"
  [[ "${#octets[@]}" -eq 4 ]] || return 1
  for octet in "${octets[@]}"; do
    [[ "$octet" =~ ^(0|[1-9][0-9]{0,2})$ ]] || return 1
    (( 10#$octet <= 255 )) || return 1
  done
}

is_dns_name() {
  local value="$1"
  local label
  local -a labels
  (( ${#value} >= 1 && ${#value} <= 253 )) || return 1
  [[ "$value" != localhost && "$value" != *.local && "$value" != *..* ]] || return 1
  IFS='.' read -r -a labels <<< "$value"
  for label in "${labels[@]}"; do
    (( ${#label} >= 1 && ${#label} <= 63 )) || return 1
    [[ "$label" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] || return 1
  done
}

urlencode_path() {
  local value="$1"
  local character encoded=''
  local index code
  LC_ALL=C
  for ((index = 0; index < ${#value}; index += 1)); do
    character="${value:index:1}"
    case "$character" in
      [A-Za-z0-9._~-]) encoded+="$character" ;;
      *)
        printf -v code '%02X' "'$character"
        encoded+="%$code"
        ;;
    esac
  done
  printf '%s' "$encoded"
}

assert_secure_directory "$ROOT"
assert_secure_directory "$SHARED"
if is_ipv4_address "$PUBLIC_HOST"; then
  [[ "$PUBLIC_HOST" != 0.* && "$PUBLIC_HOST" != 127.* ]] \
    || die 'RAG_POSTGRES_PUBLIC_HOST must be a public IPv4 address or DNS name'
  public_san="IP:$PUBLIC_HOST"
elif is_dns_name "$PUBLIC_HOST"; then
  public_san="DNS:$PUBLIC_HOST"
else
  die 'RAG_POSTGRES_PUBLIC_HOST must be a public IPv4 address or DNS name without a scheme or port'
fi
[[ "$RUNTIME_ENV" != "$MIGRATION_ENV" ]] || die 'Runtime and migration environment files must be different'
assert_safe_environment_path "$RUNTIME_ENV"
assert_safe_environment_path "$MIGRATION_ENV"

inspect_runtime_managed_block() {
  local filename="$1"
  [[ -f "$filename" ]] || {
    printf '%s\n' '0'
    return 0
  }
  awk '
    BEGIN {
      state = 0
      begin_count = 0
      end_count = 0
      managed_key_outside = 0
      invalid = 0
    }
    /^# BEGIN managed PostgreSQL host$/ {
      if (state != 0 || begin_count != 0) invalid = 1
      state = 1
      begin_count += 1
      next
    }
    /^# END managed PostgreSQL host$/ {
      if (state != 1 || end_count != 0) invalid = 1
      state = 2
      end_count += 1
      next
    }
    /^[[:space:]]*(export[[:space:]]+)?(RAG_PERSISTENCE_BACKEND|DATABASE_URL|POSTGRES_URL|POSTGRES_SSL_MODE|POSTGRES_MIGRATION_URL|POSTGRES_APP_ROLE|POSTGRES_PASSWORD|RAG_DEFAULT_TENANT_ID|RAG_DEFAULT_CORPUS_ID)=/ {
      if (state != 1) managed_key_outside += 1
    }
    END {
      invalid_result = invalid || begin_count != end_count || begin_count > 1 || state == 1
      invalid_result = invalid_result || (begin_count == 1 && managed_key_outside != 0)
      if (invalid_result) exit 1
      print begin_count
    }
  ' "$filename"
}

# Validate existing markers and a first cutover before creating secrets,
# volumes, containers, or any other database state.
if ! managed_block_count="$(inspect_runtime_managed_block "$RUNTIME_ENV")"; then
  die 'Runtime managed PostgreSQL block is incomplete, repeated, or shadowed; refusing to overwrite it'
fi

if [[ "$managed_block_count" = 0 && -f "$RUNTIME_ENV" ]]; then
  if ! bash --noprofile --norc -c '
    set -euo pipefail
    unset RAG_PERSISTENCE_BACKEND DATABASE_URL POSTGRES_URL POSTGRES_SSL_MODE
    unset POSTGRES_MIGRATION_URL POSTGRES_APP_ROLE POSTGRES_PASSWORD
    unset RAG_DEFAULT_TENANT_ID RAG_DEFAULT_CORPUS_ID
    set -a
    . "$1"
    case "${RAG_PERSISTENCE_BACKEND:-}" in ""|local|postgres) ;; *) exit 1 ;; esac
    test -z "${DATABASE_URL:-}"
    test -z "${POSTGRES_URL:-}"
    test -z "${POSTGRES_MIGRATION_URL:-}"
    test -z "${POSTGRES_APP_ROLE:-}"
    test -z "${POSTGRES_PASSWORD:-}"
    case "${POSTGRES_SSL_MODE:-}" in ""|disable|require) ;; *) exit 1 ;; esac
    case "${RAG_DEFAULT_TENANT_ID:-}" in ""|songuu-production) ;; *) exit 1 ;; esac
    case "${RAG_DEFAULT_CORPUS_ID:-}" in ""|default) ;; *) exit 1 ;; esac
  ' bash "$RUNTIME_ENV" >/dev/null 2>&1; then
    die 'Existing runtime persistence configuration is not eligible for managed PostgreSQL cutover'
  fi
fi

if [[ -e "$STATE_DIR" || -L "$STATE_DIR" ]]; then
  [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]] || die 'PostgreSQL secret state path must be a non-symlink directory'
  assert_secure_directory "$STATE_DIR"
  chmod 700 -- "$STATE_DIR"
else
  mkdir -- "$STATE_DIR"
  chmod 700 -- "$STATE_DIR"
fi

if [[ -e "$TLS_DIR" || -L "$TLS_DIR" ]]; then
  [[ -d "$TLS_DIR" && ! -L "$TLS_DIR" ]] \
    || die 'PostgreSQL TLS state must be a non-symlink directory'
  assert_secure_directory "$TLS_DIR"
else
  mkdir -- "$TLS_DIR"
fi
chmod 700 -- "$TLS_DIR"

if [[ -e "$SOCKET_DIR" || -L "$SOCKET_DIR" ]]; then
  [[ -d "$SOCKET_DIR" && ! -L "$SOCKET_DIR" ]] \
    || die 'PostgreSQL Unix socket path must be a non-symlink directory'
else
  mkdir -- "$SOCKET_DIR"
fi
# STATE_DIR is root-only. The image entrypoint may chown this child directory
# to postgres, but no non-root host user can traverse the protected parent.
chmod 700 -- "$SOCKET_DIR"

if [[ -e "$LOCK_FILE" || -L "$LOCK_FILE" ]]; then
  [[ -f "$LOCK_FILE" && ! -L "$LOCK_FILE" ]] \
    || die 'PostgreSQL provision lock must be a regular non-symlink file'
  assert_secure_file "$LOCK_FILE"
fi
umask 077
exec {lock_fd}> "$LOCK_FILE" || die 'PostgreSQL provision lock could not be opened'
chmod 600 -- "$LOCK_FILE"
flock -n "$lock_fd" || die 'Another PostgreSQL host provisioning process is already active'

credentials_exist=false
if [[ -e "$CREDENTIALS_FILE" || -L "$CREDENTIALS_FILE" ]]; then
  [[ -f "$CREDENTIALS_FILE" && ! -L "$CREDENTIALS_FILE" ]] \
    || die 'PostgreSQL credential state must be a regular non-symlink file'
  assert_secure_file "$CREDENTIALS_FILE"
  credentials_exist=true
fi

if [[ "$managed_block_count" = 1 && "$credentials_exist" = false ]]; then
  die 'Managed PostgreSQL runtime has no protected credential state; refusing unsafe adoption'
fi

read_secret() {
  local key="$1"
  local matches value
  matches="$(grep -E "^${key}=[0-9a-f]{64}$" "$CREDENTIALS_FILE" 2>/dev/null || true)"
  [[ -n "$matches" && "$matches" != *$'\n'* ]] || die 'Protected PostgreSQL credential state is invalid'
  value="${matches#*=}"
  [[ "$value" =~ ^[0-9a-f]{64}$ ]] || die 'Protected PostgreSQL credential state is invalid'
  printf '%s' "$value"
}

if [[ "$credentials_exist" = true ]]; then
  owner_password="$(read_secret OWNER_PASSWORD)"
  app_password="$(read_secret APP_PASSWORD)"
  admin_password="$(read_secret ADMIN_PASSWORD)"
fi

if [[ "$managed_block_count" = 1 ]]; then
  managed_runtime_url="postgresql://$APP_ROLE:$app_password@$LOCAL_HOST_ADDRESS:$HOST_PORT/$DATABASE_NAME"
  if ! bash --noprofile --norc -c '
    set -euo pipefail
    IFS= read -r expected_runtime_url <&3
    unset RAG_PERSISTENCE_BACKEND DATABASE_URL POSTGRES_URL POSTGRES_SSL_MODE
    unset POSTGRES_MIGRATION_URL POSTGRES_APP_ROLE POSTGRES_PASSWORD
    unset RAG_DEFAULT_TENANT_ID RAG_DEFAULT_CORPUS_ID
    set -a
    . "$1"
    test "${RAG_PERSISTENCE_BACKEND:-}" = postgres
    test "${DATABASE_URL:-}" = "$expected_runtime_url"
    test "${POSTGRES_URL:-}" = "$expected_runtime_url"
    case "${POSTGRES_SSL_MODE:-}" in disable|require) ;; *) exit 1 ;; esac
    test "${RAG_DEFAULT_TENANT_ID:-}" = songuu-production
    test "${RAG_DEFAULT_CORPUS_ID:-}" = default
    test -z "${POSTGRES_MIGRATION_URL:-}"
    test -z "${POSTGRES_APP_ROLE:-}"
    test -z "${POSTGRES_PASSWORD:-}"
  ' bash "$RUNTIME_ENV" 3<<< "$managed_runtime_url" >/dev/null 2>&1; then
    die 'Managed PostgreSQL runtime configuration has drifted; refusing to overwrite it'
  fi
  unset managed_runtime_url
fi

legacy_plaintext_compatibility_required=false
if [[ "$managed_block_count" = 1 ]] && bash --noprofile --norc -c '
  set -euo pipefail
  unset POSTGRES_SSL_MODE
  set -a
  . "$1"
  test "${POSTGRES_SSL_MODE:-}" = disable
' bash "$RUNTIME_ENV" >/dev/null 2>&1; then
  legacy_plaintext_compatibility_required=true
fi

docker info >/dev/null 2>&1 || die 'Docker is unavailable for PostgreSQL host provisioning'

inspect_container_contract() {
  local name="$1"
  local managed_label image volume binding restart_policy initial_admin initial_database
  local command healthcheck mounts_count socket_mount memory memory_swap nano_cpus shm_size log_driver log_size log_files
  managed_label="$(docker inspect --format '{{index .Config.Labels "com.songuu.rag-system.postgres"}}' "$name" 2>/dev/null || true)"
  image="$(docker inspect --format '{{.Config.Image}}' "$name" 2>/dev/null || true)"
  volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$name" 2>/dev/null || true)"
  binding="$(docker inspect --format '{{range (index .HostConfig.PortBindings "5432/tcp")}}{{.HostIp}}|{{.HostPort}}{{println}}{{end}}' "$name" 2>/dev/null || true)"
  restart_policy="$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$name" 2>/dev/null || true)"
  initial_admin="$(docker inspect --format '{{range .Config.Env}}{{if eq . "POSTGRES_USER=postgres"}}postgres{{end}}{{end}}' "$name" 2>/dev/null || true)"
  initial_database="$(docker inspect --format '{{range .Config.Env}}{{if eq . "POSTGRES_DB=rag_system"}}rag_system{{end}}{{end}}' "$name" 2>/dev/null || true)"
  command="$(docker inspect --format '{{json .Config.Cmd}}' "$name" 2>/dev/null || true)"
  healthcheck="$(docker inspect --format '{{json .Config.Healthcheck.Test}}' "$name" 2>/dev/null || true)"
  mounts_count="$(docker inspect --format '{{len .Mounts}}' "$name" 2>/dev/null || true)"
  socket_mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/run/rag-system-postgresql"}}{{.Type}}|{{.Source}}{{end}}{{end}}' "$name" 2>/dev/null || true)"
  memory="$(docker inspect --format '{{.HostConfig.Memory}}' "$name" 2>/dev/null || true)"
  memory_swap="$(docker inspect --format '{{.HostConfig.MemorySwap}}' "$name" 2>/dev/null || true)"
  nano_cpus="$(docker inspect --format '{{.HostConfig.NanoCpus}}' "$name" 2>/dev/null || true)"
  shm_size="$(docker inspect --format '{{.HostConfig.ShmSize}}' "$name" 2>/dev/null || true)"
  log_driver="$(docker inspect --format '{{.HostConfig.LogConfig.Type}}' "$name" 2>/dev/null || true)"
  log_size="$(docker inspect --format '{{index .HostConfig.LogConfig.Config "max-size"}}' "$name" 2>/dev/null || true)"
  log_files="$(docker inspect --format '{{index .HostConfig.LogConfig.Config "max-file"}}' "$name" 2>/dev/null || true)"
  [[ "$image" = "$CONTAINER_IMAGE" \
    && "$volume" = "$VOLUME_NAME" \
    && "$restart_policy" = unless-stopped \
    && "$initial_admin" = "$ADMIN_ROLE" \
    && "$initial_database" = "$DATABASE_NAME" ]] || return 1
  if [[ "$managed_label" = "$LEGACY_CONTAINER_LABEL_VALUE" \
    && "$binding" = "$LOCAL_HOST_ADDRESS|$HOST_PORT" \
    && "$command" = '["postgres"]' \
    && "$healthcheck" = '["CMD-SHELL","pg_isready -U postgres -d rag_system"]' \
    && "$mounts_count" = 1 \
    && -z "$socket_mount" ]]; then
    printf '%s\n' legacy
    return 0
  fi
  if [[ "$managed_label" = "$CONTAINER_LABEL_VALUE" \
    && "$binding" = "$PUBLIC_HOST_ADDRESS|$HOST_PORT" \
    && "$command" = "$EXPECTED_PUBLIC_COMMAND" \
    && "$healthcheck" = '["CMD-SHELL","pg_isready --host=/run/rag-system-postgresql -U postgres -d rag_system"]' \
    && "$mounts_count" = 2 \
    && "$socket_mount" = "bind|$SOCKET_DIR" \
    && "$memory" = "$PUBLIC_MEMORY_BYTES" \
    && "$memory_swap" = "$PUBLIC_MEMORY_BYTES" \
    && "$nano_cpus" = "$PUBLIC_NANO_CPUS" \
    && "$shm_size" = "$PUBLIC_SHM_BYTES" \
    && "$log_driver" = json-file \
    && "$log_size" = "$PUBLIC_LOG_MAX_SIZE" \
    && "$log_files" = "$PUBLIC_LOG_MAX_FILE" ]]; then
    printf '%s\n' public
    return 0
  fi
  return 1
}

backup_exists=false
if docker container inspect "$CONTAINER_BACKUP_NAME" >/dev/null 2>&1; then
  backup_exists=true
  backup_kind="$(inspect_container_contract "$CONTAINER_BACKUP_NAME" || true)"
  [[ "$backup_kind" = legacy ]] \
    || die "Container $CONTAINER_BACKUP_NAME conflicts with the managed PostgreSQL rollback contract"
fi

container_exists=false
if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  container_exists=true
  container_kind="$(inspect_container_contract "$CONTAINER_NAME" || true)"
  [[ -n "$container_kind" ]] \
    || die "Container $CONTAINER_NAME conflicts with the managed PostgreSQL contract"
fi

volume_exists=false
if docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
  volume_exists=true
fi
if [[ "$managed_block_count" = 1 && "$volume_exists" = false ]]; then
  die 'Managed PostgreSQL runtime exists without its named data volume; refusing to create an empty replacement'
fi

[[ "$READY_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || die 'RAG_POSTGRES_READY_ATTEMPTS must be a positive integer'
[[ "$READY_INTERVAL" =~ ^[0-9]+([.][0-9]+)?$ ]] || die 'RAG_POSTGRES_READY_INTERVAL must be a non-negative number'

pending_kind=''
pending_host=''
pending_state=''
pending_token=''
pending_hba=''
if [[ -e "$CUTOVER_PENDING_FILE" || -L "$CUTOVER_PENDING_FILE" ]]; then
  [[ -f "$CUTOVER_PENDING_FILE" && ! -L "$CUTOVER_PENDING_FILE" ]] \
    || die 'PostgreSQL public cutover pending state must be a regular non-symlink file'
  assert_secure_file "$CUTOVER_PENDING_FILE"
  pending_kind="$(awk -F= '$1 == "kind" { print $2 }' "$CUTOVER_PENDING_FILE")"
  pending_host="$(awk -F= '$1 == "host" { print $2 }' "$CUTOVER_PENDING_FILE")"
  pending_state="$(awk -F= '$1 == "state" { print $2 }' "$CUTOVER_PENDING_FILE")"
  pending_token="$(awk -F= '$1 == "token" { print substr($0, index($0, "=") + 1) }' "$CUTOVER_PENDING_FILE")"
  pending_hba="$(awk -F= '$1 == "hba" { print $2 }' "$CUTOVER_PENDING_FILE")"
  [[ "$(wc -l < "$CUTOVER_PENDING_FILE" | tr -d '[:space:]')" = 5 \
    && "$(grep -c '^kind=' "$CUTOVER_PENDING_FILE")" = 1 \
    && "$(grep -c '^host=' "$CUTOVER_PENDING_FILE")" = 1 \
    && "$(grep -c '^state=' "$CUTOVER_PENDING_FILE")" = 1 \
    && "$(grep -c '^token=' "$CUTOVER_PENDING_FILE")" = 1 \
    && "$(grep -c '^hba=' "$CUTOVER_PENDING_FILE")" = 1 ]] \
    || die 'PostgreSQL public cutover pending state has an invalid field contract'
  [[ "$pending_kind" = legacy || "$pending_kind" = public ]] \
    || die 'PostgreSQL public cutover pending state is invalid'
  [[ "$pending_host" = "$PUBLIC_HOST" ]] \
    || die 'RAG_POSTGRES_PUBLIC_HOST conflicts with the pending PostgreSQL public cutover'
  [[ "$pending_state" = prepared || "$pending_state" = activated \
    || "$pending_state" = finalizing || "$pending_state" = finalized ]] \
    || die 'PostgreSQL public cutover pending state has an invalid transaction phase'
  [[ "$pending_token" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]] \
    || die 'PostgreSQL public cutover pending state has an invalid transaction token'
  [[ "$pending_hba" = temporary || "$pending_hba" = strict ]] \
    || die 'PostgreSQL public cutover pending state has an invalid HBA phase'
  if [[ "$CUTOVER_ACTION" != verify ]]; then
    [[ "$pending_token" = "$CUTOVER_TOKEN" ]] \
      || die 'RAG_POSTGRES_CUTOVER_TOKEN does not own the pending PostgreSQL public cutover'
  fi
fi

if [[ "$CUTOVER_ACTION" = prepare && -n "$pending_kind" && "$pending_state" != prepared ]]; then
  die 'PostgreSQL public cutover prepare cannot downgrade an active or committed transaction'
fi
if [[ "$CUTOVER_ACTION" = activate \
  && ( -z "$pending_kind" \
    || ( "$pending_state" != prepared && "$pending_state" != activated ) ) ]]; then
  die 'PostgreSQL public cutover activate requires a successful prepare action'
fi
if [[ "$CUTOVER_ACTION" = activate \
  && ( "$container_exists" = false || "$container_kind" != public ) ]]; then
  die 'PostgreSQL public cutover activate requires the prepared public container'
fi
if [[ "$CUTOVER_ACTION" = verify ]]; then
  [[ "$container_exists" = true && "$container_kind" = public ]] \
    || die 'PostgreSQL public verify requires a finalized public container'
  [[ ( -z "$pending_kind" && "$backup_exists" = false ) \
    || ( "$pending_state" = finalizing && "$backup_exists" = false ) \
    || ( "$pending_state" = finalized && "$backup_exists" = false ) ]] \
    || die 'PostgreSQL public verify found a cutover that is still rollback-capable'
fi
if [[ "$pending_state" = finalized && "$backup_exists" = true ]]; then
  die 'Finalized PostgreSQL cutover unexpectedly retains a rollback container'
fi
if [[ "$pending_state" = finalizing && "$pending_kind" = public && "$backup_exists" = true ]]; then
  die 'Existing-public PostgreSQL cutover unexpectedly has a loopback rollback container'
fi
if [[ "$CUTOVER_ACTION" = finalize ]]; then
  [[ "$container_exists" = true && "$container_kind" = public \
    && -n "$pending_kind" \
    && ( "$pending_state" = activated || "$pending_state" = finalizing || "$pending_state" = finalized ) ]] \
    || die 'PostgreSQL public cutover finalize requires an activated or cleanup-pending public container'
fi
if [[ "$CUTOVER_ACTION" = prepare && "$container_exists" = true && "$container_kind" = public ]]; then
  [[ -f "$CA_KEY_FILE" && ! -L "$CA_KEY_FILE" \
    && -f "$CA_CERT_FILE" && ! -L "$CA_CERT_FILE" \
    && -f "$SERVER_KEY_FILE" && ! -L "$SERVER_KEY_FILE" \
    && -f "$SERVER_CERT_FILE" && ! -L "$SERVER_CERT_FILE" \
    && -f "$PUBLIC_HOST_FILE" && ! -L "$PUBLIC_HOST_FILE" ]] \
    || die 'Existing public PostgreSQL container has incomplete protected TLS state; refusing non-reversible prepare'
fi

snapshot_cutover_file() {
  local source="$1"
  local label="$2"
  local target="$3"
  if [[ -e "$source" || -L "$source" ]]; then
    [[ -f "$source" && ! -L "$source" ]] \
      || die "PostgreSQL public cutover cannot snapshot a non-regular file: $source"
    cp -p -- "$source" "$target/$label"
    chmod 600 -- "$target/$label"
  else
    : > "$target/$label.absent"
    chmod 600 -- "$target/$label.absent"
  fi
}

validate_cutover_snapshot() {
  local snapshot="$1"
  local label present absent snapshot_token
  [[ -d "$snapshot" && ! -L "$snapshot" ]] \
    || die 'PostgreSQL public cutover snapshot path must be a non-symlink directory'
  assert_secure_directory "$snapshot"
  [[ -f "$snapshot/manifest" && ! -L "$snapshot/manifest" ]] \
    || die 'PostgreSQL public cutover snapshot manifest is invalid'
  assert_secure_file "$snapshot/manifest"
  snapshot_token="$(awk -F= '$1 == "token" { print substr($0, index($0, "=") + 1) }' "$snapshot/manifest")"
  [[ "$(wc -l < "$snapshot/manifest" | tr -d '[:space:]')" = 2 \
    && "$(grep -c '^version=2$' "$snapshot/manifest")" = 1 \
    && "$(grep -c '^token=' "$snapshot/manifest")" = 1 \
    && "$snapshot_token" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]] \
    || die 'PostgreSQL public cutover snapshot manifest is invalid'
  if [[ "$CUTOVER_ACTION" != verify ]]; then
    [[ "$snapshot_token" = "$CUTOVER_TOKEN" ]] \
      || die 'RAG_POSTGRES_CUTOVER_TOKEN does not own the PostgreSQL public cutover snapshot'
  fi
  for label in runtime.env migration.env rag-app-client.env server.key server.crt public-host; do
    present=false
    absent=false
    [[ ! -e "$snapshot/$label" && ! -L "$snapshot/$label" ]] || present=true
    [[ ! -e "$snapshot/$label.absent" && ! -L "$snapshot/$label.absent" ]] || absent=true
    [[ "$present" != "$absent" ]] \
      || die "PostgreSQL public cutover snapshot must contain exactly one state for $label"
    if [[ "$present" = true ]]; then
      [[ -f "$snapshot/$label" && ! -L "$snapshot/$label" ]] \
        || die "PostgreSQL public cutover snapshot contains an unsafe file: $label"
      assert_secure_file "$snapshot/$label"
    else
      [[ -f "$snapshot/$label.absent" && ! -L "$snapshot/$label.absent" ]] \
        || die "PostgreSQL public cutover snapshot contains an unsafe absence marker: $label"
      assert_secure_file "$snapshot/$label.absent"
    fi
  done
}

restore_cutover_file() {
  local destination="$1"
  local label="$2"
  local restore_stage
  if [[ -f "$CUTOVER_SNAPSHOT_DIR/$label.absent" ]]; then
    rm -f -- "$destination"
    return 0
  fi
  [[ -f "$CUTOVER_SNAPSHOT_DIR/$label" && ! -L "$CUTOVER_SNAPSHOT_DIR/$label" ]] \
    || die "PostgreSQL public cutover snapshot is incomplete: $label"
  restore_stage="$(mktemp "$(dirname -- "$destination")/.rollback.XXXXXX")"
  cp -- "$CUTOVER_SNAPSHOT_DIR/$label" "$restore_stage"
  chmod 600 -- "$restore_stage"
  mv -f -- "$restore_stage" "$destination"
}

if [[ -n "$pending_kind" && ! -e "$CUTOVER_SNAPSHOT_DIR" \
  && "$pending_state" != finalized \
  && ! ( "$pending_state" = finalizing && "$backup_exists" = false ) ]]; then
  die 'PostgreSQL public cutover pending state has lost its protected rollback snapshot'
fi
if [[ "$backup_exists" = true && "$container_exists" = false \
  && -z "$pending_kind" && ! -e "$CUTOVER_SNAPSHOT_DIR" ]]; then
  die 'PostgreSQL loopback rollback container has no release-owned cutover transaction'
fi
if [[ "$CUTOVER_ACTION" = prepare && ! -e "$CUTOVER_SNAPSHOT_DIR" ]]; then
  snapshot_stage="$(mktemp -d "$STATE_DIR/.public-cutover-snapshot.XXXXXX")"
  chmod 700 -- "$snapshot_stage"
  printf 'version=2\ntoken=%s\n' "$CUTOVER_TOKEN" > "$snapshot_stage/manifest"
  chmod 600 -- "$snapshot_stage/manifest"
  snapshot_cutover_file "$RUNTIME_ENV" runtime.env "$snapshot_stage"
  snapshot_cutover_file "$MIGRATION_ENV" migration.env "$snapshot_stage"
  snapshot_cutover_file "$PUBLIC_CLIENT_ENV" rag-app-client.env "$snapshot_stage"
  snapshot_cutover_file "$SERVER_KEY_FILE" server.key "$snapshot_stage"
  snapshot_cutover_file "$SERVER_CERT_FILE" server.crt "$snapshot_stage"
  snapshot_cutover_file "$PUBLIC_HOST_FILE" public-host "$snapshot_stage"
  validate_cutover_snapshot "$snapshot_stage"
  mv -- "$snapshot_stage" "$CUTOVER_SNAPSHOT_DIR"
  snapshot_stage=''
elif [[ ( "$pending_state" != finalized \
    && ! ( "$pending_state" = finalizing && "$backup_exists" = false ) ) \
  && ( -e "$CUTOVER_SNAPSHOT_DIR" || -L "$CUTOVER_SNAPSHOT_DIR" ) ]]; then
  validate_cutover_snapshot "$CUTOVER_SNAPSHOT_DIR"
fi

if [[ "$CUTOVER_ACTION" = prepare && "$container_exists" = false && "$backup_exists" = true ]]; then
  docker rename "$CONTAINER_BACKUP_NAME" "$CONTAINER_NAME" >/dev/null 2>&1 \
    || die 'Release-owned PostgreSQL cutover could not restore the loopback container name'
  docker start "$CONTAINER_NAME" >/dev/null 2>&1 \
    || die 'Release-owned PostgreSQL cutover could not restart the loopback container'
  container_exists=true
  container_kind=legacy
  backup_exists=false
fi

cleanup_committed_cutover_state() {
  local snapshot_clean=true
  if [[ -e "$CUTOVER_SNAPSHOT_DIR" || -L "$CUTOVER_SNAPSHOT_DIR" ]]; then
    if ! rm -rf -- "$CUTOVER_SNAPSHOT_DIR"; then
      echo 'Warning: committed PostgreSQL cutover snapshot cleanup remains pending' >&2
      snapshot_clean=false
    fi
  fi
  if [[ "$snapshot_clean" = true && ( -e "$CUTOVER_PENDING_FILE" || -L "$CUTOVER_PENDING_FILE" ) ]]; then
    rm -f -- "$CUTOVER_PENDING_FILE" \
      || echo 'Warning: committed PostgreSQL cutover marker cleanup remains pending' >&2
  fi
}

if [[ "$CUTOVER_ACTION" = finalize \
  && ( "$pending_state" = finalized \
    || ( "$pending_state" = finalizing && "$pending_kind" = public ) \
    || ( "$pending_state" = finalizing && "$pending_kind" = legacy && "$backup_exists" = false ) ) ]]; then
  cleanup_committed_cutover_state
  echo 'PostgreSQL public cutover was already committed; pending transaction cleanup was retried'
  exit 0
fi

if [[ "$CUTOVER_ACTION" = rollback ]]; then
  if [[ -z "$pending_kind" && ! -e "$CUTOVER_SNAPSHOT_DIR" ]]; then
    echo 'No PostgreSQL public cutover transaction exists for this release token'
    exit 0
  fi
  cutover_irreversible=false
  if [[ "$pending_state" = finalized \
    || ( "$pending_state" = finalizing && "$pending_kind" = public ) \
    || ( "$pending_state" = finalizing && "$pending_kind" = legacy && "$backup_exists" = false ) ]]; then
    cutover_irreversible=true
  fi
  if [[ "$cutover_irreversible" = true ]]; then
    echo 'PostgreSQL public cutover is already committed; cleanup remains pending and rollback is intentionally skipped'
    exit 0
  fi
  if [[ "$pending_kind" = legacy && "$container_kind" = public && "$backup_exists" = false ]]; then
    die 'PostgreSQL public rollback lost its required loopback rollback container'
  fi
  if [[ "$pending_kind" = public && "$backup_exists" = true ]]; then
    die 'PostgreSQL public rollback found an unexpected loopback rollback container'
  fi
  [[ -d "$CUTOVER_SNAPSHOT_DIR" && ! -L "$CUTOVER_SNAPSHOT_DIR" ]] \
    || die 'PostgreSQL public rollback has no protected pre-cutover snapshot'
  if [[ "$container_exists" = true && "$container_kind" = legacy && "$backup_exists" = false ]]; then
    legacy_running="$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)"
    if [[ "$legacy_running" != true ]]; then
      docker start "$CONTAINER_NAME" >/dev/null 2>&1 \
        || die 'Stopped PostgreSQL loopback container could not be restarted during rollback'
    fi
    rollback_ready=false
    for ((attempt = 1; attempt <= READY_ATTEMPTS; attempt += 1)); do
      if docker exec "$CONTAINER_NAME" pg_isready -q -U "$ADMIN_ROLE" -d "$DATABASE_NAME" >/dev/null 2>&1; then
        rollback_ready=true
        break
      fi
      sleep "$READY_INTERVAL"
    done
    [[ "$rollback_ready" = true ]] \
      || die 'PostgreSQL loopback container did not become ready during rollback'
  fi
  rollback_was_public=false
  [[ "$container_exists" = true && "$container_kind" = public && "$backup_exists" = false ]] \
    && rollback_was_public=true
  if [[ "$backup_exists" = true ]]; then
    if [[ "$container_exists" = true ]]; then
      [[ "$container_kind" = public ]] \
        || die 'PostgreSQL public rollback found a non-public active container'
      docker rm --force "$CONTAINER_NAME" >/dev/null 2>&1 \
        || die 'PostgreSQL public candidate could not be removed during rollback'
    fi
    docker rename "$CONTAINER_BACKUP_NAME" "$CONTAINER_NAME" >/dev/null 2>&1 \
      || die 'PostgreSQL loopback rollback container could not recover its managed name'
    docker start "$CONTAINER_NAME" >/dev/null 2>&1 \
      || die 'PostgreSQL loopback rollback container could not be restarted'
    rollback_ready=false
    for ((attempt = 1; attempt <= READY_ATTEMPTS; attempt += 1)); do
      if docker exec "$CONTAINER_NAME" pg_isready -q -U "$ADMIN_ROLE" -d "$DATABASE_NAME" >/dev/null 2>&1; then
        rollback_ready=true
        break
      fi
      sleep "$READY_INTERVAL"
    done
    [[ "$rollback_ready" = true ]] \
      || die 'PostgreSQL loopback container was restored but did not become ready'
    rm -f -- "$PUBLIC_CLIENT_ENV"
  fi
  if [[ -d "$CUTOVER_SNAPSHOT_DIR" ]]; then
    restore_cutover_file "$RUNTIME_ENV" runtime.env
    restore_cutover_file "$MIGRATION_ENV" migration.env
    restore_cutover_file "$PUBLIC_CLIENT_ENV" rag-app-client.env
    restore_cutover_file "$SERVER_KEY_FILE" server.key
    restore_cutover_file "$SERVER_CERT_FILE" server.crt
    restore_cutover_file "$PUBLIC_HOST_FILE" public-host
    if [[ "$rollback_was_public" = true && -f "$SERVER_KEY_FILE" && -f "$SERVER_CERT_FILE" ]]; then
      docker cp "$SERVER_KEY_FILE" "$CONTAINER_NAME:$CONTAINER_TLS_DIR/server.key.next" >/dev/null 2>&1 \
        || die 'PostgreSQL rollback server key could not be staged'
      docker cp "$SERVER_CERT_FILE" "$CONTAINER_NAME:$CONTAINER_TLS_DIR/server.crt.next" >/dev/null 2>&1 \
        || die 'PostgreSQL rollback server certificate could not be staged'
      docker exec --user root "$CONTAINER_NAME" sh -ceu '
        chown postgres:postgres /var/lib/postgresql/data/rag-tls/server.key.next /var/lib/postgresql/data/rag-tls/server.crt.next
        chmod 600 /var/lib/postgresql/data/rag-tls/server.key.next
        chmod 644 /var/lib/postgresql/data/rag-tls/server.crt.next
        mv -f /var/lib/postgresql/data/rag-tls/server.key.next /var/lib/postgresql/data/rag-tls/server.key
        mv -f /var/lib/postgresql/data/rag-tls/server.crt.next /var/lib/postgresql/data/rag-tls/server.crt
      ' >/dev/null 2>&1 || die 'PostgreSQL rollback server certificate could not be activated'
      docker exec --user postgres "$CONTAINER_NAME" pg_ctl reload -D /var/lib/postgresql/data >/dev/null 2>&1 \
        || die 'PostgreSQL rollback server certificate could not be reloaded'
    fi
    rm -rf -- "$CUTOVER_SNAPSHOT_DIR" \
      || die 'PostgreSQL public rollback could not remove its protected snapshot'
  fi
  rm -f -- "$CUTOVER_PENDING_FILE" \
    || die 'PostgreSQL public rollback could not clear its pending marker'
  echo 'PostgreSQL public cutover rollback completed; the named data volume was preserved'
  exit 0
fi

if [[ "$container_exists" = false ]]; then
  if [[ -n "$(ss -H -ltn "sport = :$HOST_PORT" 2>/dev/null || true)" ]]; then
    die "Host port $HOST_PORT is already in use; refusing to replace or stop its owner"
  fi
  if [[ "$volume_exists" = true && "$credentials_exist" = false ]]; then
    die "Volume $VOLUME_NAME exists without its protected credential state; refusing unsafe adoption"
  fi
elif [[ "$credentials_exist" = false ]]; then
  die "Container $CONTAINER_NAME exists without its protected credential state; refusing unsafe adoption"
fi

if [[ "$credentials_exist" = false ]]; then
  owner_password="$(openssl rand -hex 32 2>/dev/null)"
  app_password="$(openssl rand -hex 32 2>/dev/null)"
  admin_password="$(openssl rand -hex 32 2>/dev/null)"
  [[ "$owner_password" =~ ^[0-9a-f]{64}$ \
    && "$app_password" =~ ^[0-9a-f]{64}$ \
    && "$admin_password" =~ ^[0-9a-f]{64}$ ]] \
    || die 'OpenSSL did not produce valid PostgreSQL credentials'
  credentials_stage="$(mktemp "$STATE_DIR/.credentials.XXXXXX")"
  chmod 600 -- "$credentials_stage"
  printf 'OWNER_PASSWORD=%s\nAPP_PASSWORD=%s\nADMIN_PASSWORD=%s\n' \
    "$owner_password" "$app_password" "$admin_password" > "$credentials_stage"
  mv -f -- "$credentials_stage" "$CREDENTIALS_FILE"
  credentials_stage=''
  credentials_exist=true
fi

assert_tls_regular_file() {
  local filename="$1"
  [[ -f "$filename" && ! -L "$filename" ]] \
    || die "PostgreSQL TLS asset must be a regular non-symlink file: $filename"
  [[ "$(stat -c '%u' -- "$filename")" = "$(id -u)" ]] \
    || die "PostgreSQL TLS asset is not owned by the current user: $filename"
}

ca_key_exists=false
ca_cert_exists=false
[[ ! -e "$CA_KEY_FILE" && ! -L "$CA_KEY_FILE" ]] || ca_key_exists=true
[[ ! -e "$CA_CERT_FILE" && ! -L "$CA_CERT_FILE" ]] || ca_cert_exists=true
if [[ "$CUTOVER_ACTION" != prepare \
  && ( "$ca_key_exists" = false || "$ca_cert_exists" = false ) ]]; then
  die 'PostgreSQL public cutover validation found incomplete TLS CA state'
fi
if [[ "$ca_cert_exists" = true && "$ca_key_exists" = false ]]; then
  die 'PostgreSQL TLS CA certificate exists without its private key; refusing unsafe CA rotation'
fi
if [[ "$ca_key_exists" = true ]]; then
  assert_tls_regular_file "$CA_KEY_FILE"
  assert_secure_file "$CA_KEY_FILE"
fi
if [[ "$ca_cert_exists" = true ]]; then
  assert_tls_regular_file "$CA_CERT_FILE"
fi

tls_stage="$(mktemp -d "$STATE_DIR/.tls-stage.XXXXXX")"
chmod 700 -- "$tls_stage"
if [[ "$ca_key_exists" = false ]]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 \
    -out "$tls_stage/ca.key" >/dev/null 2>&1 \
    || die 'PostgreSQL TLS CA private key could not be generated'
  chmod 600 -- "$tls_stage/ca.key"
  openssl req -x509 -new -sha256 -days 3650 \
    -key "$tls_stage/ca.key" \
    -subj '/CN=RAG System private PostgreSQL CA' \
    -out "$tls_stage/ca.crt" >/dev/null 2>&1 \
    || die 'PostgreSQL TLS CA certificate could not be generated'
  chmod 644 -- "$tls_stage/ca.crt"
  mv -f -- "$tls_stage/ca.key" "$CA_KEY_FILE"
  mv -f -- "$tls_stage/ca.crt" "$CA_CERT_FILE"
  ca_key_exists=true
  ca_cert_exists=true
elif [[ "$ca_cert_exists" = false ]]; then
  openssl req -x509 -new -sha256 -days 3650 \
    -key "$CA_KEY_FILE" \
    -subj '/CN=RAG System private PostgreSQL CA' \
    -out "$tls_stage/ca.crt" >/dev/null 2>&1 \
    || die 'PostgreSQL TLS CA certificate could not be recovered from its private key'
  chmod 644 -- "$tls_stage/ca.crt"
  mv -f -- "$tls_stage/ca.crt" "$CA_CERT_FILE"
  ca_cert_exists=true
fi

rotate_server_certificate=true
if [[ -f "$SERVER_KEY_FILE" && ! -L "$SERVER_KEY_FILE" \
  && -f "$SERVER_CERT_FILE" && ! -L "$SERVER_CERT_FILE" \
  && -f "$PUBLIC_HOST_FILE" && ! -L "$PUBLIC_HOST_FILE" \
  && "$(cat -- "$PUBLIC_HOST_FILE")" = "$PUBLIC_HOST" ]]; then
  assert_tls_regular_file "$SERVER_KEY_FILE"
  assert_secure_file "$SERVER_KEY_FILE"
  assert_tls_regular_file "$SERVER_CERT_FILE"
  assert_tls_regular_file "$PUBLIC_HOST_FILE"
  reusable_identity=false
  if is_ipv4_address "$PUBLIC_HOST"; then
    openssl verify -CAfile "$CA_CERT_FILE" -verify_ip "$PUBLIC_HOST" "$SERVER_CERT_FILE" >/dev/null 2>&1 \
      && reusable_identity=true || true
  else
    openssl verify -CAfile "$CA_CERT_FILE" -verify_hostname "$PUBLIC_HOST" "$SERVER_CERT_FILE" >/dev/null 2>&1 \
      && reusable_identity=true || true
  fi
  reusable_key=false
  if openssl pkey -in "$SERVER_KEY_FILE" -pubout -out "$tls_stage/reuse-key.pub" >/dev/null 2>&1 \
    && openssl x509 -in "$SERVER_CERT_FILE" -pubkey -noout -out "$tls_stage/reuse-cert.pub" >/dev/null 2>&1 \
    && cmp -s "$tls_stage/reuse-key.pub" "$tls_stage/reuse-cert.pub"; then
    reusable_key=true
  fi
  if openssl x509 -in "$SERVER_CERT_FILE" -noout -checkend 2592000 >/dev/null 2>&1 \
    && openssl verify -CAfile "$CA_CERT_FILE" "$SERVER_CERT_FILE" >/dev/null 2>&1 \
    && [[ "$reusable_identity" = true && "$reusable_key" = true ]]; then
    rotate_server_certificate=false
  fi
fi

if [[ "$rotate_server_certificate" = true ]]; then
  [[ "$CUTOVER_ACTION" = prepare ]] \
    || die 'PostgreSQL public cutover validation found a missing, mismatched, or near-expiry server certificate'
  cat > "$tls_stage/server.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$public_san
EOF
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 \
    -out "$tls_stage/server.key" >/dev/null 2>&1 \
    || die 'PostgreSQL TLS server private key could not be generated'
  openssl req -new -sha256 \
    -key "$tls_stage/server.key" \
    -subj "/CN=$PUBLIC_HOST" \
    -out "$tls_stage/server.csr" >/dev/null 2>&1 \
    || die 'PostgreSQL TLS server request could not be generated'
  openssl x509 -req -sha256 -days 825 \
    -in "$tls_stage/server.csr" \
    -CA "$CA_CERT_FILE" -CAkey "$CA_KEY_FILE" -CAcreateserial \
    -extfile "$tls_stage/server.ext" \
    -out "$tls_stage/server.crt" >/dev/null 2>&1 \
    || die 'PostgreSQL TLS server certificate could not be signed'
  chmod 600 -- "$tls_stage/server.key"
  chmod 644 -- "$tls_stage/server.crt"
  printf '%s\n' "$PUBLIC_HOST" > "$tls_stage/public-host"
  chmod 600 -- "$tls_stage/public-host"
  mv -f -- "$tls_stage/server.key" "$SERVER_KEY_FILE"
  mv -f -- "$tls_stage/server.crt" "$SERVER_CERT_FILE"
  mv -f -- "$tls_stage/public-host" "$PUBLIC_HOST_FILE"
fi

openssl verify -CAfile "$CA_CERT_FILE" "$SERVER_CERT_FILE" >/dev/null 2>&1 \
  || die 'PostgreSQL TLS server certificate does not verify against the private CA'
openssl verify -CAfile "$CA_CERT_FILE" "$CA_CERT_FILE" >/dev/null 2>&1 \
  || die 'PostgreSQL TLS private CA certificate is not self-verifying'
openssl x509 -in "$CA_CERT_FILE" -noout -checkend 77760000 >/dev/null 2>&1 \
  || die 'PostgreSQL TLS private CA expires too soon for safe automatic server-certificate renewal'
openssl pkey -in "$CA_KEY_FILE" -pubout -out "$tls_stage/ca-key.pub" >/dev/null 2>&1 \
  || die 'PostgreSQL TLS CA private key could not be inspected'
openssl x509 -in "$CA_CERT_FILE" -pubkey -noout -out "$tls_stage/ca-cert.pub" >/dev/null 2>&1 \
  || die 'PostgreSQL TLS CA certificate public key could not be inspected'
cmp -s "$tls_stage/ca-key.pub" "$tls_stage/ca-cert.pub" \
  || die 'PostgreSQL TLS CA private key does not match its certificate'
openssl pkey -in "$SERVER_KEY_FILE" -pubout -out "$tls_stage/server-key.pub" >/dev/null 2>&1 \
  || die 'PostgreSQL TLS server private key could not be inspected'
openssl x509 -in "$SERVER_CERT_FILE" -pubkey -noout -out "$tls_stage/server-cert.pub" >/dev/null 2>&1 \
  || die 'PostgreSQL TLS server certificate public key could not be inspected'
cmp -s "$tls_stage/server-key.pub" "$tls_stage/server-cert.pub" \
  || die 'PostgreSQL TLS server private key does not match its certificate'
if is_ipv4_address "$PUBLIC_HOST"; then
  openssl verify -CAfile "$CA_CERT_FILE" -verify_ip "$PUBLIC_HOST" "$SERVER_CERT_FILE" >/dev/null 2>&1 \
    || die 'PostgreSQL TLS server certificate does not match RAG_POSTGRES_PUBLIC_HOST'
else
  openssl verify -CAfile "$CA_CERT_FILE" -verify_hostname "$PUBLIC_HOST" "$SERVER_CERT_FILE" >/dev/null 2>&1 \
    || die 'PostgreSQL TLS server certificate does not match RAG_POSTGRES_PUBLIC_HOST'
fi
rm -rf -- "$tls_stage"
tls_stage=''

if [[ "$volume_exists" = false ]]; then
  docker volume create "$VOLUME_NAME" >/dev/null 2>&1 \
    || die 'Dedicated PostgreSQL volume could not be created'
fi

wait_for_postgres() {
  local name="$1"
  local kind="$2"
  local ready=false
  local attempt
  for ((attempt = 1; attempt <= READY_ATTEMPTS; attempt += 1)); do
    if [[ "$kind" = public ]]; then
      docker exec "$name" pg_isready -q --host="$CONTAINER_SOCKET_DIR" -U "$ADMIN_ROLE" -d "$DATABASE_NAME" >/dev/null 2>&1 \
        && ready=true || true
    else
      docker exec "$name" pg_isready -q -U "$ADMIN_ROLE" -d "$DATABASE_NAME" >/dev/null 2>&1 \
        && ready=true || true
    fi
    if [[ "$ready" = true ]]; then
      ready=true
      break
    fi
    sleep "$READY_INTERVAL"
  done
  [[ "$ready" = true ]]
}

if [[ "$container_exists" = false ]]; then
  container_env_stage="$(mktemp "$STATE_DIR/.container-env.XXXXXX")"
  chmod 600 -- "$container_env_stage"
  printf 'POSTGRES_USER=%s\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=%s\n' \
    "$ADMIN_ROLE" "$admin_password" "$DATABASE_NAME" > "$container_env_stage"
  if ! docker run -d \
    --name "$CONTAINER_NAME" \
    --label "$LEGACY_CONTAINER_LABEL" \
    --restart unless-stopped \
    --publish "$LOCAL_HOST_ADDRESS:$HOST_PORT:$CONTAINER_PORT" \
    --volume "$VOLUME_NAME:/var/lib/postgresql/data" \
    --env-file "$container_env_stage" \
    --health-cmd "pg_isready -U $ADMIN_ROLE -d $DATABASE_NAME" \
    --health-interval 5s \
    --health-timeout 3s \
    --health-retries 20 \
    "$CONTAINER_IMAGE" postgres >/dev/null 2>&1; then
    die 'Dedicated PostgreSQL container could not be created'
  fi
  rm -f -- "$container_env_stage"
  container_env_stage=''
  container_kind=legacy
  container_exists=true
else
  running="$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  if [[ "$running" != true ]]; then
    docker start "$CONTAINER_NAME" >/dev/null 2>&1 \
      || die 'Dedicated PostgreSQL container could not be started'
  fi
fi

wait_for_postgres "$CONTAINER_NAME" "$container_kind" \
  || die 'Dedicated PostgreSQL container did not become ready'

if [[ "$CUTOVER_ACTION" = prepare ]]; then
  postgres_identity="$(docker exec --user postgres "$CONTAINER_NAME" sh -ceu \
    'printf "%s:%s\n" "$(id -u)" "$(id -g)"' 2>/dev/null || true)"
  [[ "$postgres_identity" =~ ^[0-9]+:[0-9]+$ ]] \
    || die 'PostgreSQL container process identity could not be determined safely'
  chown "$postgres_identity" -- "$SOCKET_DIR" \
    || die 'Protected PostgreSQL Unix socket directory could not be assigned to the container process'
  chmod 700 -- "$SOCKET_DIR"
fi

# Passwords are sent over stdin so no secret appears in the Docker
# command line, process listing, success output, or generic failure output.
admin_psql_host=()
if [[ "$container_kind" = public ]]; then
  admin_psql_host=(--host="$CONTAINER_SOCKET_DIR")
fi
if [[ "$CUTOVER_ACTION" = prepare ]]; then
if ! {
  printf '%s\n' 'BEGIN;'
  printf "%s\n" "SET LOCAL password_encryption = 'scram-sha-256';"
  printf '%s\n' 'DO $rag$'
  printf '%s\n' 'BEGIN'
  printf "  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '%s') THEN\n" "$OWNER_ROLE"
  printf "    ALTER ROLE %s WITH LOGIN PASSWORD '%s' CONNECTION LIMIT 5 NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT NOBYPASSRLS;\n" "$OWNER_ROLE" "$owner_password"
  printf '%s\n' '  ELSE'
  printf "    CREATE ROLE %s WITH LOGIN PASSWORD '%s' CONNECTION LIMIT 5 NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT NOBYPASSRLS;\n" "$OWNER_ROLE" "$owner_password"
  printf '%s\n' '  END IF;'
  printf "  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '%s') THEN\n" "$APP_ROLE"
  printf "    ALTER ROLE %s WITH LOGIN PASSWORD '%s' CONNECTION LIMIT 40 NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT NOBYPASSRLS;\n" "$APP_ROLE" "$app_password"
  printf '%s\n' '  ELSE'
  printf "    CREATE ROLE %s WITH LOGIN PASSWORD '%s' CONNECTION LIMIT 40 NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT NOBYPASSRLS;\n" "$APP_ROLE" "$app_password"
  printf '%s\n' '  END IF;'
  printf '%s\n' 'END'
  printf '%s\n' '$rag$;'
  printf 'GRANT %s TO %s WITH ADMIN TRUE, SET FALSE, INHERIT FALSE;\n' "$APP_ROLE" "$OWNER_ROLE"
  printf '%s\n' 'DO $verify$'
  printf '%s\n' 'BEGIN'
  printf "%s\n" "  IF NOT EXISTS ("
  printf "%s\n" "    SELECT 1 FROM pg_roles"
  printf "    WHERE rolname = '%s' AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb\n" "$OWNER_ROLE"
  printf '%s\n' '      AND NOT rolcreaterole AND NOT rolreplication AND rolinherit AND NOT rolbypassrls'
  printf '%s\n' '  ) THEN'
  printf "%s\n" "    RAISE EXCEPTION 'PostgreSQL migration owner role contract was not applied';"
  printf '%s\n' '  END IF;'
  printf "%s\n" "  IF NOT EXISTS ("
  printf "%s\n" "    SELECT 1 FROM pg_roles"
  printf "    WHERE rolname = '%s' AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb\n" "$APP_ROLE"
  printf '%s\n' '      AND NOT rolcreaterole AND NOT rolreplication AND rolinherit AND NOT rolbypassrls'
  printf '%s\n' '  ) THEN'
  printf "%s\n" "    RAISE EXCEPTION 'PostgreSQL application role contract was not applied';"
  printf '%s\n' '  END IF;'
  printf '%s\n' '  IF NOT EXISTS ('
  printf '%s\n' '    SELECT 1'
  printf '%s\n' '    FROM pg_auth_members membership'
  printf '%s\n' '    JOIN pg_roles granted_role ON granted_role.oid = membership.roleid'
  printf '%s\n' '    JOIN pg_roles member_role ON member_role.oid = membership.member'
  printf "    WHERE granted_role.rolname = '%s' AND member_role.rolname = '%s'\n" "$APP_ROLE" "$OWNER_ROLE"
  printf '%s\n' '      AND membership.admin_option AND NOT membership.inherit_option AND NOT membership.set_option'
  printf '%s\n' '  ) THEN'
  printf "%s\n" "    RAISE EXCEPTION 'PostgreSQL owner/application membership contract was not applied';"
  printf '%s\n' '  END IF;'
  printf '%s\n' 'END'
  printf '%s\n' '$verify$;'
  printf 'ALTER DATABASE %s OWNER TO %s;\n' "$DATABASE_NAME" "$OWNER_ROLE"
  printf 'ALTER SCHEMA public OWNER TO %s;\n' "$OWNER_ROLE"
  printf '%s\n' 'REVOKE CREATE ON SCHEMA public FROM PUBLIC;'
  printf 'GRANT CONNECT ON DATABASE %s TO %s;\n' "$DATABASE_NAME" "$OWNER_ROLE"
  printf 'GRANT CONNECT ON DATABASE %s TO %s;\n' "$DATABASE_NAME" "$APP_ROLE"
  printf "ALTER ROLE %s WITH LOGIN PASSWORD '%s';\n" "$ADMIN_ROLE" "$admin_password"
  printf '%s\n' 'COMMIT;'
} | docker exec --user postgres -i "$CONTAINER_NAME" \
  psql --no-psqlrc --set ON_ERROR_STOP=1 "${admin_psql_host[@]}" --username "$ADMIN_ROLE" --dbname "$DATABASE_NAME" \
  >/dev/null 2>&1; then
  die 'PostgreSQL owner/application roles could not be reconciled'
fi
fi

write_managed_hba() {
  local mode="$1"
  local target="$2"
  local gateway="${3:-}"
  cat > "$target" <<EOF
# Managed by provision-postgres-host.sh. First-match order is security-sensitive.
local   all         postgres                         peer
local   $DATABASE_NAME  $OWNER_ROLE                       scram-sha-256
local   all         all                              reject
EOF
  if [[ "$mode" = temporary ]]; then
    is_ipv4_address "$gateway" \
      || die 'Temporary PostgreSQL compatibility HBA requires one exact Docker IPv4 gateway'
    cat >> "$target" <<EOF
# Temporary compatibility for the old pre-cutover app process only. Finalize
# removes this plaintext rule after the TLS-required app has passed readiness.
hostnossl $DATABASE_NAME $APP_ROLE $gateway/32 scram-sha-256
EOF
  fi
  cat >> "$target" <<EOF
hostnossl all         all       0.0.0.0/0             reject
hostssl   $DATABASE_NAME $APP_ROLE 0.0.0.0/0             scram-sha-256
hostssl   all         all       0.0.0.0/0             reject
hostnossl all         all       ::0/0                 reject
hostssl   $DATABASE_NAME $APP_ROLE ::0/0                 scram-sha-256
hostssl   all         all       ::0/0                 reject
EOF
}

stage_hba() {
  local mode="$1"
  local gateway="${2:-}"
  hba_stage="$(mktemp "$STATE_DIR/.pg-hba.XXXXXX")"
  chmod 600 -- "$hba_stage"
  write_managed_hba "$mode" "$hba_stage" "$gateway"
  docker cp "$hba_stage" "$CONTAINER_NAME:$CONTAINER_HBA_FILE.next" >/dev/null 2>&1 \
    || die 'PostgreSQL pg_hba.conf could not be staged in the data volume'
  rm -f -- "$hba_stage"
  hba_stage=''
}

expected_hba_mode=strict
if [[ "$CUTOVER_ACTION" = prepare ]]; then
  if [[ -n "$pending_hba" ]]; then
    expected_hba_mode="$pending_hba"
  elif [[ "$legacy_plaintext_compatibility_required" = true \
    && ( "$container_kind" = legacy || "$backup_exists" = true || "$pending_kind" = legacy ) ]]; then
    expected_hba_mode=temporary
  fi
elif [[ "$CUTOVER_ACTION" = activate ]]; then
  expected_hba_mode="$pending_hba"
fi

if [[ "$CUTOVER_ACTION" = prepare ]]; then
  docker_gateway=''
  if [[ "$expected_hba_mode" = temporary ]]; then
    docker_gateway="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.Gateway}}{{println}}{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)"
    [[ "$docker_gateway" != *$'\n'* ]] \
      || die 'Managed PostgreSQL container has an ambiguous Docker gateway'
    is_ipv4_address "$docker_gateway" \
      || die 'Managed PostgreSQL container has no valid IPv4 Docker gateway'
  fi
  docker exec --user root "$CONTAINER_NAME" \
    install -d -o postgres -g postgres -m 700 "$CONTAINER_TLS_DIR" >/dev/null 2>&1 \
    || die 'PostgreSQL in-volume TLS directory could not be prepared'
  for tls_asset in ca.crt server.crt server.key; do
    docker cp "$TLS_DIR/$tls_asset" "$CONTAINER_NAME:$CONTAINER_TLS_DIR/$tls_asset.next" >/dev/null 2>&1 \
      || die "PostgreSQL TLS asset could not be staged in the data volume: $tls_asset"
  done
  stage_hba "$expected_hba_mode" "$docker_gateway"
  docker exec --user root "$CONTAINER_NAME" sh -ceu '
    chown postgres:postgres \
      /var/lib/postgresql/data/rag-tls/ca.crt.next \
      /var/lib/postgresql/data/rag-tls/server.crt.next \
      /var/lib/postgresql/data/rag-tls/server.key.next \
      /var/lib/postgresql/data/rag-tls/pg_hba.conf.next
    chmod 600 /var/lib/postgresql/data/rag-tls/server.key.next
    chmod 644 \
      /var/lib/postgresql/data/rag-tls/ca.crt.next \
      /var/lib/postgresql/data/rag-tls/server.crt.next \
      /var/lib/postgresql/data/rag-tls/pg_hba.conf.next
    mv -f /var/lib/postgresql/data/rag-tls/ca.crt.next /var/lib/postgresql/data/rag-tls/ca.crt
    mv -f /var/lib/postgresql/data/rag-tls/server.crt.next /var/lib/postgresql/data/rag-tls/server.crt
    mv -f /var/lib/postgresql/data/rag-tls/server.key.next /var/lib/postgresql/data/rag-tls/server.key
    mv -f /var/lib/postgresql/data/rag-tls/pg_hba.conf.next /var/lib/postgresql/data/rag-tls/pg_hba.conf
  ' >/dev/null 2>&1 || die 'PostgreSQL TLS and HBA assets could not be activated in the data volume'

  # This database-level sentinel survives replacement and proves that the
  # candidate is attached to the expected named data volume.
  printf '%s\n' "ALTER DATABASE $DATABASE_NAME SET \"rag.provision_sentinel\" = 'managed-v3';" \
    | docker exec --user postgres -i "$CONTAINER_NAME" \
      psql --no-psqlrc --set ON_ERROR_STOP=1 "${admin_psql_host[@]}" --username "$ADMIN_ROLE" --dbname "$DATABASE_NAME" \
      >/dev/null 2>&1 \
    || die 'PostgreSQL data-volume sentinel could not be recorded'
elif [[ "$CUTOVER_ACTION" = finalize && ( "$pending_state" = activated || "$backup_exists" = true ) ]]; then
  stage_hba strict
  docker exec --user root "$CONTAINER_NAME" sh -ceu '
    chown postgres:postgres /var/lib/postgresql/data/rag-tls/pg_hba.conf.next
    chmod 644 /var/lib/postgresql/data/rag-tls/pg_hba.conf.next
    mv -f /var/lib/postgresql/data/rag-tls/pg_hba.conf.next /var/lib/postgresql/data/rag-tls/pg_hba.conf
  ' >/dev/null 2>&1 || die 'Strict PostgreSQL HBA could not be activated before finalize'
  docker exec --user postgres "$CONTAINER_NAME" pg_ctl reload -D /var/lib/postgresql/data >/dev/null 2>&1 \
    || die 'Strict PostgreSQL HBA could not be reloaded before finalize'
fi

rollback_public_candidate() {
  local restored=true
  if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    docker rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || restored=false
  fi
  docker rename "$CONTAINER_BACKUP_NAME" "$CONTAINER_NAME" >/dev/null 2>&1 || restored=false
  docker start "$CONTAINER_NAME" >/dev/null 2>&1 || restored=false
  if [[ "$restored" = true ]]; then
    wait_for_postgres "$CONTAINER_NAME" legacy || restored=false
  fi
  [[ "$restored" = true ]]
}

if [[ "$CUTOVER_ACTION" = prepare && "$container_kind" = legacy ]]; then
  [[ "$backup_exists" = false ]] \
    || die 'A rollback container already exists before PostgreSQL public cutover'
  docker stop "$CONTAINER_NAME" >/dev/null 2>&1 \
    || die 'Loopback PostgreSQL container could not be stopped for public cutover'
  docker rename "$CONTAINER_NAME" "$CONTAINER_BACKUP_NAME" >/dev/null 2>&1 \
    || {
      docker start "$CONTAINER_NAME" >/dev/null 2>&1 || true
      die 'Loopback PostgreSQL container could not be reserved for rollback'
    }
  backup_exists=true
  container_env_stage="$(mktemp "$STATE_DIR/.container-env.XXXXXX")"
  chmod 600 -- "$container_env_stage"
  printf 'POSTGRES_USER=%s\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=%s\n' \
    "$ADMIN_ROLE" "$admin_password" "$DATABASE_NAME" > "$container_env_stage"
  if ! docker run -d \
    --name "$CONTAINER_NAME" \
    --label "$CONTAINER_LABEL" \
    --restart unless-stopped \
    --memory "$PUBLIC_MEMORY" \
    --memory-swap "$PUBLIC_MEMORY" \
    --cpus "$PUBLIC_CPUS" \
    --shm-size "$PUBLIC_SHM_SIZE" \
    --log-driver json-file \
    --log-opt "max-size=$PUBLIC_LOG_MAX_SIZE" \
    --log-opt "max-file=$PUBLIC_LOG_MAX_FILE" \
    --publish "$PUBLIC_HOST_ADDRESS:$HOST_PORT:$CONTAINER_PORT" \
    --volume "$VOLUME_NAME:/var/lib/postgresql/data" \
    --volume "$SOCKET_DIR:$CONTAINER_SOCKET_DIR" \
    --env-file "$container_env_stage" \
    --health-cmd "pg_isready --host=$CONTAINER_SOCKET_DIR -U $ADMIN_ROLE -d $DATABASE_NAME" \
    --health-interval 5s \
    --health-timeout 3s \
    --health-retries 20 \
    "$CONTAINER_IMAGE" \
    postgres \
      -c 'listen_addresses=*' \
      -c 'ssl=on' \
      -c 'ssl_min_protocol_version=TLSv1.3' \
      -c "ssl_cert_file=$CONTAINER_TLS_DIR/server.crt" \
      -c "ssl_key_file=$CONTAINER_TLS_DIR/server.key" \
      -c "ssl_ca_file=$CONTAINER_TLS_DIR/ca.crt" \
      -c 'password_encryption=scram-sha-256' \
      -c 'authentication_timeout=10s' \
      -c "hba_file=$CONTAINER_HBA_FILE" \
      -c "unix_socket_directories=$CONTAINER_SOCKET_DIR" \
      -c 'unix_socket_permissions=0700' \
    >/dev/null 2>&1; then
    rm -f -- "$container_env_stage"
    container_env_stage=''
    rollback_public_candidate \
      || die 'Public PostgreSQL container creation failed and loopback rollback also failed'
    die 'Public PostgreSQL container could not be created; loopback container was restored'
  fi
  rm -f -- "$container_env_stage"
  container_env_stage=''
  container_kind=public
  if ! wait_for_postgres "$CONTAINER_NAME" public; then
    rollback_public_candidate \
      || die 'Public PostgreSQL readiness failed and loopback rollback also failed'
    die 'Public PostgreSQL container did not become ready; loopback container was restored'
  fi
elif [[ "$CUTOVER_ACTION" = prepare ]]; then
  docker exec --user postgres "$CONTAINER_NAME" pg_ctl reload -D /var/lib/postgresql/data >/dev/null 2>&1 \
    || die 'Public PostgreSQL TLS/HBA configuration could not be reloaded'
fi

verification_gateway=''
if [[ "$expected_hba_mode" = temporary ]]; then
  verification_gateway="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.Gateway}}{{println}}{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  [[ "$verification_gateway" != *$'\n'* ]] \
    || die 'Public PostgreSQL candidate has an ambiguous Docker gateway'
  is_ipv4_address "$verification_gateway" \
    || die 'Public PostgreSQL candidate has no valid IPv4 Docker gateway'
fi

verify_public_candidate() {
  {
    printf "SET \"rag.expected_gateway\" = '%s';\n" "$verification_gateway"
    printf "SET \"rag.expected_hba_mode\" = '%s';\n" "$expected_hba_mode"
    cat <<'SQL'
DO $verify$
BEGIN
  IF current_setting('ssl') <> 'on'
    OR current_setting('ssl_min_protocol_version') <> 'TLSv1.3'
    OR current_setting('password_encryption') <> 'scram-sha-256'
    OR current_setting('authentication_timeout') <> '10s'
    OR current_setting('hba_file') <> '/var/lib/postgresql/data/rag-tls/pg_hba.conf'
    OR current_setting('rag.provision_sentinel', true) <> 'managed-v3' THEN
    RAISE EXCEPTION 'PostgreSQL public runtime settings or data sentinel are invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_hba_file_rules WHERE error IS NOT NULL) THEN
    RAISE EXCEPTION 'PostgreSQL pg_hba.conf contains invalid rules';
  END IF;
  IF (SELECT count(*) FROM pg_hba_file_rules) <>
      CASE current_setting('rag.expected_hba_mode') WHEN 'temporary' THEN 10 ELSE 9 END THEN
    RAISE EXCEPTION 'PostgreSQL pg_hba.conf contains an unexpected rule count';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_hba_file_rules
    WHERE type = 'local' AND database = ARRAY['all'] AND user_name = ARRAY['postgres']
      AND auth_method = 'peer'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_hba_file_rules
    WHERE type = 'local' AND database = ARRAY['rag_system'] AND user_name = ARRAY['rag_owner']
      AND auth_method = 'scram-sha-256'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_hba_file_rules
    WHERE type = 'local' AND database = ARRAY['all'] AND user_name = ARRAY['all']
      AND auth_method = 'reject'
  ) THEN
    RAISE EXCEPTION 'PostgreSQL protected Unix-socket rules are incomplete';
  END IF;
  IF current_setting('rag.expected_hba_mode') = 'temporary' AND NOT EXISTS (
    SELECT 1 FROM pg_hba_file_rules
    WHERE type = 'hostnossl' AND database = ARRAY['rag_system'] AND user_name = ARRAY['rag_app']
      AND address = current_setting('rag.expected_gateway')::inet
      AND masklen(netmask) = 32 AND auth_method = 'scram-sha-256'
  ) THEN
    RAISE EXCEPTION 'PostgreSQL host-local compatibility rule does not match the exact Docker gateway';
  END IF;
  IF current_setting('rag.expected_hba_mode') = 'strict' AND EXISTS (
    SELECT 1 FROM pg_hba_file_rules
    WHERE type = 'hostnossl' AND auth_method <> 'reject'
  ) THEN
    RAISE EXCEPTION 'Strict PostgreSQL HBA still permits a plaintext TCP connection';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_hba_file_rules
    WHERE type LIKE 'host%' AND auth_method <> 'reject'
      AND (user_name && ARRAY['rag_owner', 'postgres'] OR user_name @> ARRAY['all'])
  ) THEN
    RAISE EXCEPTION 'Owner or admin has a PostgreSQL TCP authentication path';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_hba_file_rules
    WHERE type = 'hostssl' AND database = ARRAY['rag_system'] AND user_name = ARRAY['rag_app']
      AND address = '0.0.0.0' AND netmask = '0.0.0.0' AND auth_method = 'scram-sha-256'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_hba_file_rules
    WHERE type = 'hostssl' AND database = ARRAY['rag_system'] AND user_name = ARRAY['rag_app']
      AND address = '::' AND netmask = '::' AND auth_method = 'scram-sha-256'
  ) THEN
    RAISE EXCEPTION 'PostgreSQL public rag_app TLS rules are incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_hba_file_rules
    WHERE type = 'hostnossl' AND database = ARRAY['all'] AND user_name = ARRAY['all']
      AND address = '0.0.0.0' AND netmask = '0.0.0.0' AND auth_method = 'reject'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_hba_file_rules
    WHERE type = 'hostssl' AND database = ARRAY['all'] AND user_name = ARRAY['all']
      AND address = '0.0.0.0' AND netmask = '0.0.0.0' AND auth_method = 'reject'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_hba_file_rules
    WHERE type = 'hostnossl' AND database = ARRAY['all'] AND user_name = ARRAY['all']
      AND address = '::' AND netmask = '::' AND auth_method = 'reject'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_hba_file_rules
    WHERE type = 'hostssl' AND database = ARRAY['all'] AND user_name = ARRAY['all']
      AND address = '::' AND netmask = '::' AND auth_method = 'reject'
  ) THEN
    RAISE EXCEPTION 'PostgreSQL public broad reject rules are incomplete';
  END IF;
  IF (SELECT min(rule_number) FROM pg_hba_file_rules
      WHERE type = 'local' AND user_name = ARRAY['rag_owner']) >=
     (SELECT min(rule_number) FROM pg_hba_file_rules
      WHERE type = 'local' AND user_name = ARRAY['all'] AND auth_method = 'reject')
    OR (SELECT min(rule_number) FROM pg_hba_file_rules
      WHERE type = 'hostssl' AND user_name = ARRAY['rag_app'] AND address = '0.0.0.0') >=
     (SELECT min(rule_number) FROM pg_hba_file_rules
      WHERE type = 'hostssl' AND user_name = ARRAY['all'] AND address = '0.0.0.0')
    OR (SELECT min(rule_number) FROM pg_hba_file_rules
      WHERE type = 'hostssl' AND user_name = ARRAY['rag_app'] AND address = '::') >=
     (SELECT min(rule_number) FROM pg_hba_file_rules
      WHERE type = 'hostssl' AND user_name = ARRAY['all'] AND address = '::') THEN
    RAISE EXCEPTION 'PostgreSQL HBA first-match rule order is unsafe';
  END IF;
  IF current_setting('rag.expected_hba_mode') = 'temporary' AND
     (SELECT min(rule_number) FROM pg_hba_file_rules
      WHERE type = 'hostnossl' AND user_name = ARRAY['rag_app']) >=
     (SELECT min(rule_number) FROM pg_hba_file_rules
      WHERE type = 'hostnossl' AND user_name = ARRAY['all'] AND address = '0.0.0.0') THEN
    RAISE EXCEPTION 'PostgreSQL temporary compatibility rule is shadowed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_hba_file_rules rule
    WHERE rule.auth_method <> 'reject'
      AND NOT (
        (rule.type = 'local' AND rule.database = ARRAY['all']
          AND rule.user_name = ARRAY['postgres'] AND rule.auth_method = 'peer')
        OR (rule.type = 'local' AND rule.database = ARRAY['rag_system']
          AND rule.user_name = ARRAY['rag_owner'] AND rule.auth_method = 'scram-sha-256')
        OR (rule.type = 'hostssl' AND rule.database = ARRAY['rag_system']
          AND rule.user_name = ARRAY['rag_app'] AND rule.auth_method = 'scram-sha-256')
        OR (current_setting('rag.expected_hba_mode') = 'temporary'
          AND rule.type = 'hostnossl' AND rule.database = ARRAY['rag_system']
          AND rule.user_name = ARRAY['rag_app'] AND rule.address = current_setting('rag.expected_gateway')::inet
          AND masklen(rule.netmask) = 32 AND rule.auth_method = 'scram-sha-256')
      )
  ) THEN
    RAISE EXCEPTION 'PostgreSQL HBA contains an unexpected authentication path';
  END IF;
  IF (SELECT count(*) FROM pg_authid
      WHERE rolname IN ('rag_app', 'rag_owner', 'postgres')
        AND rolpassword LIKE 'SCRAM-SHA-256$%') <> 3 THEN
    RAISE EXCEPTION 'PostgreSQL managed role password is not SCRAM';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'rag_owner' AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND rolinherit AND NOT rolbypassrls
      AND rolconnlimit = 5
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'rag_app' AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND rolinherit AND NOT rolbypassrls
      AND rolconnlimit = 40
  ) THEN
    RAISE EXCEPTION 'PostgreSQL managed role attributes have drifted';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    JOIN pg_roles member_role ON member_role.oid = membership.member
    WHERE granted_role.rolname = 'rag_app' AND member_role.rolname = 'rag_owner'
      AND membership.admin_option AND NOT membership.inherit_option AND NOT membership.set_option
  ) THEN
    RAISE EXCEPTION 'PostgreSQL owner/application membership has drifted';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles member_role ON member_role.oid = membership.member
    WHERE member_role.rolname = 'rag_app'
  ) THEN
    RAISE EXCEPTION 'PostgreSQL public application role inherits an unexpected role';
  END IF;
END
$verify$;
SQL
  } | docker exec --user postgres -i "$CONTAINER_NAME" \
    psql --no-psqlrc --set ON_ERROR_STOP=1 --host="$CONTAINER_SOCKET_DIR" --username "$ADMIN_ROLE" --dbname "$DATABASE_NAME" \
    >/dev/null 2>&1
  {
    printf '%s\n' "$app_password"
    cat <<'SQL'
SELECT ssl AS tls_active FROM pg_stat_ssl WHERE pid = pg_backend_pid() \gset
\if :tls_active
\else
  \quit 1
\endif
SQL
  } | docker exec -i "$CONTAINER_NAME" sh -ceu '
    IFS= read -r PGPASSWORD
    export PGPASSWORD
    exec psql --no-psqlrc --set ON_ERROR_STOP=1 \
      --host=127.0.0.1 --port=5432 --username=rag_app --dbname=rag_system \
      "sslmode=require"
  ' >/dev/null 2>&1
}

if ! verify_public_candidate; then
  if [[ "$CUTOVER_ACTION" = prepare && "$backup_exists" = true && -z "$pending_state" ]]; then
    rollback_public_candidate \
      || die 'Public PostgreSQL verification failed and loopback rollback also failed'
    die 'Public PostgreSQL verification failed; loopback container was restored'
  fi
  if [[ "$pending_state" = activated || "$pending_state" = finalizing ]]; then
    die 'Public PostgreSQL verification failed; the release-owned rollback state was retained'
  fi
  die 'Existing public PostgreSQL container failed its TLS/HBA/data verification gate'
fi

runtime_url="postgresql://$APP_ROLE:$app_password@$LOCAL_HOST_ADDRESS:$HOST_PORT/$DATABASE_NAME"
encoded_socket_dir="$(urlencode_path "$SOCKET_DIR")"
migration_url="postgresql://$OWNER_ROLE:$owner_password@/$DATABASE_NAME?host=$encoded_socket_dir"

runtime_stage="$(mktemp "$SHARED/.env.prod.next.XXXXXX")"
migration_stage="$(mktemp "$SHARED/.env.postgres-migration.next.XXXXXX")"
chmod 600 -- "$runtime_stage" "$migration_stage"

if [[ -f "$RUNTIME_ENV" ]]; then
  awk '
    BEGIN { retired_prefix = "SUPA" "BASE_" }
    /^# BEGIN managed PostgreSQL host$/ { managed = 1; next }
    /^# END managed PostgreSQL host$/ { managed = 0; next }
    managed { next }
    /^[[:space:]]*(export[[:space:]]+)?(RAG_PERSISTENCE_BACKEND|DATABASE_URL|POSTGRES_URL|POSTGRES_SSL_MODE|POSTGRES_MIGRATION_URL|POSTGRES_APP_ROLE|POSTGRES_PASSWORD|RAG_DEFAULT_TENANT_ID|RAG_DEFAULT_CORPUS_ID)=/ { next }
    {
      candidate = $0
      sub(/^[[:space:]]*/, "", candidate)
      sub(/^export[[:space:]]+/, "", candidate)
      if (candidate ~ ("^" retired_prefix "[A-Za-z0-9_]+=")) next
    }
    { kept[++count] = $0 }
    END {
      while (count > 0 && kept[count] ~ /^[[:space:]]*$/) count -= 1
      for (line_number = 1; line_number <= count; line_number += 1) print kept[line_number]
    }
  ' "$RUNTIME_ENV" > "$runtime_stage"
fi
cat >> "$runtime_stage" <<EOF

# BEGIN managed PostgreSQL host
# Migration credentials are stored separately.
RAG_PERSISTENCE_BACKEND='postgres'
DATABASE_URL='$runtime_url'
POSTGRES_URL='$runtime_url'
POSTGRES_SSL_MODE='require'
RAG_DEFAULT_TENANT_ID='$DEFAULT_TENANT'
RAG_DEFAULT_CORPUS_ID='$DEFAULT_CORPUS'
# END managed PostgreSQL host
EOF

cat > "$migration_stage" <<EOF
# Managed by provision-postgres-host.sh; source only for schema migration.
POSTGRES_MIGRATION_URL='$migration_url'
POSTGRES_APP_ROLE='$APP_ROLE'
POSTGRES_SSL_MODE='disable'
RAG_DEFAULT_TENANT_ID='$DEFAULT_TENANT'
RAG_DEFAULT_CORPUS_ID='$DEFAULT_CORPUS'
EOF

client_env_stage="$(mktemp "$TLS_DIR/.rag-app-client.next.XXXXXX")"
chmod 600 -- "$client_env_stage"
cat > "$client_env_stage" <<EOF
PGHOST='$PUBLIC_HOST'
PGPORT='$HOST_PORT'
PGDATABASE='$DATABASE_NAME'
PGUSER='$APP_ROLE'
PGPASSWORD='$app_password'
PGSSLMODE='verify-full'
PGSSLROOTCERT='$CA_CERT_FILE'
EOF

bash -n "$runtime_stage" >/dev/null 2>&1 || die 'Generated runtime environment is not valid shell syntax'
bash -n "$migration_stage" >/dev/null 2>&1 || die 'Generated migration environment is not valid shell syntax'
bash -n "$client_env_stage" >/dev/null 2>&1 || die 'Generated public PostgreSQL client environment is not valid shell syntax'

write_cutover_marker() {
  local state="$1"
  cutover_stage="$(mktemp "$STATE_DIR/.public-cutover.next.XXXXXX")"
  chmod 600 -- "$cutover_stage"
  printf 'kind=%s\nhost=%s\nstate=%s\ntoken=%s\nhba=%s\n' \
    "$pending_kind" "$PUBLIC_HOST" "$state" "$CUTOVER_TOKEN" "$pending_hba" > "$cutover_stage"
  sync -f "$cutover_stage" || return 1
  mv -f -- "$cutover_stage" "$CUTOVER_PENDING_FILE" || return 1
  cutover_stage=''
  chmod 600 -- "$CUTOVER_PENDING_FILE" || return 1
  sync -f "$STATE_DIR" || return 1
}

if [[ "$CUTOVER_ACTION" = verify ]]; then
  cmp -s "$runtime_stage" "$RUNTIME_ENV" \
    || die 'Finalized PostgreSQL runtime environment has drifted'
  cmp -s "$migration_stage" "$MIGRATION_ENV" \
    || die 'Finalized PostgreSQL migration environment has drifted'
  cmp -s "$client_env_stage" "$PUBLIC_CLIENT_ENV" \
    || die 'Finalized PostgreSQL public client environment has drifted'
  if [[ "$pending_state" = finalizing || "$pending_state" = finalized ]]; then
    cleanup_committed_cutover_state
  fi
  rm -f -- "$runtime_stage" "$migration_stage" "$client_env_stage"
  runtime_stage=''
  migration_stage=''
  client_env_stage=''
  echo "Finalized public PostgreSQL configuration verified at $PUBLIC_HOST:$HOST_PORT"
  exit 0
fi

if [[ "$CUTOVER_ACTION" = prepare ]]; then
  if [[ "$backup_exists" = true ]]; then
    prepared_kind=legacy
  else
    prepared_kind=public
  fi
  if [[ -n "$pending_kind" && "$pending_kind" != "$prepared_kind" ]]; then
    die 'Existing PostgreSQL public cutover pending state conflicts with the prepared container topology'
  fi
  mv -f -- "$client_env_stage" "$PUBLIC_CLIENT_ENV"
  client_env_stage=''
  chmod 600 -- "$PUBLIC_CLIENT_ENV"
  pending_kind="$prepared_kind"
  pending_hba="$expected_hba_mode"
  write_cutover_marker prepared \
    || die 'PostgreSQL public cutover prepare marker could not be durably published'
  rm -f -- "$runtime_stage" "$migration_stage"
  runtime_stage=''
  migration_stage=''
  echo "PostgreSQL public cutover is prepared at $PUBLIC_HOST:$HOST_PORT; external verification is required before activate"
  echo "External PostgreSQL client environment: $PUBLIC_CLIENT_ENV"
  echo "TLS CA certificate: $CA_CERT_FILE"
  exit 0
fi

if [[ "$pending_kind" = legacy && "$backup_exists" = false ]]; then
  die 'PostgreSQL public cutover lost its loopback rollback container before finalize'
fi
if [[ "$pending_kind" = public && "$backup_exists" = true ]]; then
  die 'PostgreSQL public cutover has an unexpected loopback rollback container'
fi
[[ -d "$CUTOVER_SNAPSHOT_DIR" && ! -L "$CUTOVER_SNAPSHOT_DIR" ]] \
  || die 'PostgreSQL public cutover has no protected pre-cutover snapshot'

if [[ "$CUTOVER_ACTION" = activate ]]; then
  # Publish migration credentials first and the active runtime file last. All
  # staging files share their destination filesystem, so each rename is atomic.
  mv -f -- "$migration_stage" "$MIGRATION_ENV"
  migration_stage=''
  chmod 600 -- "$MIGRATION_ENV"
  mv -f -- "$runtime_stage" "$RUNTIME_ENV"
  runtime_stage=''
  chmod 600 -- "$RUNTIME_ENV"
  mv -f -- "$client_env_stage" "$PUBLIC_CLIENT_ENV"
  client_env_stage=''
  chmod 600 -- "$PUBLIC_CLIENT_ENV"
  write_cutover_marker activated \
    || die 'PostgreSQL public cutover activated environment but could not publish its durable rollback marker'
  echo "PostgreSQL public cutover is activated at $PUBLIC_HOST:$HOST_PORT; rollback remains available until finalize"
  exit 0
fi

[[ "$CUTOVER_ACTION" = finalize ]] \
  || die 'Unsupported PostgreSQL public cutover terminal action'
cmp -s "$runtime_stage" "$RUNTIME_ENV" \
  || die 'Activated PostgreSQL runtime environment has drifted before finalize'
cmp -s "$migration_stage" "$MIGRATION_ENV" \
  || die 'Activated PostgreSQL migration environment has drifted before finalize'
cmp -s "$client_env_stage" "$PUBLIC_CLIENT_ENV" \
  || die 'Activated PostgreSQL public client environment has drifted before finalize'
rm -f -- "$runtime_stage" "$migration_stage" "$client_env_stage"
runtime_stage=''
migration_stage=''
client_env_stage=''

# The durable finalizing receipt is the last reversible operation. For a legacy
# cutover, the stopped loopback container remains the rollback point until its
# removal is confirmed. An absent backup after this receipt is an irreversible
# commit even when SSH disconnects before the command receipt reaches CI.
pending_hba=strict
write_cutover_marker finalizing \
  || die 'PostgreSQL public cutover could not durably record its finalize intent'
pending_state=finalizing

if [[ "$pending_kind" = legacy ]]; then
  if docker rm "$CONTAINER_BACKUP_NAME" >/dev/null 2>&1; then
    backup_exists=false
  elif docker container inspect "$CONTAINER_BACKUP_NAME" >/dev/null 2>&1; then
    die 'PostgreSQL finalize could not remove the loopback rollback container; rollback remains available'
  else
    backup_exists=false
    echo 'Warning: PostgreSQL loopback rollback container disappeared without a Docker removal receipt; treating cutover as committed' >&2
  fi
fi

if write_cutover_marker finalized; then
  pending_state=finalized
else
  echo 'Warning: PostgreSQL cutover is committed but its finalized receipt could not be published; finalizing receipt was retained' >&2
fi
cleanup_committed_cutover_state

echo "Dedicated PostgreSQL is ready locally at $LOCAL_HOST_ADDRESS:$HOST_PORT and publicly at $PUBLIC_HOST:$HOST_PORT"
echo 'PostgreSQL public cutover finalized; runtime and migration environments remain protected'
echo "External PostgreSQL client environment: $PUBLIC_CLIENT_ENV"
echo "TLS CA certificate: $CA_CERT_FILE"

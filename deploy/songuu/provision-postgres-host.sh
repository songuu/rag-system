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

readonly CONTAINER_NAME='rag-system-postgres'
readonly CONTAINER_LABEL_VALUE='managed-v2'
readonly CONTAINER_LABEL="com.songuu.rag-system.postgres=$CONTAINER_LABEL_VALUE"
readonly CONTAINER_IMAGE='postgres:17-bookworm@sha256:9b18b78397054fce88a9552e9d5a3ad5bb7fd258c5b3cc1c5028e46373d6ea8f'
readonly VOLUME_NAME='rag-system-postgres-data'
readonly HOST_ADDRESS='127.0.0.1'
readonly HOST_PORT='25432'
readonly CONTAINER_PORT='5432'
readonly DATABASE_NAME='rag_system'
readonly ADMIN_ROLE='postgres'
readonly OWNER_ROLE='rag_owner'
readonly APP_ROLE='rag_app'
readonly DEFAULT_TENANT='songuu-production'
readonly DEFAULT_CORPUS='default'
readonly READY_ATTEMPTS="${RAG_POSTGRES_READY_ATTEMPTS:-60}"
readonly READY_INTERVAL="${RAG_POSTGRES_READY_INTERVAL:-1}"

windows_posix_runtime=false
case "$(uname -s)" in
  MINGW*|MSYS*) windows_posix_runtime=true ;;
esac

runtime_stage=''
migration_stage=''
container_env_stage=''
credentials_stage=''

cleanup() {
  [[ -z "$runtime_stage" || ! -e "$runtime_stage" ]] || rm -f -- "$runtime_stage"
  [[ -z "$migration_stage" || ! -e "$migration_stage" ]] || rm -f -- "$migration_stage"
  [[ -z "$container_env_stage" || ! -e "$container_env_stage" ]] || rm -f -- "$container_env_stage"
  [[ -z "$credentials_stage" || ! -e "$credentials_stage" ]] || rm -f -- "$credentials_stage"
}
trap cleanup EXIT

for command_name in docker openssl ss awk grep stat id mktemp flock; do
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

assert_secure_directory "$ROOT"
assert_secure_directory "$SHARED"
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
    case "${POSTGRES_SSL_MODE:-}" in ""|disable) ;; *) exit 1 ;; esac
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
  managed_runtime_url="postgresql://$APP_ROLE:$app_password@$HOST_ADDRESS:$HOST_PORT/$DATABASE_NAME"
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
    test "${POSTGRES_SSL_MODE:-}" = disable
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

docker info >/dev/null 2>&1 || die 'Docker is unavailable for PostgreSQL host provisioning'

container_exists=false
if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  container_exists=true
  managed_label="$(docker inspect --format '{{index .Config.Labels "com.songuu.rag-system.postgres"}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  image="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  binding="$(docker inspect --format '{{range (index .HostConfig.PortBindings "5432/tcp")}}{{.HostIp}}|{{.HostPort}}{{println}}{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  restart_policy="$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  initial_admin="$(docker inspect --format '{{range .Config.Env}}{{if eq . "POSTGRES_USER=postgres"}}postgres{{end}}{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  initial_database="$(docker inspect --format '{{range .Config.Env}}{{if eq . "POSTGRES_DB=rag_system"}}rag_system{{end}}{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  if [[ "$managed_label" != "$CONTAINER_LABEL_VALUE" \
    || "$image" != "$CONTAINER_IMAGE" \
    || "$volume" != "$VOLUME_NAME" \
    || "$binding" != "$HOST_ADDRESS|$HOST_PORT" \
    || "$restart_policy" != unless-stopped \
    || "$initial_admin" != "$ADMIN_ROLE" \
    || "$initial_database" != "$DATABASE_NAME" ]]; then
    die "Container $CONTAINER_NAME conflicts with the managed PostgreSQL contract"
  fi
fi

volume_exists=false
if docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
  volume_exists=true
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

if [[ "$volume_exists" = false ]]; then
  docker volume create "$VOLUME_NAME" >/dev/null 2>&1 \
    || die 'Dedicated PostgreSQL volume could not be created'
fi

if [[ "$container_exists" = false ]]; then
  container_env_stage="$(mktemp "$STATE_DIR/.container-env.XXXXXX")"
  chmod 600 -- "$container_env_stage"
  printf 'POSTGRES_USER=%s\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=%s\n' \
    "$ADMIN_ROLE" "$admin_password" "$DATABASE_NAME" > "$container_env_stage"
  if ! docker run -d \
    --name "$CONTAINER_NAME" \
    --label "$CONTAINER_LABEL" \
    --restart unless-stopped \
    --publish "$HOST_ADDRESS:$HOST_PORT:$CONTAINER_PORT" \
    --volume "$VOLUME_NAME:/var/lib/postgresql/data" \
    --env-file "$container_env_stage" \
    --health-cmd "pg_isready -U $ADMIN_ROLE -d $DATABASE_NAME" \
    --health-interval 5s \
    --health-timeout 3s \
    --health-retries 20 \
    "$CONTAINER_IMAGE" >/dev/null 2>&1; then
    die 'Dedicated PostgreSQL container could not be created'
  fi
  rm -f -- "$container_env_stage"
  container_env_stage=''
else
  running="$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  if [[ "$running" != true ]]; then
    docker start "$CONTAINER_NAME" >/dev/null 2>&1 \
      || die 'Dedicated PostgreSQL container could not be started'
  fi
fi

[[ "$READY_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || die 'RAG_POSTGRES_READY_ATTEMPTS must be a positive integer'
[[ "$READY_INTERVAL" =~ ^[0-9]+([.][0-9]+)?$ ]] || die 'RAG_POSTGRES_READY_INTERVAL must be a non-negative number'
ready=false
for ((attempt = 1; attempt <= READY_ATTEMPTS; attempt += 1)); do
  if docker exec "$CONTAINER_NAME" pg_isready -q -U "$ADMIN_ROLE" -d "$DATABASE_NAME" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep "$READY_INTERVAL"
done
[[ "$ready" = true ]] || die 'Dedicated PostgreSQL container did not become ready'

# Passwords are sent over stdin so no secret appears in the Docker
# command line, process listing, success output, or generic failure output.
if ! {
  printf '%s\n' 'BEGIN;'
  printf '%s\n' 'DO $rag$'
  printf '%s\n' 'BEGIN'
  printf "  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '%s') THEN\n" "$OWNER_ROLE"
  printf "    ALTER ROLE %s WITH LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT NOBYPASSRLS;\n" "$OWNER_ROLE" "$owner_password"
  printf '%s\n' '  ELSE'
  printf "    CREATE ROLE %s WITH LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT NOBYPASSRLS;\n" "$OWNER_ROLE" "$owner_password"
  printf '%s\n' '  END IF;'
  printf "  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '%s') THEN\n" "$APP_ROLE"
  printf "    ALTER ROLE %s WITH LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT NOBYPASSRLS;\n" "$APP_ROLE" "$app_password"
  printf '%s\n' '  ELSE'
  printf "    CREATE ROLE %s WITH LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT NOBYPASSRLS;\n" "$APP_ROLE" "$app_password"
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
} | docker exec -i "$CONTAINER_NAME" \
  psql --no-psqlrc --set ON_ERROR_STOP=1 --username "$ADMIN_ROLE" --dbname "$DATABASE_NAME" \
  >/dev/null 2>&1; then
  die 'PostgreSQL owner/application roles could not be reconciled'
fi

runtime_url="postgresql://$APP_ROLE:$app_password@$HOST_ADDRESS:$HOST_PORT/$DATABASE_NAME"
migration_url="postgresql://$OWNER_ROLE:$owner_password@$HOST_ADDRESS:$HOST_PORT/$DATABASE_NAME"

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
POSTGRES_SSL_MODE='disable'
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

bash -n "$runtime_stage" >/dev/null 2>&1 || die 'Generated runtime environment is not valid shell syntax'
bash -n "$migration_stage" >/dev/null 2>&1 || die 'Generated migration environment is not valid shell syntax'

# Commit migration-only credentials first and the active runtime file last.
# Both staging files are on the destination filesystem, so each rename is atomic.
mv -f -- "$migration_stage" "$MIGRATION_ENV"
migration_stage=''
chmod 600 -- "$MIGRATION_ENV"
mv -f -- "$runtime_stage" "$RUNTIME_ENV"
runtime_stage=''
chmod 600 -- "$RUNTIME_ENV"

echo "Dedicated PostgreSQL is ready at $HOST_ADDRESS:$HOST_PORT"
echo 'Runtime and migration environments were updated without exposing credentials'

#!/usr/bin/env bash
# Release a verified Linux standalone tarball on the songuu.top host.
# Nginx is intentionally not modified here; proxy cutover is a separate gate.
set -euo pipefail

readonly ARTIFACT="${1:?usage: release-host.sh <artifact.tgz> <release-name>}"
readonly RELEASE_NAME="${2:?usage: release-host.sh <artifact.tgz> <release-name>}"
readonly ROOT="/opt/rag-system"
readonly RELEASES="$ROOT/releases"
readonly SHARED="$ROOT/shared"
readonly RAG_BASE_PATH="/rag-system"
readonly ENV_FILE="$SHARED/.env.prod"
readonly LEGACY_ENV_FILE="$SHARED/.env.production"
readonly DEFAULTS_FILE="$SHARED/.env.defaults"
readonly RUNNER="$SHARED/run-rag-system.sh"
readonly BOOTSTRAP="$SHARED/run-rag-system.cjs"
readonly PM2_ECOSYSTEM="$SHARED/rag-system.ecosystem.config.cjs"
readonly PM2_MANAGER="$SHARED/manage-rag-system-pm2.sh"
readonly READY_URL="http://127.0.0.1:5182${RAG_BASE_PATH}/api/health"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly DEFAULTS_RENDERER="${RAG_ENV_DEFAULTS_RENDERER:-$SCRIPT_DIR/render-host-env-defaults.py}"
readonly DEFAULTS_EXAMPLE="${RAG_ENV_DEFAULTS_EXAMPLE:-$SCRIPT_DIR/.env.container.example}"
readonly POSTGRES_PROVISIONER="${RAG_POSTGRES_PROVISIONER:-}"
readonly POSTGRES_MIGRATION_ENV_FILE="${RAG_POSTGRES_MIGRATION_ENV_FILE:-$SHARED/.postgres-migration.env}"
readonly ENV_RELOAD_LOCK_FILE="/run/lock/rag-system-env-reload.lock"
readonly ENV_RELOAD_LOCK_HELD="${RAG_ENV_RELOAD_LOCK_HELD:-0}"
readonly POST_RELEASE_GATE="${RAG_POST_RELEASE_GATE:-}"
readonly RELEASE_GATE_ROOT="${RAG_RELEASE_GATE_ROOT:-}"

environment_snapshot=''
migration_environment_snapshot=''
defaults_snapshot=''
environment_existed_before_provision=false
migration_environment_existed_before_provision=false
defaults_existed_before_release=false
database_environment_snapshot_ready=false
database_environment_restored=false
release_committed=false
old_process_fenced=false
cutover_started=false
legacy_local_runtime=false
previous=""
verified_post_release_gate=""

cleanup_database_environment_snapshots() {
  [[ -z "$environment_snapshot" || ! -e "$environment_snapshot" ]] \
    || rm -f -- "$environment_snapshot"
  [[ -z "$migration_environment_snapshot" || ! -e "$migration_environment_snapshot" ]] \
    || rm -f -- "$migration_environment_snapshot"
  [[ -z "$defaults_snapshot" || ! -e "$defaults_snapshot" ]] \
    || rm -f -- "$defaults_snapshot"
}

snapshot_database_environment() {
  if [[ "$database_environment_snapshot_ready" = true ]]; then
    return 0
  fi
  umask 077
  if [[ -f "$ENV_FILE" ]]; then
    environment_snapshot="$(mktemp "$SHARED/.env.prod.release-snapshot.XXXXXX")"
    cp -p -- "$ENV_FILE" "$environment_snapshot"
    chmod 600 "$environment_snapshot"
    environment_existed_before_provision=true
  fi
  if [[ -f "$POSTGRES_MIGRATION_ENV_FILE" ]]; then
    migration_environment_snapshot="$(mktemp "$SHARED/.postgres-migration.release-snapshot.XXXXXX")"
    cp -p -- "$POSTGRES_MIGRATION_ENV_FILE" "$migration_environment_snapshot"
    chmod 600 "$migration_environment_snapshot"
    migration_environment_existed_before_provision=true
  fi
  if [[ -f "$DEFAULTS_FILE" ]]; then
    defaults_snapshot="$(mktemp "$SHARED/.env.defaults.release-snapshot.XXXXXX")"
    cp -p -- "$DEFAULTS_FILE" "$defaults_snapshot"
    chmod 600 "$defaults_snapshot"
    defaults_existed_before_release=true
  fi
  database_environment_snapshot_ready=true
}

restore_or_remove_environment_file() {
  local target="$1"
  local snapshot="$2"
  local existed_before="$3"
  local stage="${target}.rollback.$$"

  if [[ "$existed_before" = true ]]; then
    if ! cp -p -- "$snapshot" "$stage"; then
      rm -f -- "$stage"
      return 1
    fi
    if ! chmod 600 "$stage" || ! mv -f -- "$stage" "$target"; then
      rm -f -- "$stage"
      return 1
    fi
  elif ! rm -f -- "$target"; then
    return 1
  fi
}

restore_database_environment() {
  local restore_failed=0
  if [[ "$database_environment_snapshot_ready" != true || "$database_environment_restored" = true ]]; then
    return 0
  fi

  restore_or_remove_environment_file \
    "$ENV_FILE" "$environment_snapshot" "$environment_existed_before_provision" \
    || restore_failed=1
  restore_or_remove_environment_file \
    "$POSTGRES_MIGRATION_ENV_FILE" "$migration_environment_snapshot" \
    "$migration_environment_existed_before_provision" \
    || restore_failed=1
  restore_or_remove_environment_file \
    "$DEFAULTS_FILE" "$defaults_snapshot" "$defaults_existed_before_release" \
    || restore_failed=1

  if [[ "$restore_failed" -ne 0 ]]; then
    return 1
  fi
  database_environment_restored=true
}

release_exit_trap() {
  local status="$?"
  local environment_restore_ok=true
  trap - EXIT
  if [[ "$release_committed" != true ]]; then
    if ! restore_database_environment; then
      echo "RAG release could not restore its previous database environment" >&2
      status=1
      environment_restore_ok=false
    fi
    if [[ "$environment_restore_ok" = true \
      && "$old_process_fenced" = true \
      && "$cutover_started" != true ]]; then
      if ! resume_previous_process_after_backfill_failure; then
        echo "RAG release could not restore the previous process after local-data backfill failure" >&2
        status=1
      fi
    fi
  fi
  cleanup_database_environment_snapshots
  exit "$status"
}

trap release_exit_trap EXIT

validate_post_release_gate() {
  local gate_root_real=""
  local gate_real=""

  if [[ -z "$POST_RELEASE_GATE" && -z "$RELEASE_GATE_ROOT" ]]; then
    return 0
  fi
  if [[ -z "$POST_RELEASE_GATE" || -z "$RELEASE_GATE_ROOT" ]]; then
    echo "RAG_POST_RELEASE_GATE and RAG_RELEASE_GATE_ROOT must be configured together" >&2
    return 1
  fi
  if [[ -L "$RELEASE_GATE_ROOT" || ! -d "$RELEASE_GATE_ROOT" ]]; then
    echo "Post-release gate root must be a real directory" >&2
    return 1
  fi
  if [[ -L "$POST_RELEASE_GATE" || ! -f "$POST_RELEASE_GATE" || ! -x "$POST_RELEASE_GATE" ]]; then
    echo "Post-release gate must be a real executable file" >&2
    return 1
  fi

  gate_root_real="$(readlink -f -- "$RELEASE_GATE_ROOT")" || return 1
  gate_real="$(readlink -f -- "$POST_RELEASE_GATE")" || return 1
  if [[ -z "$gate_root_real" || "$gate_root_real" = "/" ]]; then
    echo "Post-release gate root must be a constrained directory" >&2
    return 1
  fi
  case "$gate_real" in
    "$gate_root_real"/*) ;;
    *)
      echo "Post-release gate must be contained by its verified root" >&2
      return 1
      ;;
  esac
  if [[ "${gate_real%/*}" != "$gate_root_real" ]]; then
    echo "Post-release gate must be a direct child of its verified root" >&2
    return 1
  fi

  if find "$gate_root_real" -maxdepth 0 \
    \( ! -type d -o ! -user root -o ! -group root -o -perm /022 \) \
    -print -quit | grep -q .; then
    echo "Post-release gate root ownership or permissions are unsafe" >&2
    return 1
  fi
  if find "$gate_real" -maxdepth 0 \
    \( ! -type f -o ! -user root -o ! -group root -o -perm /022 -o ! -perm /111 \) \
    -print -quit | grep -q .; then
    echo "Post-release gate ownership or permissions are unsafe" >&2
    return 1
  fi

  verified_post_release_gate="$gate_real"
}

run_post_release_gate() {
  if [[ -z "$verified_post_release_gate" ]]; then
    return 0
  fi
  "$verified_post_release_gate" "$@"
}

case "$RELEASE_NAME" in
  rag-system-[A-Za-z0-9._-]*) ;;
  *)
    echo "Unsafe release name: $RELEASE_NAME" >&2
    exit 2
    ;;
esac

test -f "$ARTIFACT"
command -v pm2 >/dev/null
command -v curl >/dev/null
command -v openssl >/dev/null
command -v python3 >/dev/null
command -v node >/dev/null
command -v flock >/dev/null
command -v find >/dev/null
command -v readlink >/dev/null

if ! validate_post_release_gate; then
  exit 2
fi

case "$ENV_RELOAD_LOCK_HELD" in
  0|1) ;;
  *)
    echo "RAG_ENV_RELOAD_LOCK_HELD must be 0 or 1" >&2
    exit 2
    ;;
esac

# Serialize releases with the .env.prod watcher. Without this lock, the
# watcher could reload the old app after provisioning changes the DSN but
# before the new release has migrated the PostgreSQL schema.
if [[ "$ENV_RELOAD_LOCK_HELD" = "0" ]]; then
  install -d -m 0755 "$(dirname "$ENV_RELOAD_LOCK_FILE")"
  exec 9>"$ENV_RELOAD_LOCK_FILE"
  flock 9
fi

install -d -m 0755 "$RELEASES" "$SHARED" \
  "$ROOT/data/uploads" \
  "$ROOT/data/reasoning-uploads" \
  "$ROOT/data/adaptive-rag-uploads" \
  "$ROOT/data/mirofish-graph-artifacts-v2" \
  "$ROOT/data/pdf-visual-assets-v1" \
  "$ROOT/data/rag-durable-workflows-v1"

if [[ ! -e "$ENV_FILE" && -f "$LEGACY_ENV_FILE" ]]; then
  mv "$LEGACY_ENV_FILE" "$ENV_FILE"
  ln -s ".env.prod" "$LEGACY_ENV_FILE"
elif [[ -e "$ENV_FILE" && -e "$LEGACY_ENV_FILE" && ! "$ENV_FILE" -ef "$LEGACY_ENV_FILE" ]]; then
  echo "Both $ENV_FILE and $LEGACY_ENV_FILE exist but differ; refusing ambiguous runtime configuration" >&2
  exit 2
elif [[ -e "$ENV_FILE" && ! -e "$LEGACY_ENV_FILE" ]]; then
  ln -s ".env.prod" "$LEGACY_ENV_FILE"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  token=$(openssl rand -hex 32)
  umask 077
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
HOSTNAME=127.0.0.1
PORT=5182
NEXT_TELEMETRY_DISABLED=1

# The host Nginx configuration injects this token only after the existing
# songuu.top session gate has succeeded. Do not expose it to the browser.
RAG_ACCESS_MODE=single-tenant-token
RAG_SINGLE_TENANT_TOKEN=${token}
RAG_SINGLE_TENANT_ROLE=owner
RAG_DEFAULT_TENANT_ID=songuu-production
RAG_DEFAULT_CORPUS_ID=default
RAG_TENANT_ISOLATION_REQUIRED=true

# These are conservative defaults. Full readiness requires reachable model
# and vector services, which are configured independently of this release.
MODEL_PROVIDER=ollama
EMBEDDING_PROVIDER=ollama
REASONING_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
MILVUS_PROVIDER=local
MILVUS_LOCAL_ADDRESS=127.0.0.1:19530
MILVUS_DEFAULT_DATABASE=default
MILVUS_DEFAULT_COLLECTION=rag_documents
MILVUS_DEFAULT_DIMENSION=768
# Add DATABASE_URL or POSTGRES_URL to this protected file before retrying the
# first release. The release fails closed until PostgreSQL is configured.
RAG_PERSISTENCE_BACKEND=postgres
RAG_VECTOR_BACKEND=milvus

REASONING_RAG_UPLOAD_DIR=/opt/rag-system/data/reasoning-uploads
RAG_MIROFISH_GRAPH_STORE_ROOT=/opt/rag-system/data/mirofish-graph-artifacts-v2
RAG_PDF_VISUAL_STORE_ROOT=/opt/rag-system/data/pdf-visual-assets-v1
RAG_DURABLE_WORKFLOW_STORE_ROOT=/opt/rag-system/data/rag-durable-workflows-v1
EOF
  chmod 600 "$ENV_FILE"
  ln -s ".env.prod" "$LEGACY_ENV_FILE"
fi

# The GitHub host deployment supplies a dedicated provisioner. It upgrades an
# existing pre-PostgreSQL environment atomically and is intentionally separate
# from the app runtime so database owner credentials never reach PM2.
if bash -c '
  set -euo pipefail
  set -a
  . "$1"
  test "${RAG_PERSISTENCE_BACKEND:-local}" = "local"
' bash "$ENV_FILE"; then
  legacy_local_runtime=true
fi

if [[ -n "$POSTGRES_PROVISIONER" ]]; then
  if [[ ! -x "$POSTGRES_PROVISIONER" ]]; then
    echo "PostgreSQL host provisioner is missing or not executable" >&2
    exit 2
  fi
  snapshot_database_environment
  "$POSTGRES_PROVISIONER" "$ENV_FILE" "$POSTGRES_MIGRATION_ENV_FILE"
fi

# Defaults are generated below even when no database provisioner is needed.
# Snapshot the complete active release environment before that overwrite so
# every later failure can restore (or remove) this release's defaults.
snapshot_database_environment

if ! bash -c '
  set -euo pipefail
  set -a
  . "$1"
  test "${RAG_ACCESS_MODE:-}" = "single-tenant-token"
  test -n "${RAG_SINGLE_TENANT_TOKEN:-}"
  test "$RAG_SINGLE_TENANT_TOKEN" != "replace-with-a-long-random-secret"
' bash "$ENV_FILE"; then
  echo "Production RAG environment lacks a usable single-tenant token" >&2
  exit 2
fi

if [[ ! -r "$DEFAULTS_RENDERER" || ! -r "$DEFAULTS_EXAMPLE" ]]; then
  echo "Host environment default renderer or example is missing" >&2
  exit 2
fi
defaults_stage="${DEFAULTS_FILE}.next.$$"
python3 "$DEFAULTS_RENDERER" "$DEFAULTS_EXAMPLE" > "$defaults_stage"
chmod 600 "$defaults_stage"
bash -n "$defaults_stage"
if [[ -f "$DEFAULTS_FILE" ]] && cmp -s "$defaults_stage" "$DEFAULTS_FILE"; then
  rm -f "$defaults_stage"
else
  if [[ -f "$DEFAULTS_FILE" ]]; then
    cp -a "$DEFAULTS_FILE" "${DEFAULTS_FILE}.bak.$(date +%Y%m%d%H%M%S)"
  fi
  mv -f "$defaults_stage" "$DEFAULTS_FILE"
fi

# The liveness probe deliberately avoids external model calls. Validate the
# selected Embedding provider before replacing a release so a missing provider
# credential cannot be reported as a successful deployment and then surface
# only through the UI/full health endpoint.
if ! bash -c '
  set -euo pipefail
  set -a
  . "$1"
  . "$2"

  trim_outer_whitespace() {
    local value="$1"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    printf "%s" "$value"
  }

  validate_postgres_persistence() {
    local database_url
    local postgres_url
    local scope_pattern="^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"

    if [[ "${RAG_PERSISTENCE_BACKEND:-postgres}" != "postgres" ]]; then
      echo "Production RAG persistence must use postgres" >&2
      return 1
    fi

    database_url="$(trim_outer_whitespace "${DATABASE_URL:-}")"
    postgres_url="$(trim_outer_whitespace "${POSTGRES_URL:-}")"
    if [[ -z "$database_url" && -z "$postgres_url" ]]; then
      echo "DATABASE_URL or POSTGRES_URL is required for PostgreSQL persistence" >&2
      return 1
    fi
    if [[ -n "$database_url" && ! "$database_url" =~ ^postgres(ql)?://[^[:space:]]+$ ]]; then
      echo "DATABASE_URL must use the postgres or postgresql URL scheme" >&2
      return 1
    fi
    if [[ -n "$postgres_url" && ! "$postgres_url" =~ ^postgres(ql)?://[^[:space:]]+$ ]]; then
      echo "POSTGRES_URL must use the postgres or postgresql URL scheme" >&2
      return 1
    fi
    if [[ -n "$database_url" && -n "$postgres_url" && "$database_url" != "$postgres_url" ]]; then
      echo "DATABASE_URL and POSTGRES_URL must match when both are configured" >&2
      return 1
    fi
    if [[ ! "${RAG_DEFAULT_TENANT_ID:-}" =~ $scope_pattern || ! "${RAG_DEFAULT_CORPUS_ID:-}" =~ $scope_pattern ]]; then
      echo "Valid RAG_DEFAULT_TENANT_ID and RAG_DEFAULT_CORPUS_ID are required for PostgreSQL persistence" >&2
      return 1
    fi
  }

  validate_postgres_persistence

  case "${EMBEDDING_PROVIDER:-ollama}" in
    ollama)
      ;;
    siliconflow)
      test -n "${SILICONFLOW_API_KEY:-}" || {
        echo "SILICONFLOW_API_KEY is required when EMBEDDING_PROVIDER=siliconflow" >&2
        exit 1
      }
      ;;
    openai)
      test -n "${OPENAI_API_KEY:-}" || {
        echo "OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai" >&2
        exit 1
      }
      ;;
    custom)
      test -n "${CUSTOM_EMBEDDING_API_KEY:-}" || {
        echo "CUSTOM_EMBEDDING_API_KEY is required when EMBEDDING_PROVIDER=custom" >&2
        exit 1
      }
      test -n "${CUSTOM_EMBEDDING_BASE_URL:-}" || {
        echo "CUSTOM_EMBEDDING_BASE_URL is required when EMBEDDING_PROVIDER=custom" >&2
        exit 1
      }
      ;;
    *)
      echo "Unsupported EMBEDDING_PROVIDER: ${EMBEDDING_PROVIDER}" >&2
      exit 1
      ;;
  esac

  require_allowed_model() {
    local label="$1"
    local model="$2"
    local configured="$3"
    local allowlist_name="$4"
    local candidate
    local -a allowed=()

    if [[ -z "$model" ]]; then
      echo "${label} active model is not configured" >&2
      exit 1
    fi
    if [[ -z "$configured" ]]; then
      echo "${label} allowlist must be non-empty in production" >&2
      exit 1
    fi

    IFS=',' read -r -a allowed <<< "$configured"
    for candidate in "${allowed[@]}"; do
      candidate="${candidate//[[:space:]]/}"
      if [[ "$candidate" = "$model" ]]; then
        return 0
      fi
    done

    echo "${label} active model is not allowed by ${allowlist_name}" >&2
    exit 1
  }

  case "${MODEL_PROVIDER:-ollama}" in
    ollama) llm_model="${OLLAMA_LLM_MODEL:-llama3.1}" ;;
    openai) llm_model="${OPENAI_LLM_MODEL:-gpt-4o-mini}" ;;
    custom) llm_model="${CUSTOM_LLM_MODEL:-default}" ;;
    openrouter) llm_model="${OPENROUTER_LLM_MODEL:-deepseek/deepseek-v4-flash}" ;;
    lemonade) llm_model="${LEMONADE_LLM_MODEL:-Gemma-4-26B-A4B-it-GGUF}" ;;
    azure) llm_model="${AZURE_OPENAI_LLM_DEPLOYMENT:-}" ;;
    *)
      echo "Unsupported MODEL_PROVIDER: ${MODEL_PROVIDER}" >&2
      exit 1
      ;;
  esac

  case "${EMBEDDING_PROVIDER:-ollama}" in
    ollama) embedding_model="${OLLAMA_EMBEDDING_MODEL:-nomic-embed-text}" ;;
    siliconflow) embedding_model="${SILICONFLOW_EMBEDDING_MODEL:-BAAI/bge-m3}" ;;
    openai) embedding_model="${OPENAI_EMBEDDING_MODEL:-text-embedding-3-small}" ;;
    custom) embedding_model="${CUSTOM_EMBEDDING_MODEL:-default}" ;;
  esac

  require_allowed_model "LLM" "$llm_model" "${RAG_ALLOWED_LLM_MODELS:-}" "RAG_ALLOWED_LLM_MODELS"
  require_allowed_model "EMBEDDING" "$embedding_model" "${RAG_ALLOWED_EMBEDDING_MODELS:-}" "RAG_ALLOWED_EMBEDDING_MODELS"
' bash "$DEFAULTS_FILE" "$ENV_FILE"; then
  echo "Production RAG environment has incomplete persistence/provider configuration or disallows its active model" >&2
  exit 2
fi

if [[ ! -x "$RUNNER" || ! -x "$BOOTSTRAP" || ! -r "$PM2_ECOSYSTEM" || ! -x "$PM2_MANAGER" ]]; then
  echo "Expected PM2 runtime assets are missing or not executable" >&2
  exit 2
fi

reload_rag_process() {
  "$PM2_MANAGER" reload
}

wait_for_liveness() {
  local response=""
  for _ in $(seq 1 30); do
    if response=$(curl -fsS "http://127.0.0.1:5182${RAG_BASE_PATH}/api/health/live"); then
      printf '%s' "$response"
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_readiness() {
  local response=""
  for _ in $(seq 1 30); do
    if response=$(curl --max-time 5 -fsS "$READY_URL"); then
      printf '%s' "$response"
      return 0
    fi
    sleep 1
  done
  return 1
}

release="$RELEASES/$RELEASE_NAME"
if [[ -e "$release" ]]; then
  echo "Release already exists: $release" >&2
  exit 2
fi

mkdir -p "$release"
tar --no-same-owner --no-same-permissions -xzf "$ARTIFACT" -C "$release"

# The archive is produced from a Docker image whose files are owned by UID
# 1001. Never preserve that identity on the host: a matching local account
# could otherwise rewrite code or migration SQL that root executes later.
if find "$release" \( -type l -o \( ! -type f ! -type d \) \) -print -quit | grep -q .; then
  echo "Release artifact contains an unsafe file type or symbolic link" >&2
  exit 1
fi
chown -R root:root -- "$release"
chmod -R go-w -- "$release"
if find "$release" \( ! -user root -o ! -group root -o -perm /022 \) -print -quit | grep -q .; then
  echo "Release artifact ownership or permissions are unsafe" >&2
  exit 1
fi
if [[ ! -f "$release/server.js" || ! -d "$release/.next/static" || ! -d "$release/public" ]]; then
  echo "Extracted release is not a complete standalone artifact" >&2
  exit 1
fi
if [[ ! -f "$release/db/postgres/bootstrap.sql" \
  || ! -f "$release/scripts/migrate-postgres.mjs" \
  || ! -f "$release/scripts/backfill-local-postgres.mjs" ]] \
  || ! compgen -G "$release/db/postgres/migrations/*.sql" >/dev/null; then
  echo "Extracted release is missing PostgreSQL migration assets" >&2
  exit 1
fi

if [[ -e "$POSTGRES_MIGRATION_ENV_FILE" && ! -f "$POSTGRES_MIGRATION_ENV_FILE" ]]; then
  echo "PostgreSQL migration environment path is not a regular file" >&2
  exit 2
fi

# Migrate the newly extracted release before changing the current symlink. The
# owner DSN is sourced only inside this subshell; the PM2 bootstrap separately
# allowlists app variables and strips POSTGRES_MIGRATION_URL.
if ! (
  set -euo pipefail
  set -a
  . "$DEFAULTS_FILE"
  . "$ENV_FILE"
  if [[ -f "$POSTGRES_MIGRATION_ENV_FILE" ]]; then
    . "$POSTGRES_MIGRATION_ENV_FILE"
  fi
  set +a
  cd "$release"
  node scripts/migrate-postgres.mjs
); then
  echo "PostgreSQL migration failed before release cutover" >&2
  exit 1
fi

if [[ -L "$ROOT/current" || -e "$ROOT/current" ]]; then
  previous=$(readlink -f "$ROOT/current" || true)
fi

resume_previous_process_after_backfill_failure() {
  local current_target=""
  if [[ -z "$previous" || ! -d "$previous" ]]; then
    return 0
  fi
  current_target="$(readlink -f "$ROOT/current" 2>/dev/null || true)"
  if [[ "$current_target" != "$previous" ]]; then
    return 1
  fi
  reload_rag_process >/dev/null 2>&1 \
    && wait_for_liveness >/dev/null \
    && wait_for_readiness >/dev/null
}

local_backfill_args=(--source-root "$ROOT/data/uploads")
shopt -s nullglob
for local_upload_root in "$RELEASES"/rag-system-*/uploads; do
  local_backfill_args+=(--source-root "$local_upload_root")
done
shopt -u nullglob

run_local_backfill() {
  local mode="$1"
  (
    set -euo pipefail
    set -a
    . "$DEFAULTS_FILE"
    . "$ENV_FILE"
    if [[ -f "$POSTGRES_MIGRATION_ENV_FILE" ]]; then
      . "$POSTGRES_MIGRATION_ENV_FILE"
    fi
    set +a
    cd "$release"
    node scripts/backfill-local-postgres.mjs "$mode" "${local_backfill_args[@]}"
  )
}

pm2_entry_exists() {
  local process_list=""
  if ! process_list="$(pm2 jlist 2>/dev/null)"; then
    return 2
  fi
  python3 -c '
import json
import sys

try:
    processes = json.load(sys.stdin)
except (json.JSONDecodeError, TypeError):
    raise SystemExit(2)
if not isinstance(processes, list):
    raise SystemExit(2)
raise SystemExit(
    0
    if any(isinstance(process, dict) and process.get("name") == "rag-system" for process in processes)
    else 1
)
' <<<"$process_list"
}

is_rag_port_reachable() {
  python3 -c '
import socket

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
    connection.settimeout(1)
    raise SystemExit(0 if connection.connect_ex(("127.0.0.1", 5182)) == 0 else 1)
' >/dev/null 2>&1
}

wait_for_rag_runtime_shutdown() {
  local pm2_state=2
  for _ in $(seq 1 15); do
    pm2_state=0
    pm2_entry_exists || pm2_state=$?
    if [[ "$pm2_state" -eq 1 ]] \
      && ! curl --connect-timeout 1 --max-time 1 -fsS \
        "http://127.0.0.1:5182${RAG_BASE_PATH}/api/health/live" >/dev/null 2>&1 \
      && ! is_rag_port_reachable; then
      return 0
    fi
    sleep 1
  done
  return 1
}

fence_previous_process() {
  local pm2_state=0
  if [[ "$old_process_fenced" = true ]]; then
    if ! wait_for_rag_runtime_shutdown; then
      echo "Could not re-confirm the previous RAG writer remained shut down" >&2
      return 1
    fi
    return 0
  fi

  pm2_entry_exists || pm2_state=$?
  case "$pm2_state" in
    0)
      if ! pm2 delete rag-system >/dev/null 2>&1; then
        echo "Could not delete the previous PM2 entry before local-data backfill" >&2
        return 1
      fi
      # Set this immediately after deletion so the EXIT trap attempts to resume
      # the old release even if a stray listener makes shutdown verification fail.
      old_process_fenced=true
      ;;
    1)
      ;;
    *)
      echo "Could not determine the previous PM2 process state" >&2
      return 1
      ;;
  esac

  if ! wait_for_rag_runtime_shutdown; then
    echo "Could not prove the previous RAG writer and port were shut down" >&2
    return 1
  fi
}

# A prior failed cutover may have committed a receipt before the legacy local
# writer was restored. Once that writer is fenced, reset only the receipt and
# rebuild it from the now-immutable source plan; imported rows remain intact.
if [[ "$legacy_local_runtime" = true ]]; then
  fence_previous_process
  if ! run_local_backfill --reset-receipt; then
    echo "Could not reset the local upload backfill receipt" >&2
    exit 1
  fi
fi

backfill_status=0
run_local_backfill --check || backfill_status=$?
case "$backfill_status" in
  0)
    ;;
  3)
    # Stop the legacy writer before rebuilding the source plan. This closes the
    # last mutation window without deleting any source files.
    fence_previous_process
    if ! run_local_backfill --apply; then
      echo "Local upload backfill failed before release cutover" >&2
      exit 1
    fi
    if ! run_local_backfill --check; then
      echo "Local upload backfill readback failed before release cutover" >&2
      exit 1
    fi
    ;;
  *)
    echo "Local upload backfill preflight failed before release cutover" >&2
    exit 1
    ;;
esac

next_link="$ROOT/current.next.$$"
ln -s "$release" "$next_link"
mv -Tf "$next_link" "$ROOT/current"
cutover_started=true

rollback() {
  local rollback_failed=0
  local current_target=""
  local environment_restore_ok=true
  local pm2_state=0
  if ! restore_database_environment; then
    rollback_failed=1
    environment_restore_ok=false
  fi
  if [[ -n "$previous" && -d "$previous" ]]; then
    rollback_link="$ROOT/current.rollback.$$"
    if ! ln -s "$previous" "$rollback_link"; then
      rollback_failed=1
    elif ! mv -Tf "$rollback_link" "$ROOT/current"; then
      rm -f -- "$rollback_link"
      rollback_failed=1
    elif [[ "$environment_restore_ok" != true ]]; then
      rollback_failed=1
    elif ! reload_rag_process >/dev/null 2>&1; then
      rollback_failed=1
    elif ! wait_for_liveness >/dev/null || ! wait_for_readiness >/dev/null; then
      rollback_failed=1
    fi
  else
    current_target="$(readlink -f "$ROOT/current" 2>/dev/null || true)"
    if [[ "$current_target" = "$release" ]]; then
      if ! rm -f -- "$ROOT/current"; then
        rollback_failed=1
      fi
      pm2_entry_exists || pm2_state=$?
      case "$pm2_state" in
        0)
          if ! pm2 delete rag-system >/dev/null 2>&1; then
            rollback_failed=1
          fi
          ;;
        1)
          ;;
        *)
          rollback_failed=1
          ;;
      esac
      if ! wait_for_rag_runtime_shutdown; then
        rollback_failed=1
      fi
    else
      rollback_failed=1
    fi
  fi
  # The gate owns any gateway-side mutation performed by `verify`. Invoke its
  # rollback only after the old environment/current/process restoration has
  # been attempted, and treat failure as an incomplete release rollback.
  if ! run_post_release_gate rollback "$previous" "$release"; then
    rollback_failed=1
  fi
  return "$rollback_failed"
}

if ! reload_rag_process; then
  if rollback; then
    echo "RAG release failed to hand off the PM2 runtime; restored and verified the previous release" >&2
  else
    echo "RAG release failed to hand off the PM2 runtime and rollback verification failed" >&2
  fi
  exit 1
fi

if ! live="$(wait_for_liveness)"; then
  if rollback; then
    echo "RAG release failed liveness; restored and verified the previous release" >&2
  else
    echo "RAG release failed liveness and rollback verification failed" >&2
  fi
  exit 1
fi
if ! ready="$(wait_for_readiness)"; then
  if rollback; then
    echo "RAG release failed readiness; restored and verified the previous release" >&2
  else
    echo "RAG release failed readiness and rollback verification failed" >&2
  fi
  exit 1
fi
if ! run_post_release_gate verify "$release" "$previous"; then
  if rollback; then
    echo "RAG post-release gateway verification failed; restored and verified the previous release" >&2
  else
    echo "RAG post-release gateway verification failed and rollback verification failed" >&2
  fi
  exit 1
fi
if ! pm2 save; then
  if rollback; then
    echo "RAG release could not persist PM2 state; restored and verified the previous release" >&2
  else
    echo "RAG release could not persist PM2 state and rollback verification failed" >&2
  fi
  exit 1
fi

release_committed=true
cleanup_database_environment_snapshots
trap - EXIT

printf 'release=%s\n' "$release"
printf 'current=%s\n' "$(readlink -f "$ROOT/current")"
printf 'live=%s\n' "$live"
printf 'ready=%s\n' "$ready"

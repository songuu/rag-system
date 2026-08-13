#!/usr/bin/env bash
# Apply a validated .env.prod edit without requiring an application release.
#
# This script is invoked by rag-system-env-reload.path. It keeps the last
# liveness-verified production configuration so an invalid edit cannot leave
# the RAG process down. Ordinary edits use a PM2 cluster handoff; token
# rotation remains a separately synchronized Nginx/app operation.
set -euo pipefail

readonly ROOT="/opt/rag-system"
readonly SHARED="$ROOT/shared"
readonly DEFAULTS_FILE="$SHARED/.env.defaults"
readonly ENV_FILE="${RAG_ENV_FILE:-$SHARED/.env.prod}"
readonly LAST_GOOD_FILE="$SHARED/.env.prod.last-known-good"
readonly APPLIED_HASH_FILE="$SHARED/.env.prod.last-applied.sha256"
readonly NGINX_TOKEN_REFRESH="$SHARED/refresh-rag-nginx-token.sh"
readonly NGINX_PATCH="$SHARED/patch-nginx.py"
readonly PM2_MANAGER="$SHARED/manage-rag-system-pm2.sh"
readonly LOCK_FILE="/run/lock/rag-system-env-reload.lock"
readonly LIVE_URL="http://127.0.0.1:5182/rag-system/api/health/live"
readonly READY_URL="http://127.0.0.1:5182/rag-system/api/health"
readonly SETTLE_SECONDS="${RAG_ENV_RELOAD_SETTLE_SECONDS:-1}"

if ! [[ "$SETTLE_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "RAG_ENV_RELOAD_SETTLE_SECONDS must be a non-negative integer" >&2
  exit 2
fi

install -d -m 0755 "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "rag-system env reload already in progress; coalescing change"
  exit 0
fi

sleep "$SETTLE_SECONDS"

wait_for_liveness() {
  local live=""
  for _ in $(seq 1 30); do
    if live=$(curl -fsS "$LIVE_URL"); then
      printf '%s' "$live"
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_readiness() {
  local ready=""
  for _ in $(seq 1 30); do
    if ready=$(curl --max-time 5 -fsS "$READY_URL"); then
      printf '%s' "$ready"
      return 0
    fi
    sleep 1
  done
  return 1
}

reload_rag_process() {
  if [[ ! -x "$PM2_MANAGER" ]]; then
    echo "RAG PM2 runtime manager is missing or not executable: $PM2_MANAGER" >&2
    return 1
  fi
  "$PM2_MANAGER" reload
}

restart_rag_process() {
  if [[ ! -x "$PM2_MANAGER" ]]; then
    echo "RAG PM2 runtime manager is missing or not executable: $PM2_MANAGER" >&2
    return 1
  fi
  "$PM2_MANAGER" restart
}

validate_environment() {
  test -r "$DEFAULTS_FILE"
  test -r "$ENV_FILE"
  bash -n "$DEFAULTS_FILE"
  bash -n "$ENV_FILE"
  bash -c '
    set -euo pipefail
    set -a
    . "$1"
    . "$2"
    test "${PORT:-}" = "5182"
    test "${HOSTNAME:-}" = "127.0.0.1"
    test "${RAG_ACCESS_MODE:-}" = "single-tenant-token"
    test -n "${RAG_SINGLE_TENANT_TOKEN:-}"
    test "$RAG_SINGLE_TENANT_TOKEN" != "replace-with-a-long-random-secret"

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

    # Embedding is configured independently from the chat/reasoning provider.
    # A live-only probe cannot initialize it, so reject incomplete provider
    # settings here instead of reporting a successful reload that later makes
    # the full health endpoint and UI fail.
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
  ' bash "$DEFAULTS_FILE" "$ENV_FILE"
}

read_token() {
  bash -c 'set -euo pipefail; set -a; . "$1"; printf "%s" "${RAG_SINGLE_TENANT_TOKEN:-}"' bash "$1"
}

rollback() {
  local reason="$1"
  local reload_runtime="${2:-0}"
  local rejected="$ENV_FILE.rejected.$(date +%Y%m%d%H%M%S)"
  if [[ ! -r "$LAST_GOOD_FILE" ]]; then
    echo "Cannot roll back RAG environment: no verified baseline ($reason)" >&2
    return 1
  fi

  cp -a "$ENV_FILE" "$rejected" 2>/dev/null || true
  cp -a "$LAST_GOOD_FILE" "$ENV_FILE"
  if [[ "$reload_runtime" = "1" ]]; then
    reload_rag_process >/dev/null
    wait_for_liveness >/dev/null
  fi
  echo "rag-system env reload rejected and restored verified configuration: $reason" >&2
}

if [[ ! -r "$ENV_FILE" ]]; then
  if [[ -r "$LAST_GOOD_FILE" ]]; then
    rollback "environment file is missing"
  else
    echo "RAG environment file is missing before a verified baseline exists" >&2
  fi
  exit 1
fi

# A candidate is never a trustworthy baseline. The release or installer seeds
# this state only after the running app and Nginx bearer header have both been
# verified. Without it, a first token edit could be mistaken for an ordinary
# reload and leave the gateway injecting the previous token forever.
if [[ ! -r "$LAST_GOOD_FILE" || ! -r "$APPLIED_HASH_FILE" ]]; then
  echo "RAG environment reload baseline is missing; run a verified deployment or host installer first" >&2
  exit 1
fi

candidate_hash="$(sha256sum "$ENV_FILE" | cut -d' ' -f1)"
if [[ -r "$APPLIED_HASH_FILE" && "$(cat "$APPLIED_HASH_FILE")" = "$candidate_hash" ]]; then
  echo "rag-system environment content is unchanged; ignoring watcher event"
  exit 0
fi

if ! validate_environment; then
  if [[ -r "$LAST_GOOD_FILE" ]]; then
    rollback "environment validation failed"
  else
    echo "RAG environment validation failed before a verified baseline exists" >&2
  fi
  exit 1
fi

previous_token="$(read_token "$LAST_GOOD_FILE")"
candidate_token="$(read_token "$ENV_FILE")"
token_changed=0
if [[ "$candidate_token" != "$previous_token" ]]; then
  token_changed=1
fi

if [[ "$candidate_hash" != "$(sha256sum "$ENV_FILE" | cut -d' ' -f1)" ]]; then
  echo "RAG environment changed while reload was preparing; waiting for the next event"
  exit 0
fi

if [[ "$token_changed" = "1" ]]; then
  # The gateway injects one bearer token. Until dual-token authorization is
  # introduced, rotate it with a restart so Nginx and the app move as one
  # conservative operation. All ordinary configuration edits use cluster
  # reload and retain the old worker until the replacement is listening.
  if ! restart_rag_process >/dev/null; then
    rollback "PM2 restart failed" 1 || true
    exit 1
  fi
else
  if ! reload_rag_process >/dev/null; then
    rollback "PM2 reload failed" 1 || true
    exit 1
  fi
fi
if ! live="$(wait_for_liveness)"; then
  rollback "liveness did not recover" 1
  exit 1
fi
if ! ready="$(wait_for_readiness)"; then
  rollback "readiness did not recover" 1
  exit 1
fi

if [[ "$token_changed" = "1" ]]; then
  if ! "$NGINX_TOKEN_REFRESH" "$NGINX_PATCH" >/dev/null; then
    rollback "Nginx token refresh failed" 1
    exit 1
  fi
fi

if [[ "$candidate_hash" != "$(sha256sum "$ENV_FILE" | cut -d' ' -f1)" ]]; then
  echo "RAG environment changed during restart; waiting for the next event"
  exit 0
fi

cp -a "$ENV_FILE" "${LAST_GOOD_FILE}.next.$$"
mv -f "${LAST_GOOD_FILE}.next.$$" "$LAST_GOOD_FILE"
chmod 600 "$LAST_GOOD_FILE"
printf '%s\n' "$candidate_hash" > "${APPLIED_HASH_FILE}.next.$$"
chmod 600 "${APPLIED_HASH_FILE}.next.$$"
mv -f "${APPLIED_HASH_FILE}.next.$$" "$APPLIED_HASH_FILE"
pm2 save >/dev/null
printf 'rag-system env reload applied; live=%s; ready=%s\n' "$live" "$ready"

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

release="$RELEASES/$RELEASE_NAME"
if [[ -e "$release" ]]; then
  echo "Release already exists: $release" >&2
  exit 2
fi

mkdir -p "$release"
tar -xzf "$ARTIFACT" -C "$release"
if [[ ! -f "$release/server.js" || ! -d "$release/.next/static" || ! -d "$release/public" ]]; then
  echo "Extracted release is not a complete standalone artifact" >&2
  exit 1
fi

previous=""
if [[ -L "$ROOT/current" || -e "$ROOT/current" ]]; then
  previous=$(readlink -f "$ROOT/current" || true)
fi

next_link="$ROOT/current.next.$$"
ln -s "$release" "$next_link"
mv -Tf "$next_link" "$ROOT/current"

rollback() {
  if [[ -n "$previous" && -d "$previous" ]]; then
    rollback_link="$ROOT/current.rollback.$$"
    ln -s "$previous" "$rollback_link"
    mv -Tf "$rollback_link" "$ROOT/current"
    reload_rag_process >/dev/null 2>&1 || true
  fi
}

if ! reload_rag_process; then
  rollback
  echo "RAG release failed to hand off the PM2 runtime; restored previous release when available" >&2
  exit 1
fi

live=""
for _ in $(seq 1 30); do
  if live=$(curl -fsS "http://127.0.0.1:5182${RAG_BASE_PATH}/api/health/live"); then
    break
  fi
  sleep 1
done
if [[ -z "$live" ]]; then
  rollback
  echo "RAG release failed liveness; restored previous release when available" >&2
  exit 1
fi
ready=""
for _ in $(seq 1 30); do
  if ready=$(curl --max-time 5 -fsS "$READY_URL"); then
    break
  fi
  sleep 1
done
if [[ -z "$ready" ]]; then
  rollback
  echo "RAG release failed readiness; restored previous release when available" >&2
  exit 1
fi
pm2 save

printf 'release=%s\n' "$release"
printf 'current=%s\n' "$(readlink -f "$ROOT/current")"
printf 'live=%s\n' "$live"
printf 'ready=%s\n' "$ready"

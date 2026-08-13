#!/usr/bin/env bash
# Runs the standalone Next.js artifact behind the songuu.top host proxy.
# Runtime secrets stay outside releases so a symlink swap never copies them.
set -euo pipefail

readonly DEFAULTS_FILE="${RAG_DEFAULTS_FILE:-/opt/rag-system/shared/.env.defaults}"
ENV_FILE="${RAG_ENV_FILE:-/opt/rag-system/shared/.env.prod}"
readonly LEGACY_ENV_FILE="/opt/rag-system/shared/.env.production"
readonly RUNTIME_NODE="${RAG_RUNTIME_NODE:-node}"
readonly SERVER_FILE="${RAG_RUNTIME_SERVER:-/opt/rag-system/current/server.js}"

if [[ ! -r "$ENV_FILE" && -z "${RAG_ENV_FILE:-}" && -r "$LEGACY_ENV_FILE" ]]; then
  ENV_FILE="$LEGACY_ENV_FILE"
fi
readonly ENV_FILE

if [[ ! -r "$ENV_FILE" ]]; then
  echo "RAG runtime environment file is missing or unreadable: $ENV_FILE" >&2
  exit 1
fi

set -a
if [[ -r "$DEFAULTS_FILE" ]]; then
  # Generated host defaults are intentionally lower priority than production.
  # shellcheck disable=SC1090
  . "$DEFAULTS_FILE"
fi
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

if [[ "${RAG_ACCESS_MODE:-}" = "single-tenant-token" ]] && [[ -z "${RAG_SINGLE_TENANT_TOKEN:-}" ]]; then
  echo "RAG_SINGLE_TENANT_TOKEN is required for production single-tenant access" >&2
  exit 1
fi

trim_outer_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

validate_postgres_persistence() {
  local database_url
  local postgres_url
  local scope_pattern='^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'

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

  RAG_PERSISTENCE_BACKEND=postgres
  DATABASE_URL="$database_url"
  POSTGRES_URL="$postgres_url"
  export RAG_PERSISTENCE_BACKEND DATABASE_URL POSTGRES_URL
}

validate_postgres_persistence

: "${NODE_ENV:=production}"
: "${HOSTNAME:=127.0.0.1}"
: "${PORT:=5182}"
: "${RAG_RELEASE_DIR:=$(dirname "$SERVER_FILE")}"
export NODE_ENV HOSTNAME PORT RAG_RELEASE_DIR

exec "$RUNTIME_NODE" "$SERVER_FILE"

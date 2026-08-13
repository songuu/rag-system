#!/usr/bin/env bash
# Runs the standalone Next.js artifact behind the songuu.top host proxy.
# Runtime secrets stay outside releases so a symlink swap never copies them.
set -euo pipefail

readonly DEFAULTS_FILE="${RAG_DEFAULTS_FILE:-/opt/rag-system/shared/.env.defaults}"
ENV_FILE="${RAG_ENV_FILE:-/opt/rag-system/shared/.env.prod}"
readonly LEGACY_ENV_FILE="/opt/rag-system/shared/.env.production"

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

: "${NODE_ENV:=production}"
: "${HOSTNAME:=127.0.0.1}"
: "${PORT:=5182}"
export NODE_ENV HOSTNAME PORT

exec node /opt/rag-system/current/server.js

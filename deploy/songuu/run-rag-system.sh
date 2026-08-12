#!/usr/bin/env bash
# Runs the standalone Next.js artifact behind the songuu.top host proxy.
# Runtime secrets stay outside releases so a symlink swap never copies them.
set -euo pipefail

readonly ENV_FILE="${RAG_ENV_FILE:-/opt/rag-system/shared/.env.production}"

if [[ ! -r "$ENV_FILE" ]]; then
  echo "RAG runtime environment file is missing or unreadable: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

: "${NODE_ENV:=production}"
: "${HOSTNAME:=127.0.0.1}"
: "${PORT:=5182}"
export NODE_ENV HOSTNAME PORT

exec node /opt/rag-system/current/server.js

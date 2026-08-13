#!/usr/bin/env bash
# Refresh the RAG-only Nginx bearer header after a .env.prod token rotation.
set -euo pipefail

readonly PATCH="${1:?usage: refresh-rag-nginx-token.sh <patch-nginx.py>}"
readonly CONFIG="${RAG_NGINX_CONFIG:-/etc/nginx/conf.d/default.conf}"
readonly ENV_FILE="${RAG_ENV_FILE:-/opt/rag-system/shared/.env.prod}"

test -f "$PATCH"
test -f "$CONFIG"
test -r "$ENV_FILE"
command -v nginx >/dev/null
command -v systemctl >/dev/null

patch_output=$(python3 "$PATCH" --refresh-token --config "$CONFIG" --env-file "$ENV_FILE")
printf '%s\n' "$patch_output"

backup=$(printf '%s\n' "$patch_output" | sed -n 's/^backup=//p')
if [[ -z "$backup" || ! -f "$backup" ]]; then
  echo "Nginx token refresh did not provide a usable backup path" >&2
  exit 1
fi

restore() {
  cp -a "$backup" "$CONFIG"
  nginx -t
}

if ! nginx -t; then
  restore
  echo "Nginx validation failed; restored $backup" >&2
  exit 1
fi

if ! systemctl reload nginx; then
  restore
  systemctl reload nginx
  echo "Nginx reload failed; restored $backup" >&2
  exit 1
fi

printf 'nginx_token_backup=%s\n' "$backup"
printf 'nginx-reloaded=1\n'

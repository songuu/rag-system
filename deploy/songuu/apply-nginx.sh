#!/usr/bin/env bash
# Apply the isolated RAG gateway locations and restore the exact config backup
# whenever nginx refuses the new configuration or cannot reload it.
set -euo pipefail

readonly PATCH="${1:?usage: apply-nginx.sh <patch-nginx.py> [--public-access]}"
readonly ACCESS_MODE="${2:-}"
case "$ACCESS_MODE" in
  ''|--public-access) ;;
  *) echo "Unsupported RAG gateway mode: $ACCESS_MODE" >&2; exit 2 ;;
esac
readonly CONFIG="${RAG_NGINX_CONFIG:-/etc/nginx/conf.d/default.conf}"
readonly ENV_FILE="${RAG_ENV_FILE:-/opt/rag-system/shared/.env.prod}"

test -f "$PATCH"
test -f "$CONFIG"
test -r "$ENV_FILE"
command -v nginx >/dev/null
command -v systemctl >/dev/null

patch_args=(--config "$CONFIG" --env-file "$ENV_FILE")
if [[ -n "$ACCESS_MODE" ]]; then
  patch_args+=("$ACCESS_MODE")
fi
patch_output=$(python3 "$PATCH" "${patch_args[@]}")
printf '%s\n' "$patch_output"

backup=$(printf '%s\n' "$patch_output" | sed -n 's/^backup=//p')
if [[ -z "$backup" || ! -f "$backup" ]]; then
  echo "Nginx patch did not provide a usable backup path" >&2
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

echo "nginx-reloaded=1"

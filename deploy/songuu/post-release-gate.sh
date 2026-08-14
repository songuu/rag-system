#!/usr/bin/env bash
# Complete the host-side gateway/watcher handoff while release-host still owns
# the application rollback transaction. The verify phase snapshots every file
# it may mutate; release-host invokes rollback after restoring the old app/env.
set -euo pipefail

readonly MODE="${1:?usage: post-release-gate.sh <verify|rollback> <release> <other-release>}"
readonly RELEASE_PATH="${2:-}"
readonly OTHER_RELEASE_PATH="${3:-}"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly STATE_ROOT="$SCRIPT_DIR/post-release-gate-state"
readonly SNAPSHOT_ROOT="$STATE_ROOT/files"
readonly MANIFEST="$STATE_ROOT/files.manifest"
readonly SNAPSHOT_COMPLETE="$STATE_ROOT/snapshot.complete"
readonly MUTATIONS_STARTED="$STATE_ROOT/mutations.started"
readonly VERIFY_COMPLETE="$STATE_ROOT/verify.complete"
readonly ROLLBACK_COMPLETE="$STATE_ROOT/rollback.complete"
readonly ROLLBACK_FAILED="$STATE_ROOT/rollback.failed"
readonly SHARED_ROOT="/opt/rag-system/shared"
readonly ENV_FILE="$SHARED_ROOT/.env.prod"
readonly NGINX_CONFIG="/etc/nginx/conf.d/default.conf"
readonly WATCHER_SERVICE="rag-system-env-reload.service"
readonly WATCHER_PATH="rag-system-env-reload.path"
readonly DOMAIN_NAME="${DOMAIN:?DOMAIN is required by the post-release gate}"
readonly RAG_BASE_PATH="${BASE_PATH:-/rag-system}"

umask 077

validate_state_root() {
  test -d "$SCRIPT_DIR" || return 2
  test ! -L "$SCRIPT_DIR" || return 2
  test "$(stat -c '%U:%G' -- "$SCRIPT_DIR")" = 'root:root' || return 2
  if find "$SCRIPT_DIR" -maxdepth 0 -perm /022 -print -quit | grep -q .; then
    echo "Post-release gate root is group/other writable: $SCRIPT_DIR" >&2
    return 2
  fi
}

validate_snapshot_entry() {
  local backup_name="$1"
  local target="$2"
  case "$backup_name:$target" in
    reload-rag-system-env.sh:/opt/rag-system/shared/reload-rag-system-env.sh|\
    patch-nginx.py:/opt/rag-system/shared/patch-nginx.py|\
    refresh-rag-nginx-token.sh:/opt/rag-system/shared/refresh-rag-nginx-token.sh|\
    rag-system-env-reload.service:/etc/systemd/system/rag-system-env-reload.service|\
    rag-system-env-reload.path:/etc/systemd/system/rag-system-env-reload.path|\
    nginx-default.conf:/etc/nginx/conf.d/default.conf|\
    env-last-known-good:/opt/rag-system/shared/.env.prod.last-known-good|\
    env-last-applied-sha256:/opt/rag-system/shared/.env.prod.last-applied.sha256)
      ;;
    *)
      echo "Unsafe post-release snapshot entry: $backup_name" >&2
      return 2
      ;;
  esac
}

validate_regular_root_file() {
  local file="$1"
  if [[ ! -f "$file" || -L "$file" ]]; then
    echo "Post-release gate requires a regular non-symlink file: $file" >&2
    return 2
  fi
  if [[ "$(stat -c '%U:%G' -- "$file")" != 'root:root' ]]; then
    echo "Post-release gate requires root ownership: $file" >&2
    return 2
  fi
  if find "$file" -maxdepth 0 -perm /022 -print -quit | grep -q .; then
    echo "Post-release gate refuses a group/other-writable file: $file" >&2
    return 2
  fi
}

snapshot_file() {
  local backup_name="$1"
  local target="$2"
  validate_snapshot_entry "$backup_name" "$target"
  if [[ -e "$target" || -L "$target" ]]; then
    validate_regular_root_file "$target"
    cp -a -- "$target" "$SNAPSHOT_ROOT/$backup_name"
    printf 'present\t%s\t%s\n' "$backup_name" "$target" >> "$MANIFEST"
  else
    printf 'absent\t%s\t%s\n' "$backup_name" "$target" >> "$MANIFEST"
  fi
}

capture_watcher_state() {
  if systemctl is-enabled --quiet "$WATCHER_PATH" 2>/dev/null; then
    printf '1\n' > "$STATE_ROOT/watcher.enabled"
  else
    printf '0\n' > "$STATE_ROOT/watcher.enabled"
  fi
  if systemctl is-active --quiet "$WATCHER_PATH" 2>/dev/null; then
    printf '1\n' > "$STATE_ROOT/watcher.active"
  else
    printf '0\n' > "$STATE_ROOT/watcher.active"
  fi
}

prepare_snapshots() {
  if [[ -e "$STATE_ROOT" || -L "$STATE_ROOT" ]]; then
    echo "Post-release gate state already exists: $STATE_ROOT" >&2
    return 2
  fi
  mkdir -m 700 -- "$STATE_ROOT"
  mkdir -m 700 -- "$SNAPSHOT_ROOT"
  : > "$MANIFEST"
  chmod 600 "$MANIFEST"

  snapshot_file reload-rag-system-env.sh "$SHARED_ROOT/reload-rag-system-env.sh"
  snapshot_file patch-nginx.py "$SHARED_ROOT/patch-nginx.py"
  snapshot_file refresh-rag-nginx-token.sh "$SHARED_ROOT/refresh-rag-nginx-token.sh"
  snapshot_file rag-system-env-reload.service "/etc/systemd/system/$WATCHER_SERVICE"
  snapshot_file rag-system-env-reload.path "/etc/systemd/system/$WATCHER_PATH"
  snapshot_file nginx-default.conf "$NGINX_CONFIG"
  snapshot_file env-last-known-good "$SHARED_ROOT/.env.prod.last-known-good"
  snapshot_file env-last-applied-sha256 "$SHARED_ROOT/.env.prod.last-applied.sha256"
  capture_watcher_state
  : > "$SNAPSHOT_COMPLETE"
}

install_text_file() {
  local source_name="$1"
  local target="$2"
  local mode="$3"
  local validator="$4"
  local source="$SCRIPT_DIR/$source_name"
  local stage="${target}.next.$$"

  validate_regular_root_file "$source"
  tr -d '\r' < "$source" > "$stage"
  chmod "$mode" "$stage"
  case "$validator" in
    bash)
      if ! bash -n "$stage"; then
        rm -f -- "$stage"
        return 1
      fi
      ;;
    python)
      if ! python3 -c 'import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))' "$stage"; then
        rm -f -- "$stage"
        return 1
      fi
      ;;
    none)
      ;;
    *)
      rm -f -- "$stage"
      echo "Unknown post-release validator: $validator" >&2
      return 2
      ;;
  esac
  mv -f -- "$stage" "$target"
}

location_count() {
  awk -v modifier="$1" -v route="$2" \
    '$1 == "location" && $2 == modifier && $3 == route { count++ } END { print count + 0 }' \
    "$NGINX_CONFIG"
}

configure_nginx() {
  local root_location
  local direct_api_location
  local page_location
  local live_location
  local api_location

  root_location="$(location_count '=' '/rag-system')"
  direct_api_location="$(location_count '^~' '/rag-system/api/')"
  page_location="$(location_count '^~' '/rag-system/')"
  live_location="$(location_count '=' '/rag-api/health/live')"
  api_location="$(location_count '^~' '/rag-api/')"
  if [[ "$root_location" = 0 \
    && "$direct_api_location" = 0 \
    && "$page_location" = 0 \
    && "$live_location" = 0 \
    && "$api_location" = 0 ]]; then
    "$SCRIPT_DIR/apply-nginx.sh" "$SHARED_ROOT/patch-nginx.py"
  elif [[ "$root_location" != 1 \
    || "$direct_api_location" != 1 \
    || "$page_location" != 1 \
    || "$live_location" != 1 \
    || "$api_location" != 1 ]]; then
    echo 'RAG Nginx locations are incomplete or ambiguous; refusing deployment.' >&2
    return 1
  fi

  "$SHARED_ROOT/refresh-rag-nginx-token.sh" "$SHARED_ROOT/patch-nginx.py" >/dev/null
}

verify_gateway() {
  local live_code
  local anonymous_ui_code
  local direct_api_code
  live_code="$(curl -sk -o /dev/null -w '%{http_code}' -H "Host:${DOMAIN_NAME}" "https://127.0.0.1/rag-api/health/live")"
  test "$live_code" = 200 || return
  anonymous_ui_code="$(curl -sk -o /dev/null -w '%{http_code}' -H "Host:${DOMAIN_NAME}" "https://127.0.0.1${RAG_BASE_PATH}")"
  test "$anonymous_ui_code" = 302 || return
  direct_api_code="$(curl -sk -o /dev/null -w '%{http_code}' -H "Host:${DOMAIN_NAME}" "https://127.0.0.1${RAG_BASE_PATH}/api/health/live")"
  test "$direct_api_code" = 404 || return
}

seed_watcher_state() {
  local env_hash
  local last_good="$SHARED_ROOT/.env.prod.last-known-good"
  local applied_hash="$SHARED_ROOT/.env.prod.last-applied.sha256"
  local last_good_stage="${last_good}.next.$$"
  local applied_hash_stage="${applied_hash}.next.$$"

  validate_regular_root_file "$ENV_FILE"
  env_hash="$(sha256sum "$ENV_FILE" | cut -d' ' -f1)"
  cp -a -- "$ENV_FILE" "$last_good_stage"
  chmod 600 "$last_good_stage"
  if [[ "$env_hash" != "$(sha256sum "$ENV_FILE" | cut -d' ' -f1)" ]]; then
    rm -f -- "$last_good_stage"
    echo 'RAG environment changed while seeding watcher state.' >&2
    return 1
  fi
  mv -f -- "$last_good_stage" "$last_good"
  printf '%s\n' "$env_hash" > "$applied_hash_stage"
  chmod 600 "$applied_hash_stage"
  mv -f -- "$applied_hash_stage" "$applied_hash"
}

verify_gate() {
  test -n "$RELEASE_PATH"
  test -d "$RELEASE_PATH"
  prepare_snapshots
  : > "$MUTATIONS_STARTED"

  install_text_file reload-rag-system-env.sh "$SHARED_ROOT/reload-rag-system-env.sh" 700 bash
  install_text_file patch-nginx.py "$SHARED_ROOT/patch-nginx.py" 600 python
  install_text_file refresh-rag-nginx-token.sh "$SHARED_ROOT/refresh-rag-nginx-token.sh" 700 bash
  install_text_file rag-system-env-reload.service "/etc/systemd/system/$WATCHER_SERVICE" 644 none
  install_text_file rag-system-env-reload.path "/etc/systemd/system/$WATCHER_PATH" 644 none

  systemctl daemon-reload
  systemctl enable --now rag-system-env-reload.path
  configure_nginx
  verify_gateway
  seed_watcher_state
  : > "$VERIFY_COMPLETE"
  printf 'post-release-gate=verified\n'
}

restore_file() {
  local state="$1"
  local backup_name="$2"
  local target="$3"
  local backup="$SNAPSHOT_ROOT/$backup_name"
  local stage="${target}.rollback.$$"
  validate_snapshot_entry "$backup_name" "$target" || return
  case "$state" in
    present)
      validate_regular_root_file "$backup" || return
      rm -f -- "$stage" || return
      cp -a -- "$backup" "$stage" || return
      mv -f -- "$stage" "$target" || return
      ;;
    absent)
      rm -f -- "$target" || return
      ;;
    *)
      echo "Unsafe post-release snapshot state: $state" >&2
      return 2
      ;;
  esac
}

restore_snapshots() {
  local state
  local backup_name
  local target
  local restore_failed=0
  validate_regular_root_file "$MANIFEST" || return
  while IFS=$'\t' read -r state backup_name target; do
    restore_file "$state" "$backup_name" "$target" || restore_failed=1
  done < "$MANIFEST"
  return "$restore_failed"
}

verify_restored_snapshots() {
  local state
  local backup_name
  local target
  local verify_failed=0
  validate_regular_root_file "$MANIFEST" || return
  while IFS=$'\t' read -r state backup_name target; do
    validate_snapshot_entry "$backup_name" "$target" || {
      verify_failed=1
      continue
    }
    case "$state" in
      present)
        cmp -s -- "$SNAPSHOT_ROOT/$backup_name" "$target" || verify_failed=1
        ;;
      absent)
        [[ ! -e "$target" && ! -L "$target" ]] || verify_failed=1
        ;;
      *)
        verify_failed=1
        ;;
    esac
  done < "$MANIFEST"
  return "$verify_failed"
}

restore_watcher_state() {
  local was_enabled
  local was_active
  local is_enabled=0
  local is_active=0
  local restore_failed=0
  was_enabled="$(cat "$STATE_ROOT/watcher.enabled")" || return
  was_active="$(cat "$STATE_ROOT/watcher.active")" || return
  case "$was_enabled:$was_active" in
    0:0|0:1|1:0|1:1) ;;
    *) echo 'Invalid saved watcher state.' >&2; return 2 ;;
  esac

  if [[ "$was_enabled" = 1 ]]; then
    systemctl enable "$WATCHER_PATH" >/dev/null || restore_failed=1
  else
    if ! systemctl disable "$WATCHER_PATH" >/dev/null 2>&1 \
      && systemctl is-enabled --quiet "$WATCHER_PATH" 2>/dev/null; then
      restore_failed=1
    fi
  fi
  if [[ "$was_active" = 1 ]]; then
    systemctl start "$WATCHER_PATH" || restore_failed=1
  else
    if ! systemctl stop "$WATCHER_PATH" >/dev/null 2>&1 \
      && systemctl is-active --quiet "$WATCHER_PATH" 2>/dev/null; then
      restore_failed=1
    fi
  fi
  systemctl is-enabled --quiet "$WATCHER_PATH" 2>/dev/null && is_enabled=1
  systemctl is-active --quiet "$WATCHER_PATH" 2>/dev/null && is_active=1
  [[ "$was_enabled" = "$is_enabled" ]] || restore_failed=1
  [[ "$was_active" = "$is_active" ]] || restore_failed=1
  return "$restore_failed"
}

rollback_gate() {
  local rollback_failed=0
  if [[ -f "$ROLLBACK_COMPLETE" ]]; then
    return 0
  fi
  if [[ ! -e "$MUTATIONS_STARTED" ]]; then
    return 0
  fi
  test -f "$SNAPSHOT_COMPLETE" || return
  systemctl stop "$WATCHER_PATH" >/dev/null 2>&1 || true
  restore_snapshots || rollback_failed=1
  systemctl daemon-reload || rollback_failed=1
  restore_watcher_state || rollback_failed=1
  verify_restored_snapshots || rollback_failed=1
  if nginx -t; then
    systemctl reload nginx || rollback_failed=1
  else
    rollback_failed=1
  fi
  if [[ -n "$RELEASE_PATH" ]]; then
    verify_gateway || rollback_failed=1
  fi
  if [[ "$rollback_failed" != 0 ]]; then
    return 1
  fi
  : > "$ROLLBACK_COMPLETE"
  printf 'post-release-gate=rolled-back\n'
}

validate_state_root
case "$MODE" in
  verify)
    verify_gate
    ;;
  rollback)
    if ! rollback_gate; then
      if [[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" ]]; then
        : > "$ROLLBACK_FAILED"
      fi
      echo "Post-release gateway/watcher rollback failed for ${OTHER_RELEASE_PATH:-unknown release}." >&2
      exit 1
    fi
    ;;
  *)
    echo "Unsupported post-release gate mode: $MODE" >&2
    exit 2
    ;;
esac

#!/usr/bin/env bash
# Manage the singleton PM2 cluster worker used by the songuu.top RAG host.
#
# `reload` is gap-free only after the one-time migration from the legacy Bash
# fork process. `restart` intentionally remains available for the separate
# token-rotation path, where the app and Nginx bearer token must move together.
set -euo pipefail

readonly ACTION="${1:?usage: manage-rag-system-pm2.sh <reload|restart>}"
readonly ROOT="${RAG_RUNTIME_ROOT:-/opt/rag-system}"
readonly BOOTSTRAP="${RAG_RUNTIME_BOOTSTRAP:-$ROOT/shared/run-rag-system.cjs}"
readonly ECOSYSTEM="${RAG_PM2_ECOSYSTEM:-$ROOT/shared/rag-system.ecosystem.config.cjs}"
readonly LEGACY_RUNNER="${RAG_RUNTIME_LEGACY_RUNNER:-$ROOT/shared/run-rag-system.sh}"
readonly APP_NAME="rag-system"
readonly RAG_BASE_PATH="${RAG_BASE_PATH:-/rag-system}"
readonly LIVE_URL="${RAG_PM2_LIVE_URL:-http://127.0.0.1:5182${RAG_BASE_PATH}/api/health/live}"
readonly STARTUP_ATTEMPTS="${RAG_PM2_STARTUP_ATTEMPTS:-30}"
readonly STARTUP_INTERVAL="${RAG_PM2_STARTUP_INTERVAL:-1}"

# Systemd already supplies this on the host watcher. Keep the default here so
# an operator invoking the manager directly controls the same PM2 daemon.
export PM2_HOME="${PM2_HOME:-/root/.pm2}"

case "$ACTION" in
  reload|restart)
    ;;
  *)
    echo "Unsupported PM2 RAG action: $ACTION" >&2
    exit 2
    ;;
esac

command -v node >/dev/null
command -v pm2 >/dev/null
command -v curl >/dev/null
test -r "$BOOTSTRAP"
test -r "$ECOSYSTEM"
test -x "$LEGACY_RUNNER"

if ! [[ "$STARTUP_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || ! [[ "$STARTUP_INTERVAL" =~ ^[0-9]+$ ]]; then
  echo "RAG PM2 startup probe settings must be positive attempts and a non-negative interval" >&2
  exit 2
fi

wait_for_liveness() {
  local _
  for _ in $(seq 1 "$STARTUP_ATTEMPTS"); do
    if curl -fsS "$LIVE_URL" >/dev/null; then
      return 0
    fi
    sleep "$STARTUP_INTERVAL"
  done
  return 1
}

uses_cluster_bootstrap() {
  pm2 jlist | node -e '
    const fs = require("node:fs");
    const expected = process.argv[1];
    const apps = JSON.parse(fs.readFileSync(0, "utf8"));
    const app = apps.find(candidate => candidate.name === "rag-system");
    const env = app?.pm2_env;
    process.exit(env?.exec_mode === "cluster_mode" && env?.pm_exec_path === expected ? 0 : 1);
  ' "$BOOTSTRAP"
}

restore_legacy_runtime() {
  # The initial migration is the only point at which the old Bash/fork
  # runtime must be removed. If the Node/cluster bootstrap cannot start,
  # immediately restore that known launcher instead of leaving the host down.
  pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
  pm2 start "$LEGACY_RUNNER" --name "$APP_NAME" --cwd "$ROOT/current" --interpreter bash --update-env >/dev/null
  wait_for_liveness
}

start_cluster_runtime() {
  local had_legacy=0
  # A legacy Bash/fork process cannot become a cluster worker in place. This
  # occurs once during migration; later configuration edits use `pm2 reload`.
  if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    had_legacy=1
    echo "Migrating $APP_NAME to the zero-downtime PM2 cluster runtime" >&2
    if ! pm2 delete "$APP_NAME" >/dev/null; then
      echo "Cannot remove the legacy RAG PM2 process; leaving it in place" >&2
      return 1
    fi
  fi

  if pm2 start "$ECOSYSTEM" --only "$APP_NAME" --update-env >/dev/null && wait_for_liveness; then
    return 0
  fi

  echo "PM2 cluster migration failed; restoring the legacy Bash runtime" >&2
  pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
  if [[ "$had_legacy" = "1" ]] && restore_legacy_runtime; then
    echo "Legacy RAG runtime restored after failed PM2 cluster migration" >&2
  fi
  return 1
}

if ! pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  start_cluster_runtime
  exit 0
fi

if ! uses_cluster_bootstrap; then
  start_cluster_runtime
  exit 0
fi

case "$ACTION" in
  reload)
    pm2 reload "$APP_NAME" --update-env
    ;;
  restart)
    pm2 restart "$APP_NAME" --update-env
    ;;
esac

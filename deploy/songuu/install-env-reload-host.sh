#!/usr/bin/env bash
# Install the .env.prod auto-reload watcher on an already deployed songuu host.
# The source directory must contain the runtime scripts, PM2 cluster assets,
# and the two systemd units.
set -euo pipefail

readonly SOURCE_DIR="${1:?usage: install-env-reload-host.sh <staged-assets-dir>}"
readonly ROOT="/opt/rag-system"
readonly SHARED="$ROOT/shared"
readonly LEGACY_ENV="$SHARED/.env.production"
readonly ENV_FILE="$SHARED/.env.prod"
readonly DEFAULTS_FILE="$SHARED/.env.defaults"
readonly RUNNER="$SHARED/run-rag-system.sh"
readonly BOOTSTRAP="$SHARED/run-rag-system.cjs"
readonly PM2_ECOSYSTEM="$SHARED/rag-system.ecosystem.config.cjs"
readonly PM2_MANAGER="$SHARED/manage-rag-system-pm2.sh"
readonly RELOAD_RUNNER="$SHARED/reload-rag-system-env.sh"
readonly TOKEN_REFRESH="$SHARED/refresh-rag-nginx-token.sh"
readonly PATCHER="$SHARED/patch-nginx.py"
readonly SERVICE="/etc/systemd/system/rag-system-env-reload.service"
readonly PATH_UNIT="/etc/systemd/system/rag-system-env-reload.path"
readonly LAST_GOOD="$SHARED/.env.prod.last-known-good"
readonly APPLIED_HASH="$SHARED/.env.prod.last-applied.sha256"
readonly BACKUP_DIR="$SOURCE_DIR/install-backup"

for asset in \
  run-rag-system.sh \
  run-rag-system.cjs \
  rag-system.ecosystem.config.cjs \
  manage-rag-system-pm2.sh \
  reload-rag-system-env.sh \
  refresh-rag-nginx-token.sh \
  patch-nginx.py \
  rag-system-env-reload.service \
  rag-system-env-reload.path; do
  test -r "$SOURCE_DIR/$asset"
done
test -r "$DEFAULTS_FILE"
command -v curl >/dev/null
command -v pm2 >/dev/null
command -v node >/dev/null
command -v python3 >/dev/null
command -v systemctl >/dev/null

test ! -e "$ENV_FILE"
test -f "$LEGACY_ENV"
install -d -m 700 "$BACKUP_DIR"
cp -a "$LEGACY_ENV" "$BACKUP_DIR/env.production.before"

backup_target() {
  target="$1"
  label="$2"
  if [[ -e "$target" ]]; then
    cp -a "$target" "$BACKUP_DIR/$label.before"
    : > "$BACKUP_DIR/$label.existed"
  fi
}

restore_target() {
  target="$1"
  label="$2"
  if [[ -f "$BACKUP_DIR/$label.existed" ]]; then
    cp -a "$BACKUP_DIR/$label.before" "$target"
  else
    rm -f "$target"
  fi
}

backup_target "$RUNNER" runner
backup_target "$BOOTSTRAP" bootstrap
backup_target "$PM2_ECOSYSTEM" pm2-ecosystem
backup_target "$PM2_MANAGER" pm2-manager
backup_target "$RELOAD_RUNNER" reload-runner
backup_target "$TOKEN_REFRESH" token-refresh
backup_target "$PATCHER" patcher
backup_target "$SERVICE" service
backup_target "$PATH_UNIT" path

restore() {
  code="$?"
  set +e
  systemctl disable --now rag-system-env-reload.path >/dev/null 2>&1 || true
  restore_target "$RUNNER" runner
  restore_target "$BOOTSTRAP" bootstrap
  restore_target "$PM2_ECOSYSTEM" pm2-ecosystem
  restore_target "$PM2_MANAGER" pm2-manager
  restore_target "$RELOAD_RUNNER" reload-runner
  restore_target "$TOKEN_REFRESH" token-refresh
  restore_target "$PATCHER" patcher
  restore_target "$SERVICE" service
  restore_target "$PATH_UNIT" path
  rm -f "$LAST_GOOD" "$APPLIED_HASH"
  rm -f "$ENV_FILE" "$LEGACY_ENV"
  cp -a "$BACKUP_DIR/env.production.before" "$LEGACY_ENV"
  systemctl daemon-reload >/dev/null 2>&1 || true
  PM2_HOME=/root/.pm2 pm2 delete rag-system >/dev/null 2>&1 || true
  PM2_HOME=/root/.pm2 pm2 start "$RUNNER" --name rag-system --cwd "$ROOT/current" --interpreter bash >/dev/null 2>&1 || true
  PM2_HOME=/root/.pm2 pm2 save >/dev/null 2>&1 || true
  echo "environment watcher setup rolled back" >&2
  exit "$code"
}
trap restore ERR

mv "$LEGACY_ENV" "$ENV_FILE"
ln -s ".env.prod" "$LEGACY_ENV"
chmod 600 "$ENV_FILE"

token_lines="$(grep -c '^RAG_SINGLE_TENANT_TOKEN=' "$ENV_FILE" || true)"
if [[ "$token_lines" = "0" ]]; then
  token="$(python3 - <<'PY'
import re
from pathlib import Path

text = Path("/etc/nginx/conf.d/default.conf").read_text(encoding="utf-8")
block = re.search(
    r"location\s+\^~\s+/rag-api/\s*\{(?P<body>.*?)^\s*\}",
    text,
    re.MULTILINE | re.DOTALL,
)
if not block:
    raise SystemExit("missing RAG API Nginx block")
tokens = re.findall(
    r'proxy_set_header\s+Authorization\s+"Bearer\s+([^"\s]+)"\s*;',
    block.group("body"),
)
if len(tokens) != 1 or not re.fullmatch(r"[A-Za-z0-9._~+/-]{24,256}", tokens[0]):
    raise SystemExit("missing or unsafe RAG API Nginx token")
print(tokens[0])
PY
)"
  printf '\nRAG_SINGLE_TENANT_TOKEN=%s\n' "$token" >> "$ENV_FILE"
elif [[ "$token_lines" != "1" ]]; then
  echo "RAG environment has ambiguous tenant token assignments" >&2
  exit 2
fi

install_file() {
  source_name="$1"
  target="$2"
  mode="$3"
  stage="$target.next.$$"
  tr -d '\r' < "$SOURCE_DIR/$source_name" > "$stage"
  chmod "$mode" "$stage"
  mv -f "$stage" "$target"
}

install_file run-rag-system.sh "$RUNNER" 700
install_file run-rag-system.cjs "$BOOTSTRAP" 700
install_file rag-system.ecosystem.config.cjs "$PM2_ECOSYSTEM" 600
install_file manage-rag-system-pm2.sh "$PM2_MANAGER" 700
install_file reload-rag-system-env.sh "$RELOAD_RUNNER" 700
install_file refresh-rag-nginx-token.sh "$TOKEN_REFRESH" 700
install_file patch-nginx.py "$PATCHER" 700
install_file rag-system-env-reload.service "$SERVICE" 644
install_file rag-system-env-reload.path "$PATH_UNIT" 644
node --check "$BOOTSTRAP"
node --check "$PM2_ECOSYSTEM"
bash -n "$PM2_MANAGER"

bash -c '
  set -euo pipefail
  set -a
  . "$1"
  . "$2"
  test "${RAG_ACCESS_MODE:-}" = "single-tenant-token"
  test -n "${RAG_SINGLE_TENANT_TOKEN:-}"
  test "$RAG_SINGLE_TENANT_TOKEN" != "replace-with-a-long-random-secret"
' bash "$DEFAULTS_FILE" "$ENV_FILE"

systemctl daemon-reload
systemd-analyze verify "$SERVICE" "$PATH_UNIT"
PM2_HOME=/root/.pm2 "$PM2_MANAGER" reload >/dev/null

live=""
for _ in $(seq 1 30); do
  if live="$(curl -fsS http://127.0.0.1:5182/rag-system/api/health/live)"; then
    break
  fi
  sleep 1
done
test -n "$live"
"$TOKEN_REFRESH" "$PATCHER" >/dev/null

# Enable the watcher only after both the runtime and the injected Nginx token
# reflect the same file. The first edit can then reliably distinguish a token
# rotation from an ordinary cluster reload.
cp -a "$ENV_FILE" "$LAST_GOOD.next.$$"
chmod 600 "$LAST_GOOD.next.$$"
mv -f "$LAST_GOOD.next.$$" "$LAST_GOOD"
sha256sum "$ENV_FILE" | cut -d' ' -f1 > "$APPLIED_HASH.next.$$"
chmod 600 "$APPLIED_HASH.next.$$"
mv -f "$APPLIED_HASH.next.$$" "$APPLIED_HASH"
PM2_HOME=/root/.pm2 pm2 save >/dev/null

systemctl enable --now rag-system-env-reload.path >/dev/null
systemctl is-active --quiet rag-system-env-reload.path
trap - ERR
printf 'env-reload-installed=1\n'
printf 'live=%s\n' "$live"

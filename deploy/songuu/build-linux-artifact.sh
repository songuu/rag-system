#!/usr/bin/env bash
# Build a Linux/x64 standalone artifact outside the Windows worktree.
# This avoids copying Windows-only native modules into the songuu.top host.
set -euo pipefail

readonly SOURCE_DIR="${1:-/mnt/c/project/my/rag-system}"
readonly BUILD_ROOT="${2:?pass an unused absolute build directory under /tmp}"
readonly NODE_VERSION="${NODE_VERSION:-v24.13.0}"
readonly NODE_ARCHIVE="node-${NODE_VERSION}-linux-x64.tar.xz"
readonly NODE_ROOT="$BUILD_ROOT/toolchain/node-${NODE_VERSION}-linux-x64"
readonly PNPM_ROOT="$BUILD_ROOT/toolchain/pnpm"
readonly SOURCE_COPY="$BUILD_ROOT/source"
readonly STAGE="$BUILD_ROOT/stage"
readonly ARTIFACT="$BUILD_ROOT/rag-system-linux-standalone.tgz"
readonly PUBLISH_ARTIFACT="${PUBLISH_ARTIFACT:-}"

case "$BUILD_ROOT" in
  /tmp/rag-system-*) ;;
  *)
    echo "Refusing unsafe build directory: $BUILD_ROOT" >&2
    exit 2
    ;;
esac

if [[ -e "$BUILD_ROOT" ]]; then
  echo "Build directory already exists: $BUILD_ROOT" >&2
  exit 2
fi
if [[ ! -f "$SOURCE_DIR/package.json" || ! -f "$SOURCE_DIR/pnpm-lock.yaml" ]]; then
  echo "Source directory is not a pnpm project: $SOURCE_DIR" >&2
  exit 2
fi

mkdir -p "$BUILD_ROOT/toolchain"
curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${NODE_ARCHIVE}" \
  -o "$BUILD_ROOT/toolchain/$NODE_ARCHIVE"
tar -xJf "$BUILD_ROOT/toolchain/$NODE_ARCHIVE" -C "$BUILD_ROOT/toolchain"

export PATH="$NODE_ROOT/bin:$PATH"
npm install --global --prefix "$PNPM_ROOT" pnpm@11.1.3 --no-audit --no-fund
export PATH="$PNPM_ROOT/bin:$PATH"

mkdir -p "$SOURCE_COPY"
rsync -a \
  --exclude '.git/' \
  --exclude '.next/' \
  --exclude 'node_modules/' \
  --exclude '.env' \
  --exclude '.env.local' \
  --exclude '.env.production' \
  "$SOURCE_DIR/" "$SOURCE_COPY/"

cd "$SOURCE_COPY"
unset STATIC_EXPORT
export NEXT_TELEMETRY_DISABLED=1
# The root host is a route directory. A Next basePath keeps this service's
# pages and chunks isolated under /rag-system instead of shared root routes.
export RAG_BASE_PATH="${RAG_BASE_PATH:-/rag-system}"
pnpm install --frozen-lockfile
if ! pnpm build; then
  echo 'pnpm build failed before artifact staging' >&2
  exit 1
fi

mkdir -p "$STAGE/.next"
cp -a .next/standalone/. "$STAGE/"
cp -a .next/static "$STAGE/.next/static"
cp -a public "$STAGE/public"
tar -C "$STAGE" -czf "$ARTIFACT" .

(
  cd "$STAGE"
  PORT=5182 HOSTNAME=127.0.0.1 NODE_ENV=production node server.js > "$BUILD_ROOT/smoke.log" 2>&1 &
  smoke_pid=$!
  cleanup() { kill "$smoke_pid" 2>/dev/null || true; wait "$smoke_pid" 2>/dev/null || true; }
  trap cleanup EXIT

  for _ in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:5182${RAG_BASE_PATH}/api/health/live" > "$BUILD_ROOT/live.json"; then
      break
    fi
    sleep 1
  done
  test -s "$BUILD_ROOT/live.json"
  curl -fsS "http://127.0.0.1:5182${RAG_BASE_PATH}" > "$BUILD_ROOT/home.html"
  asset_path=$(grep -Eo "${RAG_BASE_PATH}/_next/static/[^\" ]+\\.(css|js)" "$BUILD_ROOT/home.html" | head -n 1)
  test -n "$asset_path"
  curl -fsSI "http://127.0.0.1:5182${asset_path}" > "$BUILD_ROOT/asset.headers"

  readiness_status=$(curl -sS -o "$BUILD_ROOT/readiness.json" -w '%{http_code}' "http://127.0.0.1:5182${RAG_BASE_PATH}/api/health")
  printf '%s' "$readiness_status" > "$BUILD_ROOT/readiness.status"
  if grep -Eqi 'Cannot find module|ERR_DLOPEN_FAILED|invalid ELF|Failed to load external module' \
    "$BUILD_ROOT/readiness.json" "$BUILD_ROOT/smoke.log"; then
    echo "Linux native-module smoke failed" >&2
    exit 1
  fi
)

if [[ -n "$PUBLISH_ARTIFACT" ]]; then
  mkdir -p "$(dirname "$PUBLISH_ARTIFACT")"
  install -m 0644 "$ARTIFACT" "$PUBLISH_ARTIFACT"
fi

printf 'artifact=%s\n' "$ARTIFACT"
du -h "$ARTIFACT"
printf 'live='
tr -d '\n' < "$BUILD_ROOT/live.json"
printf '\nasset='
head -n 1 "$BUILD_ROOT/asset.headers"
printf 'readiness_status=%s\n' "$(cat "$BUILD_ROOT/readiness.status")"
if [[ -n "$PUBLISH_ARTIFACT" ]]; then
  printf 'published_artifact=%s\n' "$PUBLISH_ARTIFACT"
fi

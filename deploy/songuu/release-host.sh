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
readonly ENV_FILE="$SHARED/.env.production"
readonly RUNNER="$SHARED/run-rag-system.sh"

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

install -d -m 0755 "$RELEASES" "$SHARED" \
  "$ROOT/data/uploads" \
  "$ROOT/data/reasoning-uploads" \
  "$ROOT/data/adaptive-rag-uploads" \
  "$ROOT/data/mirofish-graph-artifacts-v2" \
  "$ROOT/data/pdf-visual-assets-v1" \
  "$ROOT/data/rag-durable-workflows-v1"

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
SUPABASE_DEFAULT_TENANT_ID=songuu-production
SUPABASE_DEFAULT_CORPUS_ID=default
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
RAG_PERSISTENCE_BACKEND=local
RAG_VECTOR_BACKEND=milvus

REASONING_RAG_UPLOAD_DIR=/opt/rag-system/data/reasoning-uploads
RAG_MIROFISH_GRAPH_STORE_ROOT=/opt/rag-system/data/mirofish-graph-artifacts-v2
RAG_PDF_VISUAL_STORE_ROOT=/opt/rag-system/data/pdf-visual-assets-v1
RAG_DURABLE_WORKFLOW_STORE_ROOT=/opt/rag-system/data/rag-durable-workflows-v1
EOF
  chmod 600 "$ENV_FILE"
fi

if [[ ! -x "$RUNNER" ]]; then
  echo "Expected runner is missing or not executable: $RUNNER" >&2
  exit 2
fi

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
    pm2 restart rag-system --update-env >/dev/null 2>&1 || true
  fi
}

if pm2 describe rag-system >/dev/null 2>&1; then
  pm2 restart rag-system --update-env
else
  pm2 start "$RUNNER" --name rag-system --cwd "$ROOT/current" --interpreter bash
fi
pm2 save

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

printf 'release=%s\n' "$release"
printf 'current=%s\n' "$(readlink -f "$ROOT/current")"
printf 'live=%s\n' "$live"

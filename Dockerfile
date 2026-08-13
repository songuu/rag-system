# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    npm_config_registry="${NPM_CONFIG_REGISTRY}" \
    NEXT_TELEMETRY_DISABLED="1"
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.1.3 --activate

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG RAG_BASE_PATH
ENV RAG_BASE_PATH="${RAG_BASE_PATH}"
ENV NODE_ENV="production"
RUN pnpm build

FROM base AS runner
ARG RAG_BASE_PATH=/rag-system
ENV NODE_ENV="production" \
    HOSTNAME="0.0.0.0" \
    PORT="3000" \
    RAG_BASE_PATH="${RAG_BASE_PATH}" \
    RAG_RUNTIME_ENV_SOURCE="process" \
    RAG_RUNTIME_SERVER="/app/server.js"

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/db/postgres ./db/postgres
COPY --from=builder --chown=nextjs:nodejs /app/scripts/migrate-postgres.mjs ./scripts/migrate-postgres.mjs
COPY --from=builder --chown=nextjs:nodejs /app/deploy/songuu/run-rag-system.cjs ./run-rag-system.cjs
RUN mkdir -p /app/uploads /app/reasoning-uploads /app/adaptive-rag-uploads \
  && chown -R nextjs:nodejs /app/uploads /app/reasoning-uploads /app/adaptive-rag-uploads

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const port=process.env.PORT||3000; const base=process.env.RAG_BASE_PATH||''; fetch('http://127.0.0.1:' + port + base + '/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "run-rag-system.cjs"]

FROM rag-system:local
COPY --chown=nextjs:nodejs graph-control-worker.cjs /app/graph-control-worker.cjs
RUN node --check /app/graph-control-worker.cjs

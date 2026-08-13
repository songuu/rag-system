/* eslint-disable @typescript-eslint/no-require-imports -- the standalone Next server and shared production bootstrap are CommonJS entry points. */
'use strict';

const path = require('node:path');

// Keep every production entry point behind the same PostgreSQL configuration
// and runtime-secret allowlist used by containers and the host deployment.
process.env.RAG_RUNTIME_ENV_SOURCE = 'process';
process.env.RAG_RUNTIME_SERVER = path.join(
  __dirname,
  '..',
  '.next',
  'standalone',
  'server.js'
);

require('../deploy/songuu/run-rag-system.cjs');

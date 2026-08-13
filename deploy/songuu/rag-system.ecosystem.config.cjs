'use strict';

/**
 * One cluster worker is deliberate: it provides handoff during `pm2 reload`
 * without turning the host's local RAG stores into a multi-instance runtime.
 */
module.exports = {
  apps: [
    {
      name: 'rag-system',
      script: '/opt/rag-system/shared/run-rag-system.cjs',
      cwd: '/opt/rag-system',
      interpreter: 'node',
      exec_mode: 'cluster',
      instances: 1,
      autorestart: true,
      watch: false,
      listen_timeout: 15000,
      kill_timeout: 10000,
      env: {
        RAG_DEFAULTS_FILE: '/opt/rag-system/shared/.env.defaults',
        RAG_ENV_FILE: '/opt/rag-system/shared/.env.prod',
      },
    },
  ],
};

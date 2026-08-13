#!/usr/bin/env node
'use strict';

/**
 * Start the standalone Next server with the current host runtime environment.
 *
 * PM2 must run a Node entry point in cluster mode for `pm2 reload` to keep the
 * old worker serving until the replacement worker is listening. The legacy
 * Bash runner cannot provide that behavior. We still let Bash source the
 * files because the production environment is intentionally Bash-compatible
 * and can safely contain quoted values that a hand-written dotenv parser
 * would interpret differently.
 */

const { existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = process.env.RAG_RUNTIME_ROOT || '/opt/rag-system';
const DEFAULTS_FILE = process.env.RAG_DEFAULTS_FILE || path.join(ROOT, 'shared', '.env.defaults');
const ENV_FILE = process.env.RAG_ENV_FILE || path.join(ROOT, 'shared', '.env.prod');
const SERVER_FILE = process.env.RAG_RUNTIME_SERVER || path.join(ROOT, 'current', 'server.js');
const BASH = process.env.RAG_RUNTIME_BASH || 'bash';

// Remove the configuration surface inherited from the previous PM2 worker
// before applying the files. This matters when an operator removes a setting
// (for example a previous custom provider key): PM2 itself retains process
// environment values across reloads, but the files are the source of truth.
const RUNTIME_KEY = /^(?:AZURE_OPENAI_|COHERE_|CONTEXTUAL_RETRIEVAL_|CUSTOM_|EMBEDDING_|FAST_LLM_MODEL$|HOSTNAME$|KEEP_ALIVE_TIMEOUT$|LANGCHAIN_|LANGSMITH_|LEMONADE_|LLM_MODEL$|MAIC_|MILVUS_|MODEL_|NEXT_PUBLIC_|NEXT_TELEMETRY_DISABLED$|NODE_ENV$|NOTION_|OLLAMA_|OPENAI_|OPENROUTER_|PDF_PARSE_|PORT$|RAG_|REASONING_|RERANK_|RERANKER_|SEMANTIC_CACHE_|SILICONFLOW_|STATIC_EXPORT$|SUPABASE_|VOYAGE_)/;

function fail(message, cause) {
  console.error(`[rag-system bootstrap] ${message}`);
  if (cause) console.error(cause);
  process.exit(1);
}

function inheritedShellEnvironment() {
  const fallbackPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  const keys = [
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  ];
  const environment = { PATH: process.env.PATH || fallbackPath };
  for (const key of keys) {
    if (key !== 'PATH' && process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

function parseNullSeparatedEnvironment(buffer) {
  const values = new Map();
  for (const entry of buffer.toString('utf8').split('\0')) {
    if (!entry) continue;
    const separator = entry.indexOf('=');
    if (separator > 0) values.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return values;
}

function loadRuntimeEnvironment() {
  if (!existsSync(DEFAULTS_FILE) || !existsSync(ENV_FILE)) {
    fail(`runtime environment file is missing: ${DEFAULTS_FILE} or ${ENV_FILE}`);
  }

  const sourced = spawnSync(
    BASH,
    [
      '--noprofile',
      '--norc',
      '-c',
      'set -euo pipefail; set -a; . "$1"; . "$2"; env -0',
      'rag-system-runtime-env',
      DEFAULTS_FILE,
      ENV_FILE,
    ],
    { encoding: 'buffer', env: inheritedShellEnvironment() }
  );

  if (sourced.error || sourced.status !== 0) {
    const stderr = sourced.stderr?.toString('utf8').trim();
    fail('failed to load runtime environment', stderr || sourced.error?.message);
  }

  for (const key of Object.keys(process.env)) {
    if (RUNTIME_KEY.test(key)) delete process.env[key];
  }
  for (const [key, value] of parseNullSeparatedEnvironment(sourced.stdout)) {
    if (RUNTIME_KEY.test(key)) process.env[key] = value;
  }
}

loadRuntimeEnvironment();

if (!existsSync(SERVER_FILE)) {
  fail(`standalone server is missing: ${SERVER_FILE}`);
}

require(SERVER_FILE);

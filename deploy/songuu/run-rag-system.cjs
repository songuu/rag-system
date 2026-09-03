#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- PM2 requires a CommonJS bootstrap and the release server path is resolved at runtime. */
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
const ENVIRONMENT_SOURCE = process.env.RAG_RUNTIME_ENV_SOURCE || 'files';

// Remove the configuration surface inherited from the previous PM2 worker
// before applying the files. This matters when an operator removes a setting
// (for example a previous custom provider key): PM2 itself retains process
// environment values across reloads, but the files are the source of truth.
const RUNTIME_KEY = /^(?:AZURE_OPENAI_|COHERE_|CONTEXTUAL_RETRIEVAL_|CUSTOM_|EMBEDDING_|FAST_LLM_MODEL$|HOSTNAME$|KEEP_ALIVE_TIMEOUT$|LANGCHAIN_|LANGSMITH_|LEMONADE_|LLM_MODEL$|MAIC_|MILVUS_|MODEL_|NEXT_PUBLIC_(?:BASE_PATH|LANGCHAIN_PROJECT|LANGCHAIN_TRACING)$|NEXT_TELEMETRY_DISABLED$|NODE_ENV$|NOTION_|OLLAMA_|OPENAI_|OPENROUTER_|PDF_PARSE_|PORT$|PROMPT_OPTIMIZER_|RAG_|REASONING_|RERANK_|RERANKER_|SEMANTIC_CACHE_|SILICONFLOW_|STATIC_EXPORT$|VOYAGE_)/;
const POSTGRES_RUNTIME_KEY = /^(?:DATABASE_URL|POSTGRES_URL|POSTGRES_SSL_MODE|POSTGRES_MAX_CONNECTIONS|POSTGRES_IDLE_TIMEOUT_MS|POSTGRES_CONNECTION_TIMEOUT_MS|POSTGRES_DEFAULT_TENANT_ID|POSTGRES_DEFAULT_CORPUS_ID)$/;
const MIGRATION_ONLY_RUNTIME_KEY = /^POSTGRES_MIGRATION_URL$/;
const BOOTSTRAP_CONTROL_KEY = /^RAG_RUNTIME_/;
const INHERITED_SYSTEM_KEYS = new Set([
  'ALL_PROXY', 'APPDATA', 'COMSPEC', 'HOME', 'HTTP_PROXY', 'HTTPS_PROXY',
  'LANG', 'LC_ALL', 'LOCALAPPDATA', 'NODE_EXTRA_CA_CERTS', 'NO_PROXY', 'PATH',
  'PATHEXT', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SSL_CERT_DIR',
  'SSL_CERT_FILE', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'TZ', 'USERPROFILE',
  'WINDIR',
]);

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

function isAppRuntimeKey(key) {
  return (
    (RUNTIME_KEY.test(key) || POSTGRES_RUNTIME_KEY.test(key))
    && !MIGRATION_ONLY_RUNTIME_KEY.test(key)
    && !BOOTSTRAP_CONTROL_KEY.test(key)
  );
}

function applyRuntimeEnvironment(values) {
  const inheritedSystemEnvironment = new Map(
    Object.entries(process.env).filter(([key]) => INHERITED_SYSTEM_KEYS.has(key.toUpperCase()))
  );

  // The app receives only required operating-system values plus explicitly
  // approved runtime configuration. This prevents stale PM2/container values
  // and infrastructure-only database credentials from reaching server code.
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [key, value] of inheritedSystemEnvironment) process.env[key] = value;
  for (const [key, value] of values) {
    if (value !== undefined && isAppRuntimeKey(key)) process.env[key] = value;
  }
}

function loadRuntimeEnvironment() {
  if (ENVIRONMENT_SOURCE === 'process') {
    applyRuntimeEnvironment(new Map(Object.entries(process.env)));
    return;
  }
  if (ENVIRONMENT_SOURCE !== 'files') {
    fail('RAG_RUNTIME_ENV_SOURCE must be files or process');
  }
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

  applyRuntimeEnvironment(parseNullSeparatedEnvironment(sourced.stdout));
}

function validateProductionPersistence() {
  const backend = process.env.RAG_PERSISTENCE_BACKEND?.trim() || 'postgres';
  if (backend !== 'postgres') {
    fail('Production RAG persistence must use postgres');
  }
  process.env.RAG_PERSISTENCE_BACKEND = backend;

  const databaseUrl = normalizePostgresUrl('DATABASE_URL');
  const postgresUrl = normalizePostgresUrl('POSTGRES_URL');
  if (!databaseUrl && !postgresUrl) {
    fail('DATABASE_URL or POSTGRES_URL is required for PostgreSQL persistence');
  }
  if (databaseUrl && postgresUrl && databaseUrl !== postgresUrl) {
    fail('DATABASE_URL and POSTGRES_URL must not point to different databases');
  }

  const scopePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const tenantId = process.env.RAG_DEFAULT_TENANT_ID?.trim() || '';
  const corpusId = process.env.RAG_DEFAULT_CORPUS_ID?.trim() || '';
  if (!tenantId || !corpusId) {
    fail('RAG_DEFAULT_TENANT_ID and RAG_DEFAULT_CORPUS_ID are required for PostgreSQL persistence');
  }
  if (!scopePattern.test(tenantId) || !scopePattern.test(corpusId)) {
    fail('RAG_DEFAULT_TENANT_ID and RAG_DEFAULT_CORPUS_ID must be valid scope identifiers');
  }
  process.env.RAG_DEFAULT_TENANT_ID = tenantId;
  process.env.RAG_DEFAULT_CORPUS_ID = corpusId;
}

function normalizePostgresUrl(name) {
  const value = process.env[name]?.trim() || '';
  if (!value) {
    delete process.env[name];
    return '';
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${name} must be a valid PostgreSQL connection URL`);
  }
  if (
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:')
    || !parsed.hostname
  ) {
    fail(`${name} must be a valid PostgreSQL connection URL`);
  }
  process.env[name] = value;
  return value;
}

loadRuntimeEnvironment();
validateProductionPersistence();

// The PM2 cwd is the stable release root, while schema assets live beside the
// currently linked standalone server. Readiness must resolve the exact release.
process.env.RAG_RELEASE_DIR = path.dirname(SERVER_FILE);

if (!existsSync(SERVER_FILE)) {
  fail(`standalone server is missing: ${SERVER_FILE}`);
}

require(SERVER_FILE);

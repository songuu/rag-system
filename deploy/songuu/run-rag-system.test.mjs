import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const bootstrap = path.join(scriptDirectory, 'run-rag-system.cjs');
const windowsGitBash = 'C:/Apps/Git/bin/bash.exe';

test('runtime bootstrap gives .env.prod precedence and applies the app allowlist', {
  skip: process.platform === 'win32' && !existsSync(windowsGitBash),
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rag-system-runtime-'));
  const shared = path.join(root, 'shared');
  const current = path.join(root, 'current');
  const output = path.join(root, 'observed.json');

  try {
    mkdirSync(shared, { recursive: true });
    mkdirSync(current, { recursive: true });
    writeFileSync(
      path.join(shared, '.env.defaults'),
      [
        "MODEL_PROVIDER='ollama'",
        "EMBEDDING_PROVIDER='ollama'",
        "DATABASE_URL='postgresql://defaults:defaults-secret@postgres:5432/rag_system'",
        "POSTGRES_SSL_MODE='disable'",
        "RAG_PERSISTENCE_BACKEND='postgres'",
        "RAG_DEFAULT_TENANT_ID='songuu-production'",
        "RAG_DEFAULT_CORPUS_ID='default'",
        "PORT='5182'",
        "HOSTNAME='127.0.0.1'",
      ].join('\n') + '\n'
    );
    writeFileSync(
      path.join(shared, '.env.prod'),
      [
        "MODEL_PROVIDER='custom'",
        "CUSTOM_API_KEY='fresh key with spaces'",
        "DATABASE_URL='postgresql://runtime:fresh-database-secret@postgres:5432/rag_system'",
        "POSTGRES_SSL_MODE='require'",
        "POSTGRES_PASSWORD='infrastructure-secret-must-not-be-loaded'",
        "POSTGRES_MIGRATION_URL='postgresql://owner:migration-secret@postgres:5432/rag_system'",
        "UNLISTED_FILE_SECRET='unlisted-file-secret'",
      ].join('\n') + '\n'
    );
    writeFileSync(
      path.join(current, 'server.js'),
      [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({`,
        '  modelProvider: process.env.MODEL_PROVIDER,',
        '  customApiKey: process.env.CUSTOM_API_KEY,',
        '  embeddingProvider: process.env.EMBEDDING_PROVIDER,',
        "  hasStaleEmbeddingKey: Object.hasOwn(process.env, 'CUSTOM_EMBEDDING_API_KEY'),",
        "  hasFreshDatabaseUrl: process.env.DATABASE_URL === 'postgresql://runtime:fresh-database-secret@postgres:5432/rag_system',",
        "  hasStalePostgresUrl: Object.hasOwn(process.env, 'POSTGRES_URL'),",
        '  postgresSslMode: process.env.POSTGRES_SSL_MODE,',
        '  releaseDir: process.env.RAG_RELEASE_DIR,',
        "  hasPostgresPassword: Object.hasOwn(process.env, 'POSTGRES_PASSWORD'),",
        "  hasMigrationUrl: Object.hasOwn(process.env, 'POSTGRES_MIGRATION_URL'),",
        "  hasUnlistedFileSecret: Object.hasOwn(process.env, 'UNLISTED_FILE_SECRET'),",
        "  hasUnlistedInheritedSecret: Object.hasOwn(process.env, 'UNLISTED_PM2_SECRET'),",
        '  hostname: process.env.HOSTNAME,',
        '  port: process.env.PORT,',
        '}));',
      ].join('\n') + '\n'
    );

    const result = spawnSync(process.execPath, [bootstrap], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RAG_RUNTIME_ROOT: root,
        ...(process.platform === 'win32' ? { RAG_RUNTIME_BASH: windowsGitBash } : {}),
        MODEL_PROVIDER: 'stale-provider',
        CUSTOM_EMBEDDING_API_KEY: 'stale-should-not-survive',
        DATABASE_URL: 'postgresql://stale:stale-database-secret@old-host:5432/old_database',
        POSTGRES_URL: 'postgresql://stale-alias:stale-alias-secret@old-host:5432/old_database',
        POSTGRES_MIGRATION_URL: 'postgresql://owner:stale-migration-secret@old-host:5432/old_database',
        POSTGRES_PASSWORD: 'stale-infrastructure-secret',
        UNLISTED_PM2_SECRET: 'unlisted-inherited-secret',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /database-secret|alias-secret|migration-secret|infrastructure-secret|unlisted-inherited-secret/);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), {
      modelProvider: 'custom',
      customApiKey: 'fresh key with spaces',
      embeddingProvider: 'ollama',
      hasStaleEmbeddingKey: false,
      hasFreshDatabaseUrl: true,
      hasStalePostgresUrl: false,
      postgresSslMode: 'require',
      releaseDir: current,
      hasPostgresPassword: false,
      hasMigrationUrl: false,
      hasUnlistedFileSecret: false,
      hasUnlistedInheritedSecret: false,
      hostname: '127.0.0.1',
      port: '5182',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime bootstrap rejects explicit local persistence before loading the server', {
  skip: process.platform === 'win32' && !existsSync(windowsGitBash),
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rag-system-runtime-'));
  const shared = path.join(root, 'shared');
  const current = path.join(root, 'current');
  const output = path.join(root, 'observed.json');

  try {
    mkdirSync(shared, { recursive: true });
    mkdirSync(current, { recursive: true });
    writeFileSync(path.join(shared, '.env.defaults'), "RAG_PERSISTENCE_BACKEND='local'\n");
    writeFileSync(path.join(shared, '.env.prod'), "NODE_ENV='production'\n");
    writeFileSync(
      path.join(current, 'server.js'),
      [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(output)}, 'server-loaded');`,
      ].join('\n') + '\n'
    );

    const result = spawnSync(process.execPath, [bootstrap], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RAG_RUNTIME_ROOT: root,
        ...(process.platform === 'win32' ? { RAG_RUNTIME_BASH: windowsGitBash } : {}),
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Production RAG persistence must use postgres/);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('process environment mode applies the same runtime allowlist for containers', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rag-system-runtime-'));
  const current = path.join(root, 'current');
  const output = path.join(root, 'observed.json');

  try {
    mkdirSync(current, { recursive: true });
    writeFileSync(
      path.join(current, 'server.js'),
      [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({`,
        '  databaseUrl: process.env.DATABASE_URL,',
        "  hasPostgresPassword: Object.hasOwn(process.env, 'POSTGRES_PASSWORD'),",
        "  hasMigrationUrl: Object.hasOwn(process.env, 'POSTGRES_MIGRATION_URL'),",
        "  hasUnlistedSecret: Object.hasOwn(process.env, 'UNLISTED_CONTAINER_SECRET'),",
        "  hasBootstrapControl: Object.hasOwn(process.env, 'RAG_RUNTIME_ENV_SOURCE'),",
        '}));',
      ].join('\n') + '\n'
    );

    const result = spawnSync(process.execPath, [bootstrap], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RAG_RUNTIME_ENV_SOURCE: 'process',
        RAG_RUNTIME_SERVER: path.join(current, 'server.js'),
        RAG_PERSISTENCE_BACKEND: 'postgres',
        RAG_DEFAULT_TENANT_ID: 'songuu-production',
        RAG_DEFAULT_CORPUS_ID: 'default',
        DATABASE_URL: 'postgresql://runtime:container-secret@postgres:5432/rag_system',
        POSTGRES_PASSWORD: 'infrastructure-secret',
        POSTGRES_MIGRATION_URL: 'postgresql://owner:migration-secret@postgres:5432/rag_system',
        UNLISTED_CONTAINER_SECRET: 'unlisted-container-secret',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /container-secret|infrastructure-secret|migration-secret|unlisted-container-secret/);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), {
      databaseUrl: 'postgresql://runtime:container-secret@postgres:5432/rag_system',
      hasPostgresPassword: false,
      hasMigrationUrl: false,
      hasUnlistedSecret: false,
      hasBootstrapControl: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('process environment defaults to PostgreSQL and fails closed without connection settings', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rag-system-runtime-'));
  const server = path.join(root, 'server.js');
  const output = path.join(root, 'server-loaded');

  try {
    writeFileSync(server, `require('node:fs').writeFileSync(${JSON.stringify(output)}, 'loaded');\n`);
    const result = spawnSync(process.execPath, [bootstrap], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RAG_RUNTIME_ENV_SOURCE: 'process',
        RAG_RUNTIME_SERVER: server,
        RAG_DEFAULT_TENANT_ID: 'songuu-production',
        RAG_DEFAULT_CORPUS_ID: 'default',
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DATABASE_URL or POSTGRES_URL is required/);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('process environment rejects dual-write, invalid database URLs, and invalid scope', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rag-system-runtime-'));
  const server = path.join(root, 'server.js');
  const output = path.join(root, 'server-loaded');

  try {
    writeFileSync(server, `require('node:fs').writeFileSync(${JSON.stringify(output)}, 'loaded');\n`);
    const cases = [
      {
        overrides: {
          RAG_PERSISTENCE_BACKEND: 'dual-write',
          DATABASE_URL: 'postgresql://rag:secret@postgres:5432/rag',
        },
        message: /Production RAG persistence must use postgres/,
      },
      {
        overrides: { DATABASE_URL: 'https://postgres.invalid/rag' },
        message: /DATABASE_URL must be a valid PostgreSQL connection URL/,
      },
      {
        overrides: {
          DATABASE_URL: 'postgresql://rag:secret@postgres:5432/rag',
          RAG_DEFAULT_TENANT_ID: 'tenant with spaces',
        },
        message: /must be valid scope identifiers/,
      },
    ];

    for (const testCase of cases) {
      const result = spawnSync(process.execPath, [bootstrap], {
        encoding: 'utf8',
        env: {
          ...process.env,
          RAG_RUNTIME_ENV_SOURCE: 'process',
          RAG_RUNTIME_SERVER: server,
          RAG_PERSISTENCE_BACKEND: 'postgres',
          RAG_DEFAULT_TENANT_ID: 'songuu-production',
          RAG_DEFAULT_CORPUS_ID: 'default',
          DATABASE_URL: '',
          POSTGRES_URL: '',
          ...testCase.overrides,
        },
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, testCase.message);
      assert.equal(existsSync(output), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

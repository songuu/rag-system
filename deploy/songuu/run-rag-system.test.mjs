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

test('runtime bootstrap gives .env.prod precedence and removes stale PM2 configuration', {
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
        "PORT='5182'",
        "HOSTNAME='127.0.0.1'",
      ].join('\n') + '\n'
    );
    writeFileSync(
      path.join(shared, '.env.prod'),
      [
        "MODEL_PROVIDER='custom'",
        "CUSTOM_API_KEY='fresh key with spaces'",
      ].join('\n') + '\n'
    );
    writeFileSync(
      path.join(current, 'server.js'),
      [
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.TEST_OUTPUT, JSON.stringify({",
        '  modelProvider: process.env.MODEL_PROVIDER,',
        '  customApiKey: process.env.CUSTOM_API_KEY,',
        '  embeddingProvider: process.env.EMBEDDING_PROVIDER,',
        "  hasStaleEmbeddingKey: Object.hasOwn(process.env, 'CUSTOM_EMBEDDING_API_KEY'),",
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
        // CI/production uses Bash from PATH. The explicit override keeps this
        // isolated test runnable on the Windows checkout as well.
        ...(process.platform === 'win32' ? { RAG_RUNTIME_BASH: windowsGitBash } : {}),
        TEST_OUTPUT: output,
        MODEL_PROVIDER: 'stale-provider',
        CUSTOM_EMBEDDING_API_KEY: 'stale-should-not-survive',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), {
      modelProvider: 'custom',
      customApiKey: 'fresh key with spaces',
      embeddingProvider: 'ollama',
      hasStaleEmbeddingKey: false,
      hostname: '127.0.0.1',
      port: '5182',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

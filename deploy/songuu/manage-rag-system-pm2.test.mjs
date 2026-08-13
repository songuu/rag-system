import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const manager = path.join(scriptDirectory, 'manage-rag-system-pm2.sh');
const windowsGitBash = 'C:/Apps/Git/bin/bash.exe';
const bash = process.platform === 'win32' ? windowsGitBash : 'bash';

test('cluster migration restores the legacy runner when the new PM2 runtime cannot start', {
  skip: process.platform === 'win32' && !existsSync(windowsGitBash),
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rag-system-pm2-manager-'));
  const shared = path.join(root, 'shared');
  const current = path.join(root, 'current');
  const mockBin = path.join(root, 'mock-bin');
  const bootstrap = path.join(shared, 'run-rag-system.cjs');
  const ecosystem = path.join(shared, 'rag-system.ecosystem.config.cjs');
  const legacyRunner = path.join(shared, 'run-rag-system.sh');
  const calls = path.join(root, 'pm2-calls.log');
  const legacyStarted = path.join(root, 'legacy-started');

  try {
    mkdirSync(shared, { recursive: true });
    mkdirSync(current, { recursive: true });
    mkdirSync(mockBin, { recursive: true });
    writeFileSync(bootstrap, "'use strict';\n");
    writeFileSync(ecosystem, "'use strict';\n");
    writeFileSync(legacyRunner, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(legacyRunner, 0o700);

    writeFileSync(path.join(mockBin, 'pm2'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$PM2_CALLS"
case "$1" in
  describe)
    exit 0
    ;;
  jlist)
    printf '%s\\n' '[{"name":"rag-system","pm2_env":{"exec_mode":"fork_mode","pm_exec_path":"/legacy/run-rag-system.sh"}}]'
    exit 0
    ;;
  delete)
    exit 0
    ;;
  start)
    if [[ "$2" = "$RAG_PM2_ECOSYSTEM" ]]; then
      exit 1
    fi
    if [[ "$2" = "$RAG_RUNTIME_LEGACY_RUNNER" ]]; then
      : > "$PM2_LEGACY_STARTED"
      exit 0
    fi
    exit 2
    ;;
  *)
    exit 2
    ;;
esac
`);
    writeFileSync(path.join(mockBin, 'curl'), `#!/usr/bin/env bash
test -f "$PM2_LEGACY_STARTED"
`);
    chmodSync(path.join(mockBin, 'pm2'), 0o700);
    chmodSync(path.join(mockBin, 'curl'), 0o700);
    chmodSync(manager, 0o700);

    const result = spawnSync(
      bash,
      ['--noprofile', '--norc', '-c', 'PATH="$1:$PATH"; export PATH; exec "$2" reload', 'pm2-manager-test', mockBin, manager],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          RAG_RUNTIME_ROOT: root,
          RAG_RUNTIME_BOOTSTRAP: bootstrap,
          RAG_PM2_ECOSYSTEM: ecosystem,
          RAG_RUNTIME_LEGACY_RUNNER: legacyRunner,
          RAG_PM2_STARTUP_ATTEMPTS: '1',
          RAG_PM2_STARTUP_INTERVAL: '0',
          PM2_CALLS: calls,
          PM2_LEGACY_STARTED: legacyStarted,
        },
      }
    );

    assert.equal(result.status, 1, result.stderr);
    assert.equal(existsSync(legacyStarted), true);
    assert.match(readFileSync(calls, 'utf8'), /start .*rag-system\.ecosystem\.config\.cjs/);
    assert.match(readFileSync(calls, 'utf8'), /start .*run-rag-system\.sh/);
    assert.match(result.stderr, /Legacy RAG runtime restored/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

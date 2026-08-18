import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';
const result = spawnSync(
  python,
  [path.join(directory, 'extract-release-artifact.test.py')],
  { encoding: 'utf8' }
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
assert.equal(result.error, undefined, `Could not run ${python}: ${result.error?.message}`);
assert.equal(result.status, 0, 'release artifact extractor tests failed');

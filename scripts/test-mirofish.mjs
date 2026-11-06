import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['src/lib/mirofish', 'src/components/mirofish', 'src/app/api/mirofish'];
function testsAt(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? testsAt(path) : entry.name.endsWith('.test.mjs') ? [path] : [];
  });
}
const files = roots.flatMap(testsAt).sort();
const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-concurrency=4', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

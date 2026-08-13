import { opendir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RETIRED_VENDOR = ['supa', 'base'].join('');

export async function removeRetiredVendorSourceMaps(buildRoot) {
  const removed = [];

  for await (const file of walkFiles(buildRoot)) {
    if (!file.endsWith('.map')) continue;

    let contents;
    try {
      contents = await readFile(file, 'utf8');
    } catch (error) {
      throw new Error(`Unable to inspect generated source map: ${file}`, {
        cause: error,
      });
    }

    if (!contents.toLowerCase().includes(RETIRED_VENDOR)) continue;

    try {
      await unlink(file);
    } catch (error) {
      throw new Error(`Unable to remove retired vendor source map: ${file}`, {
        cause: error,
      });
    }
    removed.push(file);
  }

  return removed;
}

async function* walkFiles(directory) {
  let handle;
  try {
    handle = await opendir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new Error(`Unable to scan build directory: ${directory}`, {
      cause: error,
    });
  }

  for await (const entry of handle) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(candidate);
      continue;
    }
    if (entry.isFile()) yield candidate;
  }
}

const isCli = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  const buildRoot = path.resolve(process.argv[2] ?? '.next');
  const removed = await removeRetiredVendorSourceMaps(buildRoot);
  console.log(`Build source map sanitizer removed ${removed.length} retired map(s).`);
}

import { copyFile, lstat, mkdir, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { traceStandaloneRuntime } from './standalone-runtime-dependencies.mjs';

function within(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export async function copyRuntimeTrace(sourceModules, artifactModules, files) {
  const source = await realpath(sourceModules);
  const artifact = await realpath(artifactModules);
  async function ensureParent(file) {
    if (!within(artifact, file)) throw new Error('SDK artifact path escaped its node_modules.');
    let ancestor = path.dirname(file);
    for (;;) {
      try {
        if (!within(artifact, await realpath(ancestor))) throw new Error('SDK artifact parent resolves outside node_modules.');
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        ancestor = path.dirname(ancestor);
      }
    }
    await mkdir(path.dirname(file), { recursive: true });
  }
  const regular = [];
  const links = [];
  for (const file of files) {
    const normalized = path.posix.normalize(file.replaceAll('\\', '/'));
    if (!normalized.startsWith('node_modules/')) throw new Error('Trace includes a file outside node_modules.');
    const suffix = normalized.slice('node_modules/'.length);
    const sourceFile = path.join(source, suffix);
    const resolved = await realpath(sourceFile);
    if (!within(source, resolved)) throw new Error('SDK source resolves outside node_modules.');
    const destination = path.join(artifact, path.relative(source, resolved));
    const info = await lstat(sourceFile);
    if (info.isSymbolicLink()) links.push({ file: path.join(artifact, suffix), destination, directory: (await lstat(resolved)).isDirectory() });
    else if (info.isFile()) regular.push({ sourceFile: resolved, destination, alias: path.join(artifact, suffix) });
  }
  const copied = new Set();
  async function copy(file, target) {
    await ensureParent(target);
    const parent = await realpath(path.dirname(target));
    const canonical = path.join(parent, path.basename(target));
    if (copied.has(canonical)) return;
    try { if ((await lstat(target)).isSymbolicLink()) throw new Error('Unexpected SDK file link in the artifact.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await copyFile(file, target);
    copied.add(canonical);
  }
  // Copy physical package files before creating aliases. On Windows, Next can
  // create file-kind directory links that break mkdir during its own copying.
  for (const file of regular) await copy(file.sourceFile, file.destination);
  for (const link of links) {
    await ensureParent(link.file);
    try {
      await lstat(link.file);
      if (!within(artifact, await realpath(link.file))) throw new Error('SDK alias resolves outside the artifact.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await symlink(path.relative(path.dirname(link.file), link.destination), link.file, link.directory ? 'dir' : 'file');
    }
  }
  // Next may have materialized an alias as a real directory. Supplement those
  // as well, without replacing or recursively deleting any package directory.
  for (const file of regular) await copy(file.sourceFile, file.alias);
  return { copied: copied.size };
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  if (process.env.STATIC_EXPORT === 'true') console.log('Standalone SDK runtime: static export, skipped.');
  else {
    const project = path.resolve(path.dirname(scriptPath), '..');
    const artifact = await realpath(path.join(project, '.next', 'standalone'));
    if (!within(await realpath(project), artifact)) throw new Error('Standalone output escaped the workspace.');
    const artifactModules = await realpath(path.join(artifact, 'node_modules'));
    if (!within(artifact, artifactModules)) throw new Error('Standalone node_modules resolves outside the release artifact.');
    const result = await copyRuntimeTrace(path.join(project, 'node_modules'), artifactModules, await traceStandaloneRuntime(project));
    console.log(`Standalone native SDK closure: copied=${result.copied}.`);
  }
}

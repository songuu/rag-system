import { lstat, readdir, readlink, realpath, rm, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export async function cleanStandaloneOutput(workspaceDirectory) {
  const workspace = await realpath(workspaceDirectory);
  const artifact = path.join(workspace, '.next', 'standalone');
  try {
    const info = await lstat(artifact);
    if (info.isSymbolicLink() || !within(workspace, await realpath(artifact))) throw new Error('Standalone output is outside the workspace or is a link.');
    await rm(artifact, { recursive: true, force: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function normalizeStandaloneLinks(directory, { sourceNodeModules } = {}) {
  const root = await realpath(directory);
  const sourceModules = sourceNodeModules ? await realpath(sourceNodeModules) : undefined;
  const repairs = [];
  let inspected = 0;
  async function inspect(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (!within(root, file)) throw new Error('Link path is outside the standalone artifact.');
      if (entry.isSymbolicLink()) {
        inspected++;
        const originalTarget = await readlink(file);
        let target = originalTarget;
        let destination = path.resolve(folder, target);
        if (!within(root, destination)) {
          if (!sourceModules || !within(sourceModules, destination)) {
            throw new Error(`Link target is outside the standalone artifact: ${file}`);
          }
          destination = path.join(root, 'node_modules', path.relative(sourceModules, destination));
          if (!within(root, destination)) throw new Error('Unsafe rebased package link.');
          target = path.relative(folder, destination);
        }
        const targetInfo = await lstat(destination);
        if (target !== originalTarget) {
          repairs.push({ file, target, originalTarget, directory: targetInfo.isDirectory() });
          continue;
        }
        if (process.platform === 'win32' && targetInfo.isDirectory()) {
          try { await realpath(file); }
          catch (error) {
            if (error.code !== 'EPERM') throw error;
            repairs.push({ file, target, originalTarget, directory: true });
          }
        }
      } else if (entry.isDirectory()) await inspect(file);
    }
  }
  // Validate every target before changing any link. Never traverse a package
  // link or delete its directory: only the broken link itself is replaced.
  await inspect(root);
  for (const { file, target, originalTarget, directory: isDirectory } of repairs) {
    await unlink(file);
    try { await symlink(target, file, isDirectory ? 'dir' : 'file'); }
    catch (error) {
      await symlink(originalTarget, file, 'file');
      throw new Error(`Unable to repair standalone directory link: ${file}`, { cause: error });
    }
  }
  return { inspected, repaired: repairs.length };
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const workspace = path.resolve(path.dirname(scriptPath), '..');
  const artifact = path.join(workspace, '.next', 'standalone');
  if (!within(workspace, artifact)) throw new Error('Standalone output is outside the workspace.');
  if (process.argv.includes('--clean')) {
    await cleanStandaloneOutput(workspace);
    console.log('Retired standalone output removed before rebuilding.');
  } else if (process.platform !== 'win32' || process.env.STATIC_EXPORT === 'true') {
    console.log('Standalone Windows link normalization: not applicable.');
  } else {
    if (!within(await realpath(workspace), await realpath(artifact))) throw new Error('Standalone artifact resolves outside the workspace.');
    const result = await normalizeStandaloneLinks(artifact, { sourceNodeModules: path.join(workspace, 'node_modules') });
    console.log(`Standalone Windows links: inspected=${result.inspected}, repaired=${result.repaired}.`);
  }
}

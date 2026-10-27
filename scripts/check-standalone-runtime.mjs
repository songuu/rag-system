import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { standaloneRuntimeDependencies, standaloneEsmRuntimeDependencies, resolveStandaloneEsmEntry } from './standalone-runtime-dependencies.mjs';

if (process.env.STATIC_EXPORT === 'true') {
  console.log('Standalone runtime check skipped for static export.');
} else {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const artifact = realpathSync(path.join(projectRoot, '.next', 'standalone'));
  const requireArtifact = createRequire(path.join(artifact, 'package.json'));
  const initialCache = new Set(Object.keys(requireArtifact.cache));
  const withinArtifact = file => {
    const relative = path.relative(artifact, realpathSync(file));
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  // Require the same public CJS entry points as the compiled routes. Checking
  // workspace imports would hide missing SDK distributions and native DLLs.
  for (const dependency of standaloneRuntimeDependencies) {
    try {
      if (!withinArtifact(requireArtifact.resolve(dependency))) throw new Error('Resolved outside the release artifact.');
      requireArtifact(dependency);
    }
    catch (error) { throw new Error(`Standalone runtime dependency is incomplete: ${dependency}`, { cause: error }); }
  }
  for (const dependency of standaloneEsmRuntimeDependencies) {
    try {
      const entry = resolveStandaloneEsmEntry(requireArtifact, dependency);
      if (!withinArtifact(entry)) throw new Error('Resolved outside the release artifact.');
      await import(pathToFileURL(entry).href);
    }
    catch (error) { throw new Error(`Standalone ESM runtime dependency is incomplete: ${dependency}`, { cause: error }); }
  }
  for (const loadedFile of Object.keys(requireArtifact.cache)) {
    if (!initialCache.has(loadedFile) && !withinArtifact(loadedFile)) {
      throw new Error(`Standalone runtime fell back to a workspace dependency: ${loadedFile}`);
    }
  }
  console.log('Standalone runtime dependencies loaded from the release artifact.');
}

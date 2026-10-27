import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';
import { performance } from 'node:perf_hooks';

const entry = fileURLToPath(new URL('./production-publication-artifact.ts', import.meta.url));
const manifestEntry = fileURLToPath(new URL('./production-manifest-publication-artifact.ts', import.meta.url));
const nativeRequire = createRequire(import.meta.url);
const nativeMonotonicNow = performance.now.bind(performance);
let compiled, compiledManifest;

export function createPublicationDeadlineSubject() {
  // Keep the real writer/reader/bounded code and its private error ownership in
  // one closure. A new realm would reject otherwise valid native Promises.
  compiled ??= buildSync({ entryPoints: [entry], bundle: true, platform: 'node',
    format: 'cjs', target: 'node22', write: false }).outputFiles[0].text;
  return createControlledSubject(compiled, entry);
}

export function createManifestPublicationDeadlineSubject() {
  // Re-export the exact private writer error from the same bundle as its actual
  // manifest owner. No duck-typed error or injected producer replaces the path.
  compiledManifest ??= buildSync({ stdin: {
    contents: "export * from './production-manifest-publication-artifact.ts'; export { PublicationArtifactError } from './production-publication-artifact.ts';",
    resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'manifest-publication-deadline.test-entry.mjs',
  }, bundle: true, platform: 'node', format: 'cjs', target: 'node22', write: false }).outputFiles[0].text;
  return createControlledSubject(compiledManifest, manifestEntry);
}

function createControlledSubject(source, filename) {
  let elapsed = 0, nativeStartedAt = null;
  const now = () => elapsed + (nativeStartedAt === null ? 0 : nativeMonotonicNow() - nativeStartedAt);
  const privatePerformance = Object.freeze({ performance: Object.freeze({ now }) });
  const compiledModule = { exports: {} };
  const requireForFixture = name => {
    if (name === 'node:perf_hooks') return privatePerformance;
    if (name === 'node:crypto' || name === 'node:util') return nativeRequire(name);
    throw new Error('Unexpected publication deadline fixture dependency');
  };
  // Native timers/microtasks remain untouched. Only this instance's monotonic
  // clock is controlled; the separate real CPU-overrun test uses native imports.
  compileFunction(source, ['module', 'exports', 'require'], { filename })(compiledModule, compiledModule.exports, requireForFixture);
  return Object.freeze({ subject: compiledModule.exports, elapsedMilliseconds: now,
    advanceTo(milliseconds) {
      if (nativeStartedAt !== null || !Number.isSafeInteger(milliseconds) || milliseconds < elapsed) throw new TypeError('Invalid fixture elapsed time');
      elapsed = milliseconds;
    },
    followNativeElapsed() {
      // Late-phase CPU tests need real elapsed time AFTER proven dispatch,
      // without asserting that all controlled preparation fits a real 20ms.
      if (nativeStartedAt !== null) throw new TypeError('Fixture already follows native elapsed time');
      nativeStartedAt = nativeMonotonicNow();
    } });
}

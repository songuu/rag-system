import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { traceStandaloneRuntime, resolveStandaloneEsmEntry } from './standalone-runtime-dependencies.mjs';
import { copyRuntimeTrace } from './ensure-standalone-sdk-runtime.mjs';
import { makeMobi } from '../src/lib/ebook-fixtures.test-support.mjs';

test('native SDK tracing includes CommonJS dependency closure without project sources', async () => {
  const files = await traceStandaloneRuntime(process.cwd());
  assert.ok(files.some(file => file.endsWith('/core/dist/language_models/chat_models.cjs')));
  assert.ok(files.some(file => file.includes('@cfworker/json-schema/dist/commonjs/index.js')));
  assert.ok(files.some(file => file.endsWith('/langsmith/run_trees.cjs')));
  assert.ok(files.some(file => file.endsWith('/zod/v4/core/index.cjs')));
  assert.ok(files.every(file => file.startsWith('node_modules/')));
  assert.ok(files.includes('node_modules/langchain/package.json'));
  assert.ok(files.some(file => file.endsWith('/mobi-parser/dist/index.node.mjs')));
  assert.ok(files.some(file => file.endsWith('/shared/dist/index.js')));
});

test('tracing normalizes platform paths and excludes files outside SDK installations', async () => {
  const files = await traceStandaloneRuntime(process.cwd(), async (_entries, options) => {
    assert.equal(options.base, process.cwd());
    return { fileList: new Set(['node_modules\\fixture\\index.cjs', 'src/lib/private.ts', '../secret', 'node_modules/../../secret']), warnings: new Set() };
  });
  assert.ok(files.includes('node_modules/fixture/index.cjs'));
  assert.ok(files.every(file => file.startsWith('node_modules/')));
  assert.ok(!files.some(file => file.includes('secret') || file.startsWith('src/')));
});

test('MOBI ESM dependency closure loads and parses in an isolated release artifact', async () => {
  const requireProject = createRequire(path.join(process.cwd(), 'package.json'));
  const trace = requireProject('next/dist/compiled/@vercel/nft').nodeFileTrace;
  const { fileList } = await trace([
    requireProject.resolve('@lingo-reader/mobi-parser'),
    resolveStandaloneEsmEntry(requireProject, '@lingo-reader/mobi-parser'),
  ], {
    base: process.cwd(), processCwd: process.cwd(), conditions: ['node', 'import', 'default'],
  });
  const fixture = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ebook-artifact-')));
  try {
    await mkdir(path.join(fixture, 'node_modules'));
    await writeFile(path.join(fixture, 'package.json'), '{}');
    await copyRuntimeTrace(path.join(process.cwd(), 'node_modules'), path.join(fixture, 'node_modules'),
      [...fileList, 'node_modules/@lingo-reader/mobi-parser']);
    const requireArtifact = createRequire(path.join(fixture, 'package.json'));
    const entry = resolveStandaloneEsmEntry(requireArtifact, '@lingo-reader/mobi-parser');
    assert.ok(entry.startsWith(fixture + path.sep));
    const { transform } = await import('esbuild');
    const source = await readFile(new URL('../src/lib/mobi-parser-runtime.ts', import.meta.url), 'utf8');
    for (const format of ['cjs', 'esm']) {
      const compiled = await transform(source, { loader: 'ts', format });
      const helper = path.join(fixture, `mobi-runtime.${format === 'cjs' ? 'cjs' : 'mjs'}`);
      await writeFile(helper, compiled.code);
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
        const runtime = await import(process.argv[1]);
        const resolve = runtime.resolveMobiParserPath ?? runtime.default.resolveMobiParserPath;
        console.log(JSON.stringify({ entry: resolve() }));
      `, pathToFileURL(helper).href], { cwd: fixture, windowsHide: true });
      assert.equal(JSON.parse(stdout.trim()).entry, entry, `${format} worker resolver must stay in the release artifact`);
    }
    const { initMobiFile } = await import(pathToFileURL(entry).href);
    const book = await initMobiFile(new Uint8Array(makeMobi()), os.tmpdir());
    try { assert.match(book.getSpine()[0].text, /中文书籍/); }
    finally { book.destroy(); }
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

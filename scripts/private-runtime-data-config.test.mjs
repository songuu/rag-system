import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import ts from 'typescript';
import eslintConfig from '../eslint.config.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'rag-private-runtime-config-'));
  const owner = randomUUID();
  fs.writeFileSync(path.join(root, '.fixture-owner'), owner, { flag: 'wx' });
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('rag-private-runtime-config-'));
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    assert.equal(path.relative(root, fs.realpathSync(root)), '');
    assert.equal(fs.readFileSync(path.join(root, '.fixture-owner'), 'utf8'), owner);
    fs.rmSync(root, { recursive: true });
  });
  const write = (relative, content) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { flag: 'wx' });
  };
  write('src/public.ts', 'export const unsafe: any = 1;\n');
  write('data/context-sessions/private.ts', 'export const privateValue: any = 2;\n');
  write('data/ingest/private.mjs', 'const = SYNTHETIC_PRIVATE_CONTENT;\n');
  return { root, write };
}

test('canonical ESLint config omits runtime data while retaining source errors', async (t) => {
  const f = fixture(t);
  const lint = new ESLint({ cwd: f.root, overrideConfigFile: true, overrideConfig: eslintConfig });
  const results = await lint.lintFiles('.');
  assert.deepEqual(results.map(result => path.relative(f.root, result.filePath)), [path.join('src', 'public.ts')]);
  assert.ok(results[0].messages.some(message => message.ruleId === '@typescript-eslint/no-explicit-any' && message.severity === 2));
  for (const file of ['data/context-sessions/private.ts', 'data/ingest/private.mjs']) {
    assert.equal(await lint.isPathIgnored(path.join(f.root, file)), true);
  }
});

test('canonical TypeScript config prunes runtime data before enumeration', (t) => {
  const f = fixture(t);
  f.write('next-env.d.ts', '');
  f.write('.next/types/generated.ts', 'export {};\n');
  const configured = ts.readConfigFile(path.join(repositoryRoot, 'tsconfig.json'), ts.sys.readFile);
  assert.equal(configured.error, undefined);
  const privateRoot = path.join(f.root, 'data');
  let privateEnumerationCalls = 0;
  const getEntries = directory => {
    const relative = path.relative(privateRoot, directory);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      privateEnumerationCalls += 1;
      throw new Error('Unexpected private fixture directory enumeration.');
    }
    try {
      const entries = fs.readdirSync(directory, { withFileTypes: true });
      return { files: entries.filter(entry => entry.isFile()).map(entry => entry.name),
        directories: entries.filter(entry => entry.isDirectory()).map(entry => entry.name) };
    } catch (error) {
      if (error.code === 'ENOENT') return { files: [], directories: [] };
      throw error;
    }
  };
  const host = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: (root, extensions, excludes, includes, depth) => ts.matchFiles(
      root, extensions, excludes, includes, ts.sys.useCaseSensitiveFileNames, f.root, depth,
      // Use the compiler's own matcher: a test-only filter must not hide a missing config exclusion.
      getEntries, ts.sys.realpath,
    ),
  };
  const parsed = ts.parseJsonConfigFileContent(configured.config, host, f.root);
  assert.equal(privateEnumerationCalls, 0);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.fileNames.map(file => path.relative(f.root, file)).sort(), [
    path.join('.next', 'types', 'generated.ts'), 'next-env.d.ts', path.join('src', 'public.ts'),
  ].sort());
  assert.equal(parsed.options.strict, true);
  assert.equal(parsed.options.noEmit, true);
  assert.ok(configured.config.exclude.includes('node_modules'));
});

test('canonical ESLint config omits generated workspace scratch bundles without hiding source errors', async (t) => {
  const f = fixture(t);
  f.write('.codex-tmp/generated/worker.cjs', 'module.exports = require("node:fs");\n');
  f.write('.codex-tmp/generated/source.ts', 'export const generated: any = 1;\n');
  const lint = new ESLint({ cwd: f.root, overrideConfigFile: true, overrideConfig: eslintConfig });
  const results = await lint.lintFiles('.');
  assert.deepEqual(results.map(result => path.relative(f.root, result.filePath)), [path.join('src', 'public.ts')]);
  assert.ok(results[0].messages.some(message => message.ruleId === '@typescript-eslint/no-explicit-any' && message.severity === 2));
  for (const file of ['.codex-tmp/generated/worker.cjs', '.codex-tmp/generated/source.ts']) {
    assert.equal(await lint.isPathIgnored(path.join(f.root, file)), true);
  }
});

test('canonical TypeScript config prunes generated scratch before enumeration and keeps maintained sources', (t) => {
  const f = fixture(t);
  f.write('scripts/maintained.ts', 'export const maintained = true;\n');
  f.write('next-env.d.ts', '');
  f.write('.next/types/generated.ts', 'export {};\n');
  f.write('.codex-tmp/generated/source.ts', 'export const generated: any = 1;\n');
  const configured = ts.readConfigFile(path.join(repositoryRoot, 'tsconfig.json'), ts.sys.readFile);
  assert.equal(configured.error, undefined);
  const privateRoots = ['data', '.codex-tmp'].map(directory => path.join(f.root, directory));
  let privateEnumerationCalls = 0;
  const getEntries = directory => {
    for (const privateRoot of privateRoots) {
      const relative = path.relative(privateRoot, directory);
      if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        privateEnumerationCalls++;
        throw new Error('Unexpected private fixture directory enumeration.');
      }
    }
    try {
      const entries = fs.readdirSync(directory, { withFileTypes: true });
      return { files: entries.filter(entry => entry.isFile()).map(entry => entry.name),
        directories: entries.filter(entry => entry.isDirectory()).map(entry => entry.name) };
    } catch (error) {
      if (error.code === 'ENOENT') return { files: [], directories: [] };
      throw error;
    }
  };
  const parsed = ts.parseJsonConfigFileContent(configured.config, {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: ts.sys.fileExists, readFile: ts.sys.readFile,
    readDirectory: (root, extensions, excludes, includes, depth) => ts.matchFiles(
      root, extensions, excludes, includes, ts.sys.useCaseSensitiveFileNames, f.root, depth, getEntries, ts.sys.realpath,
    ),
  }, f.root);
  assert.equal(privateEnumerationCalls, 0);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.fileNames.map(file => path.relative(f.root, file)).sort(), [
    path.join('src', 'public.ts'), path.join('scripts', 'maintained.ts'),
    path.join('.next', 'types', 'generated.ts'), 'next-env.d.ts',
  ].sort());
  assert.equal(parsed.options.strict, true);
  assert.equal(parsed.options.noEmit, true);
  assert.ok(configured.config.exclude.includes('node_modules'));
});

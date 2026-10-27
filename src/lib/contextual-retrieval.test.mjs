import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const sourceUrl = new URL('./contextual-retrieval.ts', import.meta.url).href;
const modelUrl = 'data:text/javascript,export function createLLM(){throw new Error("unexpected model creation")}';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === sourceUrl && specifier === './model-config') {
      return { url: modelUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url !== sourceUrl) return nextLoad(url, context);
    return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText };
  },
});
const { generateContextForChunk, contextualizeChunks } = await import('./contextual-retrieval.ts');

test('contextual generation retains string, text-block and non-text-block handling', async () => {
  for (const [content, expected] of [
    ['  context  ', 'context'],
    [[{ type: 'text', text: ' context ' }, { type: 'image_url', image_url: { url: 'offline' } }, '!'], 'context !'],
  ]) {
    assert.equal(await generateContextForChunk('document', 'chunk', { invoke: async () => ({ content }) }), expected);
  }
});

test('contextual generation truncates only the document and retains the complete chunk', async t => {
  t.mock.method(console, 'log', () => {});
  let prompt;
  const llm = { invoke: async messages => { prompt = messages[0].content; return { content: 'summary' }; } };
  assert.equal(await generateContextForChunk('abcdef', 'complete-chunk', llm, 3), 'summary');
  assert.ok(prompt.includes('<document>\nabc\n</document>'));
  assert.ok(prompt.includes('<chunk>\ncomplete-chunk\n</chunk>'));
});

test('disabled contextual retrieval preserves chunk text and accepts opaque metadata', async t => {
  t.mock.method(console, 'log', () => {});
  const result = await contextualizeChunks({ fullDocument: 'document',
    chunks: [{ text: 'original', metadata: { nested: { count: 2 }, tags: ['local'] } }],
    config: { enabled: false } });
  assert.deepEqual(result, [{ contextualPreamble: '', originalText: 'original', contextualizedText: 'original' }]);
});

test('contextual retrieval keeps ordered results, bounded batches and per-chunk fallback', async t => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let active = 0, maximum = 0, calls = 0;
  const progress = [];
  const result = await contextualizeChunks({ fullDocument: 'document',
    chunks: ['one', 'two', 'three'].map(text => ({ text })),
    config: { enabled: true, cacheEnabled: false, batchConcurrency: 2 },
    onProgress: (current, total) => progress.push([current, total]),
    llm: { invoke: async () => {
      const ordinal = calls++;
      active++; maximum = Math.max(maximum, active);
      await Promise.resolve(); active--;
      if (ordinal === 1) throw new Error('synthetic unavailable');
      return { content: `context-${ordinal}` };
    } },
  });
  assert.equal(maximum, 2);
  assert.equal(calls, 3);
  assert.deepEqual(result.map(row => row.contextualizedText), ['context-0\n\none', 'two', 'context-2\n\nthree']);
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { AIMessage } from '@langchain/core/messages';
import { RunnableLambda } from '@langchain/core/runnables';
import ts from 'typescript';

const sourceUrl = new URL('./conversation-expansion.ts', import.meta.url).href;
const fixtureKey = Symbol.for('conversation-expansion.test.fixture');
const modelFixtureUrl = `data:text/javascript,${encodeURIComponent(`
  export function createLLM(...args) {
    return globalThis[Symbol.for('conversation-expansion.test.fixture')].createLLM(...args);
  }
  export function createEmbedding() {
    return globalThis[Symbol.for('conversation-expansion.test.fixture')].embedding;
  }
  export function getModelFactory() { throw new Error('unused model factory'); }
  export function isOllamaProvider() { throw new Error('unused provider lookup'); }
`)}`;
const entityFixtureUrl = `data:text/javascript,${encodeURIComponent(`
  export class EntityPreprocessor {
    static extractEntitiesByRules() { return []; }
  }
`)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === sourceUrl) {
      if (specifier === './model-config') {
        return { url: modelFixtureUrl, shortCircuit: true };
      }
      if (specifier === './adaptive-entity-rag') {
        return { url: entityFixtureUrl, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url !== sourceUrl) return nextLoad(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText,
    };
  },
});

const { ConversationExpansionEngine } = await import('./conversation-expansion.ts');
const anchor = {
  entities: [{ name: 'Atlas', type: 'product', confidence: 0.9 }],
  attributes: ['price'],
  intentType: 'query',
  stage: 'exploring',
};
const chunks = [{ id: 'chunk-local', content: 'Atlas costs 20 units. Beacon is related.' }];
const defaultStrategies = {
  'drill-down': { unexploredAttributes: ['price'] },
  'lateral-move': { relatedEntities: [{ name: 'Beacon', relation: 'alternative' }] },
  'logical-flow': { logicalExtensions: [{ type: 'suggestion', content: 'compare prices' }] },
};

async function runExpansion(t, options = {}) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const calls = { modelCreations: [], prompts: [], embeddingCalls: 0 };
  const encode = value => typeof value === 'string' ? value : JSON.stringify(value);
  const fixture = {
    embedding: {
      async embedQuery() {
        calls.embeddingCalls += 1;
        throw new Error('unexpected embedding invocation');
      },
      async embedDocuments() {
        calls.embeddingCalls += 1;
        throw new Error('unexpected embedding invocation');
      },
    },
    createLLM(model, settings) {
      const index = calls.modelCreations.length;
      calls.modelCreations.push({ model, settings });
      return RunnableLambda.from(async input => {
        const prompt = typeof input === 'string' ? input : input.toString();
        calls.prompts.push({ index, prompt });
        if (index === 0) {
          if (options.anchorError) throw options.anchorError;
          return new AIMessage(encode(options.anchorOutput ?? anchor));
        }
        if (index === 1) {
          const strategy = prompt.includes('knownAttributes') || prompt.includes('其他属性或细节')
            ? 'drill-down'
            : prompt.includes('可对比的其他实体') ? 'lateral-move' : 'logical-flow';
          const value = (options.strategies ?? defaultStrategies)[strategy];
          if (value instanceof Error) throw value;
          return new AIMessage(encode(value));
        }
        if (options.questionError) throw options.questionError;
        return new AIMessage(encode(options.questionOutput ?? { questions: [' What does Atlas cost? ', '', 42] }));
      });
    },
  };
  globalThis[fixtureKey] = fixture;
  try {
    const engine = new ConversationExpansionEngine({
      enableValidation: options.enableValidation ?? false,
      maxSuggestions: options.maxSuggestions ?? 5,
    });
    const result = await engine.expand('Tell me about Atlas', 'Atlas is available.', chunks);
    assert.equal(calls.modelCreations.length, 3);
    assert.equal(calls.embeddingCalls, 0);
    return { result, calls };
  } finally {
    delete globalThis[fixtureKey];
  }
}

test('valid model outputs retain three strategies, trimmed questions and source IDs', async t => {
  const { result, calls } = await runExpansion(t);
  assert.deepEqual(result.anchor, anchor);
  assert.equal(result.suggestions.length, 3);
  assert.deepEqual(new Set(result.suggestions.map(q => q.strategy)), new Set(Object.keys(defaultStrategies)));
  for (const suggestion of result.suggestions) {
    assert.equal(suggestion.question, 'What does Atlas cost?');
    assert.deepEqual(suggestion.sourceChunkIds, ['chunk-local']);
    assert.equal(suggestion.validated, false);
    assert.equal(suggestion.relevanceScore, 0.8);
  }
  assert.equal(calls.prompts.filter(call => call.index === 2).length, 3);
  assert.ok(calls.prompts.filter(call => call.index === 2).every(call => call.prompt.includes(chunks[0].content)));
});

test('model JSON extraction fallback preserves fenced anchor, strategy and question output', async t => {
  const fence = value => `Model response:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
  const { result } = await runExpansion(t, {
    anchorOutput: fence(anchor),
    strategies: Object.fromEntries(Object.entries(defaultStrategies).map(([key, value]) => [key, fence(value)])),
    questionOutput: fence({ questions: ['Atlas price?'] }),
  });
  assert.deepEqual(result.anchor, anchor);
  assert.equal(result.suggestions.length, 3);
  assert.ok(result.suggestions.every(q => q.question === 'Atlas price?'));
});

test('plain string strategy evidence remains usable for entity and logical hints', async t => {
  const { result, calls } = await runExpansion(t, {
    strategies: {
      'drill-down': { unexploredAttributes: ['price'] },
      'lateral-move': { relatedEntities: ['Beacon'] },
      'logical-flow': { logicalExtensions: ['compare prices'] },
    },
  });
  assert.equal(result.suggestions.length, 3);
  const prompts = calls.prompts.filter(call => call.index === 2).map(call => call.prompt);
  assert.ok(prompts.some(prompt => prompt.includes('Beacon')));
  assert.ok(prompts.some(prompt => prompt.includes('compare prices')));
});

test('malformed anchor fields become typed safe defaults instead of escaping as business objects', async t => {
  const { result, calls } = await runExpansion(t, {
    anchorOutput: {
      entities: [null, 7, { name: 5, type: 'product', confidence: 0.9 },
        { name: 'Bad type', type: 'unknown-type', confidence: 0.8 },
        { name: 'Bad score', type: 'product', confidence: 'high' },
        anchor.entities[0]],
      attributes: [null, 7, 'price'],
      intentType: 'not-an-intent',
      stage: { invalid: true },
    },
  });
  assert.deepEqual(result.anchor, {
    ...anchor,
    intentType: 'query',
    stage: 'initial',
  });
  assert.equal(calls.prompts.filter(call => call.index === 1).length, 3);
});

test('non-array anchor fields cannot break routing and retain the logical fallback', async t => {
  const { result, calls } = await runExpansion(t, {
    anchorOutput: { entities: 'Atlas', attributes: { price: true }, intentType: null, stage: false },
  });
  assert.deepEqual(result.anchor, { entities: [], attributes: [], intentType: 'query', stage: 'initial' });
  assert.equal(calls.prompts.filter(call => call.index === 1).length, 1);
  assert.equal(result.suggestions[0]?.strategy, 'logical-flow');
});

test('malformed strategy fields cannot abort other candidates or stringify model objects as evidence', async t => {
  const { result, calls } = await runExpansion(t, {
    strategies: {
      'drill-down': { unexploredAttributes: { price: true } },
      'lateral-move': { relatedEntities: [null, 7, {}, { name: 'Beacon' }, 'Beacon'] },
      'logical-flow': { logicalExtensions: [null, 7, {}, { content: 'compare prices' }] },
    },
  });
  assert.equal(result.suggestions.length, 3);
  const prompts = calls.prompts.filter(call => call.index === 2).map(call => call.prompt);
  assert.ok(prompts.every(prompt => !prompt.includes('[object Object]')));
  assert.ok(prompts.some(prompt => prompt.includes('compare prices')));
});

test('non-array question output cannot be consumed as individual character questions', async t => {
  const { result } = await runExpansion(t, { questionOutput: { questions: 'Atlas' } });
  assert.deepEqual(result.suggestions, []);
});

test('invalid JSON and model rejection keep the existing empty-result fallbacks', async t => {
  const { result } = await runExpansion(t, {
    anchorError: new Error('synthetic anchor rejection'),
    strategies: { 'logical-flow': 'not JSON' },
  });
  assert.deepEqual(result.anchor, { entities: [], attributes: [], intentType: 'query', stage: 'initial' });
  assert.deepEqual(result.suggestions, []);
});

test('a failing strategy and question generation do not reject the expansion', async t => {
  const { result } = await runExpansion(t, {
    strategies: { ...defaultStrategies, 'lateral-move': new Error('synthetic routing rejection') },
    questionError: new Error('synthetic candidate rejection'),
  });
  assert.deepEqual(result.anchor, anchor);
  assert.deepEqual(result.suggestions, []);
});

test('validation still annotates and limits candidates without invoking embedding services', async t => {
  const { result } = await runExpansion(t, { enableValidation: true, maxSuggestions: 1 });
  assert.equal(result.suggestions.length, 1);
  assert.equal(typeof result.suggestions[0].validationDetails?.hasEvidence, 'boolean');
  assert.equal(typeof result.suggestions[0].validationDetails?.isDuplicate, 'boolean');
});

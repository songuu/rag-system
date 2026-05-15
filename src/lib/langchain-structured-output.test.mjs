import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeImport(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const {
  invokeStructuredJson,
  parseStructuredJson,
  extractModelText,
} = await import('./langchain-structured-output.ts');

test('invokeStructuredJson prefers native structured output when available', async () => {
  const model = {
    withStructuredOutput(schema, config) {
      assert.equal(schema.type, 'object');
      assert.equal(config.name, 'ScorePayload');
      return {
        async invoke(input) {
          assert.equal(input, 'grade this');
          return { parsed: { score: '0.8', reasoning: 'ok' } };
        },
      };
    },
  };

  const result = await invokeStructuredJson({
    model,
    input: 'grade this',
    schema: { name: 'ScorePayload', schema: { type: 'object' } },
    normalize: (value) => ({
      score: Number(value.score),
      reasoning: value.reasoning,
    }),
  });

  assert.equal(result.mode, 'native');
  assert.deepEqual(result.data, { score: 0.8, reasoning: 'ok' });
});

test('invokeStructuredJson falls back to prompt JSON parsing', async () => {
  const model = {
    async invoke(input) {
      assert.equal(input, 'grade this');
      return { content: '```json\n{"score":0.7,"reasoning":"fallback"}\n```' };
    },
  };

  const result = await invokeStructuredJson({
    model,
    input: 'grade this',
    schema: { name: 'ScorePayload', schema: { type: 'object' } },
    normalize: (value) => value,
  });

  assert.equal(result.mode, 'json');
  assert.deepEqual(result.data, { score: 0.7, reasoning: 'fallback' });
});

test('parseStructuredJson extracts the first balanced JSON object', () => {
  const parsed = parseStructuredJson('说明文字 {"text":"keep {braces} inside","ok":true} trailing');

  assert.deepEqual(parsed, {
    text: 'keep {braces} inside',
    ok: true,
  });
});

test('extractModelText supports content block arrays', () => {
  const text = extractModelText({
    content: [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ],
  });

  assert.equal(text, 'first\nsecond');
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

import assert from 'node:assert/strict';
import test from 'node:test';

const { parseMaicJsonResponse } = await import('./json-response.ts');

test('parses an exact JSON response without rewriting literal reasoning tags', () => {
  assert.deepEqual(
    parseMaicJsonResponse('{"message":"literal </think> text","ok":true}'),
    { message: 'literal </think> text', ok: true }
  );
});

test('keeps a literal reasoning tag inside prose-wrapped JSON strings', () => {
  assert.deepEqual(
    parseMaicJsonResponse(
      'Result: {"message":"literal </think> text","nested":{"ok":true}} trailing'
    ),
    { message: 'literal </think> text', nested: { ok: true } }
  );
});

test('parses JSON from a fenced response', () => {
  assert.deepEqual(
    parseMaicJsonResponse('```json\n[{"type":"ShowFile","value":{"slide_index":0}}]\n```'),
    [{ type: 'ShowFile', value: { slide_index: 0 } }]
  );
});

test('prefers the final payload after the last reasoning closing tag', () => {
  const response = [
    '<think>I might return this draft: {"answer":"draft"}</think>',
    '<reasoning>One more draft: ```json\n{"answer":"still-draft"}\n```</reasoning>',
    '{"answer":"final"}',
  ].join('\n');

  assert.deepEqual(parseMaicJsonResponse(response), { answer: 'final' });
});

test('accepts an unpaired reasoning closing tag before the final payload', () => {
  assert.deepEqual(
    parseMaicJsonResponse('discarded analysis </thinking> {"answer":"final"}'),
    { answer: 'final' }
  );
});

test('extracts balanced JSON while respecting strings, escapes, and nested containers', () => {
  const response =
    'Result: {"text":"brace } and escaped quote \\\" stay in the string","nested":{"items":[1,{"ok":true}]}} trailing';

  assert.deepEqual(parseMaicJsonResponse(response), {
    text: 'brace } and escaped quote " stay in the string',
    nested: { items: [1, { ok: true }] },
  });
});

test('continues past an invalid balanced candidate to a later valid payload', () => {
  assert.deepEqual(
    parseMaicJsonResponse('draft {not-json} final [{"answer":"usable"}]'),
    [{ answer: 'usable' }]
  );
});

test('returns null when no valid JSON payload exists', () => {
  assert.equal(parseMaicJsonResponse('No structured payload was generated.'), null);
});

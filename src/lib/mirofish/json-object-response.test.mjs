import assert from 'node:assert/strict';
import test from 'node:test';

const {
  MiroFishJsonObjectResponseError,
  parseMiroFishJsonObjectResponse,
} = await import('./json-object-response.ts');

const ERROR_CODE = 'MIROFISH_JSON_OBJECT_RESPONSE_INVALID';
const ERROR_MESSAGE = 'Invalid MiroFish JSON object response.';

test('parses one exact top-level plain object without corrupting JSON string syntax', () => {
  const value = parseMiroFishJsonObjectResponse(String.raw`{
    "text": "literal braces { and }, escaped quote \" and slash \\",
    "reasoningTag": "keep </think> inside the string",
    "nested": {"items": [1, {"closing": "}"}]}
  }`);

  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.deepEqual(value, {
    text: 'literal braces { and }, escaped quote " and slash \\',
    reasoningTag: 'keep </think> inside the string',
    nested: { items: [1, { closing: '}' }] },
  });
});

test('parses a single complete markdown json fence', () => {
  assert.deepEqual(
    parseMiroFishJsonObjectResponse('```json\r\n{"status":"ok"}\r\n```'),
    { status: 'ok' },
  );
});

test('parses the final object after a supported reasoning wrapper', () => {
  for (const tag of ['think', 'thinking', 'reasoning']) {
    const response = [
      `<${tag}>A draft may mention {"discard":true} and an array [1, 2].</${tag}>`,
      '{"final":true,"text":"escaped \\\" brace }"}',
    ].join('\n');

    assert.deepEqual(parseMiroFishJsonObjectResponse(response), {
      final: true,
      text: 'escaped " brace }',
    });
  }
});

test('rejects top-level arrays, null, and primitive JSON values', () => {
  for (const response of [
    '[]',
    '[{"nested":"object"}]',
    'null',
    'true',
    '42',
    '"text"',
    '```json\n[1, 2]\n```',
    '<think>draft</think>\nnull',
  ]) {
    assertInvalidResponse(response);
  }
});

test('rejects multiple JSON containers even when separated by explanation', () => {
  for (const response of [
    '{"first":1}{"second":2}',
    '{"first":1}\nExplanation between results.\n{"second":2}',
    '{"first":1}\nExplanation between results.\n[2]',
    '```json\n{"first":1}\n```\n```json\n{"second":2}\n```',
    '```json\n{"first":1}\n```\n{"second":2}',
  ]) {
    assertInvalidResponse(response);
  }
});

test('rejects truncated, empty, object-free, and malformed wrapper responses', () => {
  for (const response of [
    '',
    '   \r\n\t',
    'No JSON object was produced.',
    '{"outer":{"inner":1}',
    '{"value":"unterminated}',
    '<think>unfinished reasoning\n{"final":true}',
    '<think>reasoning only</think>',
    '<think>draft</think>\n{"final":true} trailing text',
  ]) {
    assertInvalidResponse(response);
  }
});

test('rejects non-string runtime inputs as non-plain responses', () => {
  for (const response of [undefined, null, {}, [], new String('{"boxed":true}')]) {
    assertInvalidResponse(response);
  }
});

test('uses one stable redacted error without retaining the input or parse cause', () => {
  const secret = 'TOP-SECRET-JSON-RESPONSE-811';
  const failures = [
    `{\"secret\":\"${secret}\"`,
    `{\"first\":1} ${secret} {\"second\":2}`,
    `<think>${secret}</think>\n[]`,
  ].map(captureInvalidResponse);

  for (const error of failures) {
    assert.ok(error instanceof MiroFishJsonObjectResponseError);
    assert.equal(error.name, 'MiroFishJsonObjectResponseError');
    assert.equal(error.code, ERROR_CODE);
    assert.equal(error.message, ERROR_MESSAGE);
    assert.equal(error.cause, undefined);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.doesNotMatch(String(error), new RegExp(secret));
    assert.doesNotMatch(error.stack ?? '', new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
  }

  assert.equal(new Set(failures.map(error => error.code)).size, 1);
  assert.equal(new Set(failures.map(error => error.message)).size, 1);
});

function assertInvalidResponse(response) {
  assert.throws(
    () => parseMiroFishJsonObjectResponse(response),
    error => {
      assert.ok(error instanceof MiroFishJsonObjectResponseError);
      assert.equal(error.code, ERROR_CODE);
      assert.equal(error.message, ERROR_MESSAGE);
      return true;
    },
  );
}

function captureInvalidResponse(response) {
  try {
    parseMiroFishJsonObjectResponse(response);
  } catch (error) {
    return error;
  }

  assert.fail('Expected parser to reject the response.');
}

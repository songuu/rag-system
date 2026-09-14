import assert from 'node:assert/strict';
import test from 'node:test';

const {
  parseScopedAgentDecision,
  buildScopedDecisionSystemPrompt,
  ScopedAgentDecisionError,
  SCOPED_AGENT_DECISION_SCHEMA,
} = await import('./scoped-agent-decision.ts');

test('structured decision accepts escaped JSON text and arbitrary property order', () => {
  const answer = 'Quotation: "a,b". Path: C:\\docs\\file.\nSecond line.';
  const parsed = parseScopedAgentDecision(JSON.stringify({ answer, evidenceNumbers: [2, 1], query: '', action: 'answer' }));
  assert.deepEqual(parsed, { action: 'answer', query: '', answer, evidenceNumbers: [2, 1] });
});

test('structured decision accepts one provider text block and normalizes active whitespace', () => {
  assert.deepEqual(parseScopedAgentDecision([
    { type: 'text', text: '{"action":"search","query":"  missing fact  ","answer":"","evidenceNumbers":[]}' },
  ]), { action: 'search', query: 'missing fact', answer: '', evidenceNumbers: [] });
});

test('structured decision accepts explicit abstention with no selected sources', () => {
  assert.deepEqual(parseScopedAgentDecision('{"action":"abstain","query":"","answer":"missing","evidenceNumbers":[]}'),
    { action: 'abstain', query: '', answer: 'missing', evidenceNumbers: [] });
});

test('structured decision permits exactly forty unique safe source numbers', () => {
  const evidenceNumbers = Array.from({ length: 40 }, (_, index) => index + 1);
  assert.deepEqual(parseScopedAgentDecision(JSON.stringify({ action: 'answer', query: '', answer: 'fact', evidenceNumbers })).evidenceNumbers, evidenceNumbers);
});

for (const [name, content] of [
  ['multiple text blocks', [
    { type: 'text', text: '{"action":"search",' },
    { type: 'text', text: '"query":"missing","answer":"","evidenceNumbers":[]}' },
  ]],
  ['non-text block', [{ type: 'tool_use', name: 'private-tool', input: {} }]],
  ['trailing content', '{"action":"answer","query":"","answer":"fact","evidenceNumbers":[1]} extra'],
  ['oversized encoded output', ' '.repeat(65_537)],
  ['escaped duplicate key', '{"action":"search","query":"secret","answer":"","evidenceNumbers":[],"\\u0061ction":"answer"}'],
  ['duplicate source key', '{"action":"answer","query":"","answer":"fact","evidenceNumbers":[1],"evidenceNumbers":[2]}'],
  ['missing source key', '{"action":"answer","query":"","answer":"fact"}'],
  ['empty answer sources', '{"action":"answer","query":"","answer":"fact","evidenceNumbers":[]}'],
  ['search sources', '{"action":"search","query":"fact","answer":"","evidenceNumbers":[1]}'],
  ['duplicate source numbers', '{"action":"answer","query":"","answer":"fact","evidenceNumbers":[1,1]}'],
  ['zero source number', '{"action":"answer","query":"","answer":"fact","evidenceNumbers":[0]}'],
  ['negative source number', '{"action":"answer","query":"","answer":"fact","evidenceNumbers":[-1]}'],
  ['fractional source number', '{"action":"answer","query":"","answer":"fact","evidenceNumbers":[1.5]}'],
  ['unsafe source number', '{"action":"answer","query":"","answer":"fact","evidenceNumbers":[9007199254740992]}'],
  ['string source number', '{"action":"answer","query":"","answer":"fact","evidenceNumbers":["1"]}'],
  ['object source numbers', '{"action":"answer","query":"","answer":"fact","evidenceNumbers":{}}'],
  ['too many source numbers', JSON.stringify({ action: 'answer', query: '', answer: 'fact', evidenceNumbers: Array.from({ length: 41 }, (_, index) => index + 1) })],
  ['non-empty unused answer', '{"action":"search","query":"fact","answer":" ","evidenceNumbers":[]}'],
  ['non-empty unused query', '{"action":"abstain","query":" ","answer":"missing","evidenceNumbers":[]}'],
  ['object prototype key', '{"action":"answer","query":"","answer":"fact","evidenceNumbers":[1],"__proto__":{}}'],
  ['null', 'null'],
  ['array', '["answer","","fact",[1]]'],
  ['number', '3'],
]) {
  test('structured decision rejects ' + name + ' with a static error', () => {
    assert.throws(() => parseScopedAgentDecision(content), error => {
      assert(error instanceof ScopedAgentDecisionError);
      assert.equal(error.message, 'Scoped retrieval agent returned an invalid structured decision.');
      assert.equal(error.cause, undefined);
      return true;
    });
  });
}

test('structured schema has three strict action branches and is deeply immutable', () => {
  function assertDeeplyFrozen(value) {
    if (!value || typeof value !== 'object') return;
    assert(Object.isFrozen(value));
    for (const child of Object.values(value)) assertDeeplyFrozen(child);
  }
  assertDeeplyFrozen(SCOPED_AGENT_DECISION_SCHEMA);
  assert.equal(SCOPED_AGENT_DECISION_SCHEMA.oneOf.length, 3);
  const branches = Object.fromEntries(SCOPED_AGENT_DECISION_SCHEMA.oneOf.map(branch => {
    assert.equal(branch.type, 'object');
    assert.equal(branch.additionalProperties, false);
    assert.deepEqual(branch.required, ['action', 'query', 'answer', 'evidenceNumbers']);
    assert.deepEqual(Object.keys(branch.properties), branch.required);
    return [branch.properties.action.const, branch.properties];
  }));
  assert.deepEqual(Object.keys(branches).sort(), ['abstain', 'answer', 'search']);
  assert.deepEqual(branches.search.query, { type: 'string', minLength: 1, maxLength: 1024 });
  assert.equal(branches.search.answer.const, '');
  assert.deepEqual(branches.search.evidenceNumbers.const, []);
  for (const action of ['answer', 'abstain']) {
    assert.equal(branches[action].query.const, '');
    assert.equal(branches[action].answer.minLength, 1);
    assert.equal(branches[action].answer.maxLength, 16_000);
    assert.equal(branches[action].evidenceNumbers.minItems, action === 'answer' ? 1 : 0);
    assert.equal(branches[action].evidenceNumbers.maxItems, 40);
    assert.equal(branches[action].evidenceNumbers.uniqueItems, true);
    assert.deepEqual(branches[action].evidenceNumbers.items, {
      type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
    });
  }
});

test('structured decision rules require explicit relationship and fact sources without automatic citations', () => {
  const prompt = buildScopedDecisionSystemPrompt({ searchesRemaining: 0, stopReason: 'no_gain' });
  assert.match(prompt, /Search is unavailable/);
  assert.match(prompt, /Searches remaining: 0/);
  assert.match(prompt, /both the evidence establishing that relationship/);
  assert.match(prompt, /evidenceNumbers/);
  assert.match(prompt, /without inline/);
  assert.match(prompt, /Answer only the facts requested/);
  assert.match(prompt, /visible version or status/);
  assert.match(prompt, /archived/);
  assert.match(prompt, /untrusted data/);
});


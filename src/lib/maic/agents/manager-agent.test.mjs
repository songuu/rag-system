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

const { parseManagerDecision, summarizeManagerHistory } = await import('./manager-agent.ts');

test('parseManagerDecision uses the final payload after reasoning and rejects invalid output', () => {
  const decision = parseManagerDecision(
    [
      '<think>{"next_agent":"clown","action":{"type":"Idle","value":{}},"reason":"draft"}</think>',
      '```json',
      '{"next_agent":"teacher","action":{"type":"Idle","value":{}},"reason":"final"}',
      '```',
    ].join('\n')
  );

  assert.deepEqual(decision, {
    next_agent: 'teacher',
    action: { type: 'Idle', value: {} },
    reason: 'final',
  });
  assert.equal(parseManagerDecision('not valid JSON'), null);
  assert.equal(parseManagerDecision('{"next_agent":"teacher"}'), null);
});

test('summarizeManagerHistory labels human students and agents separately (OpenMAIC e5148be)', () => {
  const history = summarizeManagerHistory([
    utterance('teacher', '李老师', '今天我们学习轴对称。'),
    utterance('student', '我', '[我]: 但三维建筑真的能叫轴对称吗?'),
    utterance('thinker', '思考者', '这需要区分二维轮廓和三维旋转对称。'),
  ]);

  assert.match(history, /\[Agent:teacher\] 今天我们学习轴对称。/);
  assert.match(history, /\[Student \(Human\)\] 但三维建筑真的能叫轴对称吗\?/);
  assert.match(history, /\[Agent:thinker\] 这需要区分二维轮廓和三维旋转对称。/);
  assert.doesNotMatch(history, /\[我\]:/);
});

test('summarizeManagerHistory truncates long turns and uses an explicit empty sentinel', () => {
  assert.equal(summarizeManagerHistory([]), '(课堂刚开始)');

  const history = summarizeManagerHistory(
    [utterance('student', '我', 'A'.repeat(260))],
    8,
    40
  );
  assert.match(history, /\[Student \(Human\)\] A{40}\.\.\./);
  assert.doesNotMatch(history, /A{41}/);
});

function utterance(speaker, speakerName, content) {
  return {
    id: `utt_${speaker}_${content.length}`,
    speaker,
    speaker_name: speakerName,
    content,
    timestamp: '2026-06-01T00:00:00.000Z',
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

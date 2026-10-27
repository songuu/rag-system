import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import * as diagnostic from './durable-response-diagnostic.test-support.mjs';

const boundedTag = 'durable-bounded-replay-first-post/v1';
const marker = diagnostic.DURABLE_FIRST_POST_DIAGNOSTIC_MARKER;
const privateValue = 'RAW_PRIVATE_BOUNDED_RESPONSE';
function format(input) {
  assert.equal(typeof diagnostic.formatDurableBoundedFirstPostDiagnostic, 'function');
  return diagnostic.formatDurableBoundedFirstPostDiagnostic(input);
}
const empty = {
  caseTag: boundedTag, site: 'first-post-status', status: 'unknown', bodyCode: 'unknown',
  durableStatus: 'unknown', durableReplay: 'unknown', milvusConnect: 'unknown', milvusSearch: 'unknown',
  modelEmbed: 'unknown', modelGenerate: 'unknown', scopedAgentCalls: 'unknown',
};

test('bounded first POST diagnostics have an owner-fixed tag and preserve only closed response facts', () => {
  const message = format({ caseTag: privateValue, status: 500,
    body: { code: 'DURABLE_ASK_INTERNAL_ERROR', message: privateValue, error: privateValue,
      durable: { status: 'failed', replay: false, details: privateValue } },
    milvusSignals: { connect: 1, search: 2, request: privateValue },
    modelSignals: { embed: 2, generate: 0, prompt: privateValue }, scopedAgentCalls: 1 });
  const expected = { ...empty, status: 500, bodyCode: 'DURABLE_ASK_INTERNAL_ERROR', durableStatus: 'failed', durableReplay: false,
    milvusConnect: 1, milvusSearch: 2, modelEmbed: 2, modelGenerate: 0, scopedAgentCalls: 1 };
  assert.deepEqual(JSON.parse(message.slice(marker.length)), expected);
  assert.deepEqual(diagnostic.parseDurableFirstPostDiagnosticMessage(message), expected);
  assert.equal(message.includes(privateValue), false);
  const legacy = diagnostic.formatDurableFirstPostDiagnostic({ caseTag: boundedTag });
  assert.equal(JSON.parse(legacy.slice(marker.length)).caseTag, 'durable-agentic-replay-first-post/v1');
});

test('bounded first POST diagnostics do not invoke getters proxy traps or coercion hooks', () => {
  let hooks = 0;
  const trap = () => { hooks++; throw Error(privateValue); };
  const root = Object.fromEntries(['status', 'body', 'milvusSignals', 'modelSignals', 'scopedAgentCalls']
    .map(key => [key, undefined]));
  for (const key of Object.keys(root)) Object.defineProperty(root, key, { enumerable: true, get: trap });
  const proxy = new Proxy({}, { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const nested = { toString: trap, valueOf: trap, toJSON: trap };
  for (const input of [root, proxy, revoked.proxy,
    { status: nested, body: proxy, milvusSignals: proxy, modelSignals: proxy, scopedAgentCalls: nested },
    { body: { code: nested, durable: { status: nested, replay: nested } } }]) {
    assert.deepEqual(JSON.parse(format(input).slice(marker.length)), empty);
  }
  assert.equal(hooks, 0);
});

test('bounded first POST parser rejects alternate tags duplicate extra or noncanonical fields', () => {
  const message = format({});
  const candidates = [
    message.replace(boundedTag, privateValue),
    message.replace('"caseTag":', '"caseTag":"' + privateValue + '","caseTag":'),
    message.slice(0, -1) + ',"extra":"' + privateValue + '"}',
    message.replace('"milvusSearch":"unknown"', '"milvusSearch":0.5'),
    message.replace('"bodyCode":"unknown"', '"bodyCode":"' + privateValue + '"'),
    message.replace('"status":"unknown",', ''),
    message + '\n',
  ];
  assert.deepEqual(diagnostic.parseDurableFirstPostDiagnosticMessage(message), empty);
  for (const candidate of candidates) assert.equal(diagnostic.parseDurableFirstPostDiagnosticMessage(candidate), null);
});

test('bounded first POST diagnostic survives a real native assertion TAP failure without response text', () => {
  const url = new URL('./durable-response-diagnostic.test-support.mjs', import.meta.url).href;
  const script = `import assert from 'node:assert/strict';import test from 'node:test';
    import {formatDurableBoundedFirstPostDiagnostic} from ${JSON.stringify(url)};
    test('synthetic bounded first POST status',()=>assert.equal(500,200,formatDurableBoundedFirstPostDiagnostic({
      status:500,body:{code:'DURABLE_ASK_INTERNAL_ERROR',error:${JSON.stringify(privateValue)}},
      milvusSignals:{connect:1,search:2},modelSignals:{embed:2,generate:0},scopedAgentCalls:1})));`;
  // Do not inherit the parent's private Node test IPC/reporter environment:
  // this child must emit genuine standalone TAP, as the existing runner test does.
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP']) if (process.env[key] !== undefined) env[key] = process.env[key];
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined); assert.equal(result.status, 1);
  assert.match(result.stdout, /not ok 1 - synthetic bounded first POST status/);
  assert.equal(result.stdout.includes(privateValue) || result.stderr.includes(privateValue), false);
  const records = result.stdout.split(/\r?\n/).map(line => diagnostic.parseDurableFirstPostDiagnosticMessage(line.trim())).filter(Boolean);
  assert.deepEqual(records, [{ ...empty, status: 500, bodyCode: 'DURABLE_ASK_INTERNAL_ERROR',
    milvusConnect: 1, milvusSearch: 2, modelEmbed: 2, modelGenerate: 0, scopedAgentCalls: 1 }]);
});

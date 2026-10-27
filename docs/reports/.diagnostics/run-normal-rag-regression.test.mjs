import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  DURABLE_FIRST_POST_DIAGNOSTIC_MARKER, formatDurableFirstPostDiagnostic,
  formatDurableBoundedFirstPostDiagnostic,
  parseDurableFirstPostDiagnosticMessage,
} from '../../../src/app/api/ask/durable-response-diagnostic.test-support.mjs';

const runner = fileURLToPath(new URL('./run-normal-rag-regression.mjs', import.meta.url));
const inventory = JSON.parse(readFileSync(new URL('./normal-rag-regression-v1.inventory.json', import.meta.url)));
const authority = readFileSync(new URL('./closed-rag-observer-run.cjs', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const privateValue = 'SYNTHETIC_PRIVATE_RUNNER_VALUE';

function fixture(scenario = 'success', diagnosticTap = '') {
  const source = readFileSync(runner, 'utf8');
  const root = path.resolve(path.parse(runner).root, 'synthetic-regression-workspace');
  const filename = path.join(root, 'docs/reports/.diagnostics/run-normal-rag-regression.mjs');
  const manifest = structuredClone(inventory);
  const content = new Map(manifest.tests.map(row => [row.file, Buffer.from(`synthetic source ${row.file}`)]));
  for (const row of manifest.tests) row.sha256 = sha(content.get(row.file));
  if (scenario === 'scope') manifest.tests.pop();
  if (scenario === 'order') manifest.tests.reverse();
  if (scenario === 'budget') manifest.parentTimeoutMs += 1;
  if (scenario === 'loader') manifest.nodeArguments.unshift('--import', 'synthetic-loader');
  if (scenario === 'identity') manifest.tests[0].sha256 = '0'.repeat(64);
  if (scenario === 'production') manifest.productionAccepted = true;
  content.set('docs/reports/.diagnostics/normal-rag-regression-v1.inventory.json', Buffer.from(JSON.stringify(manifest)));
  content.set('docs/reports/.diagnostics/closed-rag-observer-run.cjs', authority);
  content.set('docs/reports/.diagnostics/run-normal-rag-regression.mjs', Buffer.from(source));
  content.set('src/synthetic-source.ts', Buffer.from('synthetic source'));
  const logs = [];
  const calls = [];
  let nodeCalls = 0;
  const contextProcess = { execPath: process.execPath, env: { PATH: 'synthetic-path', PROVIDER_SECRET: privateValue, NODE_OPTIONS: privateValue }, exitCode: 0 };
  const fakeFs = {
    realpathSync: value => value,
    readFileSync(file, encoding) {
      const relative = path.relative(root, path.resolve(file)).replaceAll('\\', '/');
      if (!content.has(relative)) throw new Error(privateValue);
      const bytes = content.get(relative);
      return encoding ? bytes.toString(encoding) : bytes;
    },
  };
  const fakeCp = {
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      if (command === 'git') {
        return { status: 0, stdout: Buffer.from(args.includes('--stage') ? 'synthetic index' : 'src/synthetic-source.ts\0'), stderr: Buffer.alloc(0) };
      }
      assert.equal(command, process.execPath);
      nodeCalls += 1;
      if (scenario === 'throw') throw new Error(privateValue);
      if (scenario === 'drift') content.set('src/synthetic-source.ts', Buffer.from('changed'));
      const pass = scenario === 'assertion' ? 1193 : 1194;
      const fail = scenario === 'assertion' ? 1 : 0;
      const skipped = scenario === 'skip' ? 1 : 0;
      return { status: scenario === 'assertion' ? 1 : scenario === 'spawn-error' ? null : 0,
        error: scenario === 'spawn-error' ? new Error(privateValue) : undefined,
        stdout: scenario === 'incomplete' ? privateValue : `${privateValue}\n${diagnosticTap}# tests 1194\n# pass ${pass}\n# fail ${fail}\n# cancelled 0\n# skipped ${skipped}\n# todo 0\n`,
        stderr: privateValue };
    },
  };
  const emitted = transformSync(source, {
    format: 'cjs', target: 'es2022',
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(filename).href) },
  }).code;
  vm.runInNewContext(emitted, {
    __dirname: path.dirname(filename), __filename: filename, Buffer, process: contextProcess,
    console: { log: value => logs.push(value) },
    require(name) {
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:path') return path;
      if (name === 'node:crypto') return { createHash };
      if (name === 'node:child_process') return fakeCp;
      if (name === 'node:url') return { fileURLToPath, pathToFileURL };
      if (name === '../../../src/app/api/ask/durable-response-diagnostic.test-support.mjs') {
        return { DURABLE_FIRST_POST_DIAGNOSTIC_MARKER, parseDurableFirstPostDiagnosticMessage };
      }
      throw new Error(`Unexpected runner dependency ${name}`);
    },
  }, { filename, timeout: 1000 });
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], new RegExp(privateValue));
  return { report: JSON.parse(logs[0]), exitCode: contextProcess.exitCode, calls, nodeCalls };
}

test('complete runner uses original Node budgets, complete scope, clean environment and closed output', () => {
  const f = fixture();
  assert.equal(f.exitCode, 0);
  assert.equal(f.report.passed, true);
  assert.equal(f.report.productionAccepted, false);
  assert.equal(f.report.historicalOrderRecovered, false);
  assert.equal(f.report.testFiles, 60);
  assert.equal(f.nodeCalls, 1);
  const call = f.calls.find(row => row.command === process.execPath);
  assert.deepEqual(Array.from(call.args), ['--test', '--test-timeout=30000', ...inventory.tests.map(row => row.file)]);
  assert.equal(call.options.timeout, 90000);
  assert.equal(call.options.maxBuffer, 16 * 1024 * 1024);
  assert.equal(call.options.env.RAG_SEMANTIC_ROUTER, 'off');
  assert.equal(call.options.env.PROVIDER_SECRET, undefined);
  assert.equal(call.options.env.NODE_OPTIONS, undefined);
  assert.equal(call.options.env.DATABASE_URL, '');
});

for (const scenario of ['scope', 'order', 'budget', 'loader', 'identity', 'production']) {
  test(`complete runner refuses ${scenario} drift before dispatch`, () => {
    const f = fixture(scenario);
    assert.equal(f.exitCode, 1);
    assert.equal(f.report.passed, false);
    assert.equal(f.nodeCalls, 0);
  });
}

for (const scenario of ['assertion', 'spawn-error', 'incomplete', 'skip', 'drift', 'throw']) {
  test(`complete runner preserves ${scenario} failure without raw diagnostics`, () => {
    const f = fixture(scenario);
    assert.equal(f.exitCode, 1);
    assert.equal(f.report.passed, false);
    assert.equal(f.report.productionAccepted, false);
    assert.equal(f.nodeCalls, 1);
  });
}

test('successful complete runner emits an empty closed failure catalog', () => {
  const f = fixture();
  assert.deepEqual(f.report.failedDiagnostics, []);
  assert.equal(f.report.failureDiagnosticsTruncated, false);
});

test('failed runner locates only inventory-owned source positions and closed assertion fields', () => {
  const root = path.resolve(path.parse(runner).root, 'synthetic-regression-workspace');
  const absolute = path.join(root, inventory.tests[0].file);
  const tap = `not ok 1 - ${privateValue}\n  ---\n  location: '${pathToFileURL(absolute).href}:1:1'\n  failureType: 'testCodeFailure'\n  error: '${privateValue}'\n  code: 'ERR_ASSERTION'\n  expected: 200\n  actual: 503\n  operator: 'strictEqual'\n  stack: |-\n    TestContext.<anonymous> (${absolute}:1:2)\n  ...\n`;
  const f = fixture('assertion', tap);
  assert.equal(f.exitCode, 1);
  assert.equal(f.report.passed, false);
  assert.deepEqual(f.report.failedDiagnostics, [{
    labelSha: sha(privateValue), failureType: 'testCodeFailure', errorCode: 'ERR_ASSERTION',
    operator: 'strictEqual', expectedNumeric: 200, actualNumeric: 503,
    sourceLocations: [{ fileIndex: 0, line: 1, column: 1 }, { fileIndex: 0, line: 1, column: 2 }],
  }]);
  assert.equal(f.report.failureDiagnosticsTruncated, false);
});

test('failure catalog rejects unknown strings, quoted numeric carriers and unowned source paths', () => {
  const tap = `not ok 1 - ${privateValue}\n  ---\n  location: '${privateValue}/unowned.test.mjs:1:1'\n  failureType: '${privateValue}'\n  code: '${privateValue}'\n  operator: '${privateValue}'\n  expected: '200'\n  actual: 503${privateValue}\n  error: |-\n    code: 'ERR_ASSERTION'\n    failureType: 'testCodeFailure'\n    operator: 'strictEqual'\n    expected: 200\n    actual: 503\n  ...\n`;
  const f = fixture('assertion', tap);
  assert.deepEqual(f.report.failedDiagnostics, [{
    labelSha: sha(privateValue), failureType: 'other', errorCode: 'other', operator: 'other', sourceLocations: [],
  }]);
});

test('failure catalog rejects invalid positions and path-prefix lookalikes', () => {
  const root = path.resolve(path.parse(runner).root, 'synthetic-regression-workspace');
  const absolute = path.join(root, inventory.tests[0].file);
  const tap = `not ok 1 - ${privateValue}\n  ---\n  stack: |-\n    TestContext.<anonymous> (${absolute}:0:1)\n    TestContext.<anonymous> (${absolute}:1:0)\n    TestContext.<anonymous> (${absolute}:999999:1)\n    TestContext.<anonymous> (${absolute}:1:999999)\n    TestContext.<anonymous> (unowned${absolute}:1:1)\n  ...\n`;
  const f = fixture('assertion', tap);
  assert.deepEqual(f.report.failedDiagnostics, [{
    labelSha: sha(privateValue), failureType: null, errorCode: null, operator: null, sourceLocations: [],
  }]);
});

test('failure catalog is bounded without changing the complete failure verdict', () => {
  const tap = Array.from({ length: 70 }, (_, i) => `not ok ${i + 1} - ${privateValue}-${i}\n  ---\n  failureType: 'testTimeoutFailure'\n  code: 'ERR_TEST_FAILURE'\n  ...\n`).join('');
  const f = fixture('assertion', tap);
  assert.equal(f.exitCode, 1);
  assert.equal(f.report.passed, false);
  assert.equal(f.report.failedLabelHashes.length, 70);
  assert.equal(f.report.failedDiagnostics.length, 64);
  assert.equal(f.report.failureDiagnosticsTruncated, true);
  assert.equal(f.report.failedDiagnostics[0].failureType, 'testTimeoutFailure');
});

test('provider entry context remains a closed diagnostic instead of serializing its cause', () => {
  const tap = `not ok 1 - ${privateValue}\n  ---\n  error: 'Provider execution failed before expected entry [code=operation-timeout, phase=encrypt, pending=true, mutation=false] ${privateValue}'\n  ...\n`;
  const f = fixture('assertion', tap);
  assert.equal(f.report.failedDiagnostics[0].fixtureEntryFailure, 'provider-before-entry');
  assert.deepEqual(f.report.failedDiagnostics[0].providerEntryContext, {
    code: 'operation-timeout', phase: 'encrypt', pending: 'true', mutation: 'false',
  });
  const unknown = fixture('assertion', tap.replace('code=operation-timeout, phase=encrypt', 'code=untrusted, phase=untrusted'));
  assert.deepEqual(unknown.report.failedDiagnostics[0].providerEntryContext, {
    code: 'unknown', phase: 'unknown', pending: 'true', mutation: 'false',
  });
});

test('bounded assertion integers do not claim an unproven HTTP meaning', () => {
  const tap = `not ok 1 - ${privateValue}\n  ---\n  expected: 256\n  actual: 384\n  operator: 'strictEqual'\n  ...\n`;
  const f = fixture('assertion', tap);
  assert.equal(f.report.failedDiagnostics[0].expectedNumeric, 256);
  assert.equal(f.report.failedDiagnostics[0].actualNumeric, 384);
  assert.equal('expectedHttpStatus' in f.report.failedDiagnostics[0], false);
  assert.equal('actualHttpStatus' in f.report.failedDiagnostics[0], false);
});

test('unclosed failure YAML is incomplete at EOF or the next test boundary', () => {
  for (const suffix of ['', '# Subtest: synthetic next test\nok 2 - synthetic next test\n', '    synthetic line\n'.repeat(201)]) {
    const tap = `not ok 1 - ${privateValue}\n  ---\n  failureType: 'testCodeFailure'\n${suffix}`;
    const f = fixture('assertion', tap);
    assert.equal(f.report.failureDiagnosticsTruncated, true);
    assert.equal(f.report.passed, false);
    assert.equal(f.exitCode, 1);
  }
});

test('source positions are deduplicated and bounded with explicit incomplete evidence', () => {
  const root = path.resolve(path.parse(runner).root, 'synthetic-regression-workspace');
  const absolute = path.join(root, inventory.tests[0].file);
  const positions = [1, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(column => `    TestContext.<anonymous> (${absolute}:1:${column})\n`).join('');
  const tap = `not ok 1 - ${privateValue}\n  ---\n  stack: |-\n${positions}  ...\n`;
  const f = fixture('assertion', tap);
  assert.equal(f.report.failedDiagnostics[0].sourceLocations.length, 8);
  assert.equal(f.report.failureDiagnosticsTruncated, true);
});

const firstResponseMessage = () => formatDurableFirstPostDiagnostic({ status: 503,
  body: { code: 'DURABLE_WORKFLOW_PAUSED', error: privateValue },
  milvusSignals: { connect: 1, search: 1 }, modelSignals: { embed: 1, generate: 0 }, scopedAgentCalls: 1 });
const expectedFirstResponse = {
  caseTag: 'durable-agentic-replay-first-post/v1', site: 'first-post-status', status: 503,
  bodyCode: 'DURABLE_WORKFLOW_PAUSED', durableStatus: 'unknown', durableReplay: 'unknown',
  milvusConnect: 1, milvusSearch: 1, modelEmbed: 1, modelGenerate: 0, scopedAgentCalls: 1,
};

test('failure catalog retains only canonical first-response diagnostics from a TAP error field', () => {
  const message = firstResponseMessage();
  for (const error of [`  error: |-\n    ${message}\n    503 !== 200\n`, `  error: '${message}'\n`, `  error: ${JSON.stringify(message)}\n`]) {
    const f = fixture('assertion', `not ok 1 - ${privateValue}\n  ---\n${error}  ...\n`);
    assert.deepEqual(f.report.failedDiagnostics[0].durableFirstResponse, expectedFirstResponse);
    assert.equal(f.report.passed, false);
  }
});

test('non-error or noncanonical first-response text cannot become a closed response diagnostic', () => {
  const message = firstResponseMessage();
  for (const field of [`  stack: |-\n    ${message}\n`, `  note: '${message}'\n`,
    `  error: |-\n    ${message.replace('DURABLE_WORKFLOW_PAUSED', privateValue)}\n`,
    `  error: |-\n    ${message}\n    ${message}\n`,
    `  error: |-\n    ${message.slice(0, -1)},"extra":"${privateValue}"}\n`,
    `  error: |-\n    ${message}${privateValue}\n`]) {
    const f = fixture('assertion', `not ok 1 - ${privateValue}\n  ---\n${field}  ...\n`);
    assert.equal(Object.hasOwn(f.report.failedDiagnostics[0], 'durableFirstResponse'), false);
  }
});

test('native Node assertion TAP delivers the canonical closed first-response message', () => {
  const helper = new URL('../../../src/app/api/ask/durable-response-diagnostic.test-support.mjs', import.meta.url).href;
  const source = `import test from 'node:test';import assert from 'node:assert/strict';import {formatDurableFirstPostDiagnostic as format} from ${JSON.stringify(helper)};test('native synthetic first-response failure',()=>assert.equal(503,200,format({status:503,body:{code:'DURABLE_WORKFLOW_PAUSED'},milvusSignals:{connect:1,search:1},modelSignals:{embed:1,generate:0},scopedAgentCalls:1})));`;
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP']) if (process.env[key] !== undefined) env[key] = process.env[key];
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    env, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 1); assert.equal(Boolean(result.error), false);
  const f = fixture('assertion', result.stdout);
  assert.deepEqual(f.report.failedDiagnostics[0].durableFirstResponse, expectedFirstResponse);
  assert.equal(f.report.passed, false);
});

test('failure catalog keeps the bounded first POST site distinct without changing failure status', () => {
  const message = formatDurableBoundedFirstPostDiagnostic({ status: 500,
    body: { code: 'DURABLE_ASK_INTERNAL_ERROR', error: privateValue },
    milvusSignals: { connect: 1, search: 2 }, modelSignals: { embed: 2, generate: 0 }, scopedAgentCalls: 1 });
  const f = fixture('assertion', `not ok 1 - ${privateValue}\n  ---\n  error: '${message}'\n  ...\n`);
  assert.deepEqual(f.report.failedDiagnostics[0].durableFirstResponse, {
    caseTag: 'durable-bounded-replay-first-post/v1', site: 'first-post-status', status: 500,
    bodyCode: 'DURABLE_ASK_INTERNAL_ERROR', durableStatus: 'unknown', durableReplay: 'unknown',
    milvusConnect: 1, milvusSearch: 2, modelEmbed: 2, modelGenerate: 0, scopedAgentCalls: 1,
  });
  assert.equal(f.report.passed, false); assert.equal(f.exitCode, 1);
});

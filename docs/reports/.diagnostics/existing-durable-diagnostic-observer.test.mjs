import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { inspect } from 'node:util';
import ts from 'typescript';

const subjectUrl = new URL('./existing-durable-diagnostic-observer.mjs', import.meta.url);
const subject = existsSync(subjectUrl) ? await import(subjectUrl.href) : null;
const reader = (text) => {
  assert.ok(subject, 'the diagnostic observer module must exist');
  return subject.parseExistingDurableDiagnostics(text);
};
const record = () => ({
  requestIdHash: 'a'.repeat(64), stage: 'durable-catch', status: 503,
  publicCode: null, mappedCode: 'DURABLE_WORKFLOW_PAUSED',
  codeChain: ['DURABLE_WORKFLOW_STEP_FAILED', 'EPERM'], causeDepth: 2, chainTermination: 'end',
});
const tap = (value) => '# [Ask API] durable failure diagnostic '
  + inspect(value, { breakLength: 60 }).split('\n').join('\n# ') + '\n';

test('existing diagnostic reader retains only bounded closed fields and no attribution claim', () => {
  const result = reader(tap(record()));
  assert.equal(result.complete, true);
  assert.equal(result.productionAccepted, false);
  assert.equal(result.attribution, 'unproven');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].mappedCode, 'DURABLE_WORKFLOW_PAUSED');
  assert.deepEqual(result.records[0].codeChain, ['DURABLE_WORKFLOW_STEP_FAILED', 'EPERM']);
  assert.equal(result.records[0].status, 503);
});

test('existing diagnostic reader never carries unknown text or private extra fields', () => {
  const value = { ...record(), requestIdHash: 'PRIVATE_SENTINEL', stage: 'PRIVATE_SENTINEL',
    publicCode: 'PRIVATE_SENTINEL', mappedCode: 'PRIVATE_SENTINEL',
    codeChain: ['PRIVATE_SENTINEL'], private: 'PRIVATE_SENTINEL', status: 999, causeDepth: 99 };
  const result = reader(tap(value));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
  assert.equal(result.records[0].stage, null);
  assert.equal(result.records[0].status, null);
  assert.equal(result.records[0].causeDepth, null);
  assert.deepEqual(result.records[0].codeChain, ['UNCLASSIFIED']);
});

test('missing diagnostic text means unobserved, not a successful workflow', () => {
  const result = reader('# tests 1\n# pass 1\n');
  assert.equal(result.records.length, 0);
  assert.equal(result.diagnosticsObserved, false);
  assert.equal(result.productionAccepted, false);
});

test('input and size bounds reject without executing coercion hooks', () => {
  let hooks = 0;
  assert.equal(reader({ toString() { hooks++; throw Error('PRIVATE_SENTINEL'); } }).complete, false);
  assert.equal(hooks, 0);
  assert.equal(reader('x'.repeat(16 * 1024 * 1024 + 1)).complete, false);
});

test('diagnostic records are capped with explicit incomplete observation', () => {
  const result = reader(tap(record()).repeat(129));
  assert.equal(result.records.length, 128);
  assert.equal(result.truncated, true);
  assert.equal(result.complete, false);
});

test('legacy parser source cannot be substituted under a caller-selected hash', () => {
  assert.ok(subject);
  const source = readFileSync(new URL('./closed-rag-observer-run.cjs', import.meta.url), 'utf8');
  assert.equal(typeof subject.extractFrozenDiagnosticReader(source).read, 'function');
  assert.throws(() => subject.extractFrozenDiagnosticReader(source + '\n'), /frozen/);
});

test('extracted reader also rejects unsafe carriers before any method lookup', () => {
  assert.ok(subject);
  const source = readFileSync(new URL('./closed-rag-observer-run.cjs', import.meta.url), 'utf8');
  let hooks = 0;
  assert.throws(() => subject.extractFrozenDiagnosticReader(source).read({
    get matchAll() { hooks++; throw Error('PRIVATE_SENTINEL'); },
  }));
  assert.equal(hooks, 0);
});

test('a malformed existing diagnostic frame is incomplete instead of silently absent', () => {
  const result = reader('# [Ask API] durable failure diagnostic {\n# PRIVATE_SENTINEL\n');
  assert.equal(result.complete, false);
  assert.equal(result.records.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
});

function spawnCalls(source) {
  const file = ts.createSourceFile('parent.mjs', source, ts.ScriptTarget.Latest, true);
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'spawnSync') calls.push(node.getText(file));
    ts.forEachChild(node, visit);
  }
  visit(file);
  return calls;
}

test('observed parent changes only result reporting, preserving exact child spawn expressions', () => {
  assert.ok(subject);
  const source = readFileSync(new URL('./run-normal-rag-regression.mjs', import.meta.url), 'utf8');
  const prepared = subject.prepareObservedParent(source);
  assert.deepEqual(spawnCalls(prepared.source), spawnCalls(source));
  assert.equal(prepared.childSpawnCallsPreserved, true);
  assert.equal(prepared.productionAccepted, false);
  assert.match(prepared.source, /__readSafeDurableDiagnostics\(stdout\)/);
  assert.throws(() => subject.prepareObservedParent(source + '\n'), /frozen/);
});

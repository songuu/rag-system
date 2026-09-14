import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArguments } from './run-scoped-agent-eval.mjs';
const execute = promisify(execFile);
const script = fileURLToPath(new URL('./run-scoped-agent-eval.mjs', import.meta.url));

test('CLI rejects ambiguous providers, variants, trials and durations before provider access', () => {
  for (const args of [['--think', 'maybe'], ['--num-predict', '0'], ['--num-predict', '8193'], ['--num-predict', 'NaN'], ['--decision-mode', 'freeform'], ['--provider', 'auto'], ['--variant', 'gold'], ['--trials', '0'], ['--trials', '11'], ['--max-duration-ms', 'Infinity']]) {
    assert.throws(() => parseArguments(args));
  }
  assert.equal(parseArguments([]).provider, 'fake');
  assert.equal(parseArguments([]).decisionMode, 'structured');
  assert.equal(parseArguments([]).numPredict, 700);
  assert.equal(parseArguments(['--think', 'on']).think, 'on');
  assert.equal(parseArguments(['--think', 'off', '--num-predict', '2048']).numPredict, 2048);
  assert.equal(parseArguments(['--decision-mode', 'native-tools']).decisionMode, 'native-tools');
  assert.deepEqual(parseArguments([]).variants, ['snapshot', 'rerank', 'iterative']);
  assert.equal(parseArguments(['--provider', 'ollama', '--model', 'llama3.1']).provider, 'ollama');
});

test('hermetic CLI emits each report, honest quality failures and safety-budget gates', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scoped-agent-eval-'));
  const output = path.join(directory, 'report.json');
  await execute(process.execPath, [script, '--output', output], { timeout: 30_000 });
  const artifact = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(artifact.summary.realModelMeasured, false);
  assert.equal(artifact.summary.productionQualityMeasured, false);
  assert.equal(artifact.summary.securityPassed, true);
  assert.equal(artifact.summary.budgetPassed, true);
  assert.equal(artifact.reports.length, 3);
  assert.equal(artifact.reports[2].metadata.decisionMode, 'structured');
  assert.equal(artifact.reports[2].cases.find(item => item.caseId === 'multihop').trajectory.decisionMode, 'structured');
  assert.equal(artifact.reports[0].gate.quality.passed, false);
  assert.ok(artifact.reports[2].summary.meanRequiredFactCoverage > artifact.reports[0].summary.meanRequiredFactCoverage);
  assert.equal(artifact.reports[0].summary.costUsd.total, null);
  assert.equal(artifact.reports[0].summary.tokens.inputTotal, null);
  for (const report of artifact.reports) {
    assert.ok(report.cases.filter(item => item.status === 'completed').every(item => item.trajectory.providerRetryMeasurement === 'disabled'));
  }
});

test('strict CI gate exits nonzero on honest baseline quality deficits', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scoped-agent-gate-'));
  const output = path.join(directory, 'report.json');
  await assert.rejects(execute(process.execPath, [script, '--variant', 'snapshot', '--gate', '--output', output], { timeout: 30_000 }), error => error.code === 2);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).summary.passed, false);
});

test('provider failure is hermetic, stops later variants and cannot fall back to the fake target', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scoped-agent-provider-failure-'));
  const output = path.join(directory, 'report.json');
  const argumentsList = ['--provider', 'ollama', '--model', 'llama3.1', '--think', 'on', '--num-predict', '2048', '--output', output];
  const driver = [
    "import { registerHooks } from 'node:module';",
    "import { FakeToolCallingModel } from 'langchain';",
    "globalThis.scopedEvalFailingModel = () => { const m = new FakeToolCallingModel({toolCalls: []}); m.bindTools = () => m; m._generate = async () => { throw new Error('PRIVATE_PROVIDER_PAYLOAD'); }; return m; };",
    "const stub = 'data:text/javascript,' + encodeURIComponent('export class ChatOllama { constructor(options) { if (options.think !== true || options.numPredict !== 2048) throw new Error(\"CLI model parameters did not reach provider\"); return globalThis.scopedEvalFailingModel(); } }');",
    "registerHooks({ resolve(s,c,n) { return s === '@langchain/ollama' ? {url:stub,shortCircuit:true} : n(s,c); } });",
    'const { main } = await import(' + JSON.stringify(pathToFileURL(script).href) + ');',
    'process.exitCode = await main(' + JSON.stringify(argumentsList) + ');',
  ].join('\n');
  await assert.rejects(execute(process.execPath, ['--input-type=module', '-e', driver], { timeout: 30_000 }), error => {
    assert.equal(error.code, 1);
    assert.equal((error.stdout + error.stderr).includes('PRIVATE_PROVIDER_PAYLOAD'), false);
    return true;
  });
  const serialized = await readFile(output, 'utf8');
  const artifact = JSON.parse(serialized);
  assert.equal(serialized.includes('PRIVATE_PROVIDER_PAYLOAD'), false);
  assert.equal(artifact.summary.provider, 'ollama');
  assert.equal(artifact.summary.stoppedOnFailure, true);
  assert.equal(artifact.summary.realModelMeasured, false);
  assert.equal(artifact.reports.length, 1);
  assert.deepEqual(artifact.reports[0].metadata.modelParameters, { temperature: 0, numPredict: 2048, think: true });
  assert.equal(artifact.reports[0].cases[0].trajectory.modelCallCount, 1);
  assert.equal(artifact.reports[0].cases[0].trajectory.modelResponseCount, 0);
  assert.equal(artifact.summary.productionQualityMeasured, false);
});

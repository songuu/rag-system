import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = new URL('./calibrate-rag-judge.mjs', import.meta.url);
const input = () => ({ schemaVersion: 'rag-eval-judge-calibration/v1', judgeId: 'reviewed-judge-v1',
  calibrationCaseIds: ['a'], evaluationCaseIds: ['holdout'],
  judgeScores: [{ caseId: 'a', dimension: 'relevance', score: 0.8 }],
  humanScores: [{ caseId: 'a', dimension: 'relevance', score: 1 }] });
function run(args) { return spawnSync(process.execPath, [fileURLToPath(script), ...args], { encoding: 'utf8' }); }

test('calibration CLI binds an input digest, preserves measurement gaps and refuses overwrite', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rag-calibration-'));
  try {
    const source = path.join(dir, 'input.json'), output = path.join(dir, 'output.json');
    await writeFile(source, JSON.stringify(input()));
    const result = run(['--input', source, '--output', output]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.judgeId, 'reviewed-judge-v1');
    assert.match(report.inputSha256, /^[a-f0-9]{64}$/u);
    assert.equal(report.calibration.pairedDimensions, 1);
    assert.equal(report.calibration.coverage, 1);
    assert.ok(!JSON.stringify(report).includes('humanScores'));
    assert.notEqual(run(['--input', source, '--output', output]).status, 0);
    assert.equal(await readFile(output, 'utf8'), JSON.stringify(report, null, 2) + '\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('calibration CLI rejects holdout leakage and malformed input without writing a report', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rag-calibration-'));
  try {
    const source = path.join(dir, 'input.json'), output = path.join(dir, 'output.json');
    await writeFile(source, JSON.stringify({ ...input(), evaluationCaseIds: ['a'] }));
    assert.notEqual(run(['--input', source, '--output', output]).status, 0);
    await assert.rejects(readFile(output));
    await writeFile(source, JSON.stringify({ ...input(), judgeId: '' }));
    assert.notEqual(run(['--input', source, '--output', output]).status, 0);
    assert.notEqual(run(['--input', source, '--unknown']).status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

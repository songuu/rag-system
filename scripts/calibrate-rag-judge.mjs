#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/calibrate-rag-judge.mjs --input calibration.json --output report.json\nOnly reports agreement on labelled calibration cases; holdout case IDs must remain disjoint. Existing files are never overwritten.');
  } else {
    const options = new Map();
    for (let index = 0; index < args.length; index += 2) {
      if (!['--input', '--output'].includes(args[index]) || !args[index + 1] || options.has(args[index])) throw new Error('invalid arguments');
      options.set(args[index], args[index + 1]);
    }
    if (options.size !== 2) throw new Error('--input and --output are required');
    const inputPath = options.get('--input');
    const info = await stat(inputPath);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error('input must be a JSON file no larger than 4 MiB');
    const raw = await readFile(inputPath, 'utf8');
    const input = JSON.parse(raw);
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['schemaVersion', 'judgeId', 'calibrationCaseIds', 'evaluationCaseIds', 'judgeScores', 'humanScores', 'tolerance'].includes(key))
      || input.schemaVersion !== 'rag-eval-judge-calibration/v1'
      || typeof input.judgeId !== 'string' || !input.judgeId.trim() || input.judgeId.length > 200) throw new Error('invalid calibration input schema or judge identity');
    const { calibrateSemanticJudge } = await import('../src/lib/rag/eval/quality-scoring.ts');
    const calibration = calibrateSemanticJudge({ calibrationCaseIds: input.calibrationCaseIds,
      evaluationCaseIds: input.evaluationCaseIds, judgeScores: input.judgeScores, humanScores: input.humanScores,
      ...(input.tolerance === undefined ? {} : { tolerance: input.tolerance }) });
    const report = { schemaVersion: 'rag-eval-judge-calibration-report/v1', judgeId: input.judgeId,
      inputSha256: createHash('sha256').update(raw).digest('hex'), tolerance: input.tolerance ?? 0.1,
      calibrationCaseCount: input.calibrationCaseIds.length, evaluationCaseCount: input.evaluationCaseIds.length, calibration };
    await writeFile(options.get('--output'), JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    console.log(`Calibration report written: paired=${calibration.pairedDimensions} coverage=${calibration.coverage ?? 'unmeasured'}`);
  }
} catch (error) {
  console.error('[rag-eval judge calibration] ' + (error instanceof Error ? error.message : 'failed'));
  process.exitCode = 1;
}

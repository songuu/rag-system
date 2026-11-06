#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const usage = `Usage:
  node scripts/prepare-rag-regression.mjs prepare --input feedback-export.json --output draft.json
  node scripts/prepare-rag-regression.mjs review --input draft.json --annotations human-reviews.json --output reviewed.json
  node scripts/prepare-rag-regression.mjs export --input reviewed.json --output regression-dataset.json

Local files only. Output files must not already exist; no source file is changed.
prepare accepts rag-feedback-export/v1 with datasetId, datasetVersion, snapshotId,
snapshotVersion, a versioned V2 corpus and traces (traceId, query, answer,
snapshotId, snapshotVersion, scope, evidenceIds and feedback {value, comment?}).
No observed answer or feedback becomes gold automatically.
review accepts rag-feedback-review/v1 {reviews:[{caseId, reviewer, reviewedAt,
annotation:{disposition, goldEvidence, expectedAnswer?, reason?, allowedPolicies,
allowedLanes, securityExpectations}}]}. reviewedAt is a UTC ISO timestamp.
Each answer needs human referenceAnswer/requiredFacts and exact gold spans.
abstain/clarify need an explicit reason and empty gold; all cases need policy,
lane and security labels. Review is a local human attestation, not authentication.
export requires every case reviewed; edits invalidate review digests. Clarification
is retained as expectedDisposition, a tag and provenance. The output includes
regressionProvenance for audit.`;

export function parseArguments(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { help: true };
  const mode = args[0];
  if (!['prepare', 'review', 'export'].includes(mode)) throw new Error('select prepare, review or export explicitly');
  const options = { mode };
  const seen = new Set();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!['--input', '--output', '--annotations'].includes(flag) || seen.has(flag)
      || typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw new Error('invalid or duplicate argument');
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) || /^file:/i.test(value)) throw new Error('only local filesystem paths are accepted');
    seen.add(flag);
    options[flag.slice(2)] = path.resolve(value);
  }
  if (!options.input || !options.output || (mode === 'review') !== Boolean(options.annotations)) {
    throw new Error('explicit input/output required; annotations required only for review');
  }
  const identity = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (identity(options.output) === identity(options.input)
    || (options.annotations && identity(options.output) === identity(options.annotations))) throw new Error('output must be distinct from source files');
  return options;
}

let hooksInstalled = false;
function installTypeScriptResolution() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  registerHooks({ resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[mc]?[jt]s$/.test(specifier)) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  } });
}

async function readJson(file) {
  try {
    const details = await stat(file);
    if (!details.isFile() || details.size > MAX_INPUT_BYTES) throw new Error();
    const data = await readFile(file, 'utf8');
    if (Buffer.byteLength(data, 'utf8') > MAX_INPUT_BYTES) throw new Error();
    return JSON.parse(data);
  } catch {
    // Native JSON parse messages can contain excerpts of confidential feedback.
    throw new Error('input must be a readable JSON file no larger than 32 MiB');
  }
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseArguments(args);
    if (options.help) { console.log(usage); return 0; }
    installTypeScriptResolution();
    const { createFeedbackRegressionDraft, reviewFeedbackRegressionCase, exportReviewedRegressionDataset,
      serializeFeedbackRegressionDraft } = await import('../src/lib/rag/eval/feedback-regression.ts');
    const input = await readJson(options.input);
    let serialized;
    if (options.mode === 'prepare') {
      serialized = serializeFeedbackRegressionDraft(createFeedbackRegressionDraft(input));
    } else if (options.mode === 'review') {
      const annotations = await readJson(options.annotations);
      if (!annotations || annotations.schemaVersion !== 'rag-feedback-review/v1'
        || !Array.isArray(annotations.reviews) || !annotations.reviews.length) throw new Error('annotations must contain an explicit nonempty human review list');
      const reviewedIds = new Set();
      let draft = input;
      for (const item of annotations.reviews) {
        if (!item || typeof item.caseId !== 'string' || reviewedIds.has(item.caseId)) throw new Error('review case IDs must be unique');
        reviewedIds.add(item.caseId);
        draft = reviewFeedbackRegressionCase(draft, item.caseId, item.annotation,
          { reviewer: item.reviewer, reviewedAt: item.reviewedAt });
      }
      serialized = serializeFeedbackRegressionDraft(draft);
    } else {
      serialized = JSON.stringify(exportReviewedRegressionDataset(input), null, 2);
    }
    try { await writeFile(options.output, serialized + '\n', { encoding: 'utf8', flag: 'wx' }); }
    catch { throw new Error('output must be a new writable file; existing files are never overwritten'); }
    console.log('Saved ' + options.mode + ' artifact to ' + options.output);
    return 0;
  } catch (error) {
    console.error('[rag-regression] ' + (error instanceof Error ? error.message : 'operation failed'));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}

#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultFixturePath = path.join(
  projectRoot,
  'src',
  'lib',
  'rag',
  'eval',
  'fixtures',
  'e1a-dense-v1.json'
);

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      printHelp();
      process.exitCode = 0;
      return;
    }

    const [
      { parseRagEvalDataset, createRagEvalDatasetHash },
      { createDenseBaselineTarget },
      { runRagEval },
      { runRagEvalMatrix },
      { evaluateRagEvalGate },
    ] = await Promise.all([
      import('../src/lib/rag/eval/dataset.ts'),
      import('../src/lib/rag/eval/dense-baseline.ts'),
      import('../src/lib/rag/eval/runner.ts'),
      import('../src/lib/rag/eval/matrix.ts'),
      import('../src/lib/rag/eval/gate.ts'),
    ]);
    const fixturePath = options.fixturePath ?? defaultFixturePath;
    const dataset = parseRagEvalDataset(
      JSON.parse(await readFile(fixturePath, 'utf8'))
    );
    const datasetHash = createRagEvalDatasetHash(dataset);

    if (options.validateOnly) {
      console.log(
        '[rag-eval] valid dataset=' +
          dataset.datasetId +
          '@' +
          dataset.datasetVersion +
          ' corpus=' +
          dataset.corpus.length +
          ' cases=' +
          dataset.cases.length +
          ' sha256=' +
          datasetHash
      );
      return;
    }

    const targetIds =
      options.targetIds.length > 0
        ? options.targetIds
        : [
            dataset.schemaVersion === 'rag-eval-dataset/v2'
              ? 'fixture-hash-dense-v2'
              : 'fixture-hash-dense-v1',
          ];
    const targets = targetIds.map(targetId =>
      createRegisteredTarget(targetId, createDenseBaselineTarget)
    );
    const runId = createRunId(targets.length > 1 ? 'matrix' : 'eval');
    const metadata = {
      runner: 'hermetic-target-registry/v2',
      fixture: path.relative(projectRoot, fixturePath).replaceAll('\\', '/'),
      note: 'Deterministic local baseline; it does not represent a production embedding model.',
    };
    let artifact;
    let evaluatedReports;

    if (targets.length === 1) {
      if (
        options.baselineTargetId !== undefined &&
        options.baselineTargetId !== targets[0].id
      ) {
        throw new Error('--baseline must name the selected target for a single-target run');
      }
      const report = await runRagEval(dataset, targets[0], {
        topK: options.topK,
        runId,
        metadata,
      });
      const gate = evaluateRagEvalGate(report, options.gate);
      artifact = options.gate === 'none' ? report : { ...report, gate };
      evaluatedReports = [{ report, gate }];
    } else {
      const matrix = await runRagEvalMatrix(dataset, targets, {
        topK: options.topK,
        matrixRunId: runId,
        baselineTargetId: options.baselineTargetId,
        metadata,
      });
      const gates = Object.fromEntries(
        matrix.targets.map(item => [
          item.targetId,
          evaluateRagEvalGate(item.report, options.gate),
        ])
      );
      artifact =
        options.gate === 'none'
          ? matrix
          : {
              ...matrix,
              gates,
            };
      evaluatedReports = matrix.targets.map(item => ({
        report: item.report,
        gate: gates[item.targetId],
      }));
    }

    const outputPath =
      options.outputPath ??
      path.join(
        projectRoot,
        '.codex-tmp',
        'rag-eval',
        dataset.datasetId,
        runId + '.json'
      );
    await writeJsonAtomically(outputPath, artifact);
    printReports(evaluatedReports, outputPath);
    if (evaluatedReports.some(item => !item.gate.passed)) {
      process.exitCode = 2;
    }
  } catch (error) {
    console.error('[rag-eval] ' + formatError(error));
    process.exitCode = 1;
  }
}

class HashingEmbeddings {
  constructor(dimensions = 256, tokenMode = 'mixed') {
    this.dimensions = dimensions;
    this.tokenMode = tokenMode;
  }

  async embedDocuments(texts) {
    return texts.map(text => this.#embed(text));
  }

  async embedQuery(text) {
    return this.#embed(text);
  }

  #embed(text) {
    const vector = new Array(this.dimensions).fill(0);
    const tokens = this.tokenMode === 'words' ? tokenizeWords(text) : tokenize(text);
    for (const token of tokens) {
      const hash = fnv1a(token);
      const index = hash % this.dimensions;
      const sign = (hash & 1) === 0 ? 1 : -1;
      vector[index] += sign;
    }
    const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
    return norm === 0 ? vector : vector.map(value => value / norm);
  }
}

function createRegisteredTarget(targetId, createDenseBaselineTarget) {
  const configurations = {
    'fixture-hash-dense-v1': {
      dimensions: 256,
      tokenMode: 'mixed',
      minimumScore: 0.05,
      relativeThreshold: 0,
    },
    'fixture-hash-dense-v2': {
      // Keep the hermetic baseline large enough that canary identifiers do not
      // alias ordinary corpus tokens and turn an isolation probe into an answer.
      dimensions: 1024,
      tokenMode: 'words',
      minimumScore: 0.05,
      relativeThreshold: 0.5,
    },
    'fixture-hash-dense-v2-strict': {
      dimensions: 4096,
      tokenMode: 'words',
      minimumScore: 0.1,
      relativeThreshold: 0.6,
    },
  };
  const configuration = configurations[targetId];
  if (!configuration) {
    throw new Error(
      'unknown target registry id: ' +
        targetId +
        '; available: ' +
        Object.keys(configurations).join(', ')
    );
  }
  return createDenseBaselineTarget({
    id: targetId,
    policyId: targetId,
    laneId: 'dense-vector-required',
    minimumScore: configuration.minimumScore,
    embeddings: new HashingEmbeddings(
      configuration.dimensions,
      configuration.tokenMode
    ),
    generator: new ExtractiveGenerator(configuration),
  });
}

class ExtractiveGenerator {
  constructor(options = {}) {
    this.minimumScore = options.minimumScore ?? 0.05;
    this.relativeThreshold = options.relativeThreshold ?? 0;
  }

  async generate({ evalCase, evidence }) {
    const candidates = evidence.filter(item => item.score >= this.minimumScore);
    const highestTrustRank = Math.max(
      0,
      ...candidates.map(item => trustRank(item.trustLevel))
    );
    const trustedCandidates = candidates.filter(
      item => trustRank(item.trustLevel) === highestTrustRank
    );
    const topScore = trustedCandidates[0]?.score ?? 0;
    const selectedEvidence = trustedCandidates
      .filter(item => item.score >= topScore * this.relativeThreshold)
      .slice(0, 3);
    const abstained = selectedEvidence.length === 0;
    const answer = abstained
      ? '根据当前知识库无法回答该问题。'
      : selectedEvidence.map(item => item.content).join('\n');
    const inputText = `${evalCase.query}\n${selectedEvidence
      .map(item => item.content)
      .join('\n')}`;

    return {
      answer,
      abstained,
      citations: abstained
        ? []
        : selectedEvidence.map(item => ({
            evidenceId: item.evidenceId,
            startOffset: 0,
            endOffset: item.content.length,
          })),
      inputTokens: estimateTokens(inputText),
      outputTokens: estimateTokens(answer),
      tokenMeasurement: 'estimated',
      costMeasurement: 'unavailable',
    };
  }
}

function trustRank(trustLevel) {
  if (trustLevel === 'trusted') return 3;
  if (trustLevel === 'reviewed') return 2;
  if (trustLevel === 'external') return 1;
  return 1;
}

function tokenize(value) {
  const normalized = value.normalize('NFKC').toLocaleLowerCase();
  const compact = normalized.replace(/\s+/g, '');
  const characters = [...compact];
  const characterNgrams = characters.flatMap((character, index) => {
    const next = characters[index + 1];
    return next === undefined ? [character] : [character, `${character}${next}`];
  });
  const words = normalized.match(/[a-z0-9][a-z0-9._/-]*/g) ?? [];
  return [...characterNgrams, ...words];
}

function tokenizeWords(value) {
  const stopWords = new Set([
    'a',
    'an',
    'and',
    'are',
    'for',
    'is',
    'of',
    'the',
    'to',
    'what',
    'when',
    'which',
  ]);
  return (
    value
      .normalize('NFKC')
      .toLocaleLowerCase()
      .match(/[a-z0-9]+(?:[-_/.:][a-z0-9]+)*/g) ?? []
  ).filter(token => !stopWords.has(token));
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function estimateTokens(value) {
  return Math.max(1, Math.ceil([...value].length / 4));
}

function parseArguments(argumentsList) {
  const options = {
    help: false,
    validateOnly: false,
    topK: 5,
    outputPath: undefined,
    fixturePath: undefined,
    targetIds: [],
    baselineTargetId: undefined,
    gate: 'none',
  };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--validate-only') {
      options.validateOnly = true;
    } else if (argument === '--top-k') {
      const rawValue = argumentsList[index + 1];
      const topK = Number(rawValue);
      if (!Number.isInteger(topK) || topK <= 0) {
        throw new Error('--top-k must be followed by a positive integer');
      }
      options.topK = topK;
      index += 1;
    } else if (argument === '--fixture') {
      const rawValue = argumentsList[index + 1];
      if (rawValue === undefined || rawValue.startsWith('--')) {
        throw new Error('--fixture must be followed by a file path');
      }
      options.fixturePath = path.resolve(process.cwd(), rawValue);
      index += 1;
    } else if (argument === '--target') {
      const rawValue = argumentsList[index + 1];
      if (rawValue === undefined || rawValue.startsWith('--')) {
        throw new Error('--target must be followed by a registry id');
      }
      options.targetIds.push(rawValue);
      index += 1;
    } else if (argument === '--baseline') {
      const rawValue = argumentsList[index + 1];
      if (rawValue === undefined || rawValue.startsWith('--')) {
        throw new Error('--baseline must be followed by a target registry id');
      }
      options.baselineTargetId = rawValue;
      index += 1;
    } else if (argument === '--gate') {
      const rawValue = argumentsList[index + 1];
      if (rawValue !== 'none' && rawValue !== 'e1b') {
        throw new Error('--gate must be followed by none or e1b');
      }
      options.gate = rawValue;
      index += 1;
    } else if (argument === '--output') {
      const rawValue = argumentsList[index + 1];
      if (rawValue === undefined || rawValue.startsWith('--')) {
        throw new Error('--output must be followed by a file path');
      }
      options.outputPath = path.resolve(process.cwd(), rawValue);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

async function writeJsonAtomically(outputPath, value) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, outputPath);
}

function createRunId(prefix) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return prefix + '-' + timestamp + '-' + randomUUID().slice(0, 8);
}

function printReports(evaluatedReports, outputPath) {
  for (const { report, gate } of evaluatedReports) {
    const summary = report.summary;
    const securityViolations = Object.values(summary.security).reduce(
      (total, value) => total + value,
      0
    );
    console.log(
      '[rag-eval] run=' +
        report.runId +
        ' target=' +
        report.target.id +
        ' completed=' +
        summary.completedCases +
        '/' +
        summary.totalCases +
        ' failed=' +
        summary.failedCases
    );
    console.log(
      '[rag-eval] recall@' +
        report.configuration.topK +
        '=' +
        formatMetric(summary.meanRecallAtK) +
        ' mrr@' +
        report.configuration.topK +
        '=' +
        formatMetric(summary.meanReciprocalRankAtK) +
        ' ndcg@' +
        report.configuration.topK +
        '=' +
        formatMetric(summary.meanNdcgAtK) +
        ' factCoverage=' +
        formatMetric(summary.meanRequiredFactCoverage) +
        ' abstainAccuracy=' +
        formatMetric(summary.abstainAccuracy)
    );
    console.log(
      '[rag-eval] citationValidity=' +
        formatMetric(summary.citation.meanValidity) +
        ' citationPrecision=' +
        formatMetric(summary.citation.meanPrecision) +
        ' citationCoverage=' +
        formatMetric(summary.citation.meanCoverage) +
        ' unanswerableTPR=' +
        formatMetric(summary.abstain.unanswerableTruePositiveRate) +
        ' answerableFPR=' +
        formatMetric(summary.abstain.answerableFalsePositiveRate) +
        ' securityViolations=' +
        securityViolations
    );
    if (!gate.passed) {
      console.error(
        '[rag-eval] gate=' +
          gate.profile +
          ' FAILED findings=' +
          gate.findings.map(finding => finding.code).join(',')
      );
    }
  }
  console.log('[rag-eval] report=' + outputPath);
}

function formatMetric(value) {
  return value === null ? 'n/a' : value.toFixed(4);
}

function formatError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function printHelp() {
  console.log(`Usage: node scripts/run-rag-eval.mjs [options]

Options:
  --validate-only   Validate the fixture and print its content hash without running a target.
  --fixture <path>  Select a V1 or V2 fixture JSON file.
  --target <id>     Run a registered target; repeat for a cross-policy matrix.
  --baseline <id>   Select the matrix baseline target.
  --gate <profile>  Gate profile: none or e1b (default: none).
  --top-k <number>  Retrieval depth (default: 5).
  --output <path>   Override the JSON report path.
  --help, -h        Show this help.

Registered targets:
  fixture-hash-dense-v1
  fixture-hash-dense-v2
  fixture-hash-dense-v2-strict
`);
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

await main();

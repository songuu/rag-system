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
  'production-policy-contract-v1.json'
);
const defaultOutputPath = path.join(
  projectRoot,
  '.codex-tmp',
  'rag-eval',
  'production-policy-contract',
  'report.json'
);

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(
        'Usage: node scripts/run-production-policy-contract-eval.mjs ' +
          '[--fixture <path>] [--output <path>]'
      );
      return;
    }
    const [{ runProductionPolicyContractEval }, { productionPolicyContractTarget }] =
      await Promise.all([
        import('../src/lib/rag/eval/production-policy-contract.ts'),
        import('../src/lib/rag/eval/production-policy-target.ts'),
      ]);
    const fixturePath = options.fixturePath ?? defaultFixturePath;
    const outputPath = options.outputPath ?? defaultOutputPath;
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
    const report = await runProductionPolicyContractEval(
      fixture,
      productionPolicyContractTarget
    );
    await writeJsonAtomically(outputPath, report);
    console.log(
      '[rag-production-contract] suite=' +
        report.suite.id +
        '@' +
        report.suite.version +
        ' target=' +
        report.target.id
    );
    console.log(
      '[rag-production-contract] passed=' +
        report.passedCases +
        '/' +
        report.totalCases +
        ' failed=' +
        report.failedCases +
        ' executionMode=hermetic-in-process externalServicePolicy=disabled' +
        ' productionQualityMeasured=false'
    );
    if (!report.passed) {
      console.error(
        '[rag-production-contract] findings=' +
          report.cases
            .filter(item => item.status !== 'passed')
            .map(item => `${item.caseId}:${item.status}`)
            .join(',')
      );
      process.exitCode = 2;
    }
    console.log('[rag-production-contract] report=' + outputPath);
  } catch (error) {
    console.error(
      '[rag-production-contract] ' +
        (error instanceof Error ? error.message : String(error))
    );
    process.exitCode = 1;
  }
}

function parseArguments(argumentsList) {
  const options = {
    help: false,
    fixturePath: undefined,
    outputPath: undefined,
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--fixture' || argument === '--output') {
      const value = argumentsList[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${argument} must be followed by a file path`);
      }
      const resolved = path.resolve(process.cwd(), value);
      if (argument === '--fixture') options.fixturePath = resolved;
      else options.outputPath = resolved;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

async function writeJsonAtomically(outputPath, value) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, outputPath);
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

await main();

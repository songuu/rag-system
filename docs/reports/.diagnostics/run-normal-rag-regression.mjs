import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDurableFirstPostDiagnosticMessage } from '../../../src/app/api/ask/durable-response-diagnostic.test-support.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const runnerFile = fileURLToPath(import.meta.url);
const root = fs.realpathSync(path.resolve(path.dirname(runnerFile), '../../..'));
const inventoryFile = 'docs/reports/.diagnostics/normal-rag-regression-v1.inventory.json';
const authorityFile = 'docs/reports/.diagnostics/closed-rag-observer-run.cjs';
const orderedListSha = '40c0685c909520864d5a2e6bd979080cb04a3a0034ccb4f1c76caf8cfa36f274';
const nodeArguments = ['--test', '--test-timeout=30000'];
const report = {
  name: 'normalRagRegression60', started: new Date().toISOString(), passed: false,
  executionProfile: 'local-reference', productionAccepted: false, historicalOrderRecovered: false,
};
let phase = 'preflight';

function requireCondition(value) {
  if (!value) throw new Error('Local regression precondition failed.');
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, windowsHide: true });
  requireCondition(result.status === 0);
  return result.stdout;
}

function sourceSnapshot() {
  // Limit inventory discovery to code/config. Never enumerate runtime data or
  // original session directories just to prove a test run did not modify them.
  const files = git(['ls-files', '-co', '--exclude-standard', '-z', '--',
    'src', 'scripts', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json',
    'eslint.config.mjs', 'next.config.ts', 'next-env.d.ts']).toString('utf8').split('\0').filter(Boolean);
  files.push(inventoryFile, authorityFile, path.relative(root, runnerFile));
  return new Map([...new Set(files)].sort().map(file => [file, sha(fs.readFileSync(path.join(root, file)))]));
}

function closedFailureCatalog(stdout, files) {
  const firstResponseFromError = block => {
    const at = block.findIndex(line => line.startsWith('  error: '));
    if (at < 0) return null;
    const value = block[at].slice('  error: '.length);
    if (value === '|-' || value === '|') {
      const matches = [];
      for (let i = at + 1; i < block.length; i += 1) {
        if (/^  \S/.test(block[i])) break;
        if (!block[i].startsWith('    ')) continue;
        const parsed = parseDurableFirstPostDiagnosticMessage(block[i].slice(4));
        if (parsed !== null) matches.push(parsed);
      }
      return matches.length === 1 ? matches[0] : null;
    }
    if (value.length > 8192) return null;
    if (value.startsWith("'") && value.endsWith("'")) {
      return parseDurableFirstPostDiagnosticMessage(value.slice(1, -1).replaceAll("''", "'"));
    }
    if (value.startsWith('"') && value.endsWith('"')) {
      try { return parseDurableFirstPostDiagnosticMessage(JSON.parse(value)); } catch { return null; }
    }
    return null;
  };
  const ownedSources = files.map((file, fileIndex) => {
    const absolute = path.join(root, file);
    return { fileIndex, prefixes: [absolute.replaceAll('\\', '/'), pathToFileURL(absolute).href],
      lines: fs.readFileSync(absolute, 'utf8').split(/\r?\n/) };
  });
  const lines = stdout.split(/\r?\n/);
  const failures = [];
  let truncated = false;
  for (let i = 0; i < lines.length; i += 1) {
    const label = /^not ok \d+ - (.+)$/.exec(lines[i]);
    if (!label) continue;
    if (failures.length === 64) { truncated = true; break; }
    const block = [];
    let terminated = false;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^(?:not )?ok \d+ - |^# Subtest:/.test(lines[j])) break;
      if (block.length === 200) { truncated = true; break; }
      block.push(lines[j]);
      if (lines[j] === '  ...') { terminated = true; break; }
    }
    if (!terminated) truncated = true;
    // Only real YAML fields at this indentation are read. Error/body literals
    // are never logs and cannot inject code/operator/numeric fields.
    const field = (key, allowed) => {
      const line = block.find(value => value.startsWith(`  ${key}: `));
      if (line === undefined) return null;
      const match = /^  [A-Za-z]+: (?:(['"])([A-Za-z0-9_-]+)\1|([A-Za-z0-9_-]+))$/.exec(line);
      const value = match?.[2] ?? match?.[3];
      return allowed.includes(value) ? value : 'other';
    };
    const failure = { labelSha: sha(label[1]),
      failureType: field('failureType', ['testCodeFailure', 'testTimeoutFailure', 'cancelledByParent', 'hookFailed', 'parentAlreadyFinished']),
      errorCode: field('code', ['ERR_ASSERTION', 'ERR_TEST_FAILURE', 'ERR_TEST_TIMEOUT', 'ERR_TEST_CODE_FAILURE', 'EPERM', 'EACCES', 'EBUSY', 'ENOENT', 'ETIMEDOUT']),
      operator: field('operator', ['strictEqual', 'deepStrictEqual', 'equal', 'ok', 'rejects', 'throws', 'doesNotReject', 'notStrictEqual', 'match', 'doesNotMatch']),
      sourceLocations: [] };
    // This is the assertion's fixed-site, allowlisted response description,
    // never an arbitrary log/body match or an authentication decision.
    const durableFirstResponse = firstResponseFromError(block);
    if (durableFirstResponse !== null) failure.durableFirstResponse = durableFirstResponse;
    for (const key of ['expected', 'actual']) {
      const match = block.find(value => new RegExp(`^  ${key}: [1-5][0-9]{2}$`).test(value));
      if (match) failure[`${key}Numeric`] = Number(match.slice(match.lastIndexOf(' ') + 1));
    }
    let inStack = false;
    const seen = new Set();
    for (const raw of block) {
      if (/^  [A-Za-z]+:/.test(raw)) inStack = raw === '  stack: |-';
      if (!raw.startsWith('  location: ') && !(inStack && raw.startsWith('    '))) continue;
      const normalized = raw.replaceAll('\\', '/');
      for (const source of ownedSources) for (const prefix of source.prefixes) {
        const offset = normalized.indexOf(prefix);
        if (offset < 0 || (offset > 0 && !/[ ('"]/.test(normalized[offset - 1]))) continue;
        const match = /^:(\d+):(\d+)(?=$|[)'"\s])/.exec(normalized.slice(offset + prefix.length));
        if (!match) continue;
        const line = Number(match[1]), column = Number(match[2]);
        if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column)
          || line < 1 || line > source.lines.length || column < 1 || column > source.lines[line - 1].length + 1) continue;
        const identity = `${source.fileIndex}:${line}:${column}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        if (failure.sourceLocations.length === 8) { truncated = true; continue; }
        failure.sourceLocations.push({ fileIndex: source.fileIndex, line, column });
      }
    }
    if (block.some(value => value.includes('Durable fixture execution settled before step entry'))) {
      failure.fixtureEntryFailure = 'durable-before-step';
    } else if (block.some(value => value.includes('Provider execution failed before expected entry'))) {
      failure.fixtureEntryFailure = 'provider-before-entry';
      const context = block.map(value => /Provider execution failed before expected entry \[code=([a-z-]+), phase=([a-z-]+), pending=(true|false|unknown), mutation=(true|false|unknown)\]/.exec(value)).find(Boolean);
      if (context) {
        const codes = ['invalid-config', 'invalid-request', 'busy', 'already-sealed', 'halted', 'publication-mismatch',
          'invalid-clock', 'invalid-key', 'invalid-readback', 'operation-failed', 'operation-timeout', 'provider-contract-invalid'];
        const phases = ['configuration', 'preflight', 'publication-read', 'clock', 'encrypt', 'seal', 'readback', 'decrypt', 'final-validation'];
        failure.providerEntryContext = { code: codes.includes(context[1]) ? context[1] : 'unknown',
          phase: phases.includes(context[2]) ? context[2] : 'unknown', pending: context[3], mutation: context[4] };
      }
    }
    failures.push(failure);
  }
  return { failedDiagnostics: failures, failureDiagnosticsTruncated: truncated };
}

try {
  const inventoryBytes = fs.readFileSync(path.join(root, inventoryFile));
  const inventory = JSON.parse(inventoryBytes.toString('utf8'));
  requireCondition(inventory.schemaVersion === 'rag-local-regression-inventory/v1'
    && inventory.executionProfile === 'local-reference' && inventory.productionAccepted === false
    && inventory.historicalOrderRecovered === false && inventory.defaultConcurrency === true
    && inventory.parentTimeoutMs === 90000 && inventory.maxBufferBytes === 16777216
    && inventory.router === 'off' && JSON.stringify(inventory.nodeArguments) === JSON.stringify(nodeArguments));
  const files = inventory.tests.map(row => row.file);
  requireCondition(files.length === 60 && new Set(files).size === 60
    && sha(JSON.stringify(files)) === orderedListSha && inventory.orderedListSha256 === orderedListSha);
  requireCondition(inventory.authority.base54Source === authorityFile
    && sha(fs.readFileSync(path.join(root, authorityFile))) === inventory.authority.base54SourceSha256
    && sha(JSON.stringify(files.slice(0, 54))) === inventory.authority.base54OrderedListSha256);
  for (const row of inventory.tests) {
    requireCondition(/^(src|scripts)\/[A-Za-z0-9_./-]+\.test\.mjs$/.test(row.file)
      && !row.file.split('/').includes('..')
      && sha(fs.readFileSync(path.join(root, row.file))) === row.sha256);
  }
  report.inventorySha = sha(inventoryBytes);
  report.orderedListSha = orderedListSha;
  report.testFiles = files.length;
  const before = sourceSnapshot();
  report.sourceCountBefore = before.size;
  report.indexBefore = sha(git(['ls-files', '--stage', '-z']));
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, { DATABASE_URL: '', POSTGRES_URL: '', RAG_RELEASE_DIR: '', RAG_SEMANTIC_ROUTER: 'off',
    NEXT_TELEMETRY_DISABLED: '1', LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false', COREPACK_ENABLE_NETWORK: '0' });
  phase = 'run';
  let result;
  try {
    result = spawnSync(process.execPath, [...nodeArguments, ...files], {
      cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 16777216,
    });
  } finally {
    const after = sourceSnapshot();
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(file => before.get(file) !== after.get(file));
    report.sourceCountAfter = after.size;
    report.sourceDriftFileHashes = changed.map(file => sha(file));
    report.indexAfter = sha(git(['ls-files', '--stage', '-z']));
    report.sourceFreezePassed = changed.length === 0 && report.indexBefore === report.indexAfter;
  }
  phase = 'test-result';
  const stdout = result.stdout ?? '';
  const entries = [...stdout.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)];
  const counts = Object.fromEntries(entries.map(match => [match[1], Number(match[2])]));
  report.status = Number.isInteger(result.status) ? result.status : null;
  report.spawnErrored = Boolean(result.error);
  report.counts = counts;
  report.stdoutSha = sha(stdout);
  report.stderrSha = sha(result.stderr ?? '');
  report.failedLabelHashes = [...stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => sha(match[1]));
  Object.assign(report, closedFailureCatalog(stdout, files));
  report.passed = result.status === 0 && !result.error && report.sourceFreezePassed
    && entries.length === 6 && counts.tests > 0 && counts.pass === counts.tests
    && ['fail', 'cancelled', 'skipped', 'todo'].every(key => counts[key] === 0);
} catch {
  // Child output, exceptions, credentials and response bodies are never logs.
  report.failureStage = phase;
} finally {
  report.ended = new Date().toISOString();
  console.log(JSON.stringify(report));
  process.exitCode = report.passed ? 0 : 1;
}

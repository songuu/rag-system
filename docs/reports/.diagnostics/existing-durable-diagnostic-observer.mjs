import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import ts from 'typescript';

const legacyUrl = new URL('./closed-rag-observer-run.cjs', import.meta.url);
const normalUrl = new URL('./run-normal-rag-regression.mjs', import.meta.url);
const legacySha = 'c75df5c033fa242879880c0dfd1fca8b009832fef72b678761bb38d07bfa2dfb';
const normalSha = '915eb0f5b64cab49b28bc468555a765c8c835121e92662de37895421b940bad2';
const sha = value => createHash('sha256').update(value).digest('hex');
const boundedInteger = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max ? value : null;

function parsed(source) {
  const file = ts.createSourceFile('frozen-diagnostic.cjs', source, ts.ScriptTarget.Latest, true);
  if (file.parseDiagnostics.length) throw Error('Invalid frozen diagnostic syntax.');
  return file;
}

function uniqueVariable(file, name) {
  const found = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (found.length !== 1) throw Error('Ambiguous frozen diagnostic declaration.');
  return found[0].initializer;
}

export function extractFrozenDiagnosticReader(source) {
  if (typeof source !== 'string' || sha(source) !== legacySha) throw Error('Invalid frozen legacy source.');
  const file = parsed(source);
  const catalog = uniqueVariable(file, 'DIAGNOSTIC_CODES');
  const body = uniqueVariable(file, 'body');
  if (!ts.isArrayLiteralExpression(catalog) || !ts.isStringLiteral(body)) throw Error('Invalid frozen parser layout.');
  const bodyFile = parsed(body.text);
  const reader = uniqueVariable(bodyFile, 'diagnosticRecords');
  if (!ts.isArrowFunction(reader)) throw Error('Invalid frozen parser entry.');
  // Reuse only the pinned text reader, never the legacy CLI, preload or source patches.
  const context = vm.createContext({});
  vm.runInContext(`const __read = (${reader.getText(bodyFile)});`, context, { timeout: 1000 });
  const codes = new Set(Array.from(vm.runInContext(catalog.getText(file), context, { timeout: 1000 })));
  return {
    codes,
    read(stdout) {
      if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 16 * 1024 * 1024) {
        throw Error('Invalid diagnostic input contract.');
      }
      context.__input = stdout;
      try { return vm.runInContext('__read(__input)', context, { timeout: 1000 }); }
      finally { delete context.__input; }
    },
  };
}

export function parseExistingDurableDiagnostics(stdout) {
  const result = { schemaVersion: 'existing-durable-diagnostic-text/v1', productionAccepted: false,
    attribution: 'unproven', complete: false, diagnosticsObserved: false, truncated: false, records: [] };
  if (typeof stdout !== 'string') return { ...result, reason: 'input-contract' };
  if (Buffer.byteLength(stdout) > 16 * 1024 * 1024) return { ...result, reason: 'output-too-large' };
  try {
    const { read, codes } = extractFrozenDiagnosticReader(readFileSync(legacyUrl, 'utf8'));
    const raw = read(stdout);
    const frames = (stdout.match(/^# \[Ask API\] durable failure diagnostic \{/gm) ?? []).length;
    result.truncated = raw.length > 128;
    result.records = Array.from(raw.slice(0, 128), row => ({
      requestIdHash: typeof row.requestIdHash === 'string' && /^[a-f0-9]{64}$/.test(row.requestIdHash) ? row.requestIdHash : null,
      stage: ['durable-catch', 'durable-return'].includes(row.stage) ? row.stage : null,
      status: boundedInteger(row.status, 100, 599),
      publicCode: codes.has(row.publicCode) ? row.publicCode : null,
      mappedCode: codes.has(row.mappedCode) ? row.mappedCode : null,
      codeChain: Array.from(row.codeChain.slice(0, 8), code => codes.has(code) ? code : 'UNCLASSIFIED'),
      causeDepth: boundedInteger(row.causeDepth, 0, 8),
      chainTermination: ['end', 'depth-limit', 'cycle', 'accessor', 'proxy', 'non-object', 'uninspectable'].includes(row.chainTermination)
        ? row.chainTermination : null,
    }));
    result.diagnosticsObserved = result.records.length > 0;
    result.complete = !result.truncated && frames === raw.length;
    return { ...result, reason: result.complete ? null : 'incomplete-observation' };
  } catch {
    return { ...result, reason: 'parser-incomplete' };
  }
}

function spawnCalls(source) {
  const file = parsed(source), calls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'spawnSync') calls.push(node.getText(file));
    ts.forEachChild(node, visit);
  }
  visit(file);
  return calls;
}

function replaceUnique(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Invalid frozen parent anchor.');
  return source.replace(before, after);
}

export function prepareObservedParent(source) {
  if (typeof source !== 'string' || sha(source) !== normalSha) throw Error('Invalid frozen normal runner.');
  let changed = replaceUnique(source, "name: 'normalRagRegression60'", "name: 'existingSafeDurableDiagnosticObservation60'");
  changed = replaceUnique(changed, '  report.stdoutSha = sha(stdout);',
    '  report.stdoutSha = sha(stdout);\n  report.existingDurableDiagnostics = __readSafeDurableDiagnostics(stdout);');
  if (JSON.stringify(spawnCalls(source)) !== JSON.stringify(spawnCalls(changed))) throw Error('Child spawn expressions changed.');
  return Object.freeze({ source: changed, sourceSha: sha(changed), normalRunnerSha: normalSha,
    childSpawnCallsPreserved: true, productionAccepted: false });
}

function runObservation() {
  if (process.argv.length !== 2 || process.env.NODE_TEST_CONTEXT) throw Error('Unsupported observation CLI context.');
  const ownUrl = new URL(import.meta.url), ownBefore = sha(readFileSync(ownUrl));
  const legacyBefore = sha(readFileSync(legacyUrl));
  const prepared = prepareObservedParent(readFileSync(normalUrl, 'utf8'));
  const code = transformSync(prepared.source, { format: 'cjs', target: 'es2022',
    define: { 'import.meta.url': JSON.stringify(normalUrl.href) } }).code;
  const testModule = { exports: {} };
  console.log(JSON.stringify({ name: 'existingSafeDiagnosticParentIdentity', observerSha: ownBefore,
    normalRunnerSha: prepared.normalRunnerSha, memoryParentSha: prepared.sourceSha,
    childSpawnCallsPreserved: true, preloadAdded: false, productionAccepted: false }));
  try {
    vm.runInNewContext(code, { require: createRequire(normalUrl), module: testModule, exports: testModule.exports,
      process, console, Buffer, __readSafeDurableDiagnostics: parseExistingDurableDiagnostics,
      __filename: fileURLToPath(normalUrl), __dirname: path.dirname(fileURLToPath(normalUrl)) });
  } finally {
    const frozen = ownBefore === sha(readFileSync(ownUrl)) && legacyBefore === sha(readFileSync(legacyUrl));
    console.log(JSON.stringify({ name: 'existingSafeDiagnosticObserverFreeze', passed: frozen, productionAccepted: false }));
    if (!frozen) process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runObservation(); }
  catch {
    console.log(JSON.stringify({ name: 'existingSafeDiagnosticParentRejected', code: 'observation-parent-failed', productionAccepted: false }));
    process.exitCode = 2;
  }
}

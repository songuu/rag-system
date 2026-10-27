import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const hash = text => createHash('sha256').update(text).digest('hex');
const response = sequence => ({
  sequence, type: 'post-response', caseTag: 'aaaaaaaaaaaaaaaa',
  postSite: 1, requestOrdinal: sequence, category: null, writerOrdinal: null, status: 200,
});
const trace = records => ({
  schemaVersion: 'rag-closed-test-trace/v1', productionAccepted: false,
  overflow: false, observerFailures: 0, ioCalls: 0, totals: {}, records,
});
const line = value => '# RAG_CLOSED_TRACE ' + JSON.stringify(value) + '\n';
const fixtureCount = process.env.CLOSED_OBSERVER_SYNTHETIC_RECORDS;

if (fixtureCount !== undefined) {
  const size = Number(fixtureCount);
  if (![64, 512, 2048].includes(size)) throw new Error('invalid synthetic trace size');
  test('closed observer synthetic TAP fixture', () => {});
  // Reproduce the existing observer; transport metadata is inspected by the parent.
  process.on('exit', () => console.log('RAG_CLOSED_TRACE ' + JSON.stringify(trace(
    Array.from({ length: size }, (_, i) => response(i + 1)),
  ))));
} else {
  let subject = null;
  try { subject = createRequire(import.meta.url)('./closed-rag-observer-run.cjs'); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

  test('isolated TAP exit output exposes transport shape without raw content', () => {
    let allComplete = true;
    for (const size of [64, 512, 2048]) {
      const childEnv = { ...process.env, CLOSED_OBSERVER_SYNTHETIC_RECORDS: String(size) };
      // A nested Node test must use its own TAP channel, not inherit child-v8 transport.
      delete childEnv.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, [
        '--max-old-space-size=128', '--test', '--test-timeout=30000', fileURLToPath(import.meta.url),
      ], {
        encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
        env: childEnv,
      });
      assert.equal(child.status, 0);
      const allRows = child.stdout.split(/\r?\n/);
      const candidates = allRows.filter(row => row.startsWith('# RAG_CLOSED_TRACE '));
      const expected = JSON.stringify(trace(Array.from({ length: size }, (_, i) => response(i + 1))));
      const shapes = candidates.map(row => {
        const payload = row.slice('# RAG_CLOSED_TRACE '.length);
        let jsonValid = false;
        try { JSON.parse(payload); jsonValid = true; } catch { /* Report only closed shape. */ }
        return {
          bytes: Buffer.byteLength(payload), expectedBytes: Buffer.byteLength(expected),
          jsonValid, endsWithBrace: payload.endsWith('}'),
          anotherPrefix: payload.includes('# '), sha256: hash(payload),
        };
      });
      console.log(JSON.stringify({ name: 'syntheticTapShape', size, shapes,
        stdoutBytes: Buffer.byteLength(child.stdout), stdoutSha: hash(child.stdout),
        followingRows: allRows.slice(allRows.indexOf(candidates[0]) + 1, allRows.indexOf(candidates[0]) + 5).map(row => ({
          bytes: Buffer.byteLength(row), comment: row.startsWith('# '), endsWithBrace: row.endsWith('}'),
        })), stderrSha: hash(child.stderr), productTests: 0 }));
      assert.equal(candidates.length, 1);
      // This is a transport baseline, not proof of the previous full-run trace.
      const decoded = subject.parseClosedTraceOutput(child.stdout);
      allComplete &&= decoded.complete && decoded.traces.length === 1
        && decoded.traces[0].records.length === size && decoded.frames[0].sha256 === hash(expected);
    }
    assert.equal(allComplete, true);
  });

  test('closed trace parser accepts a genuine bounded trace', () => {
    const parsed = subject.parseClosedTraceOutput(line(trace([response(1)])));
    assert.equal(parsed.complete, true);
    assert.equal(parsed.traces.length, 1);
    assert.equal(parsed.traces[0].records[0].status, 200);
  });

  test('malformed trace is isolated and later valid trace is retained', () => {
    const bad = '# RAG_CLOSED_TRACE {"PRIVATE_SENTINEL":\n';
    const parsed = subject.parseClosedTraceOutput(bad + line(trace([response(1)])));
    assert.equal(parsed.complete, false);
    assert.equal(parsed.traces.length, 1);
    assert.equal(parsed.rejections[0].reason, 'invalid-json');
    assert.equal(parsed.rejections[0].sha256, hash(bad.trimEnd().slice('# RAG_CLOSED_TRACE '.length)));
    assert.equal(JSON.stringify(parsed).includes('PRIVATE_SENTINEL'), false);
  });

  test('unknown fields, nonclosed metadata, wrong schema and forged production flags are rejected', () => {
    for (const mutate of [
      t => { t.private = 'PRIVATE_SENTINEL'; },
      t => { t.records[0].status = 'PRIVATE_SENTINEL'; },
      t => { t.records[0].caseTag = 'PRIVATE_SENTINEL'; },
      t => { t.records[0].headers = 'PRIVATE_SENTINEL'; },
      t => { t.totals['PRIVATE_SENTINEL'] = 1; },
      t => { t.schemaVersion = 'other/v1'; },
      t => { t.productionAccepted = true; },
      t => { t.records[0].sequence = -1; },
      t => { t.records[0].type = 'PRIVATE_SENTINEL'; },
    ]) {
      const value = trace([response(1)]); mutate(value);
      const parsed = subject.parseClosedTraceOutput(line(value));
      assert.equal(parsed.complete, false);
      assert.equal(parsed.traces.length, 0);
      assert.equal(parsed.rejections[0].reason, 'invalid-schema');
      assert.equal(JSON.stringify(parsed).includes('PRIVATE_SENTINEL'), false);
    }
  });

  test('overflow, observer failure and missing traces remain incomplete', () => {
    for (const value of [
      { ...trace([response(1)]), overflow: true },
      { ...trace([response(1)]), observerFailures: 1 },
    ]) {
      assert.equal(subject.parseClosedTraceOutput(line(value)).complete, false);
    }
    assert.equal(subject.parseClosedTraceOutput('# tests 1044\n').complete, false);
  });

  test('input contracts and payload/record/trace bounds fail closed', () => {
    let hooks = 0;
    const input = { toString() { hooks++; return 'PRIVATE_SENTINEL'; } };
    assert.equal(subject.parseClosedTraceOutput(input).complete, false);
    assert.equal(hooks, 0);
    assert.equal(subject.parseClosedTraceOutput('# RAG_CLOSED_TRACE ' + 'x'.repeat(4 * 1024 * 1024 + 1)).rejections[0].reason, 'oversized');
    assert.equal(subject.parseClosedTraceOutput(line(trace(Array.from({ length: 4097 }, (_, i) => response(i + 1))))).complete, false);
    assert.equal(subject.parseClosedTraceOutput(Array.from({ length: 65 }, () => line(trace([response(1)]))).join('')).complete, false);
  });

  test('final file freeze runs after observation throws without exposing the Error', () => {
    const calls = [];
    const result = subject.observeWithFinalFreeze(
      () => { calls.push('observe'); throw new Error('PRIVATE_SENTINEL'); },
      () => { calls.push('freeze'); },
    );
    assert.deepEqual(calls, ['observe', 'freeze']);
    assert.equal(result.observationStatus, 'failed');
    assert.equal(result.freezeStatus, 'completed');
    assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'), false);
  });

  test('comment fragment count is bounded independently of payload size', () => {
    const input = '# RAG_CLOSED_TRACE {\n' + '# \n'.repeat(1025);
    const parsed = subject.parseClosedTraceOutput(input);
    assert.equal(parsed.complete, false);
    assert.equal(parsed.rejections[0].reason, 'too-many-fragments');
    assert.equal(parsed.rejections[0].fragments, 1024);
  });

  test('matched cause requires a prior unique native failure with the exact native context', () => {
    const context = { caseTag: 'aaaaaaaaaaaaaaaa', postSite: 1, requestOrdinal: 1, category: 'root-ledger', writerOrdinal: 1 };
    const native = { ...context, ioSite: 1, moduleId: 'result', method: 'rename', native: true, fsCode: 'EPERM', syscall: 'rename' };
    const failure = { sequence: 1, type: 'native-failure', ...native, ioOrdinal: 1 };
    const cause = { sequence: 2, type: 'native-cause-match', ...context, category: null, writerOrdinal: null,
      match: 'matched', termination: 'end', associationOverflow: false, candidateCount: 1,
      currentRequestCandidateCount: 1, ioOrdinal: 1, nativeContext: native };
    const value = { ...trace([failure, cause]), ioCalls: 1, totals: { 'result:rename': 1 } };
    assert.equal(subject.parseClosedTraceOutput(line(value)).complete, true);
    for (const mutate of [
      t => { t.records[1].nativeContext.caseTag = 'bbbbbbbbbbbbbbbb'; },
      t => { t.records[1].nativeContext.postSite = 2; },
      t => { t.records[1].nativeContext.fsCode = 'EACCES'; },
      t => { t.records[1].nativeContext.writerOrdinal = 2; },
      t => { t.records = [{ ...t.records[1], sequence: 1 }]; },
      t => { t.records = [{ ...t.records[1], sequence: 1 }, { ...t.records[0], sequence: 2 }]; },
      t => { t.records.splice(1, 0, { ...t.records[0], sequence: 2 }); t.records[2].sequence = 3; },
    ]) {
      const changed = JSON.parse(JSON.stringify(value)); mutate(changed);
      assert.equal(subject.parseClosedTraceOutput(line(changed)).complete, false);
    }
  });

  test('unit summaries never copy untrusted TAP lines or private code spellings', () => {
    const input = '# tests PRIVATE_SENTINEL\nnot ok 1 - PRIVATE_SENTINEL\n  expected: 200\n  actual: 503\n';
    const result = subject.summarizeUnitOutput(input);
    assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'), false);
    assert.equal(result.summaryComplete, false);
    assert.equal(result.failedNames.length, 1);
    assert.equal(result.failureDetails[0].expected, 200);
    assert.equal(result.failureDetails[0].actual, 503);
    const valid = subject.summarizeUnitOutput('# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 3.5\n');
    assert.equal(valid.summaryComplete, true);
    assert.equal(valid.stats.tests, 1);
    assert.equal(valid.stats.duration_ms, 3.5);
  });

  test('actual CLI summary keeps legacy status and cause depth numeric and bounded', () => {
    // Exercise the actual embedded run() with a fake process; never dispatch the 54 product files.
    const source = readFileSync(fileURLToPath(new URL('./closed-rag-observer-run.cjs', import.meta.url)), 'utf8');
    const bodyMatch = source.match(/const body = ("(?:\\.|[^"\\])*");/);
    assert.ok(bodyMatch);
    const body = JSON.parse(bodyMatch[1]);
    const functionMatch = body.match(/function run\(name,args\)\{[\s\S]*?\nreturn r\.status===0&&summary\.summaryComplete;\}/);
    const diagnosticMatch = body.match(/const diagnosticRecords=\(out\)=>[\s\S]*?;\nlet decoded = null;/);
    const catalogMatch = source.match(/const DIAGNOSTIC_CODES = (\[[\s\S]*?\]);/);
    assert.ok(functionMatch && diagnosticMatch && catalogMatch);
    const catalog = runInNewContext(catalogMatch[1], {}, { timeout: 1000 });
    for (const [status, depth, expectedStatus, expectedDepth] of [
      ["'PRIVATE_SENTINEL'", "'PRIVATE_SENTINEL'", null, null],
      ["'503'", "'3'", null, null],
      ['99', '9', null, null],
      ['600', '9007199254740993', null, null],
      ['503', '8', 503, 8],
      ['100', '0', 100, 0],
      ['599', '1', 599, 1],
    ]) {
      const logs = [];
      let fakeCalls = 0;
      const input = ['# tests PRIVATE_SENTINEL', 'not ok 1 - PRIVATE_SENTINEL',
        '# [Ask API] durable failure diagnostic {', '#   status: ' + status + ',',
        '#   causeDepth: ' + depth + ',', "#   publicCode: 'PRIVATE_SENTINEL',",
        "#   mappedCode: 'PRIVATE_SENTINEL',", "#   codeChain: ['PRIVATE_SENTINEL'],", '# }', ''].join('\n');
      const sandbox = {
        cp: { spawnSync() { fakeCalls++; return { status: 1, stdout: input, stderr: '' }; } },
        process: { execPath: 'synthetic-node', env: {} },
        console: { log(text) { logs.push(text); } }, Buffer,
        parseClosedTraceOutput: subject.parseClosedTraceOutput,
        summarizeUnitOutput: subject.summarizeUnitOutput,
        DIAGNOSTIC_CODES: catalog, digest: hash, testDispatchStarted: false,
      };
      runInNewContext(diagnosticMatch[0] + '\n' + functionMatch[0] + "\nrun('synthetic-summary', []);", sandbox, { timeout: 1000 });
      const observed = JSON.parse(logs[0]);
      assert.equal(fakeCalls, 1);
      assert.equal(observed.diagnosticRecords.length, 1);
      assert.equal(observed.diagnosticRecords[0].status, expectedStatus);
      assert.equal(observed.diagnosticRecords[0].causeDepth, expectedDepth);
      assert.equal(JSON.stringify(observed).includes('PRIVATE_SENTINEL'), false);
    }
  });

  test('ordinary rejected unsupported carriers do not print the original Error', () => {
    const program = 'const subject=require(' + JSON.stringify(fileURLToPath(new URL('./closed-rag-observer-run.cjs', import.meta.url)))
      + ');const result=subject.observeWithFinalFreeze(()=>Promise.reject(Error("PRIVATE_SENTINEL")),()=>{});console.log(JSON.stringify(result));';
    const child = spawnSync(process.execPath, ['--max-old-space-size=128', '--unhandled-rejections=strict', '-e', program], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
    });
    assert.equal(child.status, 0);
    assert.equal(child.stderr.includes('PRIVATE_SENTINEL'), false);
    const result = JSON.parse(child.stdout);
    assert.equal(result.observationStatus, 'failed');
    assert.equal(result.freezeStatus, 'completed');
    assert.equal(result.unsupportedCompletionUnknown, true);
  });

  test('freeze failure is explicit and async callbacks cannot be called complete', () => {
    const result = subject.observeWithFinalFreeze(() => {}, () => { throw new Error('PRIVATE_SENTINEL'); });
    assert.equal(result.observationStatus, 'completed');
    assert.equal(result.freezeStatus, 'failed');
    assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'), false);
    const pending = subject.observeWithFinalFreeze(() => Promise.resolve(), () => Promise.resolve());
    assert.equal(pending.observationStatus, 'failed');
    assert.equal(pending.freezeStatus, 'failed');
  });
}

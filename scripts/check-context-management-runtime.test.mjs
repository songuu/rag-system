import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('./check-context-management-runtime.mjs', import.meta.url));
const secret = 'SYNTHETIC_SECRET_RESPONSE_OR_ERROR';

// Load the entire real CLI, not a hand-copied function. Only the owned transport,
// subprocess and clock are mocked; preflight reads a real, empty owned artifact.
async function executeIsolatedChecker() {
  const { SourceTextModule, SyntheticModule, createContext } = await import('node:vm');
  const { EventEmitter } = await import('node:events');
  const fs = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const [script, scenario] = process.argv.slice(1);
  const secret = 'SYNTHETIC_SECRET_RESPONSE_OR_ERROR';
  const calls = { requests: [], requestTimeouts: [], timers: [], kills: [], delays: [], errorReads: 0, spawnEnv: null };
  const output = [];
  let now = Date.now();
  let deadlineCallback;
  let child;
  let requestIndex = 0;
  const expected = { success: false, error: 'This legacy RAG route is disabled outside local development.', code: 'LEGACY_RAG_ROUTE_DISABLED' };
  const contextProcess = { execPath: process.execPath, env: { PATH: process.env.PATH, SYNTHETIC_PRIVATE_CREDENTIAL: secret }, exitCode: 0 };
  class Clock extends Date { static now() { return now; } }
  const fakeDelay = async (milliseconds) => { calls.delays.push(milliseconds); now += milliseconds; await Promise.resolve(); };
  const fakeSpawn = (_executable, _arguments, options) => {
    calls.spawnEnv = options.env;
    child = new EventEmitter();
    child.pid = 12345;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (signal) => {
      calls.kills.push(signal ?? 'default');
      if (scenario !== 'cleanup') queueMicrotask(() => child.emit('close', 0));
      return true;
    };
    queueMicrotask(() => {
      if (scenario === 'startup-closed') child.emit('close', 1);
      else if (scenario === 'startup-error') child.emit('error', new Error(secret));
      else if (scenario !== 'startup-timeout') child.stdout.emit('data', Buffer.from(`Ready in 1 ms :${options.env.PORT}`));
    });
    return child;
  };
  const fakeNet = {
    createServer() {
      const socket = new EventEmitter();
      socket.listen = (options, done) => { assertLoopback(options.host); done(); };
      socket.address = () => ({ port: 49152 });
      socket.close = (done) => done();
      return socket;
    },
  };
  function assertLoopback(host) { if (host !== '127.0.0.1') throw new Error('Non-loopback fake transport.'); }
  const fakeHttp = {
    request(options, receive) {
      assertLoopback(options.hostname);
      calls.requests.push(options);
      const req = new EventEmitter();
      let timeoutCallback;
      req.setTimeout = (milliseconds, callback) => { calls.requestTimeouts.push(milliseconds); timeoutCallback = callback; };
      req.destroy = (error) => { req.emit('error', error); return req; };
      req.end = (body) => {
        calls.requests.at(-1).body = body;
        requestIndex += 1;
        queueMicrotask(() => {
          const failing = scenario !== 'success' && scenario !== 'cleanup' && requestIndex === (scenario === 'second-status' ? 2 : 1);
          if (failing && scenario === 'request-timeout') return timeoutCallback();
          if (failing && scenario === 'deadline') { deadlineCallback(); return req.emit('error', new Error(secret)); }
          if (failing && scenario === 'socket') return req.emit('error', new Error(secret));
          if (failing && scenario === 'forged-code') {
            const error = new Error(secret);
            Object.defineProperty(error, 'code', { get() { calls.errorReads += 1; throw new Error(secret); } });
            return req.emit('error', error);
          }
          if (failing && scenario === 'forged-code-data') return req.emit('error', Object.assign(new Error(secret), { code: secret }));
          if (failing && scenario === 'forged-proxy') {
            const error = new Proxy({}, { get() { calls.errorReads += 1; throw new Error(secret); }, getOwnPropertyDescriptor() { calls.errorReads += 1; throw new Error(secret); }, getPrototypeOf() { calls.errorReads += 1; throw new Error(secret); } });
            return req.emit('error', error);
          }
          if (failing && scenario === 'forged-kind') return req.emit('error', { kind: 'request-timeout', code: secret, message: secret, stack: secret, cause: secret });
          const res = new EventEmitter();
          res.statusCode = failing && ['status', 'second-status'].includes(scenario) ? 503 : 410;
          res.headers = { 'content-type': failing && scenario === 'content-type' ? secret : 'application/json; charset=utf-8' };
          receive(res);
          const payload = failing && scenario === 'response-budget' ? secret.repeat(200)
            : failing && scenario === 'json' ? secret
              : JSON.stringify(failing && scenario === 'body' ? { secret } : expected);
          res.emit('data', Buffer.from(payload));
          res.emit('end');
        });
      };
      return req;
    },
  };
  const context = createContext({
    Buffer, Date: Clock, console: { log: (value) => output.push(value) }, process: contextProcess,
    setTimeout: (callback, milliseconds) => { calls.timers.push(milliseconds); deadlineCallback = callback; return 1; },
    clearTimeout: () => {},
  });
  const mocks = new Map([
    ['node:child_process', { spawn: fakeSpawn }], ['node:http', { default: fakeHttp }],
    ['node:net', { default: fakeNet }], ['node:timers/promises', { setTimeout: fakeDelay }],
  ]);
  const cliModule = new SourceTextModule(fs.readFileSync(script, 'utf8'), {
    context, identifier: pathToFileURL(script).href,
    initializeImportMeta(meta) { meta.url = pathToFileURL(script).href; },
  });
  await cliModule.link(async (specifier) => {
    const exports = mocks.get(specifier) ?? await import(specifier);
    const names = Object.keys(exports);
    const dependency = new SyntheticModule(names, function () { for (const name of names) this.setExport(name, exports[name]); }, { context });
    return dependency;
  });
  try { await cliModule.evaluate(); }
  catch { console.log(JSON.stringify({ escaped: true, output, calls })); return; }
  console.log(JSON.stringify({ escaped: false, output, calls, exitCode: contextProcess.exitCode }));
}

function runFixture(t, scenario) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'rag-context-http-observation-'));
  const owner = randomUUID();
  fs.writeFileSync(path.join(root, '.fixture-owner'), owner, { flag: 'wx' });
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('rag-context-http-observation-'));
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    assert.equal(path.relative(root, fs.realpathSync(root)), '');
    assert.equal(fs.readFileSync(path.join(root, '.fixture-owner'), 'utf8'), owner);
    fs.rmSync(root, { recursive: true });
  });
  const artifact = path.join(root, '.next/standalone');
  fs.mkdirSync(path.join(artifact, '.next'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'));
  const copy = path.join(root, 'scripts/check-context-management-runtime.mjs');
  fs.copyFileSync(checker, copy);
  fs.writeFileSync(path.join(artifact, 'server.js'), '// Owned inert fixture; never executed.\n');
  fs.writeFileSync(path.join(artifact, '.next/BUILD_ID'), 'synthetic-build-id');
  fs.writeFileSync(path.join(artifact, '.next/routes-manifest.json'), JSON.stringify({
    basePath: '/synthetic', rewrites: [{ source: '/rag-api/:path*', destination: '/api/:path*' }],
  }));
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', `(${executeIsolatedChecker.toString()})()`, copy, scenario], {
    encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  const evidence = JSON.parse(result.stdout.trim());
  assert.equal(evidence.escaped, false, 'Complete CLI must report failures without throwing.');
  assert.equal(evidence.output.length, 1);
  const reportText = evidence.output[0];
  assert.doesNotMatch(reportText, new RegExp(`${secret}|${root.replaceAll('\\', '\\\\')}|Bearer|synthetic-smoke-id|context-management`));
  return { ...evidence, report: JSON.parse(reportText) };
}

test('complete CLI keeps the exact 28 checks, isolated environment and original budgets', { timeout: 15000 }, (t) => {
  const f = runFixture(t, 'success');
  assert.equal(f.report.passed, true);
  assert.equal(f.report.failure, null);
  assert.equal(f.report.failureDetail, null);
  assert.equal(f.report.completed, 28);
  assert.equal(f.report.attempted, 28);
  assert.equal(f.report.prefixCount, 2);
  assert.equal(f.report.serverClosed, true);
  assert.equal(f.calls.requests.length, 28);
  assert.deepEqual(f.calls.requestTimeouts, Array(28).fill(5000));
  assert.deepEqual(f.calls.timers, [35000]);
  assert.equal(f.calls.spawnEnv.SYNTHETIC_PRIVATE_CREDENTIAL, undefined);
  assert.equal(f.calls.spawnEnv.NODE_ENV, 'production');
  assert.equal(f.calls.spawnEnv.HOSTNAME, '127.0.0.1');
  for (const [index, prefix] of ['/synthetic/api', '/synthetic/rag-api'].entries()) {
    const requests = f.calls.requests.slice(index * 14, index * 14 + 14);
    assert.deepEqual(requests.map((item) => item.method), [...Array(5).fill('GET'), ...Array(8).fill('POST'), 'DELETE']);
    assert.deepEqual(requests.slice(0, 5).map((item) => new URL(item.path, 'http://127.0.0.1').searchParams.get('action')), ['config', 'sessions', 'session', 'status', 'unknown']);
    assert.deepEqual(requests.slice(5, 12).map((item) => JSON.parse(item.body).action), ['query', 'stream-query', 'create-session', 'delete-session', 'compress', 'update-config', 'unknown']);
    assert.ok(requests.every((item) => item.path.startsWith(`${prefix}/context-management`)));
    assert.equal(requests[12].body, '{ malformed synthetic JSON');
  }
  assert.equal(f.report.buildIdSha, createHash('sha256').update('synthetic-build-id').digest('hex'));
  assert.equal(f.report.productionAccepted, false);
});

for (const [scenario, kind, checkStep, status] of [
  ['request-timeout', 'request-timeout', 'transport'], ['response-budget', 'response-budget', 'transport'],
  ['socket', 'socket', 'transport'], ['forged-code', 'socket', 'transport'], ['forged-code-data', 'socket', 'transport'],
  ['forged-proxy', 'socket', 'transport'], ['forged-kind', 'socket', 'transport'],
  ['deadline', 'deadline', 'transport'], ['status', 'status', 'status', 503],
  ['second-status', 'status', 'status', 503], ['content-type', 'content-type', 'content-type', 410],
  ['json', 'json', 'json', 410], ['body', 'body', 'body', 410],
]) {
  test(`complete CLI safely distinguishes ${scenario}`, { timeout: 15000 }, (t) => {
    const f = runFixture(t, scenario);
    const attempted = scenario === 'second-status' ? 2 : 1;
    assert.equal(f.report.passed, false);
    assert.equal(f.exitCode, 1);
    assert.deepEqual(f.report.failureDetail, { kind, checkStep, attempted, completed: attempted - 1, ordinal: attempted, ...(status === undefined ? {} : { status }) });
    assert.equal(f.report.serverClosed, true);
    assert.equal(f.calls.errorReads, 0);
    assert.equal(f.report.attempted, attempted);
    assert.ok(['CHECK_FAILED', 'ERR_ASSERTION'].includes(f.report.failure.code));
  });
}

for (const [scenario, kind] of [['startup-closed', 'startup-closed'], ['startup-error', 'startup-error'], ['startup-timeout', 'startup-timeout']]) {
  test(`complete CLI safely distinguishes ${scenario}`, { timeout: 15000 }, (t) => {
    const f = runFixture(t, scenario);
    assert.deepEqual(f.report.failureDetail, { kind, checkStep: 'startup-ready', attempted: 0, completed: 0 });
    assert.equal(f.report.attempted, 0);
    assert.equal(f.calls.requests.length, 0);
    if (scenario === 'startup-timeout') assert.equal(f.calls.delays.filter((value) => value === 50).length, 300);
  });
}

test('complete CLI distinguishes failed termination proof from passed requests', { timeout: 15000 }, (t) => {
  const f = runFixture(t, 'cleanup');
  assert.equal(f.report.completed, 28);
  assert.equal(f.report.serverClosed, false);
  assert.equal(f.report.passed, false);
  assert.deepEqual(f.report.failure, { stage: 'cleanup', code: 'SERVER_NOT_CLOSED' });
  assert.deepEqual(f.report.failureDetail, { kind: 'cleanup', checkStep: 'cleanup', attempted: 28, completed: 28 });
  assert.deepEqual(f.calls.kills, ['default', 'SIGKILL']);
  assert.deepEqual(f.calls.delays.filter((value) => value === 5000), [5000, 5000]);
});

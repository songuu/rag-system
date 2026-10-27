import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isNativeError } from 'node:util/types';

const workspace = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const artifact = path.join(workspace, '.next', 'standalone');
const expectedBody = {
  success: false, error: 'This legacy RAG route is disabled outside local development.', code: 'LEGACY_RAG_ROUTE_DISABLED',
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requestFailureKinds = new WeakMap();

function requestFailure(kind, message) {
  const error = new Error(message);
  requestFailureKinds.set(error, kind);
  return error;
}

function legacyFailureCode(error) {
  // Never invoke getters or proxy traps on a transport-supplied error. Preserve
  // the original assertion code, but do not print arbitrary provider codes.
  if (!isNativeError(error)) return 'CHECK_FAILED';
  return Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ERR_ASSERTION' ? 'ERR_ASSERTION' : 'CHECK_FAILED';
}

function optionalLstat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

function assertNoPrivateSessionState() {
  const data = path.join(artifact, 'data');
  const info = optionalLstat(data);
  if (!info) return;
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Artifact data parent must not be a link.');
  assert.equal(path.relative(data, fs.realpathSync(data)), '');
  // lstat rejects dangling links too; existsSync would silently accept them.
  assert.equal(optionalLstat(path.join(data, 'context-sessions')), null, 'Artifact must not contain private session state.');
}

function artifactFile(relative) {
  let current = artifact;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const info = fs.lstatSync(current);
    assert.equal(info.isSymbolicLink(), false, 'Artifact input must not be a link.');
    assert.ok(index === parts.length - 1 ? info.isFile() : info.isDirectory());
    assert.equal(path.relative(current, fs.realpathSync(current)), '');
  }
  return current;
}

async function reservePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
  });
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function request(port, target, method, body) {
  return new Promise((resolve, reject) => {
    const headers = { authorization: 'Bearer synthetic-not-authority' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    // Explicit numeric loopback transport: no proxy, redirect or external URL.
    const req = http.request({ hostname: '127.0.0.1', port, path: target, method, headers }, (res) => {
      let bytes = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 4096) req.destroy(requestFailure('response-budget', 'Local response exceeded its check budget.'));
        else chunks.push(chunk);
      });
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    req.setTimeout(5000, () => req.destroy(requestFailure('request-timeout', 'Local request timed out.')));
    req.end(body);
  });
}

async function main() {
  const started = new Date().toISOString();
  const stdoutHash = createHash('sha256');
  const stderrHash = createHash('sha256');
  let stage = 'preflight';
  let checkStep = 'preflight';
  let failure = null;
  let failureDetail = null;
  let server;
  let serverClosed = false;
  let serverError = false;
  let closed;
  let deadline;
  let deadlineExpired = false;
  let completed = 0;
  let attempted = 0;
  let responseStatus;
  let prefixCount = 0;
  let buildIdSha;
  let serverSha;
  const detail = (kind, step = checkStep) => ({
    kind, checkStep: step, attempted, completed,
    ...(stage === 'requests' && attempted > completed ? { ordinal: attempted } : {}),
    ...(Number.isInteger(responseStatus) && responseStatus >= 100 && responseStatus <= 599 ? { status: responseStatus } : {}),
  });
  try {
    assert.equal(fs.lstatSync(path.join(workspace, '.next')).isSymbolicLink(), false);
    assert.equal(path.relative(path.join(workspace, '.next'), fs.realpathSync(path.join(workspace, '.next'))), '');
    assert.equal(fs.lstatSync(artifact).isSymbolicLink(), false);
    assert.equal(path.relative(artifact, fs.realpathSync(artifact)), '');
    assert.ok(!fs.readdirSync(artifact).some((name) => /^\.env(?:\.|$)/i.test(name)), 'Refuse an artifact carrying dotenv files.');
    assertNoPrivateSessionState();
    const entry = artifactFile('server.js');
    const buildId = artifactFile('.next/BUILD_ID');
    const routesManifest = artifactFile('.next/routes-manifest.json');
    buildIdSha = sha(fs.readFileSync(buildId));
    serverSha = sha(fs.readFileSync(entry));
    const manifest = JSON.parse(fs.readFileSync(routesManifest, 'utf8'));
    const basePath = manifest.basePath ?? '';
    assert.ok(basePath === '' || /^\/[A-Za-z0-9/_-]+$/.test(basePath));
    const prefixes = [`${basePath}/api`];
    const rewrites = Array.isArray(manifest.rewrites) ? manifest.rewrites : manifest.rewrites?.afterFiles ?? [];
    if (rewrites.some((rewrite) => rewrite.source === '/rag-api/:path*' && rewrite.destination === '/api/:path*')) {
      prefixes.push(`${basePath}/rag-api`);
    }
    prefixCount = prefixes.length;
    const port = await reservePort();
    const env = {};
    // Do not inherit provider credentials, NODE_OPTIONS, proxy or dotenv settings.
    for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    Object.assign(env, {
      NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(port), RAG_ACCESS_MODE: 'local-dev',
      DATABASE_URL: '', POSTGRES_URL: '', RAG_PERSISTENCE_BACKEND: 'postgres',
      MODEL_PROVIDER: 'ollama', REASONING_PROVIDER: 'ollama', EMBEDDING_PROVIDER: 'ollama',
      OLLAMA_BASE_URL: 'http://127.0.0.1:1', NEXT_TELEMETRY_DISABLED: '1',
      LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false', COREPACK_ENABLE_NETWORK: '0',
    });
    stage = 'startup';
    checkStep = 'startup-ready';
    server = spawn(process.execPath, [entry], { cwd: artifact, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let ready = false;
    let startupText = '';
    let logBytes = 0;
    const observe = (hash, chunk) => {
      hash.update(chunk);
      logBytes += chunk.length;
      if (logBytes > 1024 * 1024) server.kill();
    };
    server.stdout.on('data', (chunk) => {
      observe(stdoutHash, chunk);
      startupText = (startupText + chunk.toString('utf8')).slice(-8192);
      ready ||= startupText.includes('Ready in') && startupText.includes(`:${port}`);
    });
    server.stderr.on('data', (chunk) => observe(stderrHash, chunk));
    closed = new Promise((resolve) => {
      // A failed spawn or kill is not proof that the child has terminated.
      server.on('error', () => { serverError = true; });
      server.once('close', () => { serverClosed = true; resolve(); });
    });
    deadline = setTimeout(() => { deadlineExpired = true; if (server.pid && !serverClosed) server.kill(); }, 35000);
    const startupDeadline = Date.now() + 15000;
    while (!ready && !serverClosed && !serverError && Date.now() < startupDeadline) await delay(50);
    assert.ok(ready && !serverClosed && !serverError, 'Owned loopback server did not become ready.');
    stage = 'requests';
    for (const prefix of prefixes) {
      const target = `${prefix}/context-management`;
      const cases = ['config', 'sessions', 'session', 'status', 'unknown'].map((action) => ({
        method: 'GET', path: `${target}?action=${action}&sessionId=synthetic-smoke-id`,
      }));
      for (const action of ['query', 'stream-query', 'create-session', 'delete-session', 'compress', 'update-config', 'unknown']) {
        cases.push({ method: 'POST', path: target, body: JSON.stringify({ action, sessionId: 'synthetic-smoke-id', question: 'hello', config: { topK: 1 } }) });
      }
      cases.push({ method: 'POST', path: target, body: '{ malformed synthetic JSON' });
      cases.push({ method: 'DELETE', path: `${target}?sessionId=synthetic-smoke-id` });
      for (const item of cases) {
        responseStatus = undefined;
        checkStep = 'server-state';
        assert.equal(serverClosed, false);
        attempted += 1;
        checkStep = 'transport';
        const response = await request(port, item.path, item.method, item.body);
        responseStatus = response.status;
        checkStep = 'status';
        assert.equal(response.status, 410, 'Every legacy production action must be disabled.');
        checkStep = 'content-type';
        assert.ok(response.headers['content-type']?.startsWith('application/json'));
        checkStep = 'json';
        try {
          assert.deepEqual(JSON.parse(response.body), expectedBody);
        } catch (error) {
          if (legacyFailureCode(error) === 'ERR_ASSERTION') checkStep = 'body';
          throw error;
        }
        completed += 1;
      }
    }
    responseStatus = undefined;
    checkStep = 'request-count';
    assert.equal(completed, prefixCount * 14);
    checkStep = 'artifact-integrity';
    assertNoPrivateSessionState();
    assert.equal(sha(fs.readFileSync(entry)), serverSha);
    assert.equal(sha(fs.readFileSync(path.join(artifact, '.next/BUILD_ID'))), buildIdSha);
  } catch (error) {
    failure = { stage, code: legacyFailureCode(error) };
    // Only owned timeout/budget markers carry a transport subtype. All other
    // evidence comes from closed control-flow labels, never the thrown value.
    const kind = deadlineExpired ? 'deadline' : requestFailureKinds.get(error)
      ?? (stage === 'startup' ? serverError ? 'startup-error' : serverClosed ? 'startup-closed' : 'startup-timeout'
        : checkStep === 'transport' ? 'socket' : checkStep);
    failureDetail = detail(kind);
  } finally {
    clearTimeout(deadline);
    if (server?.pid && !serverClosed) server.kill();
    if (closed) await Promise.race([closed, delay(5000, undefined, { ref: false })]);
    if (server?.pid && !serverClosed) {
      server.kill('SIGKILL');
      await Promise.race([closed, delay(5000, undefined, { ref: false })]);
    }
    if (server && !serverClosed && !failure) {
      failure = { stage: 'cleanup', code: 'SERVER_NOT_CLOSED' };
      failureDetail = detail('cleanup', 'cleanup');
    }
    console.log(JSON.stringify({
      name: 'contextLegacyStandaloneHttp', started, ended: new Date().toISOString(),
      passed: failure === null, failure, failureDetail, completed, attempted, prefixCount, serverClosed,
      buildIdSha, serverSha, stdoutSha: stdoutHash.digest('hex'), stderrSha: stderrHash.digest('hex'),
      productionAccepted: false,
    }));
    if (failure) process.exitCode = 1;
  }
}

await main();

import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { Agent, request as httpsRequest } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { checkServerIdentity, connect } from 'node:tls';
import type { TLSSocket } from 'node:tls';
import { debuglog, types } from 'node:util';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { boundedAskRequestCall, boundedProviderCall } from './bounded-provider-call';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { parseRagEvalDataset } from './dataset';
import { createReferenceProductionAskDatasetBinding } from './production-ask-dataset-binding';
import { selectReferenceAskPinnedAddress, validateReferenceAskNetworkArtifacts } from './production-ask-network-policy';
import { buildReferenceAskRequestBody, validateReferenceAskDeployment } from './production-ask-request-contract';
import { validateAuthorityClockReading } from './production-authority-ports';
import type { AuthorityClockReading } from './production-authority-ports';
import type { ReferenceProductionAskRequestPlan } from './production-ask-target';
import type { ReferenceAskHttpsTransportPort } from './production-ask-transport-ports';
import { RAG_CLIENT_REQUEST_TIMEOUT_MS } from '../core/request-budgets';

type Fields = Record<string, unknown>;
type Call = (input: unknown) => unknown;
type Port = { readonly receiver: object; readonly call: Call };
const nativeLookup = lookup, nativeConnect = connect, nativeRequest = httpsRequest, nativeCheckName = checkServerIdentity;
const mono = performance.now.bind(performance), apply = Reflect.apply;
// Node caches startup debug settings: deleting NODE_DEBUG later cannot disable
// an already-enabled native channel. Inspect its public flag without logging.
const startupDiagnosticEnabled = ['http', 'https', 'tls', 'net', 'stream', 'dns', 'zlib'].some(channel => debuglog(channel).enabled);
const CODES = ['invalid-config', 'invalid-request', 'busy', 'halted', 'already-executed', 'capacity-exhausted', 'invalid-clock',
  'deployment-failed', 'dns-failed', 'tls-failed', 'credential-failed', 'response-failed', 'measurement-failed', 'operation-timeout'] as const;
type Code = typeof CODES[number];
export class ProductionAskHttpsTransportError extends Error {
  readonly code: Code;
  readonly pendingCompletionUnknown: boolean;
  readonly requestMayHaveBeenDispatched: boolean;
  readonly productionAccepted = false;
  readonly automaticRetryAllowed = false;
  constructor(code: Code, pending = false, posted = false) {
    const safe = CODES.includes(code) ? code : 'response-failed';
    super('[reference Ask HTTPS transport] ' + safe);
    this.name = 'ProductionAskHttpsTransportError'; this.code = safe;
    this.pendingCompletionUnknown = pending; this.requestMayHaveBeenDispatched = posted; Object.freeze(this);
  }
}

/** Native loopback reference adapter: frozen complete input -> all-answer DNS
 * allowlist -> literal socket -> CA/hostname TLS -> late credential -> same
 * socket POST -> bounded actual bytes -> explicit measurement readback.
 * It grants NO enterprise permission, authenticates NO registry/approval or
 * measurement source, and neither retries nor proves remote cancellation. */
export function createReferenceAskHttpsTransport(inputOptions: unknown, actualDatasetJson: unknown, inputNetwork: unknown,
  inputPorts: unknown, ...extras: unknown[]): ReferenceAskHttpsTransportPort {
  let options: Fields, base: Fields, artifacts: Fields, actor: string;
  let binding: ReturnType<typeof createReferenceProductionAskDatasetBinding>;
  let network: ReturnType<typeof validateReferenceAskNetworkArtifacts>;
  let dataset: ReturnType<typeof parseRagEvalDataset>, bodies: readonly Buffer[];
  let clock: Port, secret: Port, deployment: Port, measurement: Port;
  try {
    if (extras.length) throw new Error(); environmentGate();
    options = snapshot(inputOptions); exact(options, ['executionProfile', 'askOptions', 'artifacts']);
    if (options.executionProfile !== 'local-reference') throw new Error();
    const ask = record(options.askOptions); binding = createReferenceProductionAskDatasetBinding(ask, actualDatasetJson);
    dataset = freeze(parseRagEvalDataset(JSON.parse(actualDatasetJson as string)));
    base = record(record(ask.manifest).base); artifacts = record(options.artifacts);
    integer(artifacts.operationTimeoutMs, 1, 60000); integer(artifacts.maxClockUncertaintyMs, 0, 60000);
    actor = string(record(record(ask.expectedExecutionPayload).participants).executorId);
    const model = record(base.models);
    bodies = dataset.cases.map(c => buildReferenceAskRequestBody({ question: c.query, topK: record(base.parameters).topK,
      corpusId: c.scope?.corpusId, llmModel: record(model.llm).id, embeddingModel: record(model.embedding).id }));
    const plan = binding.planRequest({ caseId: dataset.cases[0].id, rolloutMode: 'off', phase: 'trial', ordinal: 0 }).requestPlan;
    const raw = snapshot(inputNetwork); exact(raw, ['dnsPolicyJson', 'tlsTrustRootsJson']);
    network = validateReferenceAskNetworkArtifacts(plan, raw.dnsPolicyJson, raw.tlsTrustRootsJson);
    const hostname = new URL(plan.target.origin).hostname;
    if (network.mode !== 'local-loopback-test' || !['localhost', '127.0.0.1', '[::1]'].includes(hostname)
      || plan.target.networkPolicy.requestTimeoutMs > RAG_CLIENT_REQUEST_TIMEOUT_MS) throw new Error();
    const ports = descriptors(inputPorts, ['clock', 'secret', 'deployment', 'measurement']); exact(ports, ['clock', 'secret', 'deployment', 'measurement']);
    clock = capture(ports.clock, 'readTime', ['advanceTo', 'setAvailability']);
    secret = capture(ports.secret, 'readAskCredential'); deployment = capture(ports.deployment, 'readDeployment');
    measurement = capture(ports.measurement, 'readMeasurement');
  } catch { throw new ProductionAskHttpsTransportError('invalid-config'); }

  let closed = false, busy = false, deadline = Infinity, posted = false, providerPending = false, nativePending = false;
  let previousClock: AuthorityClockReading | null = null, activeStop: ((code: Code) => void) | null = null;
  const usedPlans = new Set<string>(), challenges = new Set<string>(), deployments = new Map<string, string>();
  const failure = (code: Code, pending = providerPending || nativePending) => new ProductionAskHttpsTransportError(code, pending, posted);
  const assertOpen = () => { if (closed) throw failure('halted'); if (mono() >= deadline) throw failure('operation-timeout'); environmentGate(); };
  const remaining = (max: number) => Math.min(max, Math.max(1, Math.ceil(deadline - mono())));
  function nonce(): string {
    if (challenges.size >= 10000) throw failure('capacity-exhausted');
    const value = randomBytes(16).toString('hex'); if (challenges.has(value)) throw failure('capacity-exhausted'); challenges.add(value); return value;
  }
  function ownPlan(input: unknown): ReferenceProductionAskRequestPlan {
    const supplied = snapshot(input), identity = record(supplied.requestIdentity);
    const plan = binding.planRequest(Object.fromEntries(['caseId', 'rolloutMode', 'phase', 'ordinal'].map(k => [k, identity[k]]))).requestPlan;
    if (canonicalJson(supplied) !== canonicalJson(plan)) throw failure('invalid-request'); return plan;
  }
  async function invoke(port: Port, input: unknown, code: Code, budget = 60000, gate?: () => void): Promise<unknown> {
    assertOpen(); providerPending = true;
    const observed = await boundedProviderCall(() => { assertOpen(); gate?.(); return apply(port.call, port.receiver, [input]); }, remaining(budget));
    if (observed.status === 'timeout' || observed.status === 'invalid-return') throw failure(observed.status === 'timeout' ? 'operation-timeout' : code, observed.pendingCompletionUnknown);
    providerPending = false; assertOpen(); if (observed.status !== 'fulfilled') throw failure(code, false); return observed.value;
  }
  async function freshClock(plan: ReferenceProductionAskRequestPlan) {
    const request = freeze({ context: { executionProfile: 'local-reference', binding: plan.binding, actorId: actor }, requestNonce: nonce() });
    const value = await invoke(clock, request, 'invalid-clock', artifacts.operationTimeoutMs as number);
    try {
      const reading = validateAuthorityClockReading(snapshot(value), { request, sourceIdentityRef: artifacts.clockIdentityRef,
        maxUncertaintyMs: artifacts.maxClockUncertaintyMs, previousReading: previousClock }).reading;
      const at = Date.parse(reading.observedAt);
      if (at - reading.uncertaintyMs < Date.parse(plan.effectiveWindow.startsAt)
        || at + reading.uncertaintyMs >= Date.parse(plan.effectiveWindow.endsAt)) throw new Error();
      previousClock = reading; return { at, uncertainty: reading.uncertaintyMs, observedMono: mono() };
    } catch { throw failure('invalid-clock', false); }
  }
  function clockGate(plan: ReferenceProductionAskRequestPlan, reading: Awaited<ReturnType<typeof freshClock>>) {
    assertOpen(); if (reading.at + reading.uncertainty + Math.max(0, mono() - reading.observedMono) >= Date.parse(plan.effectiveWindow.endsAt)) throw failure('invalid-clock');
  }
  return Object.freeze({ executionProfile: 'local-reference', productionCapable: false,
    close(): void { closed = true; activeStop?.('halted'); },
    async readDeployment(input: ReferenceProductionAskRequestPlan, ...extra: unknown[]): Promise<string> {
      if (closed) throw failure('halted'); if (busy) throw failure('busy'); busy = true; posted = false;
      try {
        if (extra.length) throw failure('invalid-request'); let plan: ReferenceProductionAskRequestPlan;
        try { plan = ownPlan(input); } catch { throw failure('invalid-request'); }
        deadline = mono() + plan.target.networkPolicy.requestTimeoutMs;
        if (deployments.size >= 10000) throw failure('capacity-exhausted'); await freshClock(plan);
        const value = await invoke(deployment, plan, 'deployment-failed');
        let data: Fields;
        try { data = rawJson(value); validateReferenceAskDeployment(data, plan, base); } catch { throw failure('deployment-failed', false); }
        await freshClock(plan); deployments.set(plan.planHash, canonicalJsonSha256(data)); return JSON.stringify(data);
      } catch (error) { closed = true; if (error instanceof ProductionAskHttpsTransportError) throw error; throw failure('deployment-failed'); }
      finally { busy = false; deadline = Infinity; }
    },
    async post(input: unknown, ...extra: unknown[]): Promise<string> {
      if (closed) throw failure('halted'); if (busy) throw failure('busy');
      let request: Fields, plan: ReferenceProductionAskRequestPlan, bytes: Buffer;
      try {
        if (extra.length) throw new Error(); request = snapshot(input);
        exact(request, ['schemaVersion', 'requestPlan', 'bodyBase64url', 'bodySha256', 'deploymentHash']); plan = ownPlan(request.requestPlan);
        const index = dataset.cases.findIndex(c => c.id === plan.requestIdentity.caseId); bytes = bodies[index];
        if (request.schemaVersion !== 'kg-reference-owned-ask-request/v1' || request.bodyBase64url !== bytes.toString('base64url')
          || request.bodySha256 !== digest(bytes) || deployments.get(plan.planHash) !== request.deploymentHash) throw new Error();
      } catch { closed = true; throw failure('invalid-request', false); }
      if (usedPlans.has(plan.planHash)) throw failure('already-executed'); if (usedPlans.size >= 10000) throw failure('capacity-exhausted');
      usedPlans.add(plan.planHash); busy = true; posted = false; providerPending = false;
      deadline = mono() + plan.target.networkPolicy.requestTimeoutMs;
      let socket: TLSSocket | null = null, http: ClientRequest | null = null, agent: Agent | null = null;
      const destroyOwned = () => { http?.destroy(); socket?.destroy(); agent?.destroy(); };
      let stopReject: (error: Error) => void;
      const stop = new Promise<never>((_, reject) => { stopReject = reject; });
      activeStop = code => { closed = true; destroyOwned(); stopReject(failure(code)); };
      const timer = setTimeout(() => activeStop?.('operation-timeout'), remaining(plan.target.networkPolicy.requestTimeoutMs));
      const perform = async (): Promise<string> => {
        await freshClock(plan); const url = new URL(plan.target.origin), hostname = url.hostname.replace(/^\[|\]$/g, '');
        nativePending = true;
        const observed = await boundedAskRequestCall(() => { assertOpen(); return nativeLookup(hostname, { all: true, verbatim: true }); }, remaining(plan.target.networkPolicy.requestTimeoutMs));
        if (observed.status === 'timeout' || observed.status === 'invalid-return') {
          nativePending = observed.pendingCompletionUnknown;
          throw failure(observed.status === 'timeout' ? 'operation-timeout' : 'dns-failed', nativePending);
        }
        nativePending = false; if (observed.status !== 'fulfilled') throw failure('dns-failed', false); assertOpen();
        let ip: string; try { ip = selectReferenceAskPinnedAddress(network, observed.value); } catch { throw failure('dns-failed', false); }
        nativePending = true; socket = await new Promise<TLSSocket>((resolve, reject) => {
          const current = nativeConnect({ host: ip, port: plan.target.networkPolicy.port,
            servername: isIP(hostname) ? undefined : hostname, ca: [...network.caCertificatesPem], rejectUnauthorized: true, minVersion: 'TLSv1.2',
            checkServerIdentity: (_name, cert) => nativeCheckName(hostname, cert) });
          socket = current;
          current.on('error', () => reject(failure('tls-failed', false)));
          current.once('close', () => reject(failure('tls-failed', false)));
          current.once('secureConnect', () => {
            try {
              assertOpen(); if (!current.authorized || nativeCheckName(hostname, current.getPeerCertificate())
                || current.remoteAddress !== ip || current.remotePort !== plan.target.networkPolicy.port) throw new Error();
              current.disableRenegotiation(); resolve(current);
            } catch { current.destroy(); reject(failure('tls-failed', false)); }
          });
        });
        nativePending = false; assertOpen(); const peer = socket.getPeerCertificate(); if (!peer.raw) throw failure('tls-failed', false);
        const peerGate = () => { assertOpen(); if (!socket || socket.destroyed || !socket.authorized
          || socket.remoteAddress !== ip || socket.remotePort !== plan.target.networkPolicy.port) throw failure('tls-failed', false); };
        const beforeSecret = await freshClock(plan); clockGate(plan, beforeSecret); peerGate();
        const challenge = freeze({ schemaVersion: 'kg-reference-ask-secret-request/v1', requestNonce: nonce(), requestPlanHash: plan.planHash,
          requestBodySha256: request.bodySha256, audience: plan.target.origin, binding: plan.binding,
          credentialPolicyRef: plan.target.credentialPolicyRef, tlsPeerFingerprintSha256: digest(peer.raw) });
        const rawSecret = await invoke(secret, challenge, 'credential-failed', 60000, peerGate); let token: string;
        try {
          const value = rawJson(rawSecret, 8192); exact(value, ['schemaVersion', 'requestNonce', 'requestPlanHash', 'requestBodySha256',
            'audience', 'binding', 'credentialPolicyRef', 'scheme', 'token']);
          const expected = { schemaVersion: 'kg-reference-ask-secret/v1', requestNonce: challenge.requestNonce, requestPlanHash: plan.planHash,
            requestBodySha256: request.bodySha256, audience: plan.target.origin, binding: plan.binding, credentialPolicyRef: plan.target.credentialPolicyRef,
            scheme: 'Bearer', token: value.token };
          if (canonicalJson(value) !== canonicalJson(expected) || typeof value.token !== 'string' || !/^reference-ask-token-[a-f0-9]{64}$/.test(value.token)) throw new Error();
          token = value.token;
        } catch { throw failure('credential-failed', false); }
        const beforePost = await freshClock(plan); clockGate(plan, beforePost); peerGate();
        const agentOptions = { keepAlive: false, maxSockets: 1, maxCachedSessions: 0, proxyEnv: { NODE_ENV: 'test' as const } }; agent = new Agent(agentOptions);
        const pinnedSocket = socket; let assigned = false;
        // Supplying the verified socket prevents a second lookup/handshake from
        // moving the credential to a different peer. No pool/session reuse.
        agent.createConnection = () => { assertOpen(); if (assigned || pinnedSocket.destroyed || !pinnedSocket.authorized) throw failure('tls-failed'); assigned = true; return pinnedSocket; };
        nativePending = true; const received = await new Promise<IncomingMessage>((resolve, reject) => {
          http = nativeRequest({ hostname, port: plan.target.networkPolicy.port, method: 'POST', path: '/api/ask', agent: agent!,
            maxHeaderSize: 8192, headers: { 'content-type': 'application/json', accept: 'application/json', connection: 'close',
              'accept-encoding': 'gzip, deflate, br', 'content-length': bytes.byteLength, authorization: 'Bearer ' + token } }, resolve);
          http.on('error', () => reject(failure('response-failed', false)));
          http.once('socket', assignedSocket => { try {
            clockGate(plan, beforePost); if (assignedSocket !== pinnedSocket || pinnedSocket.destroyed || !pinnedSocket.authorized) throw failure('tls-failed');
            posted = true; http!.end(bytes);
          } catch { http!.destroy(); reject(failure('response-failed', false)); } });
        });
        token = ''; assertOpen(); let status: number, headers: Record<string, string>, body: Buffer;
        try { status = integer(received.statusCode, 100, 599); headers = responseHeaders(received, status);
          body = await receiveBytes(received, plan); if (!received.complete) throw new Error(); }
        // Rejecting headers/destroying our stream cannot prove remote completion.
        catch { throw failure('response-failed'); }
        nativePending = false; assertOpen(); const response: Fields = { schemaVersion: 'kg-reference-ask-response/v1', requestPlanHash: plan.planHash,
          requestBodySha256: request.bodySha256, deploymentHash: request.deploymentHash, url: plan.target.url,
          status, headers, bodyBase64url: body.toString('base64url') };
        if (status === 200) {
          const requestNonce = nonce(), expected = { schemaVersion: 'kg-reference-ask-measurement-request/v1', requestNonce,
            requestPlanHash: plan.planHash, requestBodySha256: request.bodySha256, responseBodySha256: digest(body), binding: plan.binding };
          const rawMeasure = await invoke(measurement, freeze(expected), 'measurement-failed');
          try {
            const result = rawJson(rawMeasure); exact(result, ['schemaVersion', 'requestNonce', 'measurement']);
            const value = record(result.measurement); exact(value, ['schemaVersion', 'requestPlanHash', 'requestBodySha256', 'responseBodySha256', 'abstained', 'usage']);
            if (result.schemaVersion !== 'kg-reference-ask-measurement-readback/v1' || result.requestNonce !== requestNonce
              || value.schemaVersion !== 'kg-reference-ask-measurement/v1' || value.requestPlanHash !== plan.planHash
              || value.requestBodySha256 !== request.bodySha256 || value.responseBodySha256 !== digest(body) || typeof value.abstained !== 'boolean') throw new Error();
            record(value.usage); response.measurement = value;
          } catch { throw failure('measurement-failed', false); }
        }
        await freshClock(plan); assertOpen(); return JSON.stringify(response);
      };
      try { return await Promise.race([perform(), stop]); }
      catch (error) { closed = true; if (error instanceof ProductionAskHttpsTransportError) throw error; throw failure('response-failed'); }
      finally { clearTimeout(timer); activeStop = null; destroyOwned(); busy = false; deadline = Infinity; }
    },
  });
}

function responseHeaders(response: IncomingMessage, status: number): Record<string, string> {
  const allow = ['x-rag-policy', 'x-rag-trace-id', 'x-rag-status'], protectedNames = [...allow, 'content-encoding', 'content-length', 'transfer-encoding'];
  const seen = new Set<string>(), out: Record<string, string> = {};
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    const key = response.rawHeaders[i].toLowerCase(), value = response.rawHeaders[i + 1];
    if (protectedNames.includes(key) && seen.has(key)) throw new Error(); seen.add(key); if (allow.includes(key)) out[key] = value;
  }
  if (status === 200 && allow.some(k => !out[k])) throw new Error(); return out;
}
async function receiveBytes(response: IncomingMessage, plan: ReferenceProductionAskRequestPlan): Promise<Buffer> {
  const policy = plan.target.networkPolicy, encoding = response.headers['content-encoding'] ?? 'identity';
  const decode = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate()
    : encoding === 'br' ? createBrotliDecompress() : encoding === 'identity' ? new Transform({ transform(chunk, _encoding, cb) { cb(null, chunk); } }) : null;
  if (!decode) throw new Error(); let wire = 0, decoded = 0; const chunks: Buffer[] = [];
  const meter = new Transform({ transform(chunk: Buffer, _encoding, cb) {
    wire += chunk.byteLength; cb(wire > Math.min(policy.maxCompressedBytes, policy.maxStreamBytes) ? new Error('wire-budget') : null, chunk);
  } });
  const sink = new Writable({ write(chunk: Buffer, _encoding, cb) {
    decoded += chunk.byteLength; if (decoded > policy.maxResponseBytes) { cb(new Error('decoded-budget')); return; }
    chunks.push(Buffer.from(chunk)); cb();
  } });
  await pipeline(response, meter, decode, sink); return Buffer.concat(chunks, decoded);
}
function environmentGate(): void {
  const flags = process.execArgv.join(' ') + ' ' + (process.env.NODE_OPTIONS ?? '');
  if (startupDiagnosticEnabled || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' || process.env.SSLKEYLOGFILE !== undefined
    || (process.env.NODE_DEBUG ?? '').trim() || (process.env.NODE_DEBUG_NATIVE ?? '').trim()
    || flags.includes('--tls-keylog') || flags.includes('--trace-tls')) throw new Error();
}
function descriptors(input: unknown, keys: readonly string[]): Fields {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error();
  const result: Fields = Object.create(null); for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !keys.includes(key)) throw new Error(); const d = Object.getOwnPropertyDescriptor(input, key);
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) throw new Error(); result[key] = d.value;
  } return result;
}
function capture(input: unknown, method: string, optional: readonly string[] = []): Port {
  const keys = ['executionProfile', 'productionCapable', method], fields = descriptors(input, [...keys, ...optional]); exact(fields, keys, optional);
  if (fields.executionProfile !== 'local-reference' || fields.productionCapable !== false || typeof fields[method] !== 'function' || types.isProxy(fields[method])) throw new Error();
  return Object.freeze({ receiver: input as object, call: fields[method] as Call });
}
function rawJson(input: unknown, max = 256 * 1024): Fields { if (typeof input !== 'string' || Buffer.byteLength(input) > max) throw new Error(); return snapshot(JSON.parse(input)); }
function snapshot(input: unknown): Fields { return record(freeze(JSON.parse(canonicalJson(input)))); }
function record(input: unknown): Fields { if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(); return input as Fields; }
function exact(input: Fields, keys: readonly string[], optional: readonly string[] = []) { if (keys.some(k => !Object.hasOwn(input, k)) || Object.keys(input).some(k => !keys.includes(k) && !optional.includes(k))) throw new Error(); }
function string(input: unknown): string { if (typeof input !== 'string' || !input.length || input.length > 256) throw new Error(); return input; }
function integer(input: unknown, min: number, max: number): number { if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) throw new Error(); return input; }
function digest(input: Buffer): string { return createHash('sha256').update(input).digest('hex'); }
function freeze<T>(input: T): T { if (input && typeof input === 'object') { for (const value of Object.values(input)) freeze(value); Object.freeze(input); } return input; }

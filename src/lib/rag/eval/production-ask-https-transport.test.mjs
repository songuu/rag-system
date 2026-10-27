import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { request as httpsRequest, Agent } from 'node:https';
import { gzipSync } from 'node:zlib';
import { setImmediate as nextTurn } from 'node:timers/promises';
const { material, wrongMaterial, otherMaterial, clone, sha, flags, ref, hash, err, setup, grant, make, owned,
  waitForEntered, attachActualProducer, authoritySubject, subject, authorityFailure, authorityFixture, makeAuthority } =
  await import('./production-ask-https-fixtures.test-support.mjs');
const { createReferenceProductionAskRunner } = await import('./production-ask-runner.ts');
const { createReferenceShadowSideEffectAskRunner } = await import('./production-shadow-side-effects.ts');
const { createReferenceProviderEvidenceVerifier } = await import('./production-provider-evidence.ts');
const { createReferenceAuthorityApprovalVerifier } = await import('./production-authority-approval.ts');

test('genuine authority fixture verifies actual registry signatures and one independently read nonce', async t => {
  const f = await authorityFixture(t), cfg = f.authorityOptions.authority;
  const trust = createReferenceProviderEvidenceVerifier(cfg.evidenceOptions, { clock: f.authorityPorts.clock, registry: f.authorityPorts.registry, evidence: f.authorityPorts.evidence });
  assert.equal((await trust.verifySelection({})).stageAcceptanceComplete, false);
  const approval = createReferenceAuthorityApprovalVerifier(cfg.approvalOptions, { clock: f.authorityPorts.clock, nonceStore: f.authorityPorts.nonceStore });
  const result = await approval.verifyAndConsume({ context: { executionProfile: 'local-reference', binding: f.plan(0).binding,
    actorId: cfg.approvalOptions.actors.verifierId }, envelope: cfg.executionEnvelope, expectedPayload: f.options.askOptions.expectedExecutionPayload });
  assert.equal(result.signatureVerified, true); assert.equal(result.nonceClaimMatched, true); assert.equal(result.productionAuthorized, false);
  assert.equal(f.state.requests.length + f.state.secrets.length, 0);
});

test('authority runner actually consumes one grant before complete native sampling and rejects genuine replay before IO', async t => {
  const f = await authorityFixture(t), runner = makeAuthority(f); t.after(() => runner.close());
  const stringify = JSON.stringify; let serializedCheckpointPrefixes = 0;
  // A growing prefix need not be serialized again to enforce the same exact
  // JSON-array budget. Observe work, not a machine-dependent timing threshold.
  JSON.stringify = function (value, ...args) {
    if (Array.isArray(value) && value.length && value.every(item => item?.validationLevel === 'local-reference-provider-evidence-readback')) serializedCheckpointPrefixes++;
    return Reflect.apply(stringify, JSON, [value, ...args]);
  };
  t.after(() => { JSON.stringify = stringify; });
  const result = await runner.run({}); assert.equal(result.run.transportCalls, 12); assert.equal(result.run.trials.length, 2); assert.equal(result.run.warmups.length, 1);
  JSON.stringify = stringify;
  assert.equal(serializedCheckpointPrefixes, 0);
  assert.equal(result.executionSignatureVerified, true); assert.equal(result.executionNonceConsumed, true); assert.equal(result.productionAccepted, false);
  assert.equal(result.run.qualityReport.qualityComparisonsComputed, true); assert.equal(result.run.qualityReport.populationCaseCount, 12);
  assert.equal(result.run.qualityReport.machineGateComputed, false); assert.equal(result.run.qualityReport.sideEffectPolicyVerified, false);
  assert.ok(result.checkpoints.length > 12); assert.equal(f.state.tlsConnections, 12); assert.equal(f.state.secrets.length, 12);
  assert.equal(f.audit.filter(x => x === 'nonceStore.consumeAuthorizationNonce').length, 1);
  assert.ok(f.audit.indexOf('nonceStore.consumeAuthorizationNonce') < f.audit.indexOf('kms.encryptArtifact'));
  assert.ok(f.audit.indexOf('nonceStore.readExactNonceClaim') < f.audit.indexOf('secret.readAskCredential'));
  for (const pair of [...result.run.warmups, ...result.run.trials]) for (const arm of [pair.off, pair.treatment]) {
    assert.equal(arm.cases.every(c => c.artifacts.every(a => a.observation.encryptedReadbackMatched)), true);
    assert.deepEqual(arm.measurements.evaluation, arm.evaluation);
    assert.equal(arm.measurements.caseMeasurements.length, arm.cases.length);
    assert.equal(arm.measurements.caseMeasurements.every((m, i) => m.caseIndex === i && m.status === 'completed'), true);
  }
  for (const marker of ['RAW_QUERY_CANARY', 'RAW_EXPECTED_FACT_CANARY', 'reference-ask-token-', 'PRIVATE KEY', 'fixture://']) assert.equal(JSON.stringify(result).includes(marker), false);
  const before = f.audit.filter(x => /^(kms|store|secret|deployment|measurement)\./.test(x)).length, replay = makeAuthority(f); t.after(() => replay.close());
  await assert.rejects(replay.run({}), e => authorityFailure('approval-failed')(e) && e.nonceOutcome === 'reported-not-consumed');
  assert.equal(f.audit.filter(x => /^(kms|store|secret|deployment|measurement)\./.test(x)).length, before);
  assert.equal(f.state.requests.length, 12);
});

test('authority runner configuration rejects wrong signed ref selection roles clocks and getter grants before callback IO', async t => {
  const f = await authorityFixture(t); let hooks = 0; const trap = () => { hooks++; throw Error('RAW_SECRET'); };
  for (const edit of [o => { o.authority.executionEnvelope.signature.value = Buffer.alloc(64).toString('base64url'); },
    o => { o.authority.evidenceOptions.readerAuthorizationDigest = sha('wrong'); }, o => { o.authority.approvalOptions.actors.verifierId = 'wrong'; },
    o => { o.authority.evidenceOptions.expectedSelection.manifestHash = sha('wrong'); }, o => { o.authority.approvalOptions.clockIdentityRef = ref('wrong'); }, o => { o.executionProfile = 'enterprise'; }]) {
    const options = clone(f.authorityOptions); edit(options); assert.throws(() => authoritySubject.createReferenceAuthorityAskRunner(options, f.base.rawDatasetJson, f.network, f.authorityPorts), authorityFailure('invalid-config'));
  }
  const options = { ...f.authorityOptions }; Object.defineProperty(options, 'authority', { enumerable: true, get: trap });
  assert.throws(() => authoritySubject.createReferenceAuthorityAskRunner(options, f.base.rawDatasetJson, f.network, f.authorityPorts), authorityFailure('invalid-config'));
  assert.throws(() => authoritySubject.createReferenceAuthorityAskRunner(new Proxy(f.authorityOptions, { ownKeys: trap }), f.base.rawDatasetJson, f.network, f.authorityPorts), authorityFailure('invalid-config'));
  assert.equal(hooks, 0); assert.equal(f.audit.length, 0);
});

test('authority runner refuses substituted evidence before nonce or artifact credential mutation', async t => {
  const f = await authorityFixture(t), original = f.authorityPorts.evidence.readRuntimeMeasurement;
  f.authorityPorts.evidence.readRuntimeMeasurement = async request => { const value = clone(await original(request)); value.object.attestation.body.instanceId = 'swapped'; return value; };
  const runner = makeAuthority(f); t.after(() => runner.close()); await assert.rejects(runner.run({}), authorityFailure('evidence-failed'));
  assert.equal(f.audit.some(x => /^(nonceStore\.consume|kms|store|secret|deployment|measurement)/.test(x)), false);
});

test('authority runner revalidates signed runtime expiry after TLS handshake before taking credential', async t => {
  const f = await authorityFixture(t), original = f.authorityPorts.clock.readTime; let expired = false;
  f.authorityPorts.clock.readTime = async request => {
    // The client's first clock with a physical peer is after secureConnect.
    // Server secureConnection alone is not an ordering barrier for its Secret.
    if (!expired && f.state.sockets.size) { await nextTurn(); await nextTurn(); f.clock.advanceTo('2026-10-09T04:03:01.000Z'); expired = true; }
    return original(request);
  };
  const runner = makeAuthority(f); t.after(() => runner.close()); await assert.rejects(runner.run({}), e => e.productionAccepted === false && e.mutationMayHaveOccurred);
  assert.equal(expired, true); assert.equal(f.state.tlsConnections, 1); assert.equal(f.state.secrets.length, 0); assert.equal(f.state.requests.length, 0);
});

test('authority runner preserves the Promise firewall before guarded crypto return adoption', async t => {
  const f = await authorityFixture(t); let hooks = 0;
  f.authorityPorts.kms.encryptArtifact = () => Object.defineProperty({}, 'then', { get() { hooks++; throw Error('RAW_SECRET'); } });
  const runner = makeAuthority(f); t.after(() => runner.close()); await assert.rejects(runner.run({}), e => e.productionAccepted === false && e.pendingCompletionUnknown);
  assert.equal(hooks, 0); assert.equal(f.state.requests.length + f.state.secrets.length, 0);
});

test('authority runner final business dispatch cannot outlive upstream absolute deadline through checkpoint microtasks', async t => {
  const f = await authorityFixture(t); f.authorityOptions.artifacts.operationTimeoutMs = 500;
  let delayedReads = 0;
  for (const [port, methods] of [[f.authorityPorts.registry, ['readExactPolicy']], [f.authorityPorts.evidence, ['readExactConformance', 'readRuntimeMeasurement']]]) {
    for (const method of methods) {
      const original = port[method]; port[method] = request => {
        if (f.audit.includes('nonceStore.readExactNonceClaim')) {
          // Each native-Promise operation fits its budget; their microtask chain
          // exhausts the upstream absolute budget without allowing a timer turn.
          delayedReads++; const until = performance.now() + 120; while (performance.now() < until) { /* synthetic CPU work */ }
        }
        return original(request);
      };
    }
  }
  const runner = makeAuthority(f); t.after(() => runner.close());
  await assert.rejects(runner.run({}), e => e.productionAccepted === false && e.automaticRetryAllowed === false);
  assert.ok(delayedReads >= 5);
  assert.equal(f.audit.filter(x => /^(kms|store|deployment|secret|measurement)\./.test(x)).length, 0);
  assert.equal(f.state.requests.length, 0);
});

for (const [port, method, sent] of [['secret', 'readAskCredential', 0], ['measurement', 'readMeasurement', 1]]) {
  test('authority runner detached ' + port + ' native Promise payload never reads newly attached then getter', async t => {
    const f = await authorityFixture(t); let hooks = 0;
    f.authorityPorts[port][method] = () => {
      const value = {}, promise = Promise.resolve(value);
      Object.defineProperty(value, 'then', { enumerable: true, get() { hooks++; return undefined; } });
      return promise;
    };
    const runner = makeAuthority(f); t.after(() => runner.close());
    await assert.rejects(runner.run({}), e => e.productionAccepted === false && e.automaticRetryAllowed === false);
    assert.equal(hooks, 0); assert.equal(f.state.requests.length, sent);
  });
}

test('authority runner actual Secret dispatch shares the native final peer gate synchronous context', async t => {
  const { Socket } = await import('node:net'), { TLSSocket } = await import('node:tls'), { executionAsyncId } = await import('node:async_hooks');
  const f = await authorityFixture(t), descriptor = Object.getOwnPropertyDescriptor(Socket.prototype, 'remotePort');
  let gateId = null, dispatchId = null, readPeerDestroyed = null, dispatches = 0;
  assert.equal(Object.hasOwn(TLSSocket.prototype, 'remotePort'), false);
  Object.defineProperty(TLSSocket.prototype, 'remotePort', { ...descriptor, configurable: true, get() {
    // Observe only the genuine client's final peerGate inside the original BPC
    // callback, not its earlier handshake/perform gates or any server socket.
    const stack = new Error().stack;
    if (stack.includes('peerGate') && stack.includes('bounded-provider-call.ts')) { gateId = executionAsyncId(); readPeerDestroyed = () => this.destroyed; }
    return Reflect.apply(descriptor.get, this, []);
  } });
  t.after(() => Reflect.deleteProperty(TLSSocket.prototype, 'remotePort'));
  f.authorityPorts.secret.readAskCredential = () => { dispatches++; dispatchId = executionAsyncId(); assert.equal(readPeerDestroyed(), false); return Promise.reject(Error('synthetic-credential-denied')); };
  const runner = makeAuthority(f); t.after(() => runner.close());
  await assert.rejects(runner.run({}), e => e.productionAccepted === false);
  assert.notEqual(gateId, null); assert.equal(dispatches, 1); assert.equal(dispatchId, gateId); assert.equal(f.state.requests.length, 0);
});

test('authority runner preserves close UNKNOWN when a synchronously dispatched callback closes then throws', async t => {
  const f = await authorityFixture(t); let runner, dispatches = 0;
  f.authorityPorts.kms.encryptArtifact = () => { dispatches++; runner.close(); throw Error('synthetic-closed-callback'); };
  runner = makeAuthority(f); t.after(() => runner.close());
  await assert.rejects(runner.run({}), e => e.productionAccepted === false && e.pendingCompletionUnknown === true
    && e.mutationMayHaveOccurred === true && e.automaticRetryAllowed === false);
  assert.equal(dispatches, 1); assert.equal(f.audit.some(x => /^(store|secret|measurement)\./.test(x)), false); assert.equal(f.state.requests.length, 0);
});

test('authority runner observation callback timeout cannot disprove already dispatched held raw work', async t => {
  const f = await authorityFixture(t); f.authorityOptions.artifacts.operationTimeoutMs = 1000;
  f.authorityOptions.authority.evidenceOptions.operationTimeoutMs = 100;
  let release, dispatches = 0, settled = false; const held = new Promise(r => { release = r; }); held.then(() => { settled = true; });
  f.authorityPorts.kms.encryptArtifact = () => { dispatches++; queueMicrotask(() => {
    const until = performance.now() + 200; while (performance.now() < until) { /* synthetic observer delay */ }
  }); return held; };
  const runner = makeAuthority(f); t.after(() => { release(null); runner.close(); });
  await assert.rejects(runner.run({}), e => e.productionAccepted === false && e.pendingCompletionUnknown === true
    && e.mutationMayHaveOccurred === true && e.automaticRetryAllowed === false);
  assert.equal(dispatches, 1); assert.equal(settled, false); release(null); await nextTurn(); await nextTurn();
  assert.equal(f.audit.some(x => /^(store|secret|measurement)\./.test(x)), false); assert.equal(f.state.requests.length, 0);
});

test('authority runner close fences late registry completion before consuming nonce or reading credentials', async t => {
  const f = await authorityFixture(t); let release, enter; const entered = new Promise(r => { enter = r; }), held = new Promise(r => { release = r; });
  const original = f.authorityPorts.registry.readExactPolicy; f.authorityPorts.registry.readExactPolicy = async request => { enter(); await held; return original(request); };
  const runner = makeAuthority(f); t.after(() => { release(); runner.close(); }); const pending = runner.run({}); await waitForEntered(entered, pending); runner.close();
  await assert.rejects(pending, e => authorityFailure('halted')(e) && e.pendingCompletionUnknown); release(); await nextTurn(); await nextTurn();
  assert.equal(f.audit.some(x => /^(nonceStore|kms|store|secret|deployment|measurement)/.test(x)), false);
});

test('authority runner unknown committed nonce after close cannot arm late business work or retry', async t => {
  const f = await authorityFixture(t); let release, enter, committed; const entered = new Promise(r => { enter = r; }), held = new Promise(r => { release = r; });
  const original = f.authorityPorts.nonceStore.consumeAuthorizationNonce;
  f.authorityPorts.nonceStore.consumeAuthorizationNonce = async request => { committed = await original(request); enter(); await held; return committed; };
  const runner = makeAuthority(f); t.after(() => { release(); runner.close(); }); const pending = runner.run({}); await waitForEntered(entered, pending);
  assert.equal(committed.status, 'consumed'); runner.close(); await assert.rejects(pending, e => authorityFailure('halted')(e) && e.nonceOutcome === 'unknown' && e.mutationMayHaveOccurred && e.pendingCompletionUnknown);
  release(); await nextTurn(); await nextTurn(); await assert.rejects(runner.run({}), authorityFailure('halted'));
  assert.equal(f.audit.filter(x => x === 'nonceStore.consumeAuthorizationNonce').length, 1); assert.equal(f.state.requests.length + f.state.secrets.length, 0);
});

test('actual native TLS fixture and rebound original binder work before transport exists', async t => {
  const f = await setup(t); assert.equal(f.plan(0).productionAuthorized, false);
  await new Promise((resolve, reject) => {
    const agent = new Agent({ keepAlive: false, proxyEnv: {} });
    const req = httpsRequest({ hostname: 'localhost', port: f.plan(0).target.networkPolicy.port, family: 4,
      ca: material.cert, servername: 'localhost', path: '/fixture-check', agent }, res => {
      assert.equal(res.socket.authorized, true); res.resume(); res.once('end', () => { agent.destroy(); resolve(); });
    }); req.once('error', reject); req.end();
  }); assert.equal(f.state.tlsConnections, 1);
});

test('native client validates TLS before secrets and sends original owned bodies on exactly one socket per case', async t => {
  const f = await setup(t), client = make(f); t.after(() => client.close());
  for (const i of [0, 1]) {
    const request = await owned(f, client, i), response = JSON.parse(await client.post(request));
    assert.equal(response.status, 200); assert.equal(response.bodyBase64url, f.response.toString('base64url'));
    assert.equal(response.measurement.responseBodySha256, sha(f.response));
    assert.equal(response.deploymentHash, request.deploymentHash);
    assert.equal(f.state.requests[i].method, 'POST'); assert.equal(f.state.requests[i].url, '/api/ask');
    assert.equal(f.state.requests[i].headers.connection, 'close');
    assert.equal(sha(f.state.requests[i].bytes), request.bodySha256);
    assert.equal(f.state.secrets[i].tlsPeerFingerprintSha256, sha(new (await import('node:crypto')).X509Certificate(material.cert).raw));
    assert.equal(f.state.secrets[i].audience, request.requestPlan.target.origin);
  }
  assert.equal(f.state.tlsConnections, 2); assert.equal(f.state.measurements.length, 2);
  assert.equal(client.productionCapable, false);
});

test('wrong TLS hostname or untrusted chain halts before requesting credentials or HTTP', async t => {
  for (const settings of [{ material: wrongMaterial }, { roots: otherMaterial }]) {
    const f = await setup(t, settings), client = make(f), request = await owned(f, client);
    await assert.rejects(client.post(request), err('tls-failed'));
    assert.equal(f.state.secrets.length + f.state.requests.length, 0);
    await assert.rejects(client.post(request), err('halted'));
  }
});

test('body deployment and plan swaps cannot acquire credentials or dispatch IO', async t => {
  for (const mutate of [r => { r.bodyBase64url = Buffer.from('{}').toString('base64url'); r.bodySha256 = sha('{}'); },
    r => { r.deploymentHash = sha('swap'); }, r => { r.requestPlan.target.url += '?override=1'; }]) {
    const f = await setup(t), client = make(f), request = clone(await owned(f, client)); mutate(request);
    await assert.rejects(client.post(request), err('invalid-request')); assert.equal(f.state.secrets.length + f.state.tlsConnections, 0);
  }
});

test('config carriers and unsafe TLS logging cannot execute hooks or upgrade reference permissions', async t => {
  const f = await setup(t); let hooks = 0; const trap = () => { hooks++; throw Error('RAW_PORT_SECRET'); };
  const ports = { ...f.ports }; Object.defineProperty(ports, 'secret', { enumerable: true, get: trap });
  for (const [options, p] of [[{ ...f.options, executionProfile: 'enterprise' }, f.ports], [f.options, ports],
    [new Proxy(f.options, { get: trap, ownKeys: trap }), f.ports]]) {
    assert.throws(() => subject.createReferenceAskHttpsTransport(options, f.base.rawDatasetJson, f.network, p), err('invalid-config'));
  }
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED; process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try { assert.throws(() => make(f), err('invalid-config')); }
  finally { if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous; }
  assert.equal(hooks, 0); assert.equal(f.state.secrets.length + f.state.requests.length, 0);
});

test('non200 preserves actual error bytes without redirects raw headers or fabricated measurements', async t => {
  const f = await setup(t, { status: 302, location: 'https://169.254.169.254/', response: Buffer.from('actual-error') }), client = make(f);
  const response = JSON.parse(await client.post(await owned(f, client)));
  assert.equal(response.status, 302); assert.equal(response.bodyBase64url, f.response.toString('base64url'));
  assert.equal(Object.hasOwn(response, 'measurement'), false); assert.equal(Object.hasOwn(response.headers, 'location'), false);
  assert.equal(f.state.requests.length, 1); assert.equal(f.state.measurements.length, 0); client.close();
});

test('streaming compression preserves complete decoded bytes and rejects decompression bombs', async t => {
  const raw = Buffer.from('{"answer":"compressed fixture"}');
  const f = await setup(t, { encoding: 'gzip', response: gzipSync(raw) }), client = make(f);
  const received = JSON.parse(await client.post(await owned(f, client)));
  assert.equal(received.bodyBase64url, raw.toString('base64url')); client.close();
  const g = await setup(t, { encoding: 'gzip', response: gzipSync(Buffer.alloc(16384, 97)), maxBytes: 1024 }), other = make(g);
  await assert.rejects(other.post(await owned(g, other)), err('response-failed')); assert.equal(g.state.measurements.length, 0);
});

test('truncated HTTP and corrupt compression fail closed without making up result data', async t => {
  for (const settings of [{ truncated: true }, { encoding: 'gzip', response: gzipSync(Buffer.from('complete')).subarray(0, 12) }]) {
    const f = await setup(t, settings), client = make(f); await assert.rejects(client.post(await owned(f, client)), err('response-failed'));
    assert.equal(f.state.measurements.length, 0);
  }
});

test('close while late Secret is pending fences the same native socket and prevents late POST', async t => {
  const f = await setup(t), client = make(f); let release, enter;
  const entered = new Promise(r => { enter = r; }), held = new Promise(r => { release = r; });
  // Ports are captured at construction; build a fresh client with the held port.
  client.close(); f.ports.secret.readAskCredential = request => { enter(request); return held; };
  const active = make(f), request = await owned(f, active), pending = active.post(request); t.after(() => { release(grant({})); active.close(); });
  const credentialRequest = await Promise.race([entered, pending.then(() => { throw Error('Unexpected terminal transport'); })]);
  active.close(); await assert.rejects(pending, err('halted')); release(grant(credentialRequest));
  await nextTurn(); await nextTurn(); assert.equal(f.state.requests.length, 0);
});

test('whole request deadline retains UNKNOWN for late Secret and no request is sent after timeout', async t => {
  const f = await setup(t, { timeout: 1000 }); let release, enter;
  const entered = new Promise(r => { enter = r; }), held = new Promise(r => { release = r; });
  f.ports.secret.readAskCredential = request => { enter(request); return held; };
  const client = make(f), pending = client.post(await owned(f, client)); t.after(() => { release(grant({})); client.close(); });
  await waitForEntered(entered, pending);
  await assert.rejects(pending, e => err('operation-timeout')(e) && e.pendingCompletionUnknown && !e.requestMayHaveBeenDispatched);
  release(grant({})); await nextTurn(); await nextTurn(); assert.equal(f.state.requests.length, 0);
});

test('credential and measurement hooks correlation swaps and replay do not dispatch another request', async t => {
  const f = await setup(t); let hooks = 0;
  f.ports.secret.readAskCredential = () => Object.defineProperty({}, 'then', { get() { hooks++; throw Error('RAW_SECRET'); } });
  const client = make(f); await assert.rejects(client.post(await owned(f, client)), err('credential-failed'));
  assert.equal(hooks, 0); assert.equal(f.state.requests.length, 0);
  const g = await setup(t); g.ports.measurement.readMeasurement = async () => JSON.stringify({ schemaVersion: 'kg-reference-ask-measurement-readback/v1', requestNonce: 'swap', measurement: {} });
  const other = make(g), request = await owned(g, other); await assert.rejects(other.post(request), err('measurement-failed'));
  await assert.rejects(other.post(request), err('halted')); assert.equal(g.state.requests.length, 1);
});

test('visible native peer closure before Secret must not acquire even a local reference credential', async t => {
  const f = await setup(t); let reads = 0; const original = f.ports.clock.readTime;
  f.ports.clock.readTime = async input => {
    const result = await original(input);
    if (++reads === 4) { for (const socket of f.state.sockets) socket.destroy(); await nextTurn(); await nextTurn(); }
    return result;
  };
  const client = make(f); await assert.rejects(client.post(await owned(f, client)), err('tls-failed'));
  assert.equal(f.state.secrets.length, 0); assert.equal(f.state.requests.length, 0);
});

test('actual producer consumes full roster native HTTPS bytes original encrypted writer and oracle', async t => {
  let f;
  f = await setup(t, { responseFactory: row => {
    const input = JSON.parse(row.bytes), index = f.base.dataset.cases.findIndex(c => c.query === input.question);
    const evidence = clone(f.base.dataset.corpus[0]); delete evidence.metadata;
    return Buffer.from(JSON.stringify({ success: true, question: input.question, answer: index === 0 ? 'RAW_EXPECTED_FACT_CANARY' : '',
      models: { llm: input.llmModel, embedding: input.embeddingModel }, storageBackend: 'milvus', traceId: 'transport-fixture',
      evidence: index === 0 ? [{ ...evidence, id: evidence.evidenceId, retrievalScore: 1, laneId: 'dense' }] : [],
      citations: index === 0 ? [{ evidenceId: evidence.evidenceId, startOffset: 0, endOffset: 7 }] : [],
      laneExecutions: [{ laneId: 'dense', status: 'completed' }],
      retrievalDetails: { graph: { requestedMode: 'off' }, abstention: { mode: 'active', abstain: index !== 0 } } }));
  } });
  const original = f.ports.measurement.readMeasurement;
  f.ports.measurement.readMeasurement = async request => {
    const result = JSON.parse(await original(request)), query = JSON.parse(f.state.requests.at(-1).bytes).question;
    result.measurement.abstained = f.base.dataset.cases.findIndex(c => c.query === query) !== 0; return JSON.stringify(result);
  };
  const { client, producer } = await attachActualProducer(f); t.after(() => producer.close());
  const proof = await producer.runArm({ rolloutMode: 'off', phase: 'trial', ordinal: 0 });
  assert.equal(proof.cases.length, f.base.dataset.cases.length); assert.equal(proof.evaluation.summary.failedCases, 0);
  assert.equal(proof.transportCalls, 2); assert.equal(f.state.requests.length, 2); assert.equal(f.state.tlsConnections, 2);
  assert.equal(proof.cases.every(c => c.artifacts.length === 4), true); assert.equal(proof.productionAccepted, false);
  assert.equal(client.productionCapable, false);
});

test('complete paired runner executes actual native TLS warmups and both trial arms through original encrypted oracle chain', async t => {
  let f, currentMode = 'off';
  f = await setup(t, { responseFactory: row => {
    const input = JSON.parse(row.bytes), index = f.base.dataset.cases.findIndex(c => c.query === input.question);
    const evidence = clone(f.base.dataset.corpus[0]); delete evidence.metadata;
    return Buffer.from(JSON.stringify({ success: true, question: input.question, answer: index === 0 ? 'RAW_EXPECTED_FACT_CANARY' : '',
      models: { llm: input.llmModel, embedding: input.embeddingModel }, storageBackend: 'milvus', traceId: 'transport-fixture',
      evidence: index === 0 ? [{ ...evidence, id: evidence.evidenceId, retrievalScore: 1, laneId: 'dense' }] : [],
      citations: index === 0 ? [{ evidenceId: evidence.evidenceId, startOffset: 0, endOffset: 7 }] : [], laneExecutions: [{ laneId: 'dense', status: 'completed' }],
      retrievalDetails: { graph: { requestedMode: currentMode }, abstention: { mode: 'active', abstain: index !== 0 } } }));
  } });
  const originalDeployment = f.ports.deployment.readDeployment, originalMeasurement = f.ports.measurement.readMeasurement, deployed = [];
  f.ports.deployment.readDeployment = async plan => { currentMode = plan.requestIdentity.rolloutMode; deployed.push(plan); return originalDeployment(plan); };
  f.ports.measurement.readMeasurement = async request => {
    const result = JSON.parse(await originalMeasurement(request)), query = JSON.parse(f.state.requests.at(-1).bytes).question;
    result.measurement.abstained = f.base.dataset.cases.findIndex(c => c.query === query) !== 0; return JSON.stringify(result);
  };
  const { client, producer, producerPorts } = await attachActualProducer(f);
  const runner = createReferenceProductionAskRunner(f.options, f.base.rawDatasetJson, producerPorts);
  t.after(() => { runner.close(); producer.close(); client.close(); });
  const out = await runner.run({}); assert.equal(out.warmups.length, 1); assert.equal(out.trials.length, 2);
  assert.equal(out.transportCalls, 12); assert.equal(out.trialTransportCalls, 8);
  assert.equal(f.state.requests.length, 12); assert.equal(f.state.tlsConnections, 12); assert.equal(f.state.secrets.length, 12); assert.equal(f.state.measurements.length, 12);
  const expectedModes = ['off', 'off', 'shadow', 'shadow', 'off', 'off', 'shadow', 'shadow', 'off', 'off', 'shadow', 'shadow'];
  assert.deepEqual(deployed.map(p => p.requestIdentity.rolloutMode), expectedModes);
  for (const [index, plan] of deployed.entries()) {
    assert.equal(f.state.requests[index].method, 'POST'); assert.equal(f.state.requests[index].url, '/api/ask');
    assert.equal(f.state.secrets[index].requestPlanHash, plan.planHash); assert.equal(f.state.secrets[index].requestBodySha256, sha(f.state.requests[index].bytes));
  }
  for (const pair of [...out.warmups, ...out.trials]) for (const arm of [pair.off, pair.treatment]) {
    assert.equal(arm.evaluation.summary.completedCases, 2); assert.equal(arm.evaluation.summary.failedCases, 0);
    assert.equal(arm.cases.every(c => c.artifacts.length === 4 && c.artifacts.every(a => a.observation.encryptedReadbackMatched)), true);
  }
  assert.equal(out.productionAccepted, false); assert.equal(out.sideEffectPolicyVerified, false); assert.equal(out.machineGateComputed, false);
});

test('shadow side effect facade observes actual TLS serving data all stores and fails observed mutations', async t => {
  for (const mutate of [false, true]) {
    let f, mode = 'off', served = null;
    const state = { zeroMutation: Object.fromEntries(['graphCache', 'pointer', 'outbox', 'buildJob', 'neo4j', 'milvus', 'index', 'mode', 'traffic'].map(k => [k, { mutationCount: 0, state: [] }])),
      allowedEffects: { encryptedAudit: 0, controlledTelemetry: 0, modelBilling: 0, equivalentOrdinaryCache: 0 } };
    f = await setup(t, { responseFactory: row => {
      const input = JSON.parse(row.bytes), index = f.base.dataset.cases.findIndex(c => c.query === input.question), evidence = clone(f.base.dataset.corpus[0]); delete evidence.metadata;
      const selected = index === 0 ? [{ ...evidence, id: evidence.evidenceId, retrievalScore: 1, laneId: 'dense' }] : [];
      served = { servedEvidence: selected, context: input.question, prompt: { instruction: 'RAW_NATIVE_PROMPT', question: input.question }, cacheIdentity: sha(input.question) };
      state.allowedEffects.controlledTelemetry++; state.allowedEffects.modelBilling++;
      if (mutate) state.zeroMutation.pointer.mutationCount++;
      return Buffer.from(JSON.stringify({ success: true, question: input.question, answer: index === 0 ? 'RAW_EXPECTED_FACT_CANARY' : '',
        models: { llm: input.llmModel, embedding: input.embeddingModel }, storageBackend: 'milvus', traceId: 'transport-fixture', evidence: selected,
        citations: index === 0 ? [{ evidenceId: evidence.evidenceId, startOffset: 0, endOffset: 7 }] : [], laneExecutions: [{ laneId: 'dense', status: 'completed' }],
        retrievalDetails: { graph: { requestedMode: mode }, abstention: { mode: 'active', abstain: index !== 0 } } }));
    } });
    const deployed = f.ports.deployment.readDeployment, measured = f.ports.measurement.readMeasurement;
    f.ports.deployment.readDeployment = async plan => { mode = plan.requestIdentity.rolloutMode; return deployed(plan); };
    f.ports.measurement.readMeasurement = async request => { const out = JSON.parse(await measured(request));
      out.measurement.abstained = f.base.dataset.cases.findIndex(c => c.query === JSON.parse(f.state.requests.at(-1).bytes).question) !== 0; return JSON.stringify(out); };
    const { client, producer, producerPorts } = await attachActualProducer(f), seal = producerPorts.store.sealEncryptedArtifact;
    producerPorts.store.sealEncryptedArtifact = async request => { const out = await seal(request); state.allowedEffects.encryptedAudit++; return out; };
    const readback = { ...flags, async readShadowState(request) {
      const measurement = f.state.measurements.at(-1), serving = served && measurement ? { ...served, requestPlanHash: measurement.requestPlanHash,
        requestBodySha256: measurement.requestBodySha256, responseBodySha256: measurement.responseBodySha256 } : null;
      return JSON.stringify({ schemaVersion: 'kg-reference-shadow-state/v1', requestNonce: request.requestNonce, requestHash: hash(request),
        providerRegistrationHash: request.providerRegistrationHash, binding: request.binding, observedAt: request.observedAt, ...state, serving });
    } };
    const runner = createReferenceShadowSideEffectAskRunner(f.options, f.base.rawDatasetJson, { ...producerPorts, readback });
    t.after(() => { runner.close(); producer.close(); client.close(); });
    if (mutate) { await assert.rejects(runner.run({}), e => e.code === 'side-effect-mismatch' && e.requestMayHaveBeenDispatched);
      assert.equal(f.state.requests.length, 1); assert.equal(f.state.secrets.length, 1); }
    else { const out = await runner.run({}); assert.equal(out.run.transportCalls, 12); assert.equal(out.sideEffects.observationCount, 26);
      assert.equal(out.sideEffects.pairedCaseCount, 6); assert.equal(out.sideEffects.allowedEffectDeltas.encryptedAudit, 73);
      assert.equal(out.sideEffects.rawReadbacksEncryptedAndMatched, true);
      assert.equal(out.sideEffects.observations.length, 26);
      assert.equal(out.sideEffects.observations.every((o, i) => o.archive.encryptedReadbackMatched && o.archive.observationIndex === i
        && o.archive.bodySha256 === o.rawSha256 && o.archive.artifactIndex.entries.length === 1
        && o.archive.artifactIndex.entries[0].artifactType === 'readback-proof' && o.archive.artifactIndex.entries[0].ordinal === 1 + i * 128), true);
      assert.equal(f.state.tlsConnections, 12); assert.equal(f.state.measurements.length, 12); assert.equal(f.state.secrets.length, 12);
      assert.equal(out.sideEffectPolicyVerified, false); assert.equal(out.machineGateComputed, false); assert.equal(out.productionAccepted, false);
      assert.equal(/RAW_|CANARY|reference-ask-token|"question":|"context":|"prompt":/.test(JSON.stringify(out)), false); }
  }
});

test('producer close reaches owned native transport before late Secret can send POST', async t => {
  const f = await setup(t); let release, enter;
  const entered = new Promise(r => { enter = r; }), held = new Promise(r => { release = r; });
  f.ports.secret.readAskCredential = request => { enter(request); return held; };
  const { client, producer } = await attachActualProducer(f); t.after(() => { release(grant({})); producer.close(); client.close(); });
  const pending = producer.runArm({ rolloutMode: 'off', phase: 'trial', ordinal: 0 });
  await waitForEntered(entered, pending); producer.close();
  await assert.rejects(pending, e => e.code === 'halted' && e.productionAccepted === false);
  release(grant({})); await nextTurn(); await nextTurn(); assert.equal(f.state.requests.length, 0);
});

test('native HTTP timeout and explicit close retain UNKNOWN for a dispatched held response', async t => {
  for (const explicit of [false, true]) {
    let enter; const entered = new Promise(r => { enter = r; });
    const f = await setup(t, { holdResponse: true, onRequest: () => enter(), timeout: explicit ? 5000 : 1000 });
    const client = make(f), pending = client.post(await owned(f, client)); await waitForEntered(entered, pending);
    if (explicit) client.close();
    await assert.rejects(pending, e => err(explicit ? 'halted' : 'operation-timeout')(e)
      && e.pendingCompletionUnknown === true && e.requestMayHaveBeenDispatched === true);
    assert.equal(f.state.requests.length, 1); assert.equal(f.state.measurements.length, 0);
  }
});

test('native diagnostic environment must be refused before any credential or request IO', async t => {
  const f = await setup(t);
  for (const key of ['NODE_DEBUG', 'NODE_DEBUG_NATIVE']) {
    const previous = process.env[key]; process.env[key] = '*';
    try { assert.throws(() => make(f), err('invalid-config')); }
    finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
  }
  assert.equal(f.state.secrets.length + f.state.requests.length, 0);
});


test('duplicate protected native headers fail before reading body without an unhandled aborted stream', async t => {
  const f = await setup(t, { duplicatePolicyHeader: true, holdBody: true }), client = make(f);
  await assert.rejects(client.post(await owned(f, client)), e => err('response-failed')(e)
    && e.pendingCompletionUnknown === true && e.requestMayHaveBeenDispatched === true);
  await nextTurn(); await nextTurn(); assert.equal(f.state.measurements.length, 0); assert.equal(f.state.requests.length, 1);
});

test('startup cached native HTTP diagnostics remain forbidden after the environment label is removed', async t => {
  const f = await setup(t);
  const script = `import {debuglog} from 'node:util';import {readFileSync} from 'node:fs';import {registerHooks} from 'node:module';
    const enabled=debuglog('http').enabled;delete process.env.NODE_DEBUG;
    registerHooks({resolve(s,c,next){try{return next(s,c)}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\\.[cm]?[jt]s$/.test(s))return next(s+'.ts',c);throw e}}});
    const subject=await import('./src/lib/rag/eval/production-ask-https-transport.ts'),packet=JSON.parse(readFileSync(0,'utf8'));
    const flags={executionProfile:'local-reference',productionCapable:false},noop=async()=>undefined;
    const ports={clock:{...flags,readTime:noop},secret:{...flags,readAskCredential:noop},deployment:{...flags,readDeployment:noop},measurement:{...flags,readMeasurement:noop}};
    let accepted=false;try{subject.createReferenceAskHttpsTransport(packet.options,packet.raw,packet.network,ports);accepted=true}catch(e){if(e.code!=='invalid-config')process.exitCode=1}
    console.log(JSON.stringify({enabled,removed:process.env.NODE_DEBUG===undefined,accepted,productionAccepted:false}));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
    input: JSON.stringify({ options: f.options, raw: f.base.rawDatasetJson, network: f.network }),
    env: { ...process.env, NODE_DEBUG: 'http', NODE_DEBUG_NATIVE: '', NODE_OPTIONS: '', NODE_USE_ENV_PROXY: '0' } });
  assert.equal(result.status, 0); assert.equal(result.error, undefined); const observed = JSON.parse(result.stdout);
  assert.equal(observed.enabled, true); assert.equal(observed.removed, true); assert.equal(observed.accepted, false);
  assert.equal(f.state.secrets.length + f.state.requests.length, 0);
});

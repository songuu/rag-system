import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:https';
import { registerHooks } from 'node:module';
import { makeAskTlsTestMaterial } from './production-ask-tls-fixtures.test-support.mjs';
registerHooks({ resolve(s, c, next) { try { return next(s, c); } catch (e) {
  if (e.code === 'ERR_MODULE_NOT_FOUND' && s.startsWith('.') && !/\.[cm]?[jt]s$/.test(s)) return next(s + '.ts', c);
  throw e;
} } });
const { fixture, rebindExecution } = await import('./production-ask-dataset-fixtures.test-support.mjs');
const { createReferenceProductionAskDatasetBinding } = await import('./production-ask-dataset-binding.ts');
const { buildReferenceAskRequestBody } = await import('./production-ask-request-contract.ts');
const { canonicalJson, canonicalJsonSha256: hash } = await import('./canonical-json.ts');
const { createReferenceAuthorityClock, createReferenceAuthorizationNonceStore } = await import('./production-authority-ports.ts');
const { createReferenceProductionAskProducer } = await import('./production-ask-producer.ts');
const { fixture: providerFixture } = await import('./production-provider-fixtures.test-support.mjs');
const { createReferenceProviderRegistry } = await import('./production-provider-registry.ts');
const { createReferenceProviderEvidenceStore } = await import('./production-provider-evidence.ts');
let authoritySubject; try { authoritySubject = await import('./production-ask-authority-runner.ts'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; authoritySubject = {}; }
const { createReferenceKmsEnvelope, createReferenceArtifactStore } = await import('./production-controlled-artifacts.ts');
let subject; try { subject = await import('./production-ask-https-transport.ts'); } catch (e) {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; subject = {};
}
const material = makeAskTlsTestMaterial(), wrongMaterial = makeAskTlsTestMaterial('wrong.invalid'), otherMaterial = makeAskTlsTestMaterial();
const clone = x => structuredClone(x), sha = x => createHash('sha256').update(x).digest('hex');
const flags = { executionProfile: 'local-reference', productionCapable: false };
const ref = name => ({ objectId: name, objectVersion: 'v1', sha256: hash(name) });
const usage = { retrievalLatencyMs: 1, generationLatencyMs: 2, totalLatencyMs: 3, embeddingCalls: 1, generationCalls: 1,
  tokenMeasurement: 'unavailable', costMeasurement: 'unavailable' };
const err = code => e => e instanceof subject.ProductionAskHttpsTransportError && e.code === code
  && e.productionAccepted === false && e.automaticRetryAllowed === false && Object.isFrozen(e)
  && !Object.hasOwn(e, 'cause') && !/RAW_|token-|localhost|CERTIFICATE/.test(e.message);
function deployment(f, plan) {
  const base = f.base.options.manifest.base, r = plan.requestIdentity;
  return { schemaVersion: 'kg-reference-ask-deployment/v1', requestPlanHash: plan.planHash, origin: plan.target.origin,
    providerRegistrationHash: plan.providerRegistrationHash, scope: plan.binding, rolloutMode: r.rolloutMode,
    sharedConfigHash: r.sharedConfigHash, armConfigHash: r.armConfigHash,
    models: { llm: base.models.llm.id, embedding: base.models.embedding.id }, parameters: base.parameters };
}
async function setup(t, settings = {}) {
  const state = { tlsConnections: 0, requests: [], secrets: [], measurements: [], sockets: new Set() };
  const response = settings.response ?? Buffer.from('{"success":true,"answer":"synthetic"}');
  const server = createServer(settings.material ?? material, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const row = { method: req.method, url: req.url, headers: req.headers, bytes: Buffer.concat(chunks), socket: req.socket };
    state.requests.push(row);
    settings.onRequest?.(row);
    if (settings.holdResponse) return;
    res.statusCode = settings.status ?? 200;
    res.setHeader('x-rag-policy', 'strict-grounding'); res.setHeader('x-rag-trace-id', 'transport-fixture'); res.setHeader('x-rag-status', 'completed');
    if (settings.duplicatePolicyHeader) res.setHeader('x-rag-policy', ['strict-grounding', 'strict-grounding']);
    if (settings.encoding) res.setHeader('content-encoding', settings.encoding);
    if (settings.location) res.setHeader('location', settings.location);
    if (settings.truncated) res.setHeader('content-length', response.length + 10);
    if (settings.holdBody) { res.write(response.subarray(0, 1)); return; }
    res.end(settings.responseFactory ? settings.responseFactory(row) : response);
  });
  server.on('secureConnection', () => { state.tlsConnections++; });
  server.on('connection', socket => { state.sockets.add(socket); socket.once('close', () => state.sockets.delete(socket)); });
  server.on('tlsClientError', () => {});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { for (const socket of state.sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const base = fixture('T16'), registration = base.options.deploymentPolicy.registrations.find(x => x.purpose === 'ask');
  registration.endpointOrigin = 'https://localhost:' + server.address().port;
  registration.networkPolicy.port = server.address().port;
  if (settings.timeout) registration.networkPolicy.requestTimeoutMs = settings.timeout;
  if (settings.maxBytes) for (const key of ['maxCompressedBytes', 'maxResponseBytes', 'maxStreamBytes']) registration.networkPolicy[key] = settings.maxBytes;
  const payload = base.options.expectedExecutionPayload;
  const artifactBase = { scope: payload.scope, origin: registration.endpointOrigin,
    validFrom: payload.window.startsAt, validUntil: payload.window.endsAt };
  const dnsPolicyJson = JSON.stringify({ schemaVersion: 'kg-reference-ask-dns-policy/v1', ...artifactBase,
    mode: 'local-loopback-test', allowedAddresses: ['127.0.0.1', '::1'] });
  const tlsTrustRootsJson = JSON.stringify({ schemaVersion: 'kg-reference-ask-tls-roots/v1', ...artifactBase,
    caCertificatesPem: [(settings.roots ?? settings.material ?? material).cert] });
  registration.networkPolicy.dnsPolicyRef.sha256 = sha(dnsPolicyJson);
  registration.networkPolicy.tlsTrustRootsRef.sha256 = sha(tlsTrustRootsJson); rebindExecution(base);
  const clockIdentityRef = ref('https-fixture-clock');
  const clock = createReferenceAuthorityClock({ executionProfile: 'local-reference', scope: payload.scope,
    allowedActorIds: [payload.participants.executorId, payload.participants.readOnlyId], sourceIdentityRef: clockIdentityRef,
    initialObservedAt: new Date(Date.parse(payload.notBefore) + 60000).toISOString(), uncertaintyMs: 1, maxReadings: 10000, maxAdvanceMs: 86400000 });
  const f = { base, state, response, clock, options: { executionProfile: 'local-reference', askOptions: clone(base.options), artifacts: {
    expectedKeyRef: ref('https-fixture-key'), storeIdentityRef: ref('https-fixture-store'), clockIdentityRef,
    maxClockUncertaintyMs: 10, operationTimeoutMs: 5000, retainUntil: new Date(Date.parse(payload.window.endsAt) + 3600000).toISOString() } },
  network: { dnsPolicyJson, tlsTrustRootsJson } };
  f.ports = { clock: { ...flags, readTime: input => clock.readTime(input) },
    deployment: { ...flags, readDeployment: async plan => JSON.stringify(deployment(f, plan)) },
    secret: { ...flags, readAskCredential: async request => { state.secrets.push(request); return grant(request); } },
    measurement: { ...flags, readMeasurement: async request => { state.measurements.push(request);
      return JSON.stringify({ schemaVersion: 'kg-reference-ask-measurement-readback/v1', requestNonce: request.requestNonce,
        measurement: { schemaVersion: 'kg-reference-ask-measurement/v1', requestPlanHash: request.requestPlanHash,
          requestBodySha256: request.requestBodySha256, responseBodySha256: request.responseBodySha256, abstained: false, usage } }); } } };
  f.plan = index => createReferenceProductionAskDatasetBinding(base.options, base.rawDatasetJson).planRequest({
    caseId: base.dataset.cases[index].id, rolloutMode: 'off', phase: 'trial', ordinal: 0 }).requestPlan;
  return f;
}
function grant(request) { return JSON.stringify({ schemaVersion: 'kg-reference-ask-secret/v1', requestNonce: request.requestNonce,
  requestPlanHash: request.requestPlanHash, requestBodySha256: request.requestBodySha256, audience: request.audience,
  binding: request.binding, credentialPolicyRef: request.credentialPolicyRef, scheme: 'Bearer', token: 'reference-ask-token-' + sha('synthetic') }); }
const make = f => subject.createReferenceAskHttpsTransport(f.options, f.base.rawDatasetJson, f.network, f.ports);
async function owned(f, client, index = 0) {
  const plan = f.plan(index), deployed = JSON.parse(await client.readDeployment(plan)), base = f.base.options.manifest.base;
  const bytes = buildReferenceAskRequestBody({ question: f.base.dataset.cases[index].query, corpusId: base.scope.corpusId,
    topK: base.parameters.topK, llmModel: base.models.llm.id, embeddingModel: base.models.embedding.id });
  return { schemaVersion: 'kg-reference-owned-ask-request/v1', requestPlan: plan, bodyBase64url: bytes.toString('base64url'),
    bodySha256: sha(bytes), deploymentHash: hash(deployed) };
}
async function waitForEntered(entered, pending) {
  await Promise.race([entered, pending.then(() => { throw Error('Transport ended before expected step'); }, e => { throw Error('Transport failed before expected step', { cause: e }); })]);
}

async function attachActualProducer(f) {
  const payload = f.base.options.expectedExecutionPayload, binding = f.plan(0).binding;
  const common = { executionProfile: 'local-reference', binding,
    actors: { executorId: payload.participants.executorId, readOnlyId: payload.participants.readOnlyId },
    validFrom: payload.notBefore, validUntil: payload.expiresAt, maxObjects: 10000 };
  const kms = createReferenceKmsEnvelope({ ...common, keyPolicyRef: f.base.options.manifest.base.artifactPolicy.keyPolicyRef, maxPlaintextBytes: 65536 });
  f.options.artifacts.expectedKeyRef = await kms.rotateKey({ context: { executionProfile: 'local-reference', binding,
    actorId: payload.participants.executorId, authorizationDigest: f.base.options.executionAuthorizationRef.sha256,
    observedAt: new Date(Date.parse(payload.notBefore) + 60000).toISOString() } });
  const store = createReferenceArtifactStore({ ...common, storeIdentityRef: f.options.artifacts.storeIdentityRef, maxObjectBytes: 256 * 1024 });
  const client = make(f), producerPorts = {
    clock: f.ports.clock, transport: client,
    kms: { ...flags, encryptArtifact: r => kms.encryptArtifact(r), decryptArtifact: r => kms.decryptArtifact(r) },
    store: { ...flags, sealEncryptedArtifact: r => store.sealEncryptedArtifact(r), readExact: r => store.readExact(r) },
  };
  const producer = createReferenceProductionAskProducer(f.options, f.base.rawDatasetJson, producerPorts);
  return { client, producer, producerPorts };
}

const authorityKeys = Object.fromEntries(['execution', 'conformance', 'runtime'].map(kind => [kind, generateKeyPairSync('ed25519')]));
const authorityFailure = code => e => e instanceof authoritySubject.AuthorityAskRunnerError && e.code === code
  && e.productionAccepted === false && e.automaticRetryAllowed === false && !Object.hasOwn(e, 'cause')
  && !/RAW_|CANARY|token-|localhost|CERTIFICATE/.test(e.message) && Object.isFrozen(e);
async function authorityFixture(t, settings = {}) {
  let f, currentMode = 'off';
  f = await setup(t, { ...settings, responseFactory: row => {
    const input = JSON.parse(row.bytes), index = f.base.dataset.cases.findIndex(c => c.query === input.question), e = clone(f.base.dataset.corpus[0]); delete e.metadata;
    return Buffer.from(JSON.stringify({ success: true, question: input.question, answer: index === 0 ? 'RAW_EXPECTED_FACT_CANARY' : '',
      models: { llm: input.llmModel, embedding: input.embeddingModel }, storageBackend: 'milvus', traceId: 'transport-fixture',
      evidence: index === 0 ? [{ ...e, id: e.evidenceId, retrievalScore: 1, laneId: 'dense' }] : [],
      citations: index === 0 ? [{ evidenceId: e.evidenceId, startOffset: 0, endOffset: 7 }] : [], laneExecutions: [{ laneId: 'dense', status: 'completed' }],
      retrievalDetails: { graph: { requestedMode: currentMode }, abstention: { mode: 'active', abstain: index !== 0 } } }));
  } });
  const base = f.base.options, policy = base.deploymentPolicy, proto = providerFixture('T16');
  const attest = (kind, body) => { const signer = { algorithm: 'Ed25519', keyId: 'authority-' + kind, keyVersion: 'v1' };
    return { kind, body, signature: { ...signer, value: sign(null, Buffer.from(canonicalJson({ signatureProfile: 'kg-provider-attestation-signature/v1', kind, body, signer })), authorityKeys[kind].privateKey).toString('base64url') } }; };
  const conformanceObjects = proto.request.conformanceObjects.map(object => {
    const body = clone(object.attestation.body), registration = policy.registrations.find(r => r.purpose === body.provider.purpose);
    Object.assign(body, { registryRef: clone(base.policyRef), scope: clone(base.expectedExecutionPayload.scope), issuerId: 'authority-conformance-issuer',
      provider: Object.fromEntries(Object.keys(body.provider).map(k => [k, clone(registration[k])])) });
    const attestation = attest('conformance', body), out = { ref: ref(body.provider.purpose + '-authority-conformance'), attestation }; out.ref.sha256 = hash(attestation);
    base.manifest.base.providers.bindings.find(b => b.purpose === body.provider.purpose).conformanceRef = clone(out.ref); return out;
  });
  rebindExecution(f.base); const payload = clone(base.expectedExecutionPayload), signer = { algorithm: 'Ed25519', keyId: 'authority-execution', keyVersion: 'v1' };
  const executionEnvelope = { schemaVersion: 'kg-execution-authorization-envelope/v1', kind: 'execution', payload,
    signature: { ...signer, value: sign(null, Buffer.from(canonicalJson({ signatureProfile: 'kg-production-authorization-signature/v1', schemaVersion: 'kg-execution-authorization-envelope/v1',
      kind: 'execution', payload, signer })), authorityKeys.execution.privateKey).toString('base64url') } };
  base.executionAuthorizationRef = ref('authority-execution-envelope'); base.executionAuthorizationRef.sha256 = hash(executionEnvelope);
  base.manifest.t16.executionAuthorizationRef = clone(base.executionAuthorizationRef); f.options.askOptions = clone(base);
  const runtimeObjects = proto.request.runtimeObjects.map(object => {
    const body = clone(object.attestation.body), registration = policy.registrations.find(r => r.purpose === body.provider.purpose);
    Object.assign(body, { registryRef: clone(base.policyRef), scope: clone(payload.scope), issuerId: 'authority-runtime-issuer', runNonce: payload.runNonce,
      manifestHash: payload.manifestHash, providersHash: payload.providersHash,
      provider: Object.fromEntries(Object.keys(body.provider).map(k => [k, clone(registration[k])])) });
    const attestation = attest('runtime', body), out = { ref: ref(body.provider.purpose + '-authority-runtime'), attestation }; out.ref.sha256 = hash(attestation); return out;
  });
  const oldDeployment = f.ports.deployment.readDeployment, oldMeasurement = f.ports.measurement.readMeasurement;
  f.ports.deployment.readDeployment = async plan => { currentMode = plan.requestIdentity.rolloutMode; return oldDeployment(plan); };
  f.ports.measurement.readMeasurement = async request => { const out = JSON.parse(await oldMeasurement(request)), query = JSON.parse(f.state.requests.at(-1).bytes).question;
    out.measurement.abstained = f.base.dataset.cases.findIndex(c => c.query === query) !== 0; return JSON.stringify(out); };
  const attached = await attachActualProducer(f); t.after(() => { attached.producer.close(); attached.client.close(); });
  const binding = f.plan(0).binding, refs = { conformance: ref('authority-conformance-source'), runtime: ref('authority-runtime-source') };
  const nonceStoreIdentityRef = ref('authority-nonce-source'), registryIdentityRef = ref('authority-registry-source');
  const selection = { stage: payload.stage, scope: payload.scope, runNonce: payload.runNonce, manifestHash: payload.manifestHash,
    providers: base.manifest.base.providers, executionProvidersHash: payload.providersHash };
  const evidenceOptions = { executionProfile: 'local-reference', scope: payload.scope, registryRef: base.policyRef, registryIdentityRef,
    readerId: payload.participants.readOnlyId, readerAuthorizationDigest: base.executionAuthorizationRef.sha256,
    authorityKeys: ['conformance', 'runtime'].map(kind => ({ kind, keyId: 'authority-' + kind, keyVersion: 'v1', issuerId: 'authority-' + kind + '-issuer',
      publicKeySpki: authorityKeys[kind].publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'), validFrom: policy.validFrom, validUntil: policy.validUntil, revoked: false })),
    operationTimeoutMs: 5000, maxVerifications: 4096, expectedSelection: selection, clockIdentityRef: f.options.artifacts.clockIdentityRef,
    maxClockUncertaintyMs: 10, evidenceIdentityRefs: refs, observationWindow: clone(payload.window) };
  const approvalOptions = { executionProfile: 'local-reference', scope: payload.scope,
    actors: { verifierId: payload.participants.executorId, readOnlyId: payload.participants.readOnlyId }, clockIdentityRef: f.options.artifacts.clockIdentityRef,
    nonceStoreIdentityRef, maxClockUncertaintyMs: 10, operationTimeoutMs: 5000, maxVerifications: 1,
    keys: [{ keyId: signer.keyId, keyVersion: 'v1', issuerId: payload.issuerId, role: 'execution', publicKeySpki: authorityKeys.execution.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
      validFrom: policy.validFrom, validUntil: policy.validUntil, revoked: false }] };
  const registry = createReferenceProviderRegistry({ executionProfile: 'local-reference', scope: payload.scope, sourceIdentityRef: registryIdentityRef,
    readOnlyActorIds: [payload.participants.readOnlyId], maxReads: 4096, policies: [{ ref: base.policyRef, policy }] });
  const evidenceConfig = { executionProfile: 'local-reference', binding, readerId: payload.participants.readOnlyId,
    authorizationDigest: base.executionAuthorizationRef.sha256, sourceIdentityRefs: refs, validFrom: payload.notBefore, validUntil: payload.expiresAt, maxReads: 4096,
    objects: { conformance: conformanceObjects, runtime: runtimeObjects } };
  // The two configured source identities own independent reference lifetimes.
  // Keep the original 4096 ceiling for each: no reset, eviction or widening.
  const conformanceSource = createReferenceProviderEvidenceStore(evidenceConfig), runtimeSource = createReferenceProviderEvidenceStore(evidenceConfig);
  const evidence = { ...flags, readExactConformance: request => conformanceSource.readExactConformance(request),
    readRuntimeMeasurement: request => runtimeSource.readRuntimeMeasurement(request) };
  const nonceStore = createReferenceAuthorizationNonceStore({ executionProfile: 'local-reference', scope: payload.scope,
    actors: { writerId: payload.participants.executorId, readOnlyId: payload.participants.readOnlyId }, storeIdentityRef: nonceStoreIdentityRef,
    clockIdentityRef: f.options.artifacts.clockIdentityRef, maxClaims: 100, maxClockUncertaintyMs: 10 });
  f.audit = []; const own = (name, raw, methods) => ({ ...flags, ...Object.fromEntries(methods.map(method => [method, input => { f.audit.push(name + '.' + method); return raw[method](input); }])) });
  f.authorityPorts = { clock: own('clock', f.ports.clock, ['readTime']), kms: own('kms', attached.producerPorts.kms, ['encryptArtifact', 'decryptArtifact']),
    store: own('store', attached.producerPorts.store, ['sealEncryptedArtifact', 'readExact']), secret: own('secret', f.ports.secret, ['readAskCredential']),
    deployment: own('deployment', f.ports.deployment, ['readDeployment']), measurement: own('measurement', f.ports.measurement, ['readMeasurement']),
    registry: own('registry', registry, ['readExactPolicy']), evidence: own('evidence', evidence, ['readExactConformance', 'readRuntimeMeasurement']),
    nonceStore: own('nonceStore', nonceStore, ['consumeAuthorizationNonce', 'readExactNonceClaim']) };
  f.authorityOptions = { ...clone(f.options), authority: { executionEnvelope, approvalOptions, evidenceOptions } }; f.nonceStore = nonceStore;
  return f;
}
const makeAuthority = f => authoritySubject.createReferenceAuthorityAskRunner(f.authorityOptions, f.base.rawDatasetJson, f.network, f.authorityPorts);

export { material, wrongMaterial, otherMaterial, clone, sha, flags, ref, hash, err, setup, grant, make, owned,
  waitForEntered, attachActualProducer, authoritySubject, subject, authorityFailure, authorityFixture, makeAuthority };

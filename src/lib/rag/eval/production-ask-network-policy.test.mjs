import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { registerHooks } from 'node:module';
import { makeAskTlsTestMaterial } from './production-ask-tls-fixtures.test-support.mjs';
registerHooks({ resolve(s, c, next) { try { return next(s, c); } catch (error) {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && s.startsWith('.') && !/\.[cm]?[jt]s$/.test(s)) return next(s + '.ts', c);
  throw error;
} } });
const { fixture } = await import('./production-ask-dataset-fixtures.test-support.mjs');
const { createReferenceProductionAskDatasetBinding } = await import('./production-ask-dataset-binding.ts');
let subject; try { subject = await import('./production-ask-network-policy.ts'); } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; subject = {};
}
const sha = x => createHash('sha256').update(x).digest('hex'), clone = x => structuredClone(x);
const material = makeAskTlsTestMaterial();
function config(mode = 'local-loopback-test', addresses = ['::1', '127.0.0.1']) {
  const f = fixture('T16'); const plan = clone(createReferenceProductionAskDatasetBinding(f.options, f.rawDatasetJson).planRequest({
    caseId: f.dataset.cases[0].id, rolloutMode: 'off', phase: 'trial', ordinal: 0,
  }).requestPlan);
  const scope = Object.fromEntries(['environment', 'tenantId', 'corpusId'].map(k => [k, plan.binding[k]]));
  const base = { scope, origin: plan.target.origin, validFrom: plan.effectiveWindow.startsAt, validUntil: plan.effectiveWindow.endsAt };
  const dns = { schemaVersion: 'kg-reference-ask-dns-policy/v1', ...base, mode, allowedAddresses: addresses };
  const roots = { schemaVersion: 'kg-reference-ask-tls-roots/v1', ...base, caCertificatesPem: [material.cert] };
  const pin = () => { plan.target.networkPolicy.dnsPolicyRef.sha256 = sha(JSON.stringify(dns));
    plan.target.networkPolicy.tlsTrustRootsRef.sha256 = sha(JSON.stringify(roots)); };
  pin(); return { plan, dns, roots, pin };
}
const validate = f => subject.validateReferenceAskNetworkArtifacts(f.plan, JSON.stringify(f.dns), JSON.stringify(f.roots));
const select = (f, rows) => subject.selectReferenceAskPinnedAddress(validate(f), rows);

test('actual synthetic X509 fixture is valid before any policy implementation', () => {
  assert.match(material.cert, /-----BEGIN CERTIFICATE-----/); assert.match(material.key, /-----BEGIN PRIVATE KEY-----/);
});
test('DNS and TLS artifacts bind exact raw refs scope origin full window without authenticating them', () => {
  const f = config(), proof = validate(f);
  assert.equal(proof.productionAuthorized, false); assert.equal(proof.registryAuthenticated, false);
  assert.equal(proof.tlsEstablished, false); assert.equal(proof.classification, 'confidential');
  assert.deepEqual(proof.allowedAddresses, ['::1', '127.0.0.1']);
  for (const mutate of [x => { x.dns.scope.tenantId = 'other'; }, x => { x.roots.origin = 'https://evil.test'; },
    x => { x.dns.validUntil = x.plan.effectiveWindow.startsAt; }, x => { x.roots.validFrom = x.plan.effectiveWindow.endsAt; }]) {
    const g = config(); mutate(g); g.pin(); assert.throws(() => validate(g));
  }
});
test('raw bytes digest swaps unknown fields and TLS safety relaxations are rejected', () => {
  assert.equal(typeof subject.validateReferenceAskNetworkArtifacts, 'function');
  const f = config();
  assert.throws(() => subject.validateReferenceAskNetworkArtifacts(f.plan, JSON.stringify(f.dns) + ' ', JSON.stringify(f.roots)));
  for (const mutate of [x => { x.dns.proxy = true; }, x => { x.plan.target.networkPolicy.redirects = 'allowed'; },
    x => { x.plan.target.networkPolicy.tlsChainVerification = false; }, x => { x.plan.target.networkPolicy.port++; },
    x => { x.plan.target.url += '?override=1'; }]) {
    const g = config(); mutate(g); g.pin(); assert.throws(() => validate(g));
  }
});
test('TLS roots reject private material duplicate DER certificates and malformed PEM', () => {
  assert.equal(typeof subject.validateReferenceAskNetworkArtifacts, 'function');
  for (const certificates of [[material.key], [material.cert + material.key], [material.cert, material.cert], ['RAW_INVALID_CERTIFICATE']]) {
    const f = config(); f.roots.caCertificatesPem = certificates; f.pin(); assert.throws(() => validate(f));
  }
});

test('a single CERTIFICATE label must not conceal trailing DER private material or extra bytes', () => {
  const der = new X509Certificate(material.cert).raw;
  const privateDer = createPrivateKey(material.key).export({ type: 'pkcs8', format: 'der' });
  const encoded = bytes => '-----BEGIN CERTIFICATE-----\n'
    + bytes.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
  const clean = config(); clean.roots.caCertificatesPem = [encoded(der)]; clean.pin();
  assert.equal(validate(clean).tlsEstablished, false);
  for (const tail of [privateDer, der, Buffer.from([0])]) {
    const f = config();
    f.roots.caCertificatesPem = [encoded(Buffer.concat([der, tail]))];
    f.pin(); assert.throws(() => validate(f));
  }
});
test('explicit local loopback policy pins an approved literal and rejects any unexpected DNS result', () => {
  const f = config(); assert.equal(select(f, [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }]), '::1');
  assert.throws(() => select(f, [{ address: '::1', family: 6 }, { address: '8.8.8.8', family: 4 }]));
  assert.throws(() => select(f, [{ address: '::1', family: 4 }])); assert.throws(() => select(f, []));
});
test('public DNS policy rejects loopback private metadata link-local mapped and transition bypasses', () => {
  assert.equal(typeof subject.validateReferenceAskNetworkArtifacts, 'function');
  for (const address of ['127.0.0.1', '::1', '10.1.2.3', 'fc00::1', '169.254.169.254', '168.63.129.16',
    '100.100.100.200', 'fe80::1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', '0.0.0.0', '224.0.0.1']) {
    const f = config('public-addresses', [address]); assert.throws(() => validate(f));
  }
  const f = config('public-addresses', ['8.8.8.8']); assert.equal(select(f, [{ address: '8.8.8.8', family: 4 }]), '8.8.8.8');
});
test('private DNS allowlist is explicit and cannot authorize metadata public or other private addresses', () => {
  const f = config('private-addresses', ['10.1.2.3']); assert.equal(select(f, [{ address: '10.1.2.3', family: 4 }]), '10.1.2.3');
  assert.throws(() => select(f, [{ address: '10.1.2.4', family: 4 }]));
  for (const address of ['8.8.8.8', '169.254.169.254', 'fe80::1', 'fd00:ec2::254', 'fd20:ce::254']) {
    assert.throws(() => validate(config('private-addresses', [address])));
  }
});
test('duplicate aliases empty inventories and unsafe carriers cannot run getters or Proxy traps', () => {
  assert.equal(typeof subject.validateReferenceAskNetworkArtifacts, 'function');
  for (const addresses of [[], ['::1', '0:0:0:0:0:0:0:1'], ['127.1'], ['0177.0.0.1']]) assert.throws(() => validate(config('local-loopback-test', addresses)));
  const f = config(); let hooks = 0; const trap = () => { hooks++; throw Error('RAW_POLICY_SECRET'); };
  assert.throws(() => subject.validateReferenceAskNetworkArtifacts(new Proxy(f.plan, { get: trap, ownKeys: trap }), JSON.stringify(f.dns), JSON.stringify(f.roots)));
  const row = { family: 6 }; Object.defineProperty(row, 'address', { enumerable: true, get: trap });
  assert.throws(() => select(f, [row])); assert.equal(hooks, 0);
});

test('a caller clone or getter-labeled policy cannot masquerade as a validated artifact instance', () => {
  const f = config(), policy = validate(f), rows = [{ address: '::1', family: 6 }]; let hooks = 0;
  assert.throws(() => subject.selectReferenceAskPinnedAddress(clone(policy), rows));
  assert.throws(() => subject.selectReferenceAskPinnedAddress(new Proxy(policy, { get() { hooks++; } }), rows));
  assert.equal(hooks, 0);
});

test('an explicit public allowlist retains IANA globally reachable more-specific protocol allocations', () => {
  for (const ip of ['192.0.0.9', '192.0.0.10', '2001:1::1', '2001:1::2', '2001:1::3',
    '2001:3::1', '2001:4:112::1', '2001:20::1', '2001:30::1']) {
    assert.equal(select(config('public-addresses', [ip]), [{ address: ip, family: ip.includes(':') ? 6 : 4 }]), ip);
  }
  for (const ip of ['192.0.0.8', '2001:2::1', '2001:db8::1', '3fff::1']) assert.throws(() => validate(config('public-addresses', [ip])));
});

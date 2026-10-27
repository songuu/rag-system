import { createHash, X509Certificate } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { types } from 'node:util';
import { canonicalJson } from './canonical-json';
import type { ArtifactReference } from './production-gate-manifest';
import type { ReferenceProductionAskRequestPlan } from './production-ask-target';

type Fields = Record<string, unknown>;
type Mode = 'local-loopback-test' | 'private-addresses' | 'public-addresses';
const MAX_ARTIFACT_BYTES = 256 * 1024;
const validatedPolicies = new WeakSet<object>();
// Node BlockList applies an IPv6 mapped subnet to ordinary IPv4 inputs too.
// Keep prohibited families separate or the mapped-bypass guard blocks ALL v4.
const privateAddresses = new BlockList(), prohibitedV4 = new BlockList(), prohibitedV6 = new BlockList(), globalV6 = new BlockList();
const protocolV4 = new BlockList(), protocolV6 = new BlockList(), publicProtocolV4 = new BlockList(), publicProtocolV6 = new BlockList();
for (const [address, prefix] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) privateAddresses.addSubnet(address, prefix, 'ipv4');
privateAddresses.addSubnet('fc00::', 7, 'ipv6'); globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['0.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['100.64.0.0', 10],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) prohibitedV4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], ['fe80::', 10], ['ff00::', 8]] as const) prohibitedV6.addSubnet(address, prefix, 'ipv6');
// IANA marks these more-specific protocol allocations globally reachable.
// Exceptions override only the protocol blocks, never the metadata/hard denies.
protocolV4.addSubnet('192.0.0.0', 24, 'ipv4'); protocolV6.addSubnet('2001::', 23, 'ipv6');
for (const ip of ['192.0.0.9', '192.0.0.10']) publicProtocolV4.addAddress(ip, 'ipv4');
for (const ip of ['2001:1::1', '2001:1::2', '2001:1::3']) publicProtocolV6.addAddress(ip, 'ipv6');
for (const [ip, prefix] of [['2001:3::', 32], ['2001:4:112::', 48], ['2001:20::', 28], ['2001:30::', 28]] as const) publicProtocolV6.addSubnet(ip, prefix, 'ipv6');
// Cloud metadata/service endpoints are never granted by a private IP allowlist.
prohibitedV4.addAddress('168.63.129.16', 'ipv4');
prohibitedV6.addAddress('fd00:ec2::254', 'ipv6');
prohibitedV6.addAddress('fd20:ce::254', 'ipv6');

export class ProductionAskNetworkPolicyError extends Error {
  readonly code: 'invalid-policy' | 'invalid-dns-result';
  readonly productionAuthorized = false;
  constructor(code: 'invalid-policy' | 'invalid-dns-result') {
    const safe = code === 'invalid-dns-result' ? code : 'invalid-policy';
    super('[production Ask network policy] ' + safe);
    this.name = 'ProductionAskNetworkPolicyError'; this.code = safe; Object.freeze(this);
  }
}
export interface ReferenceAskNetworkArtifacts {
  readonly classification: 'confidential';
  readonly validationLevel: 'reference-raw-artifact-and-x509-correspondence';
  readonly productionAuthorized: false;
  readonly registryAuthenticated: false;
  readonly tlsEstablished: false;
  readonly origin: string;
  readonly mode: Mode;
  readonly allowedAddresses: readonly string[];
  readonly caCertificatesPem: readonly string[];
  readonly dnsPolicyRef: ArtifactReference;
  readonly tlsTrustRootsRef: ArtifactReference;
}

/** Verify complete artifact bytes against the frozen plan refs. This performs
 * NO lookup, TLS, credential or HTTP IO and does not authenticate the registry,
 * approval, authority clock or endpoint. The eventual transport must verify
 * the native socket on the original hostname BEFORE asking for credentials. */
export function validateReferenceAskNetworkArtifacts(inputPlan: ReferenceProductionAskRequestPlan, dnsPolicyJson: unknown, tlsTrustRootsJson: unknown, ...extras: unknown[]): ReferenceAskNetworkArtifacts {
  try {
    if (extras.length) throw new Error();
    const plan = snapshot(inputPlan), target = record(plan.target), network = record(target.networkPolicy);
    const origin = text(target.origin), url = new URL(origin);
    if (origin.length > 512 || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
      || url.search || url.hash || url.origin !== origin || target.url !== origin + '/api/ask' || target.method !== 'POST') throw new Error();
    exact(network, ['port', 'redirects', 'proxy', 'tlsHostnameVerification', 'tlsChainVerification', 'tlsTrustRootsRef', 'dnsPolicyRef',
      'requestTimeoutMs', 'maxCompressedBytes', 'maxResponseBytes', 'maxStreamBytes']);
    if (integer(network.port, 1, 65535) !== Number(url.port || 443) || network.redirects !== 'forbidden' || network.proxy !== 'disabled'
      || network.tlsHostnameVerification !== true || network.tlsChainVerification !== true) throw new Error();
    integer(network.requestTimeoutMs, 1, 300000);
    for (const key of ['maxCompressedBytes', 'maxResponseBytes', 'maxStreamBytes']) integer(network[key], 1, 16 * 1024 * 1024);
    const dnsRef = reference(network.dnsPolicyRef), tlsRef = reference(network.tlsTrustRootsRef);
    const dns = artifact(dnsPolicyJson, dnsRef), roots = artifact(tlsTrustRootsJson, tlsRef);
    const fields = ['schemaVersion', 'scope', 'origin', 'validFrom', 'validUntil'];
    exact(dns, [...fields, 'mode', 'allowedAddresses']); exact(roots, [...fields, 'caCertificatesPem']);
    if (dns.schemaVersion !== 'kg-reference-ask-dns-policy/v1' || roots.schemaVersion !== 'kg-reference-ask-tls-roots/v1') throw new Error();
    const binding = record(plan.binding), scope = Object.fromEntries(['environment', 'tenantId', 'corpusId'].map(key => [key, identifier(binding[key])]));
    const window = record(plan.effectiveWindow), starts = time(window.startsAt), ends = time(window.endsAt);
    if (ends <= starts) throw new Error();
    for (const value of [dns, roots]) {
      if (canonicalJson(value.scope) !== canonicalJson(scope) || value.origin !== origin
        || time(value.validFrom) > starts || time(value.validUntil) < ends) throw new Error();
    }
    const mode = dns.mode;
    if (mode !== 'local-loopback-test' && mode !== 'private-addresses' && mode !== 'public-addresses') throw new Error();
    const addresses = array(dns.allowedAddresses, 1, 64).map(address);
    if (new Set(addresses).size !== addresses.length || addresses.some(ip => !allowedClass(ip, mode))) throw new Error();
    const certificates = array(roots.caCertificatesPem, 1, 16).map(pem), certificateHashes = new Set<string>();
    for (const value of certificates) {
      const certificate = new X509Certificate(value), hash = digest(certificate.raw);
      if (!certificate.ca || certificateHashes.has(hash)) throw new Error(); certificateHashes.add(hash);
    }
    const result: ReferenceAskNetworkArtifacts = freeze({ classification: 'confidential', validationLevel: 'reference-raw-artifact-and-x509-correspondence',
      productionAuthorized: false, registryAuthenticated: false, tlsEstablished: false, origin, mode,
      allowedAddresses: addresses, caCertificatesPem: certificates, dnsPolicyRef: dnsRef, tlsTrustRootsRef: tlsRef });
    validatedPolicies.add(result); return result;
  } catch { throw new ProductionAskNetworkPolicyError('invalid-policy'); }
}

/** All native lookup results must be approved. Never discard a hostile answer
 * and silently try the good one. Return one approved literal for direct socket
 * connection; the transport must not resolve the hostname again or fail over. */
export function selectReferenceAskPinnedAddress(inputPolicy: ReferenceAskNetworkArtifacts, resolved: unknown, ...extras: unknown[]): string {
  try {
    if (extras.length || !inputPolicy || typeof inputPolicy !== 'object' || types.isProxy(inputPolicy) || !validatedPolicies.has(inputPolicy)) throw new Error();
    const values: unknown = JSON.parse(canonicalJson(resolved)); const rows = array(values, 1, 64), seen = new Set<string>();
    for (const raw of rows) {
      const value = record(raw); exact(value, ['address', 'family']); const ip = address(value.address);
      if (value.family !== isIP(ip) || !inputPolicy.allowedAddresses.includes(ip) || !allowedClass(ip, inputPolicy.mode) || seen.has(ip)) throw new Error();
      seen.add(ip);
    }
    const selected = inputPolicy.allowedAddresses.find(ip => seen.has(ip)); if (!selected) throw new Error(); return selected;
  } catch { throw new ProductionAskNetworkPolicyError('invalid-dns-result'); }
}

function allowedClass(ip: string, mode: Mode): boolean {
  if (mode === 'local-loopback-test') return ip === '127.0.0.1' || ip === '::1';
  const family = isIP(ip) === 4 ? 'ipv4' : 'ipv6';
  if ((family === 'ipv4' ? prohibitedV4 : prohibitedV6).check(ip, family)) return false;
  if ((family === 'ipv4' ? protocolV4 : protocolV6).check(ip, family)
    && (mode !== 'public-addresses' || !(family === 'ipv4' ? publicProtocolV4 : publicProtocolV6).check(ip, family))) return false;
  const privateIp = privateAddresses.check(ip, family);
  return mode === 'private-addresses' ? privateIp : !privateIp && (family === 'ipv4' || globalV6.check(ip, 'ipv6'));
}
function address(input: unknown): string {
  if (typeof input !== 'string' || input.length > 64 || !isIP(input)) throw new Error();
  return isIP(input) === 4 ? input : new URL('https://[' + input + ']/').hostname.slice(1, -1);
}
function pem(input: unknown): string {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 64 * 1024
    || !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(input.trim())) throw new Error(); return input;
}
function artifact(input: unknown, ref: ArtifactReference): Fields {
  if (typeof input !== 'string' || input.length > MAX_ARTIFACT_BYTES || Buffer.byteLength(input) > MAX_ARTIFACT_BYTES
    || digest(Buffer.from(input)) !== ref.sha256) throw new Error(); return snapshot(JSON.parse(input));
}
function reference(input: unknown): ArtifactReference {
  const value = record(input); exact(value, ['objectId', 'objectVersion', 'sha256']); const sha256 = text(value.sha256);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error();
  return { objectId: identifier(value.objectId), objectVersion: identifier(value.objectVersion), sha256 };
}
function identifier(input: unknown): string { const value = text(input); if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new Error(); return value; }
function text(input: unknown): string { if (typeof input !== 'string') throw new Error(); return input; }
function time(input: unknown): number {
  const value = text(input), at = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(at) || new Date(at).toISOString() !== value) throw new Error(); return at;
}
function integer(input: unknown, min: number, max: number): number { if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) throw new Error(); return input; }
function array(input: unknown, min: number, max: number): unknown[] { if (!Array.isArray(input) || input.length < min || input.length > max) throw new Error(); return input; }
function snapshot(input: unknown): Fields { return record(JSON.parse(canonicalJson(input))); }
function record(input: unknown): Fields { if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(); return input as Fields; }
function exact(input: Fields, keys: readonly string[]): void { if (keys.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !keys.includes(key))) throw new Error(); }
function digest(input: Buffer): string { return createHash('sha256').update(input).digest('hex'); }
function freeze<T>(input: T): T { if (input && typeof input === 'object') { for (const value of Object.values(input)) freeze(value); Object.freeze(input); } return input; }

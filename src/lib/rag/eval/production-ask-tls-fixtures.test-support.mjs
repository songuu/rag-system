import { createPrivateKey, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Fresh synthetic key stays in memory/private child stdio; no private-key file,
 * production trust, credentials, command argument or test-output disclosure. */
export function makeAskTlsTestMaterial(hostname = 'localhost') {
  if (!['localhost', 'wrong.invalid'].includes(hostname)) throw Error('Unsupported TLS fixture hostname');
  const result = spawnSync('openssl', ['req', '-new', '-x509', '-sha256', '-newkey', 'ec',
    '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-noenc', '-keyout', '-', '-out', '-', '-days', '3650',
    '-config', fileURLToPath(new URL('./production-ask-tls-fixture.cnf', import.meta.url)),
    '-addext', 'subjectAltName=DNS:' + hostname + (hostname === 'localhost' ? ',IP:127.0.0.1,IP:::1' : '')],
  { encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024 });
  if (result.status !== 0 || result.error) throw Error('Synthetic TLS fixture generation unavailable');
  const key = result.stdout.match(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/)?.[0];
  const cert = result.stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)?.[0];
  if (!key || !cert) throw Error('Incomplete synthetic TLS fixture');
  const certificate = new X509Certificate(cert);
  if (!certificate.ca || certificate.checkHost(hostname) !== hostname
    || !certificate.checkPrivateKey(createPrivateKey(key))) throw Error('Invalid synthetic TLS fixture');
  return Object.freeze({ key: key + '\n', cert: cert + '\n' });
}

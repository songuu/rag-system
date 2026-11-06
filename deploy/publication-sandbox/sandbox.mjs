import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(ROOT, 'runtime');
const ID = /^[a-f0-9]{24}$/;
const secret = () => `Aa1${randomBytes(24).toString('hex')}`;

function run(program, args, options = {}) {
  try {
    return execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...options }).trim();
  } catch {
    // Docker/SDK error output may contain connection strings or credentials.
    throw new Error(`${program} operation failed; inspect the isolated environment locally.`);
  }
}

function folder(id) {
  if (!ID.test(id)) throw new Error('Invalid sandbox ID.');
  const target = resolve(RUNTIME, id);
  if (dirname(target) !== resolve(RUNTIME)) throw new Error('Invalid sandbox directory.');
  if (!existsSync(target) || lstatSync(target).isSymbolicLink() || realpathSync(target) !== target) {
    throw new Error('Sandbox directory is missing or is a link.');
  }
  return target;
}

function restrictDirectory(path) {
  chmodSync(path, 0o700);
  if (process.platform === 'win32') {
    const who = run('whoami', ['/user', '/fo', 'csv', '/nh']);
    const sid = who.match(/S-1-(?:\d+-)+\d+/)?.[0];
    if (!sid) throw new Error('Cannot resolve current Windows user SID.');
    run('icacls', [path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`]);
  }
}

function writePrivate(path, data) {
  writeFileSync(path, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}

function docker(id, args) {
  const path = folder(id);
  return run('docker', ['compose', '--env-file', join(path, '.env'), '-p', `ragpub${id}`,
    '-f', join(ROOT, 'compose.yaml'), ...args]);
}

function port(id, service, internalPort) {
  const value = docker(id, ['port', service, String(internalPort)]);
  const match = /^127\.0\.0\.1:(\d+)$/.exec(value);
  if (!match) throw new Error('Sandbox service is not bound to loopback.');
  return Number(match[1]);
}

export function createSandbox() {
  mkdirSync(RUNTIME, { recursive: true, mode: 0o700 });
  if (lstatSync(RUNTIME).isSymbolicLink()) throw new Error('Sandbox runtime root must not be a link.');
  const id = randomBytes(12).toString('hex');
  const path = join(RUNTIME, id);
  mkdirSync(path, { mode: 0o700 });
  restrictDirectory(path);
  const c = { postgresAdmin: secret(), elasticAdmin: secret(), minioUser: `pub${randomBytes(8).toString('hex')}`,
    minioPassword: secret(), neo4j: secret(), milvusAdmin: secret(),
    dbMigration: secret(), dbApp: secret(), dbPublisher: secret(),
    esWriter: secret(), esSealer: secret(), esReader: secret(), milvusWriter: secret(), milvusReader: secret() };
  writePrivate(join(path, 'credentials.json'), JSON.stringify(c));
  writePrivate(join(path, 'postgres-admin.txt'), c.postgresAdmin);
  writePrivate(join(path, 'elastic-admin.txt'), c.elasticAdmin);
  const absolute = path.replaceAll('\\', '/');
  writePrivate(join(path, '.env'), [
    `SANDBOX_RUNTIME_DIR=${absolute}`, `SANDBOX_MINIO_USER=${c.minioUser}`,
    `SANDBOX_MINIO_PASSWORD=${c.minioPassword}`, `SANDBOX_NEO4J_PASSWORD=${c.neo4j}`,
    `SANDBOX_ELASTIC_ADMIN=${c.elasticAdmin}`,
  ].join('\n') + '\n');
  writePrivate(join(path, 'openssl.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n'
    + '[dn]\nCN=elasticsearch\n[extensions]\nsubjectAltName=DNS:elasticsearch,DNS:localhost,IP:127.0.0.1\n');
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '7',
    '-config', join(path, 'openssl.cnf'),
    '-keyout', join(path, 'tls.key'), '-out', join(path, 'tls.crt')]);
  // Docker's unprivileged Elasticsearch process must read the bind-mounted
  // key; the enclosing directory remains restricted to this OS account.
  chmodSync(join(path, 'tls.key'), 0o644);
  chmodSync(join(path, 'tls.crt'), 0o644);
  return id;
}

export function startSandbox(id) {
  docker(id, ['up', '-d']);
}

export function stopSandbox(id) {
  docker(id, ['stop']);
}

export function destroySandbox(id, confirmation) {
  if (confirmation !== `destroy:${id}`) throw new Error('Explicit sandbox confirmation required.');
  const path = folder(id);
  docker(id, ['down', '--volumes', '--remove-orphans']);
  // Only a verified direct child of the intended runtime directory is removed.
  if (dirname(realpathSync(path)) !== realpathSync(RUNTIME) || !path.endsWith(`${sep}${id}`)) {
    throw new Error('Sandbox directory changed before cleanup.');
  }
  rmSync(path, { recursive: true, force: false });
}

export function readSandboxConfig(id) {
  const path = folder(id);
  const credentials = JSON.parse(readFileSync(join(path, 'credentials.json'), 'utf8'));
  const state = JSON.parse(readFileSync(join(path, 'state.json'), 'utf8'));
  const database = state.database ?? 'publication_sandbox';
  if (typeof database !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(database)) throw new Error('Invalid sandbox database.');
  const ports = { postgres: port(id, 'postgres', 5432), elasticsearch: port(id, 'elasticsearch', 9200),
    milvus: port(id, 'milvus', 19530), neo4j: port(id, 'neo4j', 7687) };
  return { id, path, credentials, ports, database, ca: readFileSync(join(path, 'tls.crt')) };
}

export function writeConnectionFiles(config) {
  const { path, credentials: c, ports: p } = config;
  const database = config.database ?? 'publication_sandbox';
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(database)) throw new Error('Invalid sandbox database.');
  const db = (user, password) => `postgresql://${user}:${password}@127.0.0.1:${p.postgres}/${database}`;
  writePrivate(join(path, 'app.env'), [
    `DATABASE_URL=${db('pub_app', c.dbApp)}`, 'POSTGRES_SSL_MODE=disable',
    `ELASTICSEARCH_URL=https://127.0.0.1:${p.elasticsearch}`, `ELASTICSEARCH_USERNAME=pub_reader`,
    `ELASTICSEARCH_CA_CERT_PATH=${join(path, 'tls.crt').replaceAll('\\', '/')}`,
    `ELASTICSEARCH_PASSWORD=${c.esReader}`, `MILVUS_LOCAL_ADDRESS=127.0.0.1:${p.milvus}`,
    `MILVUS_TOKEN=pub_reader:${c.milvusReader}`,
  ].join('\n') + '\n');
  writePrivate(join(path, 'publisher.env'), [
    `PUBLICATION_DATABASE_URL=${db('pub_publisher', c.dbPublisher)}`,
    `PUBLICATION_ES_URL=https://127.0.0.1:${p.elasticsearch}`,
    `PUBLICATION_ES_WRITER=pub_writer`, `PUBLICATION_ES_WRITER_PASSWORD=${c.esWriter}`,
    `PUBLICATION_ES_SEALER=pub_sealer`, `PUBLICATION_ES_SEALER_PASSWORD=${c.esSealer}`,
    `PUBLICATION_MILVUS_ADDRESS=127.0.0.1:${p.milvus}`, `PUBLICATION_MILVUS_TOKEN=pub_writer:${c.milvusWriter}`,
  ].join('\n') + '\n');
  writePrivate(join(path, 'migration.env'), [
    `POSTGRES_MIGRATION_URL=${db('pub_migration', c.dbMigration)}`, `DATABASE_URL=${db('pub_app', c.dbApp)}`,
    'POSTGRES_APP_ROLE=pub_app', 'POSTGRES_SSL_MODE=disable',
  ].join('\n') + '\n');
  writePrivate(join(path, 'state.json'), JSON.stringify({ id: config.id, ports: p, database }, null, 2));
}

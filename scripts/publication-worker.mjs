import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function persistOperation(sandboxPath, operationId) {
  const root = realpathSync(sandboxPath);
  const directory = join(root, 'worker-operations');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink() || dirname(realpathSync(directory)) !== root) throw new Error('Invalid operation directory.');
  const fd = openSync(join(directory, `${operationId}.json`), 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify({ operationId, createdAt: new Date().toISOString() })); fsyncSync(fd); }
  finally { closeSync(fd); }
}

/** One invocation makes one attempt. A failed or empty claim is unknown and
 * must be reconciled by an operator; never retry it automatically. */
export async function runPublicationOnce(id, dependencies) {
  if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid isolated sandbox ID.');
  const sandbox = dependencies.loadSandbox(id);
  const operationId = randomUUID();
  await dependencies.persistOperation(sandbox.path, operationId);
  dependencies.reportOperation(operationId);
  const { credentials: c, ports: p, ca } = sandbox;
  const service = dependencies.createService({
    postgres: { host: '127.0.0.1', port: p.postgres, database: sandbox.database ?? 'publication_sandbox', user: 'pub_publisher', password: c.dbPublisher },
    elasticsearch: { node: `https://127.0.0.1:${p.elasticsearch}`, ca: ca.toString('utf8'),
      admin: { username: 'elastic', password: c.elasticAdmin }, reader: 'pub_reader',
      writer: { username: 'pub_writer', password: c.esWriter }, sealer: { username: 'pub_sealer', password: c.esSealer } },
    milvus: { address: `127.0.0.1:${p.milvus}`, admin: { username: 'root', password: c.milvusAdmin },
      reader: { username: 'pub_reader', password: c.milvusReader } },
    neo4j: { uri: `bolt://127.0.0.1:${p.neo4j}`, username: 'neo4j', password: c.neo4j }, timeoutMs: 30000,
  });
  await service.publishNext(operationId);
}

/** A single cooperative consumer; any uncertain attempt stops the loop. */
export async function watchPublications(dependencies, signal) {
  while (!signal.aborted) {
    if (await dependencies.hasPending()) {
      signal.throwIfAborted();
      await dependencies.publish();
    }
    if (!signal.aborted) await dependencies.wait(signal);
  }
}

async function main() {
  if (process.argv.length < 3 || process.argv.length > 4 || process.argv[3] && process.argv[3] !== '--watch') throw new Error('Usage: node --import tsx scripts/publication-worker.mjs <sandbox-id> [--watch]');
  const { readSandboxConfig } = await import('../deploy/publication-sandbox/sandbox.mjs');
  const { TrustedPublicationService } = await import('../src/lib/documents/publication-trusted-service.ts');
  const dependencies = { loadSandbox: readSandboxConfig, persistOperation,
    reportOperation: operationId => process.stdout.write(`Operation: ${operationId}\n`),
    createService: config => new TrustedPublicationService(config) };
  if (process.argv[3] === '--watch') {
    const { default: pg } = await import('pg');
    const config=readSandboxConfig(process.argv[2]);
    const connection=new pg.Client({host:'127.0.0.1',port:config.ports.postgres,database:config.database ?? 'publication_sandbox',
      user:'pub_publisher',password:config.credentials.dbPublisher,connectionTimeoutMillis:5000,query_timeout:10000});
    const controller=new AbortController();
    const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
    try {
      await connection.connect();
      await watchPublications({hasPending:async()=>{
        const r=await connection.query('select public.rag_has_pending_publication() as pending');
        if(r.rows.length!==1||typeof r.rows[0].pending!=='boolean')throw new Error('Invalid pending observation.');
        return r.rows[0].pending;
      },publish:()=>runPublicationOnce(config.id,dependencies),wait:signal=>new Promise(resolve=>{
        const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};
        const timer=setTimeout(finish,2000);signal.addEventListener('abort',finish,{once:true});if(signal.aborted)finish();
      })},controller.signal);
    } finally { process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await connection.end(); }
  } else await runPublicationOnce(process.argv[2], dependencies);
  process.stdout.write('Publication attempt completed. Inspect request status for its current state.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Backend errors can contain secrets. Do not print the underlying error.
    process.stderr.write('Publication attempt did not complete. Its outcome may be unknown; reconcile before retrying.\n');
    process.exitCode = 1;
  });
}

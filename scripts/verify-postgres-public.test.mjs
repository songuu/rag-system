import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyPublicPostgres } from './verify-postgres-public.mjs';

function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rag-public-pg-'));
  const caFile = path.join(root, 'ca.crt');
  writeFileSync(caFile, 'test-ca\n', { mode: 0o600 });
  return {
    root,
    env: {
      PGHOST: '47.253.230.197',
      PGPORT: '25432',
      PGDATABASE: 'rag_system',
      PGUSER: 'rag_app',
      PGPASSWORD: 'secret-that-must-not-be-logged',
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: caFile,
      POSTGRES_PUBLIC_EXPECTED_HOST: '47.253.230.197',
    },
  };
}

async function captureTlsClientConfig(env) {
  const configs = [];
  let clientNumber = 0;
  await verifyPublicPostgres(env, {
    createClient(config) {
      configs.push(config);
      clientNumber += 1;
      if (clientNumber === 1) {
        return {
          async connect() {},
          async query() {
            return {
              rows: [{
                current_user: 'rag_app',
                current_database: 'rag_system',
                server_version_num: 170006,
                ssl: true,
                tls_version: 'TLSv1.3',
                restricted_role: true,
                no_role_memberships: true,
                operational_dml: true,
                parent_write_denied: true,
              }],
            };
          },
          async end() {},
        };
      }
      return {
        async connect() {
          const error = new Error('HBA rejected');
          error.code = '28000';
          throw error;
        },
        async query() {},
        async end() {},
      };
    },
    writeOutput() {},
  });
  return configs[0];
}

test('validates the TLS certificate against the configured public host when pg reports localhost', async () => {
  const fixture = createFixture();
  try {
    const config = await captureTlsClientConfig(fixture.env);
    const certificate = {
      subjectaltname: `IP Address:${fixture.env.POSTGRES_PUBLIC_EXPECTED_HOST}`,
    };

    assert.equal(config.ssl.checkServerIdentity('localhost', certificate), undefined);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('validates the TLS certificate against the configured public host when pg omits servername', async () => {
  const fixture = createFixture();
  try {
    const config = await captureTlsClientConfig(fixture.env);
    const matchingCertificate = {
      subjectaltname: `IP Address:${fixture.env.POSTGRES_PUBLIC_EXPECTED_HOST}`,
    };
    const wrongCertificate = { subjectaltname: 'IP Address:203.0.113.10' };

    assert.equal(config.ssl.checkServerIdentity(undefined, matchingCertificate), undefined);
    const error = config.ssl.checkServerIdentity(undefined, wrongCertificate);
    assert.ok(error instanceof Error);
    assert.equal(error.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('verifies the public endpoint with TLS and rejects plaintext access', async () => {
  const fixture = createFixture();
  const configs = [];
  const queries = [];
  let clientNumber = 0;
  try {
    const output = [];
    await verifyPublicPostgres(fixture.env, {
      createClient(config) {
        configs.push(config);
        clientNumber += 1;
        if (clientNumber === 1) {
          return {
            async connect() {},
            async query(sql) {
              queries.push(sql);
              return {
                rows: [{
                  current_user: 'rag_app',
                  current_database: 'rag_system',
                  server_version_num: 170006,
                  ssl: true,
                  tls_version: 'TLSv1.3',
                  restricted_role: true,
                  no_role_memberships: true,
                  operational_dml: true,
                  parent_write_denied: true,
                }],
              };
            },
            async end() {},
          };
        }
        return {
          async connect() {
            const error = new Error('no pg_hba.conf entry for host');
            error.code = '28000';
            throw error;
          },
          async query() {
            throw new Error('plaintext query must not run');
          },
          async end() {},
        };
      },
      writeOutput(value) {
        output.push(value);
      },
    });

    assert.equal(configs.length, 4);
    assert.equal(configs[0].ssl.ca, 'test-ca\n');
    assert.equal(configs[0].ssl.rejectUnauthorized, true);
    assert.equal(typeof configs[0].ssl.checkServerIdentity, 'function');
    assert.equal(configs[1].ssl, false);
    assert.equal(configs[0].host, '47.253.230.197');
    assert.equal(configs[0].port, 25432);
    assert.equal(configs[0].user, 'rag_app');
    assert.deepEqual(configs.map(config => config.user), [
      'rag_app',
      'rag_app',
      'rag_owner',
      'postgres',
    ]);
    assert.deepEqual(output, [
      'Public PostgreSQL full TLS, plaintext rejection, and role isolation verification passed.',
    ]);
    for (const table of ['object_blobs', 'document_assets']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        assert.match(
          queries[0],
          new RegExp(`has_table_privilege\\(current_user, 'public\\.${table}', '${privilege}'\\)`)
        );
      }
    }
    assert.doesNotMatch(queries[0], /SELECT,INSERT,UPDATE,DELETE/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('fails when plaintext authentication unexpectedly succeeds', async () => {
  const fixture = createFixture();
  try {
    let clientNumber = 0;
    await assert.rejects(
      verifyPublicPostgres(fixture.env, {
        createClient() {
          clientNumber += 1;
          return {
            async connect() {},
            async query() {
              return clientNumber === 1
                ? {
                    rows: [{
                      current_user: 'rag_app',
                      current_database: 'rag_system',
                      server_version_num: 170006,
                      ssl: true,
                      tls_version: 'TLSv1.3',
                      restricted_role: true,
                      no_role_memberships: true,
                      operational_dml: true,
                      parent_write_denied: true,
                    }],
                  }
                : { rows: [{ ok: 1 }] };
            },
            async end() {},
          };
        },
        writeOutput() {},
      }),
      /accepted a plaintext connection/
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('does not mistake a network error for a PostgreSQL plaintext rejection', async () => {
  const fixture = createFixture();
  try {
    let clientNumber = 0;
    await assert.rejects(
      verifyPublicPostgres(fixture.env, {
        createClient() {
          clientNumber += 1;
          return {
            async connect() {
              if (clientNumber === 2) {
                const error = new Error('connection reset');
                error.code = 'ECONNRESET';
                throw error;
              }
            },
            async query() {
              return {
                rows: [{
                  current_user: 'rag_app',
                  current_database: 'rag_system',
                  server_version_num: 170006,
                  ssl: true,
                  tls_version: 'TLSv1.3',
                  restricted_role: true,
                  no_role_memberships: true,
                  operational_dml: true,
                  parent_write_denied: true,
                }],
              };
            },
            async end() {},
          };
        },
        writeOutput() {},
      }),
      /plaintext-rejection verification was inconclusive/
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('fails when a restricted role reaches password authentication instead of HBA rejection', async () => {
  const fixture = createFixture();
  try {
    let clientNumber = 0;
    await assert.rejects(
      verifyPublicPostgres(fixture.env, {
        createClient() {
          clientNumber += 1;
          if (clientNumber === 1) {
            return {
              async connect() {},
              async query() {
                return {
                  rows: [{
                    current_user: 'rag_app',
                    current_database: 'rag_system',
                    server_version_num: 170006,
                    ssl: true,
                    tls_version: 'TLSv1.3',
                    restricted_role: true,
                    no_role_memberships: true,
                    operational_dml: true,
                    parent_write_denied: true,
                  }],
                };
              },
              async end() {},
            };
          }
          return {
            async connect() {
              const error = new Error(
                clientNumber === 3 ? 'password authentication failed' : 'HBA rejected'
              );
              error.code = clientNumber === 3 ? '28P01' : '28000';
              throw error;
            },
            async query() {},
            async end() {},
          };
        },
        writeOutput() {},
      }),
      /restricted-role rejection verification was inconclusive/
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects unsafe or incomplete public client configuration before connecting', async () => {
  const fixture = createFixture();
  try {
    const invalidCases = [
      [{ ...fixture.env, PGHOST: 'db.example.com' }, /must match POSTGRES_PUBLIC_EXPECTED_HOST/],
      [{ ...fixture.env, PGPORT: '5432' }, /PGPORT must be 25432/],
      [{ ...fixture.env, PGDATABASE: 'postgres' }, /PGDATABASE must be rag_system/],
      [{ ...fixture.env, PGUSER: 'rag_owner' }, /PGUSER must be rag_app/],
      [{ ...fixture.env, PGSSLMODE: 'require' }, /PGSSLMODE must be verify-full/],
      [{ ...fixture.env, PGPASSWORD: '' }, /PGPASSWORD is required/],
      [{ ...fixture.env, POSTGRES_PUBLIC_VERIFY_PHASE: 'schema' }, /must be network or full/],
    ];

    for (const [env, expected] of invalidCases) {
      await assert.rejects(
        verifyPublicPostgres(env, {
          createClient() {
            throw new Error('connection must not be attempted');
          },
          writeOutput() {},
        }),
        expected
      );
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('network phase verifies an empty PG17 database without referencing application tables', async () => {
  const fixture = createFixture();
  const queries = [];
  let clientNumber = 0;
  try {
    await verifyPublicPostgres(
      { ...fixture.env, POSTGRES_PUBLIC_VERIFY_PHASE: 'network' },
      {
        createClient() {
          clientNumber += 1;
          if (clientNumber === 1) {
            return {
              async connect() {},
              async query(sql) {
                queries.push(sql);
                return {
                  rows: [{
                    current_user: 'rag_app',
                    current_database: 'rag_system',
                    server_version_num: 170006,
                    ssl: true,
                    tls_version: 'TLSv1.3',
                    restricted_role: true,
                    no_role_memberships: true,
                  }],
                };
              },
              async end() {},
            };
          }
          return {
            async connect() {
              const error = new Error('HBA rejected');
              error.code = '28000';
              throw error;
            },
            async query() {},
            async end() {},
          };
        },
        writeOutput() {},
      }
    );

    assert.equal(queries.length, 1);
    assert.doesNotMatch(queries[0], /object_blobs|document_assets|tenants|corpora/);
    assert.match(queries[0], /pg_auth_members/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects an application role that inherits any additional PostgreSQL role', async () => {
  const fixture = createFixture();
  try {
    await assert.rejects(
      verifyPublicPostgres(
        { ...fixture.env, POSTGRES_PUBLIC_VERIFY_PHASE: 'network' },
        {
          createClient() {
            return {
              async connect() {},
              async query() {
                return {
                  rows: [{
                    current_user: 'rag_app',
                    current_database: 'rag_system',
                    server_version_num: 170006,
                    ssl: true,
                    tls_version: 'TLSv1.3',
                    restricted_role: true,
                    no_role_memberships: false,
                  }],
                };
              },
              async end() {},
            };
          },
          writeOutput() {},
        }
      ),
      /Public PostgreSQL TLS verification failed/
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects an application role missing any required operational table privilege', async () => {
  const fixture = createFixture();
  try {
    await assert.rejects(
      verifyPublicPostgres(fixture.env, {
        createClient() {
          return {
            async connect() {},
            async query() {
              return {
                rows: [{
                  current_user: 'rag_app',
                  current_database: 'rag_system',
                  server_version_num: 170006,
                  ssl: true,
                  tls_version: 'TLSv1.3',
                  restricted_role: true,
                  no_role_memberships: true,
                  operational_dml: false,
                  parent_write_denied: true,
                }],
              };
            },
            async end() {},
          };
        },
        writeOutput() {},
      }),
      /Public PostgreSQL TLS verification failed/
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('does not expose credentials or endpoint details in public errors', async () => {
  const fixture = createFixture();
  try {
    await assert.rejects(
      verifyPublicPostgres(fixture.env, {
        createClient() {
          return {
            async connect() {
              throw new Error(`password=${fixture.env.PGPASSWORD} host=${fixture.env.PGHOST}`);
            },
            async query() {},
            async end() {},
          };
        },
        writeOutput() {},
      }),
      error => {
        assert.equal(error.message, 'Public PostgreSQL TLS verification failed.');
        assert.doesNotMatch(error.message, /secret|47\.253\.230\.197/);
        return true;
      }
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

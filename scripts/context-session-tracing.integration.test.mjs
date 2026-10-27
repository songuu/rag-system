import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const workspace = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const sha = (value) => createHash('sha256').update(value).digest('hex');

// The JS NFT API does not reproduce this Turbopack path analysis. Exercise the
// installed compiler and a positive control, not a mocked or alternate tracer.
test('Turbopack scopes actual runtime storage without collecting private project or session assets', { timeout: 30000 }, (t) => {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(workspace, '.tmp-session-trace-')));
  const marker = 'synthetic-session-tracing-repro-v1';
  const markerPath = path.join(fixture, '.fixture-owner');
  fs.writeFileSync(markerPath, marker);
  t.after(() => {
    assert.equal(fs.lstatSync(fixture).isSymbolicLink(), false);
    const resolved = fs.realpathSync(fixture);
    assert.equal(path.dirname(resolved), workspace);
    assert.ok(path.basename(resolved).startsWith('.tmp-session-trace-'));
    assert.equal(fs.readFileSync(markerPath, 'utf8'), marker);
    // Only this new, owned synthetic project is removed, never workspace data.
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const write = (relative, content) => {
    const filename = path.resolve(fixture, relative);
    const contained = path.relative(fixture, filename);
    assert.ok(contained !== '..' && !contained.startsWith(`..${path.sep}`) && !path.isAbsolute(contained));
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
  };
  const source = fs.readFileSync(path.join(workspace, 'src/lib/context-management.ts'), 'utf8');
  const ast = ts.createSourceFile('context-management.ts', source, ts.ScriptTarget.Latest, true);
  const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map((node) => [node.name?.text, node]));
  const shared = ast.statements.filter((node) => (
    (ts.isClassDeclaration(node) && node.name?.text === 'ContextSessionError')
    || (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => (
      ts.isIdentifier(declaration.name) && declaration.name.text === 'DATA_DIR'
    )))
  ));
  assert.ok(shared.some((node) => ts.isClassDeclaration(node)));
  assert.ok(shared.some((node) => ts.isVariableStatement(node)));
  const compileStoragePath = (entry) => {
    const reachable = new Set();
    const collect = (name) => {
      if (reachable.has(name)) return;
      const node = functions.get(name);
      assert.ok(node, 'actual storage function must exist');
      reachable.add(name);
      const visit = (child) => {
        if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && functions.has(child.expression.text)) {
          collect(child.expression.text);
        }
        ts.forEachChild(child, visit);
      };
      ts.forEachChild(node, visit);
    };
    collect(entry);
    const selected = ast.statements.filter((node) => shared.includes(node)
      || (ts.isFunctionDeclaration(node) && reachable.has(node.name?.text)));
    return ts.transpileModule(selected.map((node) => node.getText(ast)).join('\n').replace(/^export /gm, ''), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  };
  write('package.json', JSON.stringify({
    name: 'synthetic-session-tracing-repro', private: true,
    dependencies: {
      next: require('next/package.json').version,
      react: require('react/package.json').version,
      'react-dom': require('react-dom/package.json').version,
    },
  }));
  // Both roots must agree so the installed parent dependencies are resolvable.
  // No global tracing excludes are used; controls carry no ignore annotations.
  // The actual subset preserves the source's scoped runtime-path annotations.
  write('next.config.mjs', `export default ${JSON.stringify({
    distDir: '.build', turbopack: { root: workspace }, outputFileTracingRoot: workspace,
  })};\n`);
  write('private-decoy.txt', 'SYNTHETIC PRIVATE TRACE CANARY\n');
  write('private-source.ts', 'export const syntheticPrivateSource = true;\n');
  write('data/context-sessions/safe-id.json', '{"synthetic":true}\n');
  write('assets/public-fixture.txt', 'SYNTHETIC PUBLIC BUILD ASSET\n');
  const head = "import * as fs from 'node:fs';\nimport * as path from 'node:path';\nexport const dynamic = 'force-dynamic';\n";
  const storagePaths = [
    { route: 'current-directory', entry: 'sessionDirectory', call: 'sessionDirectory()' },
    { route: 'load-session', entry: 'loadSession', call: 'loadSession(id)' },
    { route: 'save-session', entry: 'saveSession', call: 'saveSession({ metadata: { sessionId: id }, messages: [] })' },
    { route: 'list-sessions', entry: 'listAllSessions', call: 'listAllSessions()' },
    { route: 'delete-session', entry: 'deleteSessionFile', call: 'deleteSessionFile(id)' },
  ];
  for (const { route, entry, call } of storagePaths) {
    write(`app/api/${route}/route.js`, `${head}${compileStoragePath(entry)}
export async function GET(request) {
  const id = new URL(request.url).searchParams.get('id') ?? 'safe-id';
  return Response.json({ value: ${call} ?? null });
}\n`);
  }
  // Trace the actual shared entity reader too: a clean session route alone
  // cannot protect sessions accidentally collected by another runtime store.
  const entitySource = fs.readFileSync(path.join(workspace, 'src/lib/adaptive-entity-rag.ts'), 'utf8');
  const entityAst = ts.createSourceFile('adaptive-entity-rag.ts', entitySource, ts.ScriptTarget.Latest, true);
  const entityClass = entityAst.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === 'EntityMetadataStore');
  assert.ok(entityClass);
  const memberNames = new Set(['entities', 'embeddings', 'persistPath', 'loadFromFile', 'resolvePersistPath']);
  const entityMembers = entityClass.members.filter((member) => ts.isConstructorDeclaration(member) || memberNames.has(member.name?.getText(entityAst)));
  assert.equal(entityMembers.length, 6, 'actual constructor, state and file reader must remain present');
  const entityReader = ts.transpileModule(`class EntityMetadataStore {\n${entityMembers.map((member) => member.getText(entityAst)).join('\n')}\n}`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  write('app/api/entity-metadata/route.js', `${head}
import { readFile } from 'node:fs/promises';
const createEmbedding = () => null;
${entityReader}
export async function GET(request) {
  const persistPath = new URL(request.url).searchParams.get('persistPath') ?? './data/entity-metadata.json';
  const store = new EntityMetadataStore('synthetic-no-model', persistPath);
  return Response.json({ loaded: await store.loadFromFile() });
}\n`);
  const postgresSource = fs.readFileSync(path.join(workspace, 'src/lib/postgres/client.ts'), 'utf8');
  const postgresAst = ts.createSourceFile('postgres-client.ts', postgresSource, ts.ScriptTarget.Latest, true);
  const checksumFunction = postgresAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'getExpectedSchemaChecksum');
  assert.ok(checksumFunction);
  const schemaReads = [];
  const findSchemaRead = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'readFile') schemaReads.push(node);
    ts.forEachChild(node, findSchemaRead);
  };
  findSchemaRead(checksumFunction);
  assert.equal(schemaReads.length, 1, 'actual schema path must be extracted without replacing its filesystem expression');
  const filenameNode = postgresAst.statements.filter(ts.isVariableStatement).flatMap((node) => [...node.declarationList.declarations]).find((node) => node.name.getText(postgresAst) === 'EXPECTED_SCHEMA_FILENAME');
  assert.ok(filenameNode && ts.isStringLiteral(filenameNode.initializer));
  const migration = `db/postgres/migrations/${filenameNode.initializer.text}`;
  write(migration, '-- SYNTHETIC SCHEMA ASSET\n');
  const schemaPath = schemaReads[0].arguments[0].getText(postgresAst);
  // Match the actual Postgres module's default path import. A namespace import
  // changes Turbopack's analysis and is not a faithful schema-reader fixture.
  const schemaHead = `import path from 'node:path';\nimport { readFile } from 'node:fs/promises';\nexport const dynamic = 'force-dynamic';\nconst EXPECTED_SCHEMA_FILENAME = ${JSON.stringify(filenameNode.initializer.text)};\n`;
  for (const [route, expression] of [
    ['schema-runtime', schemaPath],
    ['schema-ignore-control', schemaPath.replace('path.join(', 'path.join(/*turbopackIgnore: true*/')],
    ['schema-static-control', "path.join(process.cwd(), 'db', 'postgres', 'migrations', EXPECTED_SCHEMA_FILENAME)"],
  ]) {
    write(`app/api/${route}/route.js`, `${schemaHead}export async function GET() { return new Response(await readFile(${expression})); }\n`);
  }
  const checksumFunctions = new Set(['getExpectedSchemaChecksum', 'readErrorCode', 'readErrorConstraint']);
  const checksumState = new Set(['expectedSchemaChecksumPromise', 'EXPECTED_SCHEMA_FILENAME']);
  const checksumNodes = postgresAst.statements.filter((node) => (
    (ts.isFunctionDeclaration(node) && checksumFunctions.has(node.name?.text))
    || (ts.isClassDeclaration(node) && node.name?.text === 'PostgresQueryError')
    || (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => (
      ts.isIdentifier(declaration.name) && checksumState.has(declaration.name.text)
    )))
  ));
  assert.equal(checksumNodes.length, 6, 'checksum reader, state and error helpers must remain actual source');
  const checksumReader = ts.transpileModule(checksumNodes.map((node) => node.getText(postgresAst)).join('\n'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  write('app/api/schema-checksum/route.js', `import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export const dynamic = 'force-dynamic';
${checksumReader}
export async function GET() { return Response.json({ checksum: await getExpectedSchemaChecksum() }); }\n`);
  // Import the real module: caching functions passed through an identity object
  // must not trace neighboring private JSON files as build-time assets.
  const cacheSourcePath = path.join(workspace, 'src/lib/artifact-cache.ts');
  const cacheSource = fs.readFileSync(cacheSourcePath, 'utf8');
  const cacheImport = path.relative(path.join(fixture, 'app/api/artifact-cache'), cacheSourcePath).replaceAll('\\', '/');
  write('app/api/artifact-cache/route.js', `import { createArtifactCacheIdentity, loadArtifactFromCache } from ${JSON.stringify(cacheImport)};
export const dynamic = 'force-dynamic';
export async function GET() {
  const identity = createArtifactCacheIdentity({ cacheDir: 'uploads/maic-cache', version: 'synthetic', source: 'synthetic', modelSignature: {} });
  return Response.json({ value: await loadArtifactFromCache(identity, () => true) });
}\n`);
  write('app/api/public-asset-control/route.js', `${head}
export async function GET() { return new Response(fs.readFileSync(path.join(process.cwd(), 'assets', 'public-fixture.txt'))); }\n`);
  write('app/api/loop-control/route.js', `${head}
export async function GET() {
  const values = [];
  for (const candidate of [path.join(process.cwd(), 'data'), path.join(process.cwd(), 'data', 'context-sessions')]) {
    values.push(fs.realpathSync(candidate));
  }
  return Response.json({ values });
}\n`);
  const build = spawnSync(process.execPath, [require.resolve('next/dist/bin/next'), 'build', fixture], {
    cwd: fixture, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env, DATABASE_URL: '', POSTGRES_URL: '', RAG_RELEASE_DIR: '', NEXT_TELEMETRY_DISABLED: '1',
      LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false', COREPACK_ENABLE_NETWORK: '0',
    },
  });
  t.diagnostic(JSON.stringify({
    sourceSha: sha(source), entitySourceSha: sha(entitySource), postgresSourceSha: sha(postgresSource), cacheSourceSha: sha(cacheSource), buildStatus: build.status, buildError: build.error?.code ?? null,
    childPid: build.pid ?? null, nextStageSeen: (build.stdout ?? '').includes('Next.js'), compiledStageSeen: (build.stdout ?? '').includes('Compiled successfully'),
    stdoutSha: sha(build.stdout ?? ''), stderrSha: sha(build.stderr ?? ''),
  }));
  assert.equal(build.error, undefined, 'synthetic compiler must finish within its existing local budget');
  assert.equal(build.status, 0, 'synthetic compiler must finish before inspecting NFT results');
  const traced = (route) => {
    const filename = path.join(fixture, '.build/server/app/api', route, 'route.js.nft.json');
    const { files } = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.ok(Array.isArray(files) && files.every((value) => typeof value === 'string'));
    return new Set(files.map((value) => path.resolve(path.dirname(filename), value)));
  };
  const control = traced('loop-control');
  const publicAssets = traced('public-asset-control');
  assert.equal(publicAssets.has(path.join(fixture, 'assets/public-fixture.txt')), true, 'public asset control must prove tracing is active');
  const schemaStaticAsset = traced('schema-static-control').has(path.join(fixture, migration));
  const schemaRuntimeAsset = traced('schema-runtime').has(path.join(fixture, migration));
  const scopeRoutes = [...storagePaths, { route: 'entity-metadata' }, { route: 'schema-runtime' }, { route: 'schema-ignore-control' }, { route: 'schema-checksum' }, { route: 'artifact-cache' }].map(({ route }) => {
    const current = traced(route);
    return {
      route, count: current.size,
      rootCanary: current.has(path.join(fixture, 'private-decoy.txt')),
      sourceCanary: current.has(path.join(fixture, 'private-source.ts')),
      sessionCanary: current.has(path.join(fixture, 'data/context-sessions/safe-id.json')),
    };
  });
  t.diagnostic(JSON.stringify({ scopeRoutes, schemaStaticAsset, schemaRuntimeAsset }));
  assert.equal(schemaStaticAsset, true, 'explicit static schema asset must remain traceable');
  for (const canary of ['private-decoy.txt', 'private-source.ts']) {
    const filename = path.join(fixture, canary);
    assert.equal(control.has(filename), true, 'positive control must reproduce whole-project tracing');
  }
  for (const route of scopeRoutes) {
    assert.equal(route.rootCanary, false, `${route.route} must not collect unrelated project assets`);
    assert.equal(route.sourceCanary, false, `${route.route} must not collect private project sources`);
    assert.equal(route.sessionCanary, false, `${route.route} must not package private runtime sessions`);
  }
});

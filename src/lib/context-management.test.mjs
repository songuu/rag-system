import assert from 'node:assert/strict';
import * as nativeFs from 'node:fs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const sourcePath = fileURLToPath(new URL('./context-management.ts', import.meta.url));
const { AIMessage } = require('@langchain/core/messages');
const { RunnableLambda } = require('@langchain/core/runnables');
const compileFixtureSource = createSourceCompiler();

function createSourceCompiler(transpile = ts.transpileModule) {
  const compiledSources = new Map();
  return (filename, source) => {
    const absoluteFilename = path.resolve(filename);
    const cached = compiledSources.get(absoluteFilename);
    if (cached?.source === source) return cached.output;
    const output = transpile(source, {
      fileName: absoluteFilename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    // Cache immutable code only; every fixture still evaluates a fresh module and dependencies.
    compiledSources.set(absoluteFilename, { source, output });
    return output;
  };
}

test('fixture source compiler caches only unchanged source per absolute filename', () => {
  const calls = [];
  const compile = createSourceCompiler((source, options) => {
    calls.push({ source, options });
    return { outputText: `${options.fileName}:${source}` };
  });
  const filename = path.join(path.dirname(sourcePath), 'synthetic-cache.ts');
  const first = compile(filename, 'export const value = 1;');
  assert.equal(compile(filename, 'export const value = 1;'), first);
  assert.equal(calls.length, 1);
  assert.notEqual(compile(filename, 'export const value = 2;'), first);
  assert.equal(calls.length, 2);
  const otherFilename = path.join(path.dirname(sourcePath), 'synthetic-other-cache.ts');
  assert.notEqual(compile(otherFilename, 'export const value = 2;'), compile(filename, 'export const value = 2;'));
  assert.equal(calls.length, 3);
  assert.equal(compile(filename, 'export const value = 1;'), first);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(({ options }) => path.isAbsolute(options.fileName)));
  assert.ok(calls.every(({ options }) => options.compilerOptions.module === ts.ModuleKind.CommonJS
    && options.compilerOptions.target === ts.ScriptTarget.ES2022));
});

test('compiled fixture source never shares evaluated modules, storage, managers or route environment', async () => {
  const first = createFixture();
  const second = createFixture();
  assert.notEqual(first.api, second.api);
  assert.notEqual(first.api.createContextManager, second.api.createContextManager);
  assert.notEqual(first.files, second.files);
  assert.notEqual(first.fs, second.fs);
  assert.notEqual(first.counters, second.counters);
  const firstManager = first.api.createContextManager({ enableQueryRewriting: false });
  const secondManager = second.api.createContextManager({ enableQueryRewriting: false });
  assert.notEqual(firstManager, secondManager);
  await firstManager.processQuery('isolated-session', 'hello');
  assert.equal(second.files.size, 0);
  assert.equal(second.counters.fileAccess, 0);
  assert.equal(second.counters.modelCalls, 0);
  assert.equal(await secondManager.getSession('isolated-session'), null);
  const firstEnv = { NODE_ENV: 'production' };
  const secondEnv = { NODE_ENV: 'test', RAG_ACCESS_MODE: 'local-dev' };
  const firstRoute = createRouteFixture(first, firstEnv);
  const secondRoute = createRouteFixture(second, secondEnv);
  assert.notEqual(firstRoute, secondRoute);
  assert.notEqual(firstRoute.GET, secondRoute.GET);
  await assertLegacyBlocked(await firstRoute.GET(new Request('http://localhost/rag-api/context-management?action=config')));
  assert.equal((await secondRoute.GET(new Request('http://localhost/rag-api/context-management?action=config'))).status, 200);
  secondEnv.NODE_ENV = 'production';
  await assertLegacyBlocked(await secondRoute.GET(new Request('http://localhost/rag-api/context-management?action=config')));
  firstEnv.NODE_ENV = 'test';
  assert.equal((await firstRoute.GET(new Request('http://localhost/rag-api/context-management?action=config'))).status, 200);
});

test('context metadata and SSE payloads preserve their business types', () => {
  const filename = path.join(path.dirname(sourcePath), 'context-management.contract-types.ts');
  const contract = `
    import type { RetrievedDocument, WorkflowStep, StreamEvent, StreamEventType } from './context-management';
    type IsAny<T> = 0 extends (1 & T) ? true : false;
    type ExpectFalse<T extends false> = T;
    type ExpectTrue<T extends true> = T;
    type Metadata = ExpectFalse<IsAny<NonNullable<RetrievedDocument['metadata']>[string]>>;
    type Details = ExpectFalse<IsAny<NonNullable<WorkflowStep['details']>[string]>>;
    type Payload = ExpectFalse<IsAny<StreamEvent['data']>>;
    type RejectWrongToken = ExpectFalse<{ type: 'token'; data: { error: string } } extends StreamEvent ? true : false>;
    type TokenExists = ExpectTrue<Extract<StreamEvent, { type: 'token' }> extends never ? false : true>;
    const consume = (event: StreamEvent): string => {
      const kind: StreamEventType = event.type;
      if (event.type === 'token') return event.data.content + event.data.fullResponse;
      if (event.type === 'workflow') return event.data.step.step + event.data.allSteps.length;
      if (event.type === 'done') return event.data.response;
      if (event.type === 'error') return event.data.error;
      return kind;
    };
    export type Contract = [Metadata, Details, Payload, RejectWrongToken, TokenExists, typeof consume];
  `;
  const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const options = { ...parsed.options, noEmit: true, incremental: false };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (requested, languageVersion, onError, shouldCreateNewSourceFile) => (
    path.normalize(requested) === path.normalize(filename)
      ? ts.createSourceFile(filename, contract, languageVersion, true)
      : getSourceFile(requested, languageVersion, onError, shouldCreateNewSourceFile)
  );
  const program = ts.createProgram([filename], options, host);
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  assert.deepEqual(diagnostics.map(({ code }) => code), []);
});

test('message conversion and token counting use the real LangChain message types', async () => {
  const { api } = createFixture();
  const input = [
    { id: 'system', role: 'system', content: 'instructions', timestamp: 1 },
    { id: 'human', role: 'user', content: 'question', timestamp: 2 },
    { id: 'assistant', role: 'assistant', content: 'answer', timestamp: 3 },
  ];
  const messages = api.toBaseMessages(input);
  assert.deepEqual(messages.map((message) => message._getType()), ['system', 'human', 'ai']);
  for (let index = 0; index < messages.length; index += 1) {
    const restored = api.fromBaseMessage(messages[index], input[index].timestamp);
    assert.equal(restored.id, input[index].id);
    assert.equal(restored.role, input[index].role);
    assert.equal(restored.content, input[index].content);
    assert.equal(restored.tokenCount, api.estimateTokens(input[index].content));
  }
  assert.equal(await api.tokenCounter(messages), input.reduce((sum, item) => sum + api.estimateTokens(item.content), 0));
  const trimmed = await api.trimMessagesWithLangChain(messages, 100);
  assert.deepEqual(trimmed.map((message) => message._getType()), ['system', 'human', 'ai']);
});

test('query retrieval and session writes retain documents, steps, and totals in memory', async () => {
  const { api, counters, files } = createFixture();
  const manager = api.createContextManager({ enableQueryRewriting: false });
  const result = await manager.processQuery('query-session', 'pricing');
  assert.equal(result.response, 'local answer');
  assert.equal(result.retrievedDocs.length, 1);
  assert.equal(result.retrievedDocs[0].metadata.source, 'synthetic');
  assert.equal(result.workflowSteps.length, 7);
  assert.ok(result.workflowSteps.every((step) => step.status === 'completed'));
  assert.equal(result.state.messages.length, 2);
  assert.equal(result.state.metadata.messageCount, 2);
  assert.equal(counters.search, 1);
  assert.equal(counters.embedQuery, 1);
  assert.equal(files.size, 1);
  const restored = await manager.getSession('query-session');
  assert.equal(restored.messages[1].content, result.response);
  assert.equal(restored.metadata.totalTokens, manager.getTokenStats(restored).totalTokens);
});

test('stream emits typed workflow, token and done payloads without changing final state', async () => {
  const { api, counters } = createFixture();
  const manager = api.createContextManager({ enableQueryRewriting: false });
  const stream = manager.streamQuery('stream-session', 'pricing');
  const events = [];
  let result;
  while (true) {
    const item = await stream.next();
    if (item.done) { result = item.value; break; }
    events.push(item.value);
  }
  assert.equal(events.filter((event) => event.type === 'token').length, 1);
  assert.equal(events.find((event) => event.type === 'token').data.content, 'local answer');
  assert.equal(events.find((event) => event.type === 'token').data.fullResponse, result.response);
  assert.ok(events.filter((event) => event.type === 'workflow').every((event) => (
    typeof event.data.step.step === 'string' && Array.isArray(event.data.allSteps)
  )));
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).data, result);
  assert.equal(result.workflowSteps.length, 7);
  assert.equal(result.state.metadata.messageCount, 2);
  assert.equal(counters.search, 1);
});

test('greetings skip retrieval and model failures still emit error then durable done', async () => {
  const { api, counters } = createFixture({ failModel: true });
  const manager = api.createContextManager({ enableQueryRewriting: false });
  const events = [];
  for await (const event of manager.streamQuery('error-session', 'hello')) events.push(event);
  assert.equal(counters.search, 0);
  assert.equal(counters.embedQuery, 0);
  const errorIndex = events.findIndex((event) => event.type === 'error');
  assert.ok(errorIndex >= 0);
  assert.equal(events[errorIndex].data.error, 'synthetic model failure');
  assert.equal(events.at(-1).type, 'done');
  assert.ok(errorIndex < events.length - 1);
  assert.equal(events.at(-1).data.retrievedDocs.length, 0);
  const restored = await manager.getSession('error-session');
  assert.equal(restored.messages.length, 2);
  assert.equal(restored.messages[1].content, events.at(-1).data.response);
});

test('session lifecycle and summary compression never use the real filesystem', async () => {
  const { api, files } = createFixture();
  const manager = api.createContextManager({ enableQueryRewriting: false });
  const created = await manager.createSession('synthetic-user');
  for (let round = 0; round < 4; round += 1) await manager.processQuery(created.metadata.sessionId, 'hello');
  const compressed = await manager.compressBySummary(created.metadata.sessionId);
  assert.equal(compressed.success, true);
  assert.equal(compressed.summary, 'local answer');
  assert.equal(compressed.compressedCount, 4);
  const restored = await manager.getSession(created.metadata.sessionId);
  assert.equal(restored.messages.length, 4);
  assert.equal(restored.metadata.summarizedRounds, 2);
  const listed = await manager.listSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].messageCount, 4);
  assert.equal(await manager.deleteSession(created.metadata.sessionId), true);
  assert.equal(await manager.deleteSession(created.metadata.sessionId), false);
  assert.equal(files.size, 0);
});

test('unsafe session IDs are rejected before any filesystem or model access', async () => {
  const invalidIds = ['../outside', '..\\outside', '../../outside', '/outside', 'C:\\outside',
    'C:outside', 'folder/name', 'folder\\name', '.', '..', '', ' trailing ', 'file.json',
    'id:stream', 'CON', 'nul', 'COM1', 'Lpt9', 'id\0suffix', 'a'.repeat(161), 7, {}, null];
  for (const sessionId of invalidIds) {
    for (const operation of ['get', 'query', 'stream', 'compress', 'delete']) {
      const fixture = createFixture();
      const manager = fixture.api.createContextManager({ enableQueryRewriting: false });
      let failure;
      try {
        if (operation === 'get') await manager.getSession(sessionId);
        if (operation === 'query') await manager.processQuery(sessionId, 'hello');
        if (operation === 'stream') await manager.streamQuery(sessionId, 'hello').next();
        if (operation === 'compress') await manager.compressBySummary(sessionId);
        if (operation === 'delete') await manager.deleteSession(sessionId);
      } catch (error) { failure = error; }
      assert.equal(fixture.counters.fileAccess, 0, `filesystem touched by ${operation}`);
      assert.equal(fixture.counters.modelCalls, 0);
      assert.equal(failure?.code, 'CONTEXT_SESSION_ID_INVALID');
      assert.ok(!failure.message.includes(String(sessionId)) || String(sessionId).length < 2);
    }
  }
});

test('directory links, file links and hard links fail closed without content IO', async () => {
  for (const kind of ['parent-link', 'directory-link', 'directory-escape', 'file-link', 'hard-link', 'non-file']) {
    for (const operation of ['get', 'query', 'stream', 'compress', 'delete', 'list']) {
      const fixture = createFixture();
      const manager = fixture.api.createContextManager({ enableQueryRewriting: false });
      await manager.processQuery('safe-id', 'hello');
      const target = kind === 'parent-link' ? path.join(fixture.root, 'data')
        : kind.startsWith('directory') ? fixture.dataRoot : path.join(fixture.dataRoot, 'safe-id.json');
      const originalStat = fixture.fs.lstatSync;
      fixture.fs.lstatSync = (filename, options) => {
        const stat = originalStat(filename, options);
        if (filename !== target) return stat;
        return {
          ...stat,
          isSymbolicLink: () => kind.endsWith('-link') && kind !== 'hard-link',
          isFile: () => kind !== 'non-file',
          nlink: kind === 'hard-link' ? 2n : stat.nlink,
        };
      };
      const originalRealpath = fixture.fs.realpathSync;
      fixture.fs.realpathSync = (filename) => (
        kind === 'directory-escape' && filename === target ? path.resolve(fixture.root, '..', 'elsewhere') : originalRealpath(filename)
      );
      const baseline = { ...fixture.counters };
      let failure;
      try {
        if (operation === 'get') await manager.getSession('safe-id');
        if (operation === 'query') await manager.processQuery('safe-id', 'hello');
        if (operation === 'stream') await manager.streamQuery('safe-id', 'hello').next();
        if (operation === 'compress') await manager.compressBySummary('safe-id');
        if (operation === 'delete') await manager.deleteSession('safe-id');
        if (operation === 'list') await manager.listSessions();
      } catch (error) { failure = error; }
      assert.equal(failure?.code, 'CONTEXT_SESSION_STORAGE_UNSAFE', `${kind}/${operation}`);
      assert.equal(fixture.counters.read, baseline.read);
      assert.equal(fixture.counters.write, baseline.write);
      assert.equal(fixture.counters.unlink, baseline.unlink);
      assert.equal(fixture.counters.modelCalls, baseline.modelCalls);
      assert.equal(fixture.handles.size, 0);
    }
  }
});

test('descriptor identity changes are rejected before reading, truncating or deleting', async () => {
  for (const operation of ['get', 'query', 'delete']) {
    const fixture = createFixture();
    const manager = fixture.api.createContextManager({ enableQueryRewriting: false });
    await manager.processQuery('safe-id', 'hello');
    const originalFstat = fixture.fs.fstatSync;
    fixture.fs.fstatSync = (fd, options) => ({ ...originalFstat(fd, options), ino: 99999n });
    const before = { ...fixture.counters };
    let failure;
    try {
      if (operation === 'get') await manager.getSession('safe-id');
      if (operation === 'query') await manager.processQuery('safe-id', 'hello');
      if (operation === 'delete') await manager.deleteSession('safe-id');
    } catch (error) { failure = error; }
    assert.equal(failure?.code, 'CONTEXT_SESSION_STORAGE_UNSAFE');
    assert.equal(fixture.counters.read, before.read);
    assert.equal(fixture.counters.write, before.write);
    assert.equal(fixture.counters.unlink, before.unlink);
    assert.equal(fixture.handles.size, 0);
  }
});

test('save verifies the writable descriptor before truncation and preserves existing bytes', async () => {
  const fixture = createFixture();
  const manager = fixture.api.createContextManager({ enableQueryRewriting: false });
  await manager.processQuery('safe-id', 'hello');
  const filename = path.join(fixture.dataRoot, 'safe-id.json');
  const originalBytes = fixture.files.get(filename);
  const writes = fixture.counters.write;
  const originalFstat = fixture.fs.fstatSync;
  fixture.fs.fstatSync = (fd, options) => {
    const stat = originalFstat(fd, options);
    return fixture.handles.get(fd).flags & nativeFs.constants.O_WRONLY ? { ...stat, ino: 99999n } : stat;
  };
  await assert.rejects(() => manager.processQuery('safe-id', 'hello'), (error) => error.code === 'CONTEXT_SESSION_STORAGE_UNSAFE');
  assert.equal(fixture.counters.write, writes);
  assert.equal(fixture.files.get(filename), originalBytes);
  assert.equal(fixture.handles.size, 0);
});

test('stored identity cannot redirect later saves and legacy metadata still loads', async () => {
  const fixture = createFixture();
  const manager = fixture.api.createContextManager({ enableQueryRewriting: false });
  const filename = path.join(fixture.dataRoot, 'safe-id.json');
  fixture.files.set(filename, JSON.stringify({ metadata: { sessionId: 'other-id' }, messages: [] }));
  await assert.rejects(() => manager.getSession('safe-id'), (error) => error.code === 'CONTEXT_SESSION_STORAGE_UNSAFE');
  fixture.files.set(filename, JSON.stringify({ sessionId: 'other-id' }));
  await assert.rejects(() => manager.getSession('safe-id'), (error) => error.code === 'CONTEXT_SESSION_STORAGE_UNSAFE');
  fixture.files.set(filename, JSON.stringify({ sessionId: 'safe-id', messageCount: 0, userId: 'legacy-user' }));
  assert.equal((await manager.getSession('safe-id')).metadata.userId, 'legacy-user');
  fixture.files.set(filename, 'not JSON');
  assert.equal(await manager.getSession('safe-id'), null);
  assert.equal(fixture.handles.size, 0);
});

test('non-string IDs never execute coercion or proxy hooks', async () => {
  let hooks = 0;
  const coercible = { [Symbol.toPrimitive]() { hooks += 1; return '../outside'; } };
  const proxy = new Proxy({}, { get() { hooks += 1; throw new Error('unexpected proxy access'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const sessionId of [coercible, proxy, revoked.proxy]) {
    const fixture = createFixture();
    const manager = fixture.api.createContextManager();
    await assert.rejects(() => manager.getSession(sessionId), (error) => error.code === 'CONTEXT_SESSION_ID_INVALID');
    assert.equal(fixture.counters.fileAccess, 0);
  }
  assert.equal(hooks, 0);
});

test('native filesystem lifecycle stays in a dedicated synthetic directory', async (t) => {
  const root = nativeFs.realpathSync(nativeFs.mkdtempSync(path.join(os.tmpdir(), 'rag-session-storage-')));
  t.after(() => {
    const resolved = nativeFs.realpathSync(root);
    assert.equal(path.dirname(resolved), nativeFs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('rag-session-storage-'));
    assert.equal(nativeFs.lstatSync(resolved).isSymbolicLink(), false);
    nativeFs.rmSync(resolved, { recursive: true, force: true });
  });
  const { api } = createFixture({ storageFs: nativeFs, storageRoot: root });
  const manager = api.createContextManager({ enableQueryRewriting: false });
  const created = await manager.createSession('local-user');
  const result = await manager.processQuery(created.metadata.sessionId, 'hello');
  assert.equal((await manager.getSession(created.metadata.sessionId)).messages.length, 2);
  assert.equal(result.response, 'local answer');
  assert.equal((await manager.listSessions()).length, 1);
  assert.equal(await manager.deleteSession(created.metadata.sessionId), true);
  assert.equal(await manager.getSession(created.metadata.sessionId), null);
});

test('filesystem metadata checks stay inside the runtime data directory', async () => {
  const storagePath = { ...path };
  const fixture = createFixture({ storagePath });
  storagePath.resolve = (...parts) => {
    const filename = path.resolve(...parts);
    // Path construction is traced too; do not construct the project root as an asset.
    const relative = path.relative(path.join(fixture.root, 'data'), filename);
    assert.ok(relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)));
    return filename;
  };
  for (const method of ['realpathSync', 'lstatSync']) {
    const original = fixture.fs[method];
    fixture.fs[method] = (filename, ...args) => {
      // cwd is trusted runtime configuration, not a build-time filesystem asset.
      const relative = path.relative(path.join(fixture.root, 'data'), filename);
      assert.ok(relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)));
      return original(filename, ...args);
    };
  }
  const manager = fixture.api.createContextManager({ enableQueryRewriting: false });
  await manager.processQuery('safe-id', 'hello');
  assert.equal((await manager.getSession('safe-id')).messages.length, 2);
  assert.equal((await manager.listSessions()).length, 1);
  assert.equal(await manager.deleteSession('safe-id'), true);
  assert.equal(fixture.handles.size, 0);
});

test('native junction and hard-link guards leave only synthetic outside files unchanged', async (t) => {
  const root = nativeFs.realpathSync(nativeFs.mkdtempSync(path.join(os.tmpdir(), 'rag-session-storage-')));
  t.after(() => {
    const resolved = nativeFs.realpathSync(root);
    assert.equal(path.dirname(resolved), nativeFs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('rag-session-storage-'));
    assert.equal(nativeFs.lstatSync(resolved).isSymbolicLink(), false);
    nativeFs.rmSync(resolved, { recursive: true, force: true });
  });
  const outside = path.join(root, 'synthetic-outside');
  nativeFs.mkdirSync(outside);
  const sentinel = path.join(outside, 'safe-id.json');
  nativeFs.writeFileSync(sentinel, 'synthetic sentinel');
  nativeFs.symlinkSync(outside, path.join(root, 'data'), 'junction');
  const { api } = createFixture({ storageFs: nativeFs, storageRoot: root });
  const manager = api.createContextManager({ enableQueryRewriting: false });
  for (const operation of [() => manager.getSession('safe-id'), () => manager.processQuery('safe-id', 'hello'), () => manager.deleteSession('safe-id')]) {
    await assert.rejects(operation, (error) => error.code === 'CONTEXT_SESSION_STORAGE_UNSAFE');
  }
  assert.equal(nativeFs.readFileSync(sentinel, 'utf8'), 'synthetic sentinel');
  // This exact junction was created by this test; unlink it, never its target.
  nativeFs.unlinkSync(path.join(root, 'data'));
  nativeFs.mkdirSync(path.join(root, 'data/context-sessions'), { recursive: true });
  nativeFs.linkSync(sentinel, path.join(root, 'data/context-sessions/safe-id.json'));
  for (const operation of [() => manager.getSession('safe-id'), () => manager.processQuery('safe-id', 'hello'), () => manager.deleteSession('safe-id')]) {
    await assert.rejects(operation, (error) => error.code === 'CONTEXT_SESSION_STORAGE_UNSAFE');
  }
  assert.equal(nativeFs.readFileSync(sentinel, 'utf8'), 'synthetic sentinel');
});

test('native IO failures use owned static errors and close their descriptors', async () => {
  for (const method of ['readFileSync', 'ftruncateSync', 'writeFileSync', 'unlinkSync', 'closeSync']) {
    const fixture = createFixture();
    const manager = fixture.api.createContextManager({ enableQueryRewriting: false });
    await manager.processQuery('safe-id', 'hello');
    const original = fixture.fs[method];
    fixture.fs[method] = (...args) => {
      if (method === 'closeSync') original(...args);
      throw new Error('synthetic-sensitive-native-path');
    };
    let failure;
    try {
      if (method === 'unlinkSync') await manager.deleteSession('safe-id');
      else if (method === 'readFileSync' || method === 'closeSync') await manager.getSession('safe-id');
      else await manager.processQuery('safe-id', 'hello');
    } catch (error) { failure = error; }
    assert.equal(failure?.code, 'CONTEXT_SESSION_STORAGE_UNSAFE');
    assert.equal(failure.message.includes('synthetic-sensitive'), false);
    assert.equal(fixture.handles.size, 0);
  }
});

test('legacy API blocks production and authenticated modes before parsing or side effects', async () => {
  for (const env of [
    { NODE_ENV: 'production' },
    { NODE_ENV: 'production', RAG_ACCESS_MODE: 'local-dev' },
    { NODE_ENV: 'production', RAG_ACCESS_MODE: 'single-tenant-token' },
    { NODE_ENV: 'test', RAG_ACCESS_MODE: 'single-tenant-token' },
    { NODE_ENV: 'test', RAG_AUTH_MODE: 'single-tenant-token' },
    { NODE_ENV: 'test', RAG_ACCESS_MODE: 'unknown' },
    { NODE_ENV: 'test', RAG_ACCESS_MODE: ' ' },
    { NODE_ENV: 'test', RAG_ACCESS_MODE: 'unknown', RAG_AUTH_MODE: 'local-dev' },
  ]) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const fixture = createFixture();
      const route = createRouteFixture(fixture, env);
      let requestReads = 0;
      const request = {
        get url() { requestReads += 1; throw new Error('synthetic request must not be read'); },
        async json() { requestReads += 1; throw new Error('synthetic body must not be parsed'); },
      };
      await assertLegacyBlocked(await route[method](request));
      assert.equal(requestReads, 0);
      assert.equal(fixture.counters.managerCreations, 0);
      assert.equal(fixture.counters.fileAccess, 0);
      assert.equal(fixture.counters.modelCalls, 0);
      assert.equal(fixture.files.size, 0);
    }
  }
});

test('legacy API blocks every production action including malformed JSON and synthetic bearer input', async () => {
  const fixture = createFixture();
  const route = createRouteFixture(fixture, { NODE_ENV: 'production', RAG_ACCESS_MODE: 'local-dev' });
  for (const action of ['sessions', 'session', 'config', 'status', 'unknown']) {
    await assertLegacyBlocked(await route.GET(new Request(`http://localhost/rag-api/context-management?action=${action}&sessionId=safe-id`)));
  }
  for (const action of ['query', 'stream-query', 'create-session', 'delete-session', 'compress', 'update-config', 'unknown']) {
    await assertLegacyBlocked(await route.POST(new Request('http://localhost/rag-api/context-management', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-not-authority' },
      body: JSON.stringify({ action, sessionId: 'safe-id', question: 'hello', config: { topK: 1 } }),
    })));
  }
  await assertLegacyBlocked(await route.POST(new Request('http://localhost/rag-api/context-management', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ malformed synthetic JSON',
  })));
  await assertLegacyBlocked(await route.DELETE(new Request('http://localhost/rag-api/context-management?sessionId=safe-id', { method: 'DELETE' })));
  assert.equal(fixture.counters.managerCreations, 0);
  assert.equal(fixture.counters.fileAccess, 0);
  assert.equal(fixture.counters.modelCalls, 0);
});

test('legacy API preserves default and explicit non-production local-demo session flows', async () => {
  for (const env of [
    {}, { NODE_ENV: 'development' },
    { NODE_ENV: 'test', RAG_ACCESS_MODE: ' LOCAL-DEV ' },
    { NODE_ENV: 'development', RAG_AUTH_MODE: 'local-dev' },
  ]) {
    const fixture = createFixture();
    const route = createRouteFixture(fixture, env);
    assert.equal((await route.GET(new Request('http://localhost/rag-api/context-management?action=config'))).status, 200);
    const created = await route.POST(new Request('http://localhost/rag-api/context-management', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create-session', userId: 'synthetic-user' }),
    }));
    assert.equal(created.status, 200);
    const sessionId = (await created.json()).session.metadata.sessionId;
    const query = await route.POST(new Request('http://localhost/rag-api/context-management', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'query', sessionId, question: 'hello' }),
    }));
    assert.equal(query.status, 200);
    assert.equal((await query.json()).response, 'local answer');
    assert.equal((await route.GET(new Request(`http://localhost/rag-api/context-management?action=session&sessionId=${sessionId}`))).status, 200);
    assert.equal((await route.DELETE(new Request(`http://localhost/rag-api/context-management?sessionId=${sessionId}`, { method: 'DELETE' }))).status, 200);
    assert.equal(fixture.counters.managerCreations, 1);
    assert.equal(fixture.files.size, 0);
  }
});

test('legacy API rechecks policy for every request even after a manager was cached', async () => {
  const fixture = createFixture();
  const env = { NODE_ENV: 'development', RAG_ACCESS_MODE: 'local-dev' };
  const route = createRouteFixture(fixture, env);
  const created = await route.POST(new Request('http://localhost/rag-api/context-management', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create-session' }),
  }));
  assert.equal(created.status, 200);
  const sessionId = (await created.json()).session.metadata.sessionId;
  const before = { ...fixture.counters };
  const bytes = [...fixture.files.entries()];
  env.NODE_ENV = 'production';
  await assertLegacyBlocked(await route.GET(new Request('http://localhost/rag-api/context-management?action=sessions')));
  await assertLegacyBlocked(await route.POST(new Request('http://localhost/rag-api/context-management', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'query', sessionId, question: 'hello' }),
  })));
  await assertLegacyBlocked(await route.DELETE(new Request(`http://localhost/rag-api/context-management?sessionId=${sessionId}`, { method: 'DELETE' })));
  assert.deepEqual(fixture.counters, before);
  assert.deepEqual([...fixture.files.entries()], bytes);
});

test('disabled legacy entry never imports the context runtime before or during requests', async () => {
  for (const env of [{ NODE_ENV: 'production' }, { NODE_ENV: 'production', RAG_ACCESS_MODE: 'local-dev' }, { NODE_ENV: 'test', RAG_ACCESS_MODE: 'single-tenant-token' }]) {
    const fixture = createFixture();
    let imports = 0;
    const route = createRouteFixture(fixture, env, () => { imports += 1; });
    assert.equal(imports, 0, 'a disabled route must not eagerly load model and retrieval dependencies');
    const request = { get url() { throw new Error('disabled request must not be parsed'); }, json() { throw new Error('disabled body must not be parsed'); } };
    for (const method of ['GET', 'POST', 'DELETE']) await assertLegacyBlocked(await route[method](request));
    assert.equal(imports, 0);
    assert.equal(fixture.counters.managerCreations, 0);
    assert.equal(fixture.counters.fileAccess, 0);
    assert.equal(fixture.counters.modelCalls, 0);
  }
});

test('disabled legacy entry remains available when the context runtime cannot be imported', async () => {
  const fixture = createFixture();
  const route = createRouteFixture(fixture, { NODE_ENV: 'production' }, () => { throw new Error('synthetic unavailable context runtime'); });
  for (const method of ['GET', 'POST', 'DELETE']) await assertLegacyBlocked(await route[method]({}));
  assert.equal(fixture.counters.managerCreations, 0);
});

test('local demo imports the context runtime only on demand and retains isolation after an environment change', async () => {
  const fixture = createFixture();
  const env = { NODE_ENV: 'test', RAG_ACCESS_MODE: 'local-dev' };
  let imports = 0;
  const route = createRouteFixture(fixture, env, () => { imports += 1; });
  assert.equal(imports, 0);
  for (let i = 0; i < 2; i += 1) {
    assert.equal((await route.GET(new Request('http://localhost/rag-api/context-management?action=config'))).status, 200);
  }
  assert.equal(imports, 1);
  assert.equal(fixture.counters.managerCreations, 1);
  env.NODE_ENV = 'production';
  await assertLegacyBlocked(await route.GET(new Request('http://localhost/rag-api/context-management?action=config')));
  assert.equal(imports, 1);
});

test('concurrent first local-demo requests retain a single shared context manager', async () => {
  const fixture = createFixture();
  const route = createRouteFixture(fixture);
  const responses = await Promise.all(Array.from({ length: 3 }, () => route.GET(
    new Request('http://localhost/rag-api/context-management?action=config')
  )));
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(fixture.counters.managerCreations, 1);
});

async function assertLegacyBlocked(response) {
  assert.equal(response.status, 410);
  assert.ok(response.headers.get('content-type').startsWith('application/json'));
  assert.deepEqual(await response.json(), {
    success: false, error: 'This legacy RAG route is disabled outside local development.', code: 'LEGACY_RAG_ROUTE_DISABLED',
  });
}

test('API rejects invalid session IDs before manager creation across every session action', async () => {
  for (const sessionId of ['../outside', '..\\outside', 'id:stream', 'CON', { invalid: true }, null]) {
    for (const action of ['get', 'delete', 'query', 'stream-query', 'delete-session', 'compress']) {
      const fixture = createFixture();
      const route = createRouteFixture(fixture);
      let response;
      if (action === 'get') {
        const url = new URL('http://localhost/rag-api/context-management');
        url.searchParams.set('action', 'session');
        if (sessionId !== null) url.searchParams.set('sessionId', String(sessionId));
        response = await route.GET(new Request(url));
      } else if (action === 'delete') {
        const url = new URL('http://localhost/rag-api/context-management');
        if (sessionId !== null) url.searchParams.set('sessionId', String(sessionId));
        response = await route.DELETE(new Request(url, { method: 'DELETE' }));
      } else {
        response = await route.POST(new Request('http://localhost/rag-api/context-management', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, sessionId, question: 'hello' }),
        }));
      }
      assert.equal(response.status, 400, action);
      const body = await response.json();
      assert.equal(body.code, 'CONTEXT_SESSION_ID_INVALID');
      assert.equal(fixture.counters.managerCreations, 0);
      assert.equal(fixture.counters.fileAccess, 0);
      assert.equal(fixture.counters.modelCalls, 0);
    }
  }
});

test('API maps an unsafe storage error to 503 without exposing the path', async () => {
  const fixture = createFixture();
  const manager = fixture.api.createContextManager({ enableQueryRewriting: false });
  await manager.processQuery('safe-id', 'hello');
  const original = fixture.fs.lstatSync;
  fixture.fs.lstatSync = (filename, options) => ({ ...original(filename, options), isSymbolicLink: () => true });
  const response = await createRouteFixture(fixture).GET(new Request('http://localhost/rag-api/context-management?action=session&sessionId=safe-id'));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, 'CONTEXT_SESSION_STORAGE_UNSAFE');
  assert.equal(JSON.stringify(body).includes(fixture.root), false);
});

test('stream API returns load-time storage failures as 503 before committing SSE headers', async () => {
  const fixture = createFixture();
  const original = fixture.fs.lstatSync;
  fixture.fs.lstatSync = (filename, options) => ({ ...original(filename, options), isSymbolicLink: () => true });
  const response = await createRouteFixture(fixture).POST(new Request('http://localhost/rag-api/context-management', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'stream-query', sessionId: 'safe-id', question: 'hello' }),
  }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'CONTEXT_SESSION_STORAGE_UNSAFE');
  assert.equal(fixture.counters.modelCalls, 0);
});

test('stream API preserves the first workflow once and reports late storage failures via owned SSE code', async () => {
  const fixture = createFixture();
  fixture.fs.writeFileSync = () => { throw new Error('synthetic-sensitive-native-path'); };
  const response = await createRouteFixture(fixture).POST(new Request('http://localhost/rag-api/context-management', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'stream-query', sessionId: 'safe-id', question: 'hello' }),
  }));
  assert.equal(response.status, 200);
  const body = await response.text();
  const events = body.split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)));
  assert.equal(events[0].type, 'workflow');
  assert.equal(events.filter((event) => event.type === 'workflow' && event.data.step.step === events[0].data.step.step).length, 1);
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.at(-1).data.code, 'CONTEXT_SESSION_STORAGE_UNSAFE');
  assert.equal(body.includes('synthetic-sensitive'), false);
  assert.equal(fixture.handles.size, 0);
});

test('compress API propagates save-time storage errors instead of reporting a benign false result', async () => {
  const fixture = createFixture();
  const manager = fixture.api.createContextManager({ enableQueryRewriting: false });
  for (let round = 0; round < 4; round += 1) await manager.processQuery('safe-id', 'hello');
  const filename = path.join(fixture.dataRoot, 'safe-id.json');
  const bytes = fixture.files.get(filename);
  fixture.fs.ftruncateSync = () => { throw new Error('synthetic-sensitive-native-path'); };
  const response = await createRouteFixture(fixture).POST(new Request('http://localhost/rag-api/context-management', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'compress', sessionId: 'safe-id' }),
  }));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, 'CONTEXT_SESSION_STORAGE_UNSAFE');
  assert.equal(JSON.stringify(body).includes('synthetic-sensitive'), false);
  assert.equal(fixture.files.get(filename), bytes);
  assert.equal(fixture.handles.size, 0);
});

function createFixture({ failModel = false, storageFs, storageRoot, storagePath } = {}) {
  const files = new Map();
  const root = storageRoot ?? path.resolve('context-memory-fixture');
  const dataRoot = path.join(root, 'data/context-sessions');
  const directories = new Set([root, path.join(root, 'data')]);
  const handles = new Map();
  const inodes = new Map();
  let nextInode = 1n;
  let nextHandle = 3;
  const counters = { search: 0, embedQuery: 0, modelCalls: 0, fileAccess: 0, read: 0, write: 0, unlink: 0, managerCreations: 0 };
  const validatePath = (filename) => {
    counters.fileAccess += 1;
    const relative = path.relative(dataRoot, filename);
    assert.ok(relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)));
    return filename;
  };
  const validateMetadataPath = (filename) => {
    if (filename === root || filename === path.join(root, 'data')) { counters.fileAccess += 1; return filename; }
    return validatePath(filename);
  };
  const stat = (filename) => {
    validateMetadataPath(filename);
    if (!files.has(filename) && !directories.has(filename)) throw Object.assign(new Error('synthetic missing path'), { code: 'ENOENT' });
    if (!inodes.has(filename)) { inodes.set(filename, nextInode); nextInode += 1n; }
    return {
      dev: 1n, ino: inodes.get(filename), nlink: 1n,
      isFile: () => files.has(filename),
      isDirectory: () => directories.has(filename),
      isSymbolicLink: () => false,
    };
  };
  const fromHandle = (fd) => { assert.ok(handles.has(fd)); return handles.get(fd).filename; };
  const memoryFs = {
    constants: nativeFs.constants,
    existsSync: (filename) => files.has(validateMetadataPath(filename)) || directories.has(filename),
    mkdirSync: (filename) => { directories.add(validatePath(filename)); },
    lstatSync: stat,
    realpathSync: (filename) => validateMetadataPath(filename),
    openSync: (filename, flags) => {
      validatePath(filename);
      if (files.has(filename) && (flags & nativeFs.constants.O_EXCL)) throw Object.assign(new Error('synthetic existing path'), { code: 'EEXIST' });
      if (!files.has(filename)) {
        if (!(flags & nativeFs.constants.O_CREAT)) throw Object.assign(new Error('synthetic missing path'), { code: 'ENOENT' });
        files.set(filename, '');
      }
      const entry = stat(filename);
      const fd = nextHandle; nextHandle += 1;
      handles.set(fd, { filename, ino: entry.ino, flags });
      return fd;
    },
    fstatSync: (fd) => ({ ...stat(fromHandle(fd)), ino: handles.get(fd).ino }),
    closeSync: (fd) => { assert.ok(handles.delete(fd)); },
    ftruncateSync: (fd, length) => { counters.write += 1; const filename = fromHandle(fd); files.set(filename, files.get(filename).slice(0, length)); },
    writeFileSync: (target, content) => { counters.write += 1; const filename = typeof target === 'number' ? fromHandle(target) : target; files.set(validatePath(filename), content); },
    readFileSync: (target) => { counters.read += 1; const filename = typeof target === 'number' ? fromHandle(target) : target; assert.ok(files.has(validatePath(filename))); return files.get(filename); },
    readdirSync: (directory) => { validatePath(directory); return [...files.keys()].map((filename) => path.basename(filename)); },
    unlinkSync: (filename) => { counters.unlink += 1; files.delete(validatePath(filename)); },
  };
  const llm = RunnableLambda.from(async () => {
    counters.modelCalls += 1;
    if (failModel) throw new Error('synthetic model failure');
    return new AIMessage('local answer');
  });
  const dependencies = {
    './model-config': {
      getModelFactory: () => ({ getProvider: () => 'ollama', getEnvConfig: () => ({ OLLAMA_LLM_MODEL: 'fake-model' }) }),
      createLLM: () => llm,
      createEmbedding: () => ({ embedQuery: async () => { counters.embedQuery += 1; return [1, 0, 0]; } }),
      getModelDimension: () => 3,
      selectModelByDimension: () => 'fake-embedding',
    },
    './embedding-config': { getEmbeddingConfigSummary: () => ({ model: 'fake-embedding' }) },
    './milvus-client': {
      getMilvusInstance: () => ({
        connect: async () => {},
        getCollectionStats: async () => ({ embeddingDimension: 3 }),
        search: async () => { counters.search += 1; return [{ id: 'document-1', content: 'pricing detail', score: 0.9, metadata: { source: 'synthetic' } }]; },
      }),
    },
    fs: storageFs ?? memoryFs,
    path: storagePath ?? path,
  };
  const fixtureModule = { exports: {} };
  const output = compileFixtureSource(sourcePath, readFileSync(sourcePath, 'utf8'));
  runInNewContext(output, {
    module: fixtureModule, exports: fixtureModule.exports, Error,
    require(specifier) {
      if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier];
      assert.ok(specifier.startsWith('@langchain/core/'), `unexpected dependency: ${specifier}`);
      return require(specifier);
    },
    process: { env: { MILVUS_COLLECTION: 'synthetic' }, cwd: () => root },
    console: { log() {}, error() {} },
  }, { filename: sourcePath });
  return { api: fixtureModule.exports, counters, files, fs: storageFs ?? memoryFs, root, dataRoot, handles };
}

function createRouteFixture(fixture, env = { NODE_ENV: 'test', RAG_ACCESS_MODE: 'local-dev' }, onContextImport = () => {}) {
  const policyFilename = fileURLToPath(new URL('./security/legacy-route-policy.ts', import.meta.url));
  const policyModule = { exports: {} };
  const policyOutput = compileFixtureSource(policyFilename, readFileSync(policyFilename, 'utf8'));
  runInNewContext(policyOutput, {
    module: policyModule, exports: policyModule.exports, Error, Response, process: { env },
  }, { filename: policyFilename });
  const filename = fileURLToPath(new URL('../app/api/context-management/route.ts', import.meta.url));
  const fixtureModule = { exports: {} };
  const output = compileFixtureSource(filename, readFileSync(filename, 'utf8'));
  runInNewContext(output, {
    module: fixtureModule, exports: fixtureModule.exports, Error, URL, Response, ReadableStream, TextEncoder,
    console: { log() {}, error() {} },
    require(specifier) {
      if (specifier === 'next/server') return { NextResponse: { json: (body, init) => Response.json(body, init) } };
      if (specifier === '@/lib/security/legacy-route-policy') return policyModule.exports;
      assert.equal(specifier, '@/lib/context-management');
      onContextImport();
      return {
        ...fixture.api,
        createContextManager(...args) {
          fixture.counters.managerCreations += 1;
          return fixture.api.createContextManager(...args);
        },
      };
    },
  }, { filename });
  return fixtureModule.exports;
}

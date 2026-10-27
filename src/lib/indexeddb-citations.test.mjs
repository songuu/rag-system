import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('./indexeddb.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  fileName: 'indexeddb.ts', reportDiagnostics: true,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
assert.deepEqual(compiled.diagnostics, []);
const isolated = { exports: {} };
vm.runInNewContext(compiled.outputText, {
  module: isolated, exports: isolated.exports, Date,
  console: { log() {}, error() {} },
  require(name) { throw new Error(`Unexpected runtime dependency: ${name}`); },
});
const { dbManager, projectMessageCitations } = isolated.exports;
const partition = 'a'.repeat(64);
const otherPartition = 'b'.repeat(64);
const now = 2_000_000_000_000;
const item = { number: 1, locator: 'opaque.signed.locator', expiresAt: now + 60_000, source: '测试资料', page: 3 };
const envelope = items => ({ version: 'rag-citations/v1', status: 'available', partition, items,
  diagnostics: { reason: 'ready', citationCount: 1, invalidCitationCount: 0, unavailableCitationCount: 0 } });
const plain = value => JSON.parse(JSON.stringify(value));

function freshStorage(initial) {
  const storageModule = { exports: {} };
  vm.runInNewContext(compiled.outputText, { module: storageModule, exports: storageModule.exports, Date, console: { log() {}, error() {} } });
  const manager = storageModule.exports.dbManager;
  let stored = structuredClone(initial);
  const database = { transaction() {
    const transaction = {};
    transaction.objectStore = () => ({
      put(value) { stored = structuredClone(value); const request = {}; queueMicrotask(() => request.onsuccess()); return request; },
      get() { const request = {}; queueMicrotask(() => { request.result = structuredClone(stored); request.onsuccess(); }); return request; },
      openCursor() {
        const request = {};
        queueMicrotask(() => request.onsuccess({ target: { result: {
          value: structuredClone(stored), update(value) { stored = structuredClone(value); },
          continue() { queueMicrotask(() => { request.onsuccess({ target: { result: null } }); transaction.oncomplete(); }); },
        } } }));
        return request;
      },
    });
    return transaction;
  } };
  manager.db = database;
  return { manager, database, get stored() { return stored; } };
}
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
const staleConversation = () => ({ id: 'async-fence', title: '保留标题', createdAt: new Date(), updatedAt: new Date(),
  messages: [{ id: 'old', type: 'assistant', content: '保留正文', timestamp: new Date(), citations: envelope([item]) }] });

test('an add paused on its old conversation cannot restore handles after explicit invalidation', async () => {
  const storage = freshStorage(staleConversation());
  const pause = deferred();
  storage.manager.getConversation = async () => { await pause.promise; return staleConversation(); };
  const writing = storage.manager.addMessageToConversation('async-fence', { id: 'new', type: 'assistant', content: '仍保留新正文', timestamp: new Date(), citations: envelope([item]) });
  await storage.manager.pruneConversationCitations(null, null);
  pause.resolve(); await writing;
  assert.ok(storage.stored.messages.every(message => message.citations === undefined));
  assert.equal(storage.stored.messages[1].content, '仍保留新正文');
});

test('an analysis snapshot read before invalidation cannot restore its old handles on save', async () => {
  const storage = freshStorage(staleConversation());
  const snapshot = await storage.manager.getConversation('async-fence');
  await storage.manager.pruneConversationCitations(null, null);
  snapshot.messages[0].queryAnalysis = { summary: '保留分析更新' };
  await storage.manager.saveConversation(snapshot);
  assert.equal(storage.stored.messages[0].citations, undefined);
  assert.equal(storage.stored.messages[0].queryAnalysis.summary, '保留分析更新');
});

test('a save paused on initialization checks citation validity immediately before put', async () => {
  const storage = freshStorage(staleConversation());
  const pause = deferred();
  storage.manager.db = null;
  storage.manager.init = async () => { await pause.promise; storage.manager.db = storage.database; };
  const writing = storage.manager.saveConversation(staleConversation());
  storage.manager.db = storage.database;
  await storage.manager.pruneConversationCitations(null, null);
  pause.resolve(); await writing;
  assert.equal(storage.stored.messages[0].citations, undefined);
  assert.equal(storage.stored.messages[0].content, '保留正文');
});

test('citation persistence projects only opaque handles and display metadata', () => {
  assert.equal(typeof projectMessageCitations, 'function');
  const projected = projectMessageCitations({
    ...envelope([{ ...item, content: 'private source text', relations: ['private relation'], token: 'secret' }]),
    rawEvidence: 'private source text', actorId: 'private actor',
  }, partition, now);
  const storedItem = { ...item };
  delete storedItem.source;
  assert.deepEqual(plain(projected), envelope([storedItem]));
});

test('citation storage drops raw source URLs and titles from old or supplied envelopes', () => {
  for (const source of ['https://private.example.test/file.pdf?X-Amz-Signature=synthetic-secret',
    'https://synthetic-user:synthetic-password@private.example.test/file.pdf', 'private-file.pdf']) {
    const projected = projectMessageCitations(envelope([{ ...item, source }]), partition, now);
    assert.equal(projected.items[0].source, undefined);
    assert.equal(projected.items[0].locator, item.locator);
    assert.equal(projected.items[0].page, item.page);
  }
});

test('restoration rejects wrong partitions, malformed handles and expired items', () => {
  assert.equal(typeof projectMessageCitations, 'function');
  assert.equal(projectMessageCitations(envelope([item]), otherPartition, now), undefined);
  const projected = projectMessageCitations(envelope([
    { ...item, expiresAt: now },
    { ...item, number: 2, expiresAt: now - 1 },
    { ...item, number: 3, locator: '' },
    { ...item, number: 4 },
  ]), partition, now);
  assert.deepEqual(plain(projected).items.map(value => value.number), [4]);
  assert.equal(projectMessageCitations({ ...envelope([item]), version: 'unknown' }, partition, now), undefined);
  assert.equal(projectMessageCitations(envelope([item, item]), partition, now), undefined);
});

test('storage expiry uses the validated server clock instead of a skewed browser clock', async () => {
  assert.equal(typeof dbManager.setCitationClockOffset,'function');
  const offset=86_400_000;
  dbManager.setCitationClockOffset(offset);
  let stored;
  dbManager.db={transaction:()=>({objectStore:()=>({put(value){stored=value;const request={};queueMicrotask(()=>request.onsuccess());return request;}})})};
  const current={...item,expiresAt:Date.now()-offset+60_000};
  await dbManager.saveConversation({id:'skew-fixture',title:'保留对话',createdAt:new Date(),updatedAt:new Date(),messages:[{id:'answer',content:'回答',citations:envelope([current])}]});
  assert.equal(stored.messages[0].citations.items.length,1);
  dbManager.setCitationClockOffset(0);
});

test('unknown server time preserves opaque handles on storage and restoration until identity calibration', async () => {
  dbManager.setCitationClockOffset(null);
  let stored;
  dbManager.db = { transaction: () => ({ objectStore: () => ({
    put(value) { stored = value; const request = {}; queueMicrotask(() => request.onsuccess()); return request; },
    get() { const request = { result: stored }; queueMicrotask(() => request.onsuccess()); return request; },
  }) }) };
  const reference = { ...item, expiresAt: Date.now() - 60_000 };
  await dbManager.saveConversation({ id: 'unknown-clock', title: '保留标题', createdAt: new Date(), updatedAt: new Date(),
    messages: [{ id: 'answer', content: '保留回答', timestamp: new Date(), citations: envelope([reference]) }] });
  const restored = await dbManager.getConversation('unknown-clock');
  assert.equal(restored.messages[0].citations.items[0].locator, reference.locator);
  assert.equal(restored.messages[0].content, '保留回答');
});

test('partition pruning updates citations without deleting conversation content or other metadata', async () => {
  assert.equal(typeof dbManager.pruneConversationCitations, 'function');
  const original = [
    { id: 'old-account', title: '保留标题', messages: [{ id: 'm1', content: '保留回答', citations: { ...envelope([item]), partition: otherPartition }, processingDetails: { mode: 'rag' } }] },
    { id: 'same-account', messages: [{ id: 'm2', content: '当前回答', citations: envelope([{ ...item, expiresAt: now - 1 }, { ...item, number: 2 }]) }] },
    { id: 'legacy', messages: [{ id: 'm3', content: '旧消息没有引用' }] },
  ];
  const stored = structuredClone(original);
  const updated = [];
  let transaction;
  const request = {};
  dbManager.db = {
    transaction(names, mode) {
      assert.deepEqual(plain(names), ['conversations']);
      assert.equal(mode, 'readwrite');
      transaction = { objectStore: () => ({ openCursor: () => request }) };
      queueMicrotask(() => {
        let index = 0;
        function step() {
          const cursor = index < stored.length ? {
            value: stored[index],
            update(value) { stored[index] = value; updated.push(index); return {}; },
            continue() { index++; queueMicrotask(step); },
          } : null;
          request.onsuccess({ target: { result: cursor } });
          if (!cursor) queueMicrotask(() => transaction.oncomplete());
        }
        step();
      });
      return transaction;
    },
  };
  await dbManager.pruneConversationCitations(partition, now);
  assert.equal(stored[0].messages[0].citations, undefined);
  assert.equal(stored[0].messages[0].content, '保留回答');
  assert.equal(stored[0].title, '保留标题');
  assert.deepEqual(plain(stored[0].messages[0].processingDetails), { mode: 'rag' });
  assert.deepEqual(plain(stored[1].messages[0].citations.items).map(value => value.number), [2]);
  assert.deepEqual(stored[2], original[2]);
  assert.deepEqual(updated, [0, 1]);
  await dbManager.pruneConversationCitations(null, now);
  assert.ok(stored.every(conversation => conversation.messages.every(message => message.citations === undefined)));
  assert.equal(stored[1].messages[0].content, '当前回答');
});

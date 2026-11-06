import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { dismissPublicationRecord, isPublicationPending, loadPublicationRecords, parsePublicationCapability, parsePublicationRecords,
  publicationPhase, PublicationRequestRejectedError, savePublicationRecords, submitPublicationFile, submitStoredPublicationFile,
  PUBLICATION_STORAGE_KEY, fetchDocumentWorkspace } from './publication-client.ts';

const requestId = '1fdfd827-b0da-4fd1-a99b-2f434e7f473b';
const record = { requestId, documentId: `upload:${requestId}`, name: 'a.txt', createdAt: new Date().toISOString(), phase: 'unknown' };
function memoryStorage() {
  const entries = new Map();
  return { get length() { return entries.size; }, key(index) { return [...entries.keys()][index] ?? null; },
    getItem(key) { return entries.get(key) ?? null; }, setItem(key, value) { entries.set(key, String(value)); }, removeItem(key) { entries.delete(key); } };
}
function nextRecord() { const requestId = randomUUID(); return { ...record, requestId, documentId: `upload:${requestId}` }; }
test('capability must be explicit and unknown configuration cannot select a legacy write', () => {
  assert.deepEqual(parsePublicationCapability({ success: true, mode: 'unified', acceptsUploads: false }), { mode: 'unified', acceptsUploads: false });
  assert.throws(() => parsePublicationCapability({ success: false }));
  assert.throws(() => parsePublicationCapability({ success: true, mode: 'off', acceptsUploads: true }));
});

test('unified workspace never probes legacy Milvus or pipeline status',async()=>{
  const paths=[];
  const result=await fetchDocumentWorkspace(async path=>{paths.push(path);
    return Response.json(path.includes('capabilities')?{success:true,mode:'unified',acceptsUploads:true}:{success:true});
  });
  assert.equal(result.capability.mode,'unified');assert.equal(result.milvus,null);
  assert.ok(!paths.some(path=>path.includes('/milvus')||path.includes('/pipeline')));
  let unknownCalls=0;
  await assert.rejects(fetchDocumentWorkspace(async()=>{unknownCalls++;return Response.json({success:false},{status:503});}));
  assert.equal(unknownCalls,1);
});
test('restored identities are tied to their original document ID', () => {
  assert.deepEqual(parsePublicationRecords(JSON.stringify([record, { ...record, documentId: 'wrong' }])), [record]);
  assert.deepEqual(parsePublicationRecords('invalid'), []);
});
test('only the matching current published head is displayed as published', () => {
  assert.equal(publicationPhase({ success: true, requestId, status: { attemptState: 'published', currentlyActive: true } }, requestId), 'published');
  assert.equal(publicationPhase({ success: true, requestId, status: { attemptState: 'published', currentlyActive: false } }, requestId), 'unknown');
  assert.equal(publicationPhase({ success: true, requestId: 'wrong', status: { currentlyActive: true, attemptState: 'published' } }, requestId), 'unknown');
  assert.equal(publicationPhase({ success: true, requestId, status: { queueState: 'queued' } }, requestId), 'pending');
});
test('upload reports accepted and unknown without sending a second request', async () => {
  const file = new File(['原文'], 'a.txt', { type: 'text/plain' }); let calls = 0;
  assert.equal(await submitPublicationFile(file, record, async (_url, options) => {
    calls++; assert.equal(JSON.parse(options.body).requestId, requestId);
    assert.equal(Buffer.from(JSON.parse(options.body).contentBase64, 'base64').toString(), '原文');
    return Response.json({ success: true, status: 'accepted', requestId, documentId: record.documentId }, { status: 202 });
  }), 'pending');
  assert.equal(calls, 1);
  assert.equal(await submitPublicationFile(file, record, async () => { calls++; throw new TypeError('network'); }), 'unknown');
  assert.equal(calls, 2);
  assert.equal(await submitPublicationFile(file, record, async () => Response.json({ status: 'unknown' }, { status: 503 })), 'unknown');
  assert.equal(await submitPublicationFile(file, record, async () => Response.json({ error: 'conflict' }, { status: 409 })), 'unknown');
});
test('invalid files and cancelled preparation cannot dispatch a request', async () => {
  let calls = 0; const fetcher = async () => { calls++; return Response.json({}); };
  await assert.rejects(submitPublicationFile(new File(['x'], 'source.exe'), record, fetcher));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(submitPublicationFile(new File(['x'], 'source.txt'), record, fetcher, controller.signal));
  assert.equal(calls, 0);
});
test('stale tabs writing distinct requests cannot overwrite each other or regress confirmed results', () => {
  const storage = memoryStorage(); const first = nextRecord(); const second = nextRecord();
  savePublicationRecords(storage, [first]);
  // A second tab still has its original empty snapshot, then writes its own ID.
  savePublicationRecords(storage, [second]);
  assert.deepEqual(new Set(loadPublicationRecords(storage).map(item => item.requestId)), new Set([first.requestId, second.requestId]));
  savePublicationRecords(storage, [{ ...first, phase: 'published' }]);
  savePublicationRecords(storage, [first, { ...second, phase: 'pending' }]);
  assert.equal(loadPublicationRecords(storage).find(item => item.requestId === first.requestId).phase, 'published');
  assert.equal(loadPublicationRecords(storage).find(item => item.requestId === second.requestId).phase, 'pending');
  // Simulate another tab committing a terminal result between this tab's
  // identity read and its subsequent stale phase write.
  const third = nextRecord(); savePublicationRecords(storage, [third]);
  let interleave = true;
  const racing = { ...storage, get length() { return storage.length; }, getItem(key) {
    const stale = storage.getItem(key);
    if (interleave && key.endsWith(third.requestId)) {
      interleave = false;
      savePublicationRecords(storage, [{ ...third, phase: 'published' }]);
    }
    return stale;
  } };
  savePublicationRecords(racing, [{ ...third, phase: 'pending' }]);
  assert.equal(loadPublicationRecords(storage).find(item => item.requestId === third.requestId).phase, 'published');
});
test('legacy aggregate migration keeps every identity and only completed records may be dismissed', () => {
  const storage = memoryStorage(); const first = nextRecord(); const second = nextRecord();
  storage.setItem(PUBLICATION_STORAGE_KEY, JSON.stringify([first, second]));
  savePublicationRecords(storage, [{ ...first, phase: 'failed' }]);
  assert.equal(storage.getItem(PUBLICATION_STORAGE_KEY), null);
  assert.equal(loadPublicationRecords(storage).length, 2);
  assert.throws(() => dismissPublicationRecord(storage, second.requestId));
  assert.deepEqual(dismissPublicationRecord(storage, first.requestId).map(item => item.requestId), [second.requestId]);
  savePublicationRecords(storage, [{ ...first, phase: 'published' }]);
  assert.deepEqual(loadPublicationRecords(storage).map(item => item.requestId), [second.requestId]);
});
test('definite HTTP refusals become failed and cannot fill the unresolved request limit', async () => {
  const storage = memoryStorage(); const file = new File(['body'], 'a.txt'); let calls = 0;
  for (let index = 0; index < 22; index++) {
    const item = nextRecord();
    await assert.rejects(submitStoredPublicationFile(file, item, storage, async () => {
      calls++; assert.ok(loadPublicationRecords(storage).some(saved => saved.requestId === item.requestId));
      return Response.json({ error: { message: 'not permitted' } }, { status: 403 });
    }), error => error instanceof PublicationRequestRejectedError && error.requestId === item.requestId);
  }
  assert.equal(calls, 22);
  assert.equal(loadPublicationRecords(storage).filter(isPublicationPending).length, 0);
  assert.equal(loadPublicationRecords(storage).filter(item => item.phase === 'failed').length, 22);
  const accepted = nextRecord();
  assert.equal((await submitStoredPublicationFile(file, accepted, storage, async () => Response.json({ success: true,
    status: 'accepted', requestId: accepted.requestId, documentId: accepted.documentId }, { status: 202 }))).phase, 'pending');
});
test('server failures, duplicate IDs and lost transport remain unresolved and never resend', async () => {
  const storage = memoryStorage(); const file = new File(['body'], 'a.txt'); let calls = 0;
  for (const status of [409, 500, 503]) {
    const item = nextRecord();
    assert.equal((await submitStoredPublicationFile(file, item, storage, async () => { calls++; return Response.json({}, { status }); })).phase, 'unknown');
  }
  const lost = nextRecord();
  assert.equal((await submitStoredPublicationFile(file, lost, storage, async () => { calls++; throw new Error('connection reset'); })).phase, 'unknown');
  assert.equal(calls, 4);
  assert.equal(loadPublicationRecords(storage).filter(isPublicationPending).length, 4);
});
test('file reading failure before dispatch is terminal and cannot exhaust unresolved capacity', async () => {
  const storage = memoryStorage(); let sent = 0;
  const file = new File(['body'], 'a.txt');
  Object.defineProperty(file, 'arrayBuffer', { value: async () => { throw new Error('file unreadable'); } });
  for (let index = 0; index < 22; index++) {
    const item = nextRecord();
    await assert.rejects(submitStoredPublicationFile(file, item, storage, async () => { sent++; return Response.json({}); }));
    assert.equal(loadPublicationRecords(storage).find(saved => saved.requestId === item.requestId).phase, 'failed');
  }
  assert.equal(sent, 0);
  assert.equal(loadPublicationRecords(storage).filter(isPublicationPending).length, 0);
});
test('cancellation during a delayed file read becomes failed without dispatch', async () => {
  const storage = memoryStorage(); const item = nextRecord(); const controller = new AbortController(); let sent = 0;
  let finishRead;
  const file = new File(['body'], 'a.txt');
  Object.defineProperty(file, 'arrayBuffer', { value: () => new Promise(resolve => { finishRead = resolve; }) });
  const upload = submitStoredPublicationFile(file, item, storage, async () => { sent++; return Response.json({}); }, controller.signal);
  assert.equal(loadPublicationRecords(storage).find(saved => saved.requestId === item.requestId).phase, 'unknown');
  controller.abort();
  await assert.rejects(upload);
  finishRead(new TextEncoder().encode('body').buffer);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(sent, 0);
  assert.equal(loadPublicationRecords(storage).find(saved => saved.requestId === item.requestId).phase, 'failed');
});
test('cancellation after dispatch remains unknown', async () => {
  const storage = memoryStorage(); const item = nextRecord(); const controller = new AbortController(); let sent = 0; let started;
  const dispatched = new Promise(resolve => { started = resolve; });
  const upload = submitStoredPublicationFile(new File(['body'], 'a.txt'), item, storage, async (_url, options) => {
    sent++; started();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }));
  }, controller.signal);
  await dispatched; controller.abort();
  assert.equal((await upload).phase, 'unknown');
  assert.equal(sent, 1);
  assert.equal(loadPublicationRecords(storage).find(saved => saved.requestId === item.requestId).phase, 'unknown');
});

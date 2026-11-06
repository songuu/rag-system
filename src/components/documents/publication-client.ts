export type PublicationPhase = 'pending' | 'unknown' | 'published' | 'failed' | 'superseded' | 'revoked';
export type PublicationRecord = { requestId: string; documentId: string; name: string; createdAt: string; phase: PublicationPhase };
export type PublicationCapability = { mode: 'legacy' | 'unified'; acceptsUploads: boolean };
export const PUBLICATION_STORAGE_KEY = 'rag.document-publications.v1';
export const PUBLICATION_RECORD_PREFIX = 'rag.document-publication.v2:';
export const PUBLICATION_MAX_BYTES = 2 * 1024 * 1024;
export const PUBLICATION_ACCEPTED_FILES = '.txt,.md,.markdown,.pdf,.docx,.xlsx,.csv,.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parsePublicationCapability(value: unknown): PublicationCapability {
  const body = object(value);
  if (body.success !== true || !['legacy', 'unified'].includes(String(body.mode)) || typeof body.acceptsUploads !== 'boolean') {
    throw new Error('无法确认文档发布服务状态，请刷新后重试。');
  }
  return { mode: body.mode as PublicationCapability['mode'], acceptsUploads: body.acceptsUploads };
}

export async function fetchDocumentWorkspace(fetcher: typeof fetch = fetch, signal?: AbortSignal) {
  const capabilityResponse=await fetcher('/rag-api/documents/publications?action=capabilities',{signal,cache:'no-store'});
  if(!capabilityResponse.ok)throw new Error('无法确认文档发布服务状态，请刷新后重试。');
  const capability=parsePublicationCapability(await capabilityResponse.json());
  const [catalog,health,milvus,pipeline]=await Promise.all([
    fetcher('/rag-api/documents',{signal,cache:'no-store'}),fetcher('/rag-api/health',{signal,cache:'no-store'}),
    capability.mode==='legacy'?fetcher('/rag-api/milvus?action=status',{signal,cache:'no-store'}):null,
    capability.mode==='legacy'?fetcher('/rag-api/pipeline?action=info',{signal,cache:'no-store'}):null,
  ]);
  return {capability,catalog,health,milvus,pipeline};
}

export function parsePublicationRecords(value: string | null): PublicationRecord[] {
  if (!value) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is PublicationRecord => {
    const row = object(item);
    return typeof row.requestId === 'string' && UUID.test(row.requestId) && row.documentId === `upload:${row.requestId}`
      && typeof row.name === 'string' && row.name.length > 0 && row.name.length <= 200
      && typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt))
      && ['pending', 'unknown', 'published', 'failed', 'superseded', 'revoked'].includes(String(row.phase));
  }).map(({ requestId, documentId, name, createdAt, phase }) => ({ requestId, documentId, name, createdAt, phase }));
}

type PublicationStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;
const PHASE_PRECEDENCE: PublicationPhase[] = ['revoked', 'superseded', 'published', 'failed', 'pending', 'unknown'];

/** Each identity has its own atomic storage entry. A stale tab cannot replace
 * another tab's request list. Phase observations are independent append-only
 * keys, so racing tabs cannot overwrite a terminal result with stale state. */
export function loadPublicationRecords(storage: PublicationStorage): PublicationRecord[] {
  const records = new Map(parsePublicationRecords(storage.getItem(PUBLICATION_STORAGE_KEY)).map(record => [record.requestId, record]));
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(PUBLICATION_RECORD_PREFIX)) continue;
    const value = storage.getItem(key);
    const record = parsePublicationRecords(value ? `[${value}]` : null)[0];
    if (record && key === PUBLICATION_RECORD_PREFIX + record.requestId) records.set(record.requestId, record);
  }
  return [...records.values()].filter(record => storage.getItem(PUBLICATION_RECORD_PREFIX + record.requestId + ':dismissed') !== 'true')
    .map(record => ({ ...record, phase: PHASE_PRECEDENCE.find(phase => phase === record.phase
      || storage.getItem(`${PUBLICATION_RECORD_PREFIX}${record.requestId}:phase:${phase}`) === 'true')! }))
    .sort((left, right) => Number(isPublicationPending(right)) - Number(isPublicationPending(left))
    || right.createdAt.localeCompare(left.createdAt) || left.requestId.localeCompare(right.requestId));
}

function writePublicationRecord(storage: PublicationStorage, incoming: PublicationRecord): void {
  const record = parsePublicationRecords(JSON.stringify([incoming]))[0];
  if (!record) throw new Error('发布记录无效。');
  const key = PUBLICATION_RECORD_PREFIX + record.requestId;
  const previousValue = storage.getItem(key);
  const previous = parsePublicationRecords(previousValue ? `[${previousValue}]` : null)[0];
  if (previous && (previous.documentId !== record.documentId || previous.name !== record.name || previous.createdAt !== record.createdAt)) {
    throw new Error('发布请求标识已被使用，请查询原请求。');
  }
  // The identity is written once. Concurrent phase updates have disjoint keys
  // and remain monotone even if their getItem/setItem operations interleave.
  if (!previous) storage.setItem(key, JSON.stringify({ ...record, phase: 'unknown' }));
  storage.setItem(`${key}:phase:${record.phase}`, 'true');
}

export function savePublicationRecords(storage: PublicationStorage, incoming: readonly PublicationRecord[]): PublicationRecord[] {
  // Finish all independent writes before removing the legacy aggregate, so a
  // partial migration preserves every previously saved request identity.
  for (const record of parsePublicationRecords(storage.getItem(PUBLICATION_STORAGE_KEY))) writePublicationRecord(storage, record);
  for (const record of incoming) writePublicationRecord(storage, record);
  storage.removeItem(PUBLICATION_STORAGE_KEY);
  return loadPublicationRecords(storage);
}

export function dismissPublicationRecord(storage: PublicationStorage, requestId: string): PublicationRecord[] {
  const records = savePublicationRecords(storage, []);
  const record = records.find(item => item.requestId === requestId);
  if (!record || isPublicationPending(record)) throw new Error('结果待确认的发布请求不能移除。');
  // A tombstone prevents another open tab's late observation from restoring
  // a record the user already dismissed. Unknown identities cannot be hidden.
  storage.setItem(PUBLICATION_RECORD_PREFIX + requestId + ':dismissed', 'true');
  return loadPublicationRecords(storage);
}

export function publicationPhase(payload: unknown, expectedRequestId: string): PublicationPhase {
  const body = object(payload); const status = object(body.status);
  if (body.success !== true || body.requestId !== expectedRequestId) return 'unknown';
  if (status.currentlyActive === true && status.attemptState === 'published') return 'published';
  if (['failed', 'superseded', 'revoked'].includes(String(status.attemptState))) return status.attemptState as PublicationPhase;
  if (status.queueState === 'queued' || status.attemptState === 'queued' || status.attemptState === 'staging') return 'pending';
  return 'unknown';
}

export function isPublicationPending(record: PublicationRecord): boolean {
  return record.phase === 'pending' || record.phase === 'unknown';
}

export function validatePublicationFile(file: File): void {
  if (!file.size || file.size > PUBLICATION_MAX_BYTES || file.name.length > 200 || /[\\/\u0000-\u001f\u007f]/.test(file.name)
    || !PUBLICATION_ACCEPTED_FILES.split(',').some(extension => file.name.toLowerCase().endsWith(extension))) {
    throw new Error('请选择不超过 2MB 的 PDF、DOCX、XLSX、CSV、Markdown、TXT 或 JSON 文件。');
  }
}

export class PublicationRequestRejectedError extends Error {
  readonly requestId: string;
  constructor(requestId: string, message: string) { super(message); this.name = 'PublicationRequestRejectedError'; this.requestId = requestId; }
}

class PublicationBeforeDispatchError extends PublicationRequestRejectedError {
  constructor(requestId: string, cause: unknown) {
    super(requestId, '文件读取或提交准备已取消，文档尚未发送。请重新选择后提交。');
    this.name = 'PublicationBeforeDispatchError';
    this.cause = cause;
  }
}

async function readPublicationFile(file: File, signal?: AbortSignal): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  if (!signal) return file.arrayBuffer();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([file.arrayBuffer(), new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new DOMException('cancelled', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}

/** The caller saves this identity before dispatch. Retrying only queries its
 * status; it never sends the bytes again after an unknown response. */
export async function submitPublicationFile(file: File, record: PublicationRecord,
  fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<PublicationPhase> {
  if (!UUID.test(record.requestId) || record.documentId !== `upload:${record.requestId}`) throw new Error('发布请求标识无效。');
  let requestBody: string;
  try {
    validatePublicationFile(file);
    const bytes = new Uint8Array(await readPublicationFile(file, signal));
    signal?.throwIfAborted();
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    const contentBase64 = btoa(binary);
    requestBody = JSON.stringify({ requestId: record.requestId, filename: file.name,
      contentType: file.type || 'application/octet-stream', contentBase64 });
    signal?.throwIfAborted();
  } catch (error) {
    // No HTTP operation has been invoked yet. These failures are definite and
    // must not consume unresolved-request capacity as an ambiguous enqueue.
    throw new PublicationBeforeDispatchError(record.requestId, error);
  }
  try {
    const response = await fetcher('/rag-api/documents/publications', { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' }, body: requestBody });
    let body: Record<string, unknown> = {};
    try { body = object(await response.json()); } catch { /* HTTP rejection can still be definite without a JSON body. */ }
    if (response.status === 202 && body.success === true && body.status === 'accepted'
      && body.requestId === record.requestId && body.documentId === record.documentId) return 'pending';
    if (response.status === 409 || body.status === 'unknown') return 'unknown';
    if ([400, 401, 403, 404, 413, 415, 422, 429].includes(response.status)) {
      const error = object(body.error);
      throw new PublicationRequestRejectedError(record.requestId, typeof error.message === 'string' ? error.message : '此请求未受理，请修正后重新提交。');
    }
    return 'unknown';
  } catch (error) {
    // A rejected HTTP response has a definite user-facing message; network,
    // body parsing and cancellation failures cannot prove enqueue did not commit.
    if (error instanceof PublicationRequestRejectedError) throw error;
    return 'unknown';
  }
}

/** Persist the operation and its definite rejection together with the network
 * workflow. Transport errors keep the original identity unresolved. */
export async function submitStoredPublicationFile(file: File, record: PublicationRecord, storage: PublicationStorage,
  fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<{ phase: PublicationPhase; records: PublicationRecord[] }> {
  validatePublicationFile(file);
  signal?.throwIfAborted();
  if (loadPublicationRecords(storage).filter(isPublicationPending).length >= 20) throw new Error('待确认请求较多，请先查询已有发布状态。');
  savePublicationRecords(storage, [{ ...record, phase: 'unknown' }]);
  try {
    const phase = await submitPublicationFile(file, record, fetcher, signal);
    return { phase, records: savePublicationRecords(storage, [{ ...record, phase }]) };
  } catch (error) {
    if (error instanceof PublicationRequestRejectedError) savePublicationRecords(storage, [{ ...record, phase: 'failed' }]);
    throw error;
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

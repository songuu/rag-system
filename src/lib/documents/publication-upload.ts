import { createHash } from 'node:crypto';
import { loadDocument, splitDocument, PIPELINE_WORK_LIMITS } from '../document-pipeline';
import { resolvePublicationEmbedding } from './publication-embedding';
import { createRetrievalScope, stampDocumentScope } from '../security/retrieval-scope';
import type { PostgresQueryClient } from '../postgres/client';
import { enqueuePipelinePublication, PublicationEnqueueUnknownError } from './publication-queue-ingest';
import { PublicationRequestQueue } from './publication-request-queue';

let preparing = false;

/** Prepare and enqueue one small file; never performs a legacy storage write. */
export async function enqueueUploadedPublication(input: Record<string, unknown>,
  context: { tenantId: string; corpusId: string }, client: PostgresQueryClient, signal?: AbortSignal, timeoutMs = 30_000) {
  const invalid = () => Object.assign(new Error('Invalid publication request.'), { status: 400 });
  if (Object.keys(input).some(key => !['filename', 'contentType', 'contentBase64', 'requestId'].includes(key))
    || typeof input.filename !== 'string' || input.filename !== input.filename.trim() || !input.filename
    || input.filename.length > 200 || /[\\/\u0000-\u001f\u007f]/.test(input.filename)
    || !/\.(txt|md|markdown|pdf|docx|xlsx|csv|json)$/i.test(input.filename)
    || typeof input.contentType !== 'string' || !input.contentType.trim() || input.contentType.length > 200
    || typeof input.contentBase64 !== 'string' || input.contentBase64.length > 2_800_000
    || typeof input.requestId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) throw invalid();
  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (!bytes.length || bytes.length > 2 * 1024 * 1024 || bytes.toString('base64') !== input.contentBase64) throw invalid();
  const requestId = input.requestId;
  const filename = input.filename;
  const contentType = input.contentType;
  const documentId = `upload:${requestId}`;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw invalid();
  if (preparing) throw Object.assign(new Error('Publication preparation is busy.'), { status: 429 });
  preparing = true;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => { if (controller.signal.aborted) throw new Error('Publication preparation cancelled.'); };
  const task = (async () => {
  check();
  const previous = await new PublicationRequestQueue(client).state(requestId, { tenantId: context.tenantId, corpusId: context.corpusId, documentId });
  check();
  // The lightweight status query does not prove this new payload matches the
  // stored snapshot. Never report it as accepted or silently reuse the ID.
  if (previous !== 'not_observed') throw Object.assign(new Error('Publication request identity already exists.'),
    { status: 409, requestId, documentId });
  const embedding = await resolvePublicationEmbedding({ signal: controller.signal });
  check();
  const scope = createRetrievalScope({ tenantId: context.tenantId, corpusId: context.corpusId, enforceIsolation: true });
  const metadata = stampDocumentScope({ documentId, document_id: documentId }, scope, 'external');
  const document = await loadDocument(bytes, { filename });
  check();
  const sourceIdentity = document.pdfAssetSource ?? document.content;
  const identityBytes = typeof sourceIdentity === 'string' ? Buffer.from(sourceIdentity, 'utf8') : Buffer.from(sourceIdentity);
  const documentVersion = 'sha256:' + createHash('sha256').update(identityBytes).digest('hex');
  document.metadata = { ...document.metadata, ...metadata, documentVersion, document_version: documentVersion };
  const chunks = await splitDocument(document, { chunkSize: 500, chunkOverlap: 50, maxChunks: PIPELINE_WORK_LIMITS.maxChunksPerDocument });
  check();
  for (const chunk of chunks) {
    const start = chunk.metadata.startOffset;
    const end = chunk.metadata.endOffset;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0
      || (end as number) <= (start as number) || (end as number) > document.content.length
      || document.content.slice(start as number, end as number) !== chunk.content) {
      throw new Error('Publication chunk offsets do not match the parsed source.');
    }
  }
  const vectors = await embedding.embedDocuments(chunks.map(chunk => chunk.embeddingContent ?? chunk.content), controller.signal);
  const documents = chunks.map((chunk, index) => ({ ...chunk, embedding: vectors[index] }));
  check();
  return await enqueuePipelinePublication(requestId, { serverMetadata: metadata, documentId, documentVersion,
    sourceBytes: bytes, sourceIdentityBytes: identityBytes, originalName: filename,
    contentType, sourceKind: document.metadata.type,
    embedding: embedding.config,
    splitter: { name: 'recursive-character', revision: 'pipeline/v1', chunkSize: 500, chunkOverlap: 50 }, documents,
  }, client, controller.signal);
  })();
  // Promise.race cannot cancel parsers or database calls. Keep the single
  // preparation slot until all underlying work actually settles.
  void task.then(() => { preparing = false; }, () => { preparing = false; });
  try {
    const cancelled = new Promise<never>((_, reject) => {
      const abort = () => reject(new PublicationEnqueueUnknownError(requestId));
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) abort();
      timer = setTimeout(() => controller.abort(), timeoutMs);
    });
    return await Promise.race([task, cancelled]);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

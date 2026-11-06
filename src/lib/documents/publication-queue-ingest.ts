import type { PostgresQueryClient } from '../postgres/client';
import { preparePipelinePublication, type PipelinePublicationInput } from './publication-ingest';
import { PublicationRequestQueue } from './publication-request-queue';

export class PublicationEnqueueUnknownError extends Error {
  readonly code = 'PUBLICATION_ENQUEUE_UNKNOWN';
  readonly requestId: string;
  constructor(requestId: string, cause?: unknown) {
    super('Publication enqueue outcome is unknown; inspect the original request before retrying.', { cause });
    this.name = 'PublicationEnqueueUnknownError';
    this.requestId = requestId;
  }
}

/**
 * Server-only preparation. Call after authorizing the user and corpus, with
 * an idempotency ID retained by the caller before any database request.
 * Acceptance is not evidence of publication or permission to read a result.
 * This adapter is not wired to the upload route while the publisher is gated.
 */
export async function enqueuePipelinePublication(requestId: string, input: PipelinePublicationInput,
  client: PostgresQueryClient, signal?: AbortSignal, timeoutMs = 30_000): Promise<{
    status: 'accepted'; requestId: string; tenantId: string; corpusId: string; documentId: string; contentVersion: string;
  }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new Error('Invalid publication request identity.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid publication enqueue timeout.');
  if (signal?.aborted) throw new Error('Publication enqueue cancelled.');
  const asset = preparePipelinePublication(input);
  if (signal?.aborted) throw new Error('Publication enqueue cancelled.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const cancellation = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Publication enqueue timed out.')), timeoutMs);
      if (signal) {
        onAbort = () => reject(new Error('Publication enqueue cancelled after dispatch.'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
    });
    await Promise.race([new PublicationRequestQueue(client).enqueue(requestId, asset), cancellation]);
    // The database operation cannot be assumed cancelled by an AbortSignal.
    if (signal?.aborted) throw new Error('Publication enqueue cancelled after dispatch.');
  } catch (error) {
    throw new PublicationEnqueueUnknownError(requestId, error);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
  return { status: 'accepted', requestId, tenantId: asset.tenantId, corpusId: asset.corpusId,
    documentId: asset.documentId, contentVersion: asset.contentVersion };
}

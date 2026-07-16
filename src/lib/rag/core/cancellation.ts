/** Stable, content-free cancellation error used at every RAG execution boundary. */
export class RagRequestAbortedError extends Error {
  readonly code = 'RAG_REQUEST_ABORTED';

  constructor() {
    super('RAG request execution was cancelled.');
    this.name = 'RagRequestAbortedError';
  }
}

export function throwIfRagRequestAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new RagRequestAbortedError();
  }
}

import type { RagKernelEnvelope } from './types';

export interface RagHeaderWriter {
  set(name: string, value: string): void;
}

export function attachRagKernelHeaders(
  headers: RagHeaderWriter,
  envelope: RagKernelEnvelope
): void {
  headers.set('x-rag-policy', envelope.policy_id);
  headers.set('x-rag-trace-id', envelope.trace_id);
  headers.set('x-rag-status', envelope.status);
}

export function assertRagResponseTrace(
  bodyTraceId: unknown,
  expected: RagKernelEnvelope | string
): void {
  const expectedTraceId =
    typeof expected === 'string' ? expected : expected.trace_id;
  if (
    typeof bodyTraceId !== 'string' ||
    bodyTraceId !== expectedTraceId
  ) {
    throw new Error(
      'RAG response body traceId must match the kernel envelope trace_id.'
    );
  }
}

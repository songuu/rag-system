import type { NextRequest } from 'next/server';
import { REQUEST_LIMITS, readJsonObjectWithLimit, validateAskInput } from '@/lib/security/request-validation';
import type { ValidatedAskInput } from '@/lib/security/request-validation';
import { resolveRagSecurityContext } from '@/lib/security/request-context';
import type { RagSecurityContext } from '@/lib/security/request-context';
import { throwIfRagRequestAborted } from '@/lib/rag/core/cancellation';

export interface PreparedAskRequest {
  requestId: string;
  body: Record<string, unknown>;
  input: ValidatedAskInput;
  securityContext: RagSecurityContext;
}

export function resolveAskRequestId(request: NextRequest): string {
  const supplied = request.headers.get('x-request-id')?.trim();
  return supplied && supplied.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(supplied)
    ? supplied : crypto.randomUUID();
}

export async function prepareAskRequest(request: NextRequest, requestId: string): Promise<PreparedAskRequest> {
  throwIfRagRequestAborted(request.signal);
  const body = await readJsonObjectWithLimit(request, REQUEST_LIMITS.askJsonBytes);
  throwIfRagRequestAborted(request.signal);
  const input = validateAskInput(body);
  const securityContext = await resolveRagSecurityContext(request, {
    capability: input.executionMode === 'durable' ? 'manage-runtime' : 'query',
    requestedCorpusId: input.requestedCorpusId,
    requestIdFactory: () => requestId,
  });
  throwIfRagRequestAborted(request.signal);
  return { requestId, body, input, securityContext };
}

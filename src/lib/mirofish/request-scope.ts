import { resolveRagSecurityContext, type RagCapability, type RagSecurityRequest } from '../security/request-context';
import { getProjectStore, type MiroFishProjectStore } from './project-store';
import type { MiroFishReportScope } from './report-contracts';

export async function resolveMiroFishRequestScope(request: RagSecurityRequest, capability: RagCapability = 'query') {
  const context = await resolveRagSecurityContext(request, {
    capability, requestedCorpusId: request.headers.get('x-rag-corpus-id')?.trim() || undefined,
  });
  return { scope: { tenantId: context.tenantId, corpusId: context.corpusId }, actorId: context.actorId, requestId: context.requestId };
}
/** A requested corpus must never be served a project from the default PostgreSQL scope. */
export function getScopedMiroFishProjectStore(scope?: MiroFishReportScope): MiroFishProjectStore {
  return getProjectStore(scope);
}

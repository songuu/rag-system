import { RagSecurityError, type RagSecurityContext } from '../../security/request-context';
import { readJsonObjectWithLimit, RequestValidationError } from '../../security/request-validation';
import { CitationError, citationPartition } from './locator-codec';
import type { RagCitationPreview } from './types';

export function createCitationPreviewHandlers(dependencies: {
  resolveSecurity(request: Request): Promise<RagSecurityContext>;
  preview(input: { locator: string; security: RagSecurityContext; signal: AbortSignal }): Promise<RagCitationPreview>;
  clock?: () => number;
}) {
  return {
    async GET(request: Request): Promise<Response> {
      try {
        const security = await dependencies.resolveSecurity(request);
        return json({ success: true, partition: citationPartition(security), now: (dependencies.clock ?? Date.now)() });
      } catch (error) { return failure(error); }
    },
    async POST(request: Request): Promise<Response> {
      try {
        const security = await dependencies.resolveSecurity(request);
        const body = await readJsonObjectWithLimit(request, 10 * 1024);
        if (Object.keys(body).length !== 1 || typeof body.locator !== 'string' || body.locator.length < 1 || body.locator.length > 8192) throw new RequestValidationError('RAG_CITATION_REQUEST_INVALID', 'A single opaque citation locator is required.');
        return json(await dependencies.preview({ locator: body.locator, security, signal: request.signal }));
      } catch (error) { return failure(error); }
    },
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', Pragma: 'no-cache', Vary: 'Authorization', 'X-Content-Type-Options': 'nosniff' } });
}
function failure(error: unknown): Response {
  if (error instanceof RagSecurityError) return json({ success: false, ...error.toResponseBody() }, error.status);
  if (error instanceof CitationError || error instanceof RequestValidationError) return json({ success: false, error: { code: error.code, message: error.message } }, error.status);
  const unavailable = new CitationError('RAG_CITATION_UNAVAILABLE', 503);
  return json({ success: false, error: { code: unavailable.code, message: unavailable.message } }, unavailable.status);
}

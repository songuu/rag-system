import {
  boundedInteger,
  knowledgeGraphJsonResponse,
  knowledgeGraphHttpError,
  projectKnowledgeGraphPathResultsForHttp,
  requireKnowledgeGraphQueryPort,
  requiredString,
  resolveActiveGraphVersion,
  resolveKnowledgeGraphHttpContext,
  withKnowledgeGraphQueryAdmission,
} from '@/lib/knowledge-graph/http';
import { readJsonObjectWithLimit } from '@/lib/security/request-validation';

export async function POST(request: Request) {
  let requestId: string | undefined;
  try {
    const context = await resolveKnowledgeGraphHttpContext(request, 'query');
    requestId = context.security.requestId;
    const body = await readJsonObjectWithLimit(request, 16 * 1024);
    const result = await withKnowledgeGraphQueryAdmission(context, async () => {
      const graphVersion = await resolveActiveGraphVersion(context);
      const data = projectKnowledgeGraphPathResultsForHttp(
        await requireKnowledgeGraphQueryPort(context.runtime).findPaths({
        scope: context.scope,
        graphVersion,
        sourceEntityId: requiredString(body.sourceEntityId, 'sourceEntityId'),
        targetEntityId: requiredString(body.targetEntityId, 'targetEntityId'),
        maxHops: boundedInteger(body.maxHops, 'maxHops', 2, 1, 2) as 1 | 2,
        limit: boundedInteger(body.limit, 'limit', 25, 1, 100),
        signal: request.signal,
        })
      );
      return { data, graphVersion };
    });
    return knowledgeGraphJsonResponse({
      success: true,
      data: result.data.data,
      truncated: result.data.truncated,
      graphVersion: result.graphVersion,
      requestId,
    }, requestId);
  } catch (error) {
    return knowledgeGraphHttpError(error, requestId);
  }
}

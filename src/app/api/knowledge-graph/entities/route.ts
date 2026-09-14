import {
  boundedInteger,
  knowledgeGraphJsonResponse,
  knowledgeGraphHttpError,
  projectKnowledgeGraphEntityResultsForHttp,
  projectKnowledgeGraphPathResultsForHttp,
  requireKnowledgeGraphQueryPort,
  requiredString,
  resolveActiveGraphVersion,
  resolveKnowledgeGraphHttpContext,
  withKnowledgeGraphQueryAdmission,
} from '@/lib/knowledge-graph/http';

export async function GET(request: Request) {
  let requestId: string | undefined;
  try {
    const context = await resolveKnowledgeGraphHttpContext(request, 'query');
    requestId = context.security.requestId;
    const url = new URL(request.url);
    const entityId = url.searchParams.get('entityId')?.trim();
    const limit = boundedInteger(url.searchParams.get('limit'), 'limit', 25, 1, 100);
    const result = await withKnowledgeGraphQueryAdmission(context, async () => {
      const queryPort = requireKnowledgeGraphQueryPort(context.runtime);
      const graphVersion = await resolveActiveGraphVersion(context);
      const data = entityId ? projectKnowledgeGraphPathResultsForHttp(await queryPort.getNeighbors({
          scope: context.scope,
          graphVersion,
          entityId: requiredString(entityId, 'entityId'),
          maxHops: boundedInteger(url.searchParams.get('maxHops'), 'maxHops', 1, 1, 2) as 1 | 2,
          limit,
          signal: request.signal,
        })) : projectKnowledgeGraphEntityResultsForHttp(await queryPort.searchEntities({
          scope: context.scope,
          graphVersion,
          query: requiredString(url.searchParams.get('q'), 'q', 8_000),
          limit,
          signal: request.signal,
        }));
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

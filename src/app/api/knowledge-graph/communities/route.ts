import {
  boundedInteger,
  knowledgeGraphJsonResponse,
  knowledgeGraphHttpError,
  projectKnowledgeGraphCommunityResultsForHttp,
  requireKnowledgeGraphQueryPort,
  requiredString,
  resolveActiveGraphVersion,
  resolveKnowledgeGraphHttpContext,
  withKnowledgeGraphQueryAdmission,
} from '@/lib/knowledge-graph/http';

export async function GET(request: Request) {
  let requestId: string | undefined;
  try {
    const url = new URL(request.url);
    const query = requiredString(url.searchParams.get('q'), 'q', 8_000);
    const context = await resolveKnowledgeGraphHttpContext(request, 'query');
    requestId = context.security.requestId;
    const result = await withKnowledgeGraphQueryAdmission(context, async () => {
      const graphVersion = await resolveActiveGraphVersion(context);
      const data = projectKnowledgeGraphCommunityResultsForHttp(
        await requireKnowledgeGraphQueryPort(context.runtime).searchCommunities({
        scope: context.scope,
        graphVersion,
        query,
        limit: boundedInteger(url.searchParams.get('limit'), 'limit', 25, 1, 100),
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

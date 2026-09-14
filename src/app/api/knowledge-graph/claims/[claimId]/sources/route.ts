import { NextResponse } from 'next/server';
import {
  boundedInteger,
  knowledgeGraphHttpError,
  projectClaimSourcesForHttp,
  requireKnowledgeGraphQueryPort,
  requiredString,
  resolveActiveGraphVersion,
  resolveKnowledgeGraphHttpContext,
  withKnowledgeGraphQueryAdmission,
} from '@/lib/knowledge-graph/http';
import { KnowledgeGraphError } from '@/lib/knowledge-graph/contracts';

type RouteContext = { params: Promise<{ claimId: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  let requestId: string | undefined;
  try {
    const { claimId } = await params;
    const url = new URL(request.url);
    const validatedClaimId = requiredString(claimId, 'claimId');
    const limit = boundedInteger(url.searchParams.get('limit'), 'limit', 10, 1, 10);
    const context = await resolveKnowledgeGraphHttpContext(request, 'query');
    requestId = context.security.requestId;
    const result = await withKnowledgeGraphQueryAdmission(context, async () => {
      const graphVersion = await resolveActiveGraphVersion(context);
      const data = await requireKnowledgeGraphQueryPort(context.runtime).getClaimSources({
        scope: context.scope,
        graphVersion,
        claimId: validatedClaimId,
        limit: limit + 1,
        signal: request.signal,
      });
      return { data, graphVersion };
    });
    if (!result.data) {
      throw new KnowledgeGraphError(
        'KNOWLEDGE_GRAPH_NOT_FOUND',
        'The requested claim has no accessible source passages.'
      );
    }
    return NextResponse.json({
      success: true,
      ...result,
      data: projectClaimSourcesForHttp(result.data, { limit }),
      requestId,
    });
  } catch (error) {
    return knowledgeGraphHttpError(error, requestId);
  }
}

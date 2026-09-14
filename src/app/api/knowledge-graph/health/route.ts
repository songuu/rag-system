import { NextResponse } from 'next/server';
import { getNeo4jRuntimeConfig, getNeo4jConfigSummary } from '@/lib/neo4j/config';
import { checkNeo4jHealth } from '@/lib/neo4j/driver';
import { canRagRole, resolveRagSecurityContext } from '@/lib/security/request-context';
import {
  acquireKnowledgeGraphQueryPermit,
  knowledgeGraphHttpError,
} from '@/lib/knowledge-graph/http';

export async function GET(request: Request) {
  let requestId: string | undefined;
  try {
    const security = await resolveRagSecurityContext(request, { capability: 'query' });
    requestId = security.requestId;
    const managementEnabled = process.env.NODE_ENV !== 'production'
      && security.accessMode === 'local-dev'
      && canRagRole(security.role, 'manage-runtime');
    const release = acquireKnowledgeGraphQueryPermit(security);
    try {
    const backend = process.env.RAG_GRAPH_BACKEND?.trim().toLowerCase() || 'file';
    if (backend !== 'neo4j') {
      return NextResponse.json({
        success: true,
        status: 'disabled',
        backend: 'file',
        managementEnabled,
        requestId,
        timestamp: new Date().toISOString(),
      });
    }
    const config = getNeo4jRuntimeConfig();
    const health = await checkNeo4jHealth(config);
    return NextResponse.json({
      success: health.connected,
      status: health.connected ? 'ready' : 'not_ready',
      backend: 'neo4j',
      managementEnabled,
      neo4j: {
        ...getNeo4jConfigSummary(config),
        connected: health.connected,
        database: health.database,
        ...(health.errorCode ? { errorCode: health.errorCode } : {}),
      },
      requestId,
      timestamp: new Date().toISOString(),
    }, { status: health.connected ? 200 : 503 });
    } finally {
      release();
    }
  } catch (error) {
    return knowledgeGraphHttpError(error, requestId);
  }
}

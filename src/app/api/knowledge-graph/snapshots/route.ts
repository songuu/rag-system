import { NextResponse } from 'next/server';
import {
  boundedInteger,
  knowledgeGraphHttpError,
  requiredString,
  requiredTrustLevel,
  resolveKnowledgeGraphHttpContext,
  withKnowledgeGraphQueryAdmission,
} from '@/lib/knowledge-graph/http';
import {
  readJsonObjectWithLimit,
  RequestValidationError,
} from '@/lib/security/request-validation';
import { getGraphQueryAuthorityClient, readGraphQueryAuthority, readGraphQueryAuthorities, withAuthorizedGraphSnapshots } from '@/lib/knowledge-graph/query-authority';
import { createMiroFishGraphVersion } from '@/lib/knowledge-graph/mirofish-adapter';
import { KnowledgeGraphError } from '@/lib/knowledge-graph/contracts';

const BODY_LIMIT = 16 * 1024;

export async function GET(request: Request) {
  let requestId: string | undefined;
  try {
    const context = await resolveKnowledgeGraphHttpContext(request, 'query');
    requestId = context.security.requestId;
    const url = new URL(request.url);
    const limit = boundedInteger(url.searchParams.get('limit'), 'limit', 50, 1, 100);
    const filtered = url.searchParams.has('documentId') || url.searchParams.has('documentVersion') || url.searchParams.has('trustLevel');
    const documentFilter = filtered ? {
      documentId: requiredString(url.searchParams.get('documentId'), 'documentId'),
      documentVersion: requiredString(url.searchParams.get('documentVersion'), 'documentVersion'),
      trustLevel: requiredTrustLevel(url.searchParams.get('trustLevel')),
    } : {};
    const listOptions = { ...documentFilter, limit: filtered ? 1000 : limit };
    const { snapshots, active } = await withKnowledgeGraphQueryAdmission(context, async () => {
      if (context.runtime.backend === 'file') {
        const [snapshots, active] = await Promise.all([
          context.runtime.store.list(context.scope, listOptions),
          context.runtime.store.getActive(context.scope),
        ]);
        return { snapshots, active };
      }
      const client = getGraphQueryAuthorityClient();
      if (!filtered) return withAuthorizedGraphSnapshots(context.scope, {
        list: () => context.runtime.store.list(context.scope, listOptions),
        getActive: () => context.runtime.store.getActive(context.scope),
        readAuthorities: identities => readGraphQueryAuthorities(client, context.scope, identities),
      });
      const snapshots = [];
      let after: { createdAt: string; graphVersion: string } | undefined;
      let scanned = 0;
      let active: Awaited<ReturnType<typeof context.runtime.store.getActive>> | undefined;
      for (;;) {
        const candidates = await context.runtime.store.list(context.scope, { ...listOptions, after });
        const page = await withAuthorizedGraphSnapshots(context.scope, {
          list: async () => candidates,
          getActive: () => context.runtime.store.getActive(context.scope),
          readAuthorities: identities => readGraphQueryAuthorities(client, context.scope, identities),
        });
        if (active && active.revision !== page.active.revision) throw new KnowledgeGraphError('KNOWLEDGE_GRAPH_CONFLICT', 'Graph source changed during the query. Retry the request.');
        active = page.active;
        snapshots.push(...page.snapshots);
        if (snapshots.length >= limit || candidates.length < 1000) break;
        const last = candidates[candidates.length - 1];
        after = { createdAt: last.createdAt, graphVersion: createMiroFishGraphVersion(last.identity) };
        scanned += candidates.length;
        if (scanned >= 100_000) throw new KnowledgeGraphError('KNOWLEDGE_GRAPH_CAPACITY', 'Graph snapshot scan limit reached. Remove obsolete snapshots and retry.');
      }
      return { snapshots, active: active! };
    });
    return NextResponse.json({
      success: true,
      data: { snapshots: snapshots.slice(0, limit), active, backend: context.runtime.backend },
      requestId,
    });
  } catch (error) {
    return knowledgeGraphHttpError(error, requestId);
  }
}

export async function POST(request: Request) {
  let requestId: string | undefined;
  try {
    const context = await resolveKnowledgeGraphHttpContext(
      request,
      'manage-runtime',
      { management: true }
    );
    requestId = context.security.requestId;
    const body = await readJsonObjectWithLimit(request, BODY_LIMIT);
    const action = requiredString(body.action, 'action', 32);
    const expectedRevision = boundedInteger(
      body.expectedRevision,
      'expectedRevision',
      0,
      0,
      Number.MAX_SAFE_INTEGER
    );
    if (action === 'deactivate') {
      const active = await context.runtime.store.compareAndSetActive(
        context.scope,
        null,
        expectedRevision
      );
      return NextResponse.json({ success: true, data: active, requestId });
    }
    if (action !== 'activate') {
      throw new RequestValidationError(
        'INVALID_ACTION',
        'action must be activate or deactivate.'
      );
    }
    const identity = {
      tenantId: context.security.tenantId,
      corpusId: context.security.corpusId,
      documentId: requiredString(body.documentId, 'documentId'),
      documentVersion: requiredString(body.documentVersion, 'documentVersion'),
      trustLevel: requiredTrustLevel(body.trustLevel),
      ...(body.graphGeneration === undefined ? {} : { graphGeneration: requiredString(body.graphGeneration, 'graphGeneration', 36) }),
    };
    if (context.runtime.backend === 'neo4j' && identity.graphGeneration) {
      const authority = await readGraphQueryAuthority(getGraphQueryAuthorityClient(), context.scope, identity, createMiroFishGraphVersion(identity));
      if (!authority) throw new KnowledgeGraphError('KNOWLEDGE_GRAPH_NOT_FOUND', 'Graph generation is not validated or no longer available.');
    }
    const active = await context.runtime.store.compareAndSetActive(
      context.scope,
      identity,
      expectedRevision
    );
    return NextResponse.json({ success: true, data: active, requestId });
  } catch (error) {
    return knowledgeGraphHttpError(error, requestId);
  }
}

export async function DELETE(request: Request) {
  let requestId: string | undefined;
  try {
    const context = await resolveKnowledgeGraphHttpContext(
      request,
      'manage-runtime',
      { management: true }
    );
    requestId = context.security.requestId;
    const url = new URL(request.url);
    const deleted = await context.runtime.store.delete({
      tenantId: context.security.tenantId,
      corpusId: context.security.corpusId,
      documentId: requiredString(url.searchParams.get('documentId'), 'documentId'),
      documentVersion: requiredString(
        url.searchParams.get('documentVersion'),
        'documentVersion'
      ),
      trustLevel: requiredTrustLevel(url.searchParams.get('trustLevel')),
      ...(url.searchParams.has('graphGeneration') ? { graphGeneration: requiredString(url.searchParams.get('graphGeneration'), 'graphGeneration', 36) } : {}),
    }, context.scope);
    return NextResponse.json({ success: true, data: { deleted }, requestId });
  } catch (error) {
    return knowledgeGraphHttpError(error, requestId);
  }
}

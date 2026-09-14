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

const BODY_LIMIT = 16 * 1024;

export async function GET(request: Request) {
  let requestId: string | undefined;
  try {
    const context = await resolveKnowledgeGraphHttpContext(request, 'query');
    requestId = context.security.requestId;
    const url = new URL(request.url);
    const limit = boundedInteger(url.searchParams.get('limit'), 'limit', 50, 1, 100);
    const [snapshots, active] = await withKnowledgeGraphQueryAdmission(
      context,
      () => Promise.all([
        context.runtime.store.list(context.scope, { limit }),
        context.runtime.store.getActive(context.scope),
      ])
    );
    return NextResponse.json({
      success: true,
      data: { snapshots, active, backend: context.runtime.backend },
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
    };
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
    }, context.scope);
    return NextResponse.json({ success: true, data: { deleted }, requestId });
  } catch (error) {
    return knowledgeGraphHttpError(error, requestId);
  }
}

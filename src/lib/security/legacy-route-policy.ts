export interface LegacyRagRouteBlock {
  status: 410;
  code: 'LEGACY_RAG_ROUTE_DISABLED';
  message: string;
}

/**
 * Legacy routes do not carry the canonical tenant/corpus scope. They remain
 * available only for the unauthenticated local demo and are fail-closed
 * everywhere else.
 */
export function getLegacyRagRouteBlock(
  env: NodeJS.ProcessEnv = process.env
): LegacyRagRouteBlock | null {
  const accessMode = (env.RAG_ACCESS_MODE || env.RAG_AUTH_MODE || 'local-dev')
    .trim()
    .toLowerCase();
  if (env.NODE_ENV !== 'production' && accessMode === 'local-dev') {
    return null;
  }
  return {
    status: 410,
    code: 'LEGACY_RAG_ROUTE_DISABLED',
    message: 'This legacy RAG route is disabled outside local development.',
  };
}

export function createLegacyRagRouteResponse(
  env: NodeJS.ProcessEnv = process.env
): Response | null {
  const block = getLegacyRagRouteBlock(env);
  if (!block) return null;
  return Response.json(
    { success: false, error: block.message, code: block.code },
    { status: block.status }
  );
}

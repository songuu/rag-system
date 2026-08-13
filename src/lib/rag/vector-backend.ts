export type RagVectorBackend =
  | 'milvus'
  | 'zilliz'
  | 'hybrid'
  | 'disabled';

export const VECTOR_BACKEND_DISABLED_CODE = 'VECTOR_BACKEND_DISABLED';
export const VECTOR_BACKEND_DISABLED_MESSAGE =
  'Knowledge-base retrieval is temporarily disabled for maintenance.';

/**
 * `disabled` is an explicit maintenance state, not a fallback. It prevents
 * requests from silently switching to an unscoped in-memory corpus when the
 * production vector service is unavailable.
 */
export function resolveRagVectorBackend(
  value: string | undefined = process.env.RAG_VECTOR_BACKEND
): RagVectorBackend {
  switch (value?.trim().toLowerCase()) {
    case 'zilliz':
      return 'zilliz';
    case 'postgres_pgvector':
    case 'postgres-pgvector':
    case 'pgvector':
      throw new Error(
        'RAG_VECTOR_BACKEND=postgres_pgvector is not implemented; use milvus or zilliz.'
      );
    case 'hybrid':
      return 'hybrid';
    case 'disabled':
    case 'off':
      return 'disabled';
    case 'milvus':
    default:
      return 'milvus';
  }
}

export function isVectorBackendDisabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return resolveRagVectorBackend(env.RAG_VECTOR_BACKEND) === 'disabled';
}

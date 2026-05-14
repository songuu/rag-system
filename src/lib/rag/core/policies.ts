import type {
  RagPolicy,
  RagPolicyContext,
  RagPolicyId,
  RagPolicyResult,
  RagQueryRequest,
} from './types';

export function createRagPolicy<TOutput>(input: {
  id: RagPolicyId;
  description: string;
  execute: (context: RagPolicyContext) => Promise<RagPolicyResult<TOutput> | TOutput>;
}): RagPolicy<TOutput> {
  return {
    id: input.id,
    description: input.description,
    async execute(context) {
      const result = await input.execute(context);
      if (isPolicyResult<TOutput>(result)) {
        return result;
      }
      return { output: result };
    },
  };
}

export function resolveRagPolicyId(request: RagQueryRequest): RagPolicyId {
  if (request.storageBackend === 'milvus' && request.useAdaptiveEntityRAG) {
    return 'adaptive-entity';
  }

  if (request.storageBackend === 'milvus' && request.useAgenticRAG) {
    return 'agentic';
  }

  if (request.storageBackend === 'milvus') {
    return 'milvus-2step';
  }

  return 'memory';
}

function isPolicyResult<TOutput>(value: unknown): value is RagPolicyResult<TOutput> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'output' in value
  );
}


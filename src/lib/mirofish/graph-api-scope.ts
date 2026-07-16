import type { RagSecurityContext } from '../security/request-context';
import type { TaskInfo } from './types';

export const MIROFISH_GRAPH_TASK_SCOPE_KEY = 'ragScope';

export interface MiroFishGraphTaskScope {
  tenantId: string;
  corpusId: string;
  actorId: string;
}

type GraphScopeContext = Pick<
  RagSecurityContext,
  'tenantId' | 'corpusId' | 'actorId' | 'enforceIsolation'
>;

/**
 * Bind graph work to the authenticated corpus while retaining the creator for audit.
 * Actor identity is deliberately not an ownership boundary: members of the same
 * tenant/corpus share corpus resources according to their capability.
 */
export function createMiroFishGraphTaskScope(
  context: GraphScopeContext
): MiroFishGraphTaskScope {
  return {
    tenantId: context.tenantId,
    corpusId: context.corpusId,
    actorId: context.actorId,
  };
}

export function createMiroFishGraphTaskScopeMetadata(
  context: GraphScopeContext
): Record<typeof MIROFISH_GRAPH_TASK_SCOPE_KEY, MiroFishGraphTaskScope> {
  return {
    [MIROFISH_GRAPH_TASK_SCOPE_KEY]: createMiroFishGraphTaskScope(context),
  };
}

/**
 * Fail closed for malformed scope stamps. Truly legacy tasks remain visible only
 * in local-dev compatibility mode where downstream isolation is disabled.
 */
export function isMiroFishGraphTaskInScope(
  task: TaskInfo,
  context: GraphScopeContext
): boolean {
  const scope = readMiroFishGraphTaskScope(task);
  if (scope === undefined) return !context.enforceIsolation;
  if (scope === null) return false;
  return scope.tenantId === context.tenantId && scope.corpusId === context.corpusId;
}

export function filterMiroFishGraphTasksByScope(
  tasks: readonly TaskInfo[],
  context: GraphScopeContext
): TaskInfo[] {
  return tasks.filter(task => isMiroFishGraphTaskInScope(task, context));
}

/** undefined means legacy/unscoped; null means a present but malformed stamp. */
export function readMiroFishGraphTaskScope(
  task: TaskInfo
): MiroFishGraphTaskScope | null | undefined {
  if (
    !task.metadata
    || !Object.prototype.hasOwnProperty.call(task.metadata, MIROFISH_GRAPH_TASK_SCOPE_KEY)
  ) {
    return undefined;
  }

  const candidate = task.metadata[MIROFISH_GRAPH_TASK_SCOPE_KEY];
  if (!isRecord(candidate)) return null;

  const tenantId = readNonEmptyString(candidate.tenantId);
  const corpusId = readNonEmptyString(candidate.corpusId);
  const actorId = readNonEmptyString(candidate.actorId);
  if (!tenantId || !corpusId || !actorId) return null;

  return { tenantId, corpusId, actorId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

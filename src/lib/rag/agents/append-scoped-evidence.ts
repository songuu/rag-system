import type { RagRetrievalScope } from '../../security/retrieval-scope';
import {
  composeEvidenceContextV2,
  estimateEvidenceContextTokens,
  renderCanonicalEvidenceContext,
  type ComposedEvidenceContextV2,
} from '../core/context-composer';
import type { RagEvidence, RagStopReason } from '../core/types';

export class ScopedEvidenceValidationError extends Error {
  readonly code = 'RAG_EVIDENCE_SCOPE_VIOLATION';
  constructor(message: string) {
    super(message);
    this.name = 'ScopedEvidenceValidationError';
  }
}

export function snapshotScopedRetrievalContext(
  contextPack: ComposedEvidenceContextV2,
  scope: RagRetrievalScope
): { contextPack: ComposedEvidenceContextV2; scope: RagRetrievalScope } {
  return freezeDeep(structuredClone({ contextPack, scope }));
}

export function resolveScopedEvidenceBudget(input: { maxContextTokens: number; maxEvidence: number }) {
  if (!Number.isSafeInteger(input.maxContextTokens) || input.maxContextTokens < 1
    || !Number.isSafeInteger(input.maxEvidence) || input.maxEvidence < 1) {
    throw new Error('Scoped retrieval context and evidence budgets must be positive safe integers.');
  }
  return {
    maxContextTokens: Math.min(input.maxContextTokens, 4000),
    maxEvidence: Math.min(input.maxEvidence, 40),
  };
}

export function appendScopedEvidence(input: {
  contextPack: ComposedEvidenceContextV2;
  evidence: readonly RagEvidence[];
  scope: RagRetrievalScope;
  maxContextTokens: number;
  maxEvidence: number;
}): { contextPack: ComposedEvidenceContextV2; addedEvidenceIds: string[]; stopReason: RagStopReason } {
  const budget = resolveScopedEvidenceBudget(input);
  const initial = input.contextPack;
  if (renderCanonicalEvidenceContext(initial.includedEvidence) !== initial.context
    || initial.includedEvidenceIds.length !== initial.includedEvidence.length
    || initial.includedEvidence.some((item, index) => item.id !== initial.includedEvidenceIds[index])) {
    throw new ScopedEvidenceValidationError('Scoped evidence canonical snapshot identity mismatch.');
  }
  if (estimateEvidenceContextTokens(initial.context) > budget.maxContextTokens
    || initial.includedEvidence.length > budget.maxEvidence) {
    throw new Error('Initial scoped evidence snapshot exceeds the configured context budget.');
  }
  const known = new Map<string, RagEvidence>();
  for (const item of initial.includedEvidence) {
    assertEvidenceScope(item, input.scope);
    if (known.has(item.id)) throw new ScopedEvidenceValidationError('Scoped evidence IDs must be unique.');
    known.set(item.id, item);
  }
  const additions: RagEvidence[] = [];
  // Validate the entire provider result before applying budgets: overflow rows
  // must not be able to hide a conflicting identity or cross-scope evidence.
  for (const item of structuredClone(input.evidence)) {
    assertEvidenceScope(item, input.scope);
    const previous = known.get(item.id);
    if (previous) {
      assertSameEvidenceIdentity(previous, item);
      continue;
    }
    known.set(item.id, item);
    additions.push(item);
  }
  if (!additions.length) {
    return { contextPack: initial, addedEvidenceIds: [], stopReason: 'no_gain' };
  }
  const room = Math.max(0, budget.maxEvidence - initial.includedEvidence.length);
  const composed = composeEvidenceContextV2([
    ...initial.includedEvidence,
    ...additions.slice(0, room),
  ], {
    maxTokens: budget.maxContextTokens,
    // Appending must preserve the established citation order, including a
    // document-ordered or previously truncated initial snapshot.
    order: 'retrieval',
  });
  if (!composed.context.startsWith(initial.context)
    || initial.includedEvidence.some((item, index) =>
      composed.includedEvidence[index]?.id !== item.id
      || composed.includedEvidence[index]?.content !== item.content)) {
    throw new ScopedEvidenceValidationError('Scoped evidence append attempted to rewrite the initial snapshot.');
  }
  const includedIds = new Set(composed.includedEvidenceIds);
  const addedEvidenceIds = composed.includedEvidenceIds.slice(initial.includedEvidence.length);
  const budgetReached = additions.length > room || composed.truncated
    || composed.includedEvidence.length >= budget.maxEvidence
    || composed.tokenEstimate >= budget.maxContextTokens;
  const contextPack = freezeDeep({
    ...composed,
    truncated: initial.truncated || composed.truncated || additions.length > room,
    excludedEvidenceIds: [...new Set([
      ...initial.excludedEvidenceIds,
      ...additions.map(item => item.id),
    ])].filter(id => !includedIds.has(id)),
  });
  return {
    contextPack,
    addedEvidenceIds,
    stopReason: budgetReached ? 'budget' : addedEvidenceIds.length ? 'sufficient' : 'no_gain',
  };
}

function assertEvidenceScope(item: RagEvidence, scope: RagRetrievalScope): void {
  if (!item || typeof item !== 'object'
    || ['id', 'content', 'tenantId', 'corpusId', 'documentId', 'documentVersion', 'laneId']
      .some(key => typeof item[key as keyof RagEvidence] !== 'string'
        || !(item[key as keyof RagEvidence] as string).trim())) {
    throw new ScopedEvidenceValidationError('Scoped evidence requires complete identity and nonempty content.');
  }
  if (item.trustLevel === 'quarantined' || !scope.allowedTrustLevels.includes(item.trustLevel)
    || (scope.enforceIsolation && (item.tenantId !== scope.tenantId || item.corpusId !== scope.corpusId))) {
    throw new ScopedEvidenceValidationError('Scoped evidence is outside the immutable retrieval scope.');
  }
  if ([item.retrievalScore, item.rerankScore, item.score].some(value =>
    value !== undefined && (typeof value !== 'number' || !Number.isFinite(value)))) {
    throw new ScopedEvidenceValidationError('Scoped evidence contains an invalid retrieval score.');
  }
}

function assertSameEvidenceIdentity(previous: RagEvidence, candidate: RagEvidence): void {
  const fields = [
    'tenantId', 'corpusId', 'documentId', 'documentVersion', 'content',
    'source', 'page', 'startOffset', 'endOffset', 'trustLevel',
  ] as const;
  if (fields.some(field => previous[field] !== candidate[field])
    || JSON.stringify(previous.sectionPath ?? []) !== JSON.stringify(candidate.sectionPath ?? [])) {
    throw new ScopedEvidenceValidationError('Scoped evidence ID conflicts with an established identity or content span.');
  }
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

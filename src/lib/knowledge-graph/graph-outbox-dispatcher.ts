import type { ClaimedKnowledgeGraphPublicationEvent } from './postgres-publication-store';

export interface KnowledgeGraphOutboxDispatchStore {
  claimPendingEvents(options?: {
    limit?: number;
    leaseMs?: number;
  }): Promise<ClaimedKnowledgeGraphPublicationEvent[]>;
  acknowledgeClaim(eventId: string, leaseToken: string): Promise<boolean>;
  retryClaim(
    eventId: string,
    leaseToken: string,
    options: { maxAttempts?: number; retryDelayMs?: number; error: unknown }
  ): Promise<'retry' | 'dead-letter' | 'lost-lease'>;
}

export interface KnowledgeGraphOutboxDispatchSummary {
  claimed: number;
  published: number;
  retried: number;
  deadLettered: number;
  lostLease: number;
}

/**
 * Event ids are stable idempotency keys. A handler must persist or forward that
 * key because a process can stop after the side effect but before acknowledgement.
 */
export async function dispatchKnowledgeGraphOutbox(input: {
  store: KnowledgeGraphOutboxDispatchStore;
  publish: (event: ClaimedKnowledgeGraphPublicationEvent) => Promise<void>;
  onDeadLetter?: (event: ClaimedKnowledgeGraphPublicationEvent) => Promise<void>;
  limit?: number;
  leaseMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}): Promise<KnowledgeGraphOutboxDispatchSummary> {
  const limit = boundedDispatchLimit(input.limit);
  const summary: KnowledgeGraphOutboxDispatchSummary = {
    claimed: 0,
    published: 0,
    retried: 0,
    deadLettered: 0,
    lostLease: 0,
  };
  while (summary.claimed < limit) {
    // Claim immediately before delivery so later events never spend their
    // lease waiting behind slow webhooks from the same batch.
    const events = await input.store.claimPendingEvents({
      limit: 1,
      ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }),
    });
    if (events.length === 0) break;
    if (events.length !== 1) {
      throw new Error('Knowledge graph outbox store must honor the single-event claim contract.');
    }
    const event = events[0];
    summary.claimed += 1;
    try {
      await input.publish(event);
      if (await input.store.acknowledgeClaim(event.id, event.leaseToken)) {
        summary.published += 1;
      } else {
        summary.lostLease += 1;
      }
    } catch (error) {
      const result = await input.store.retryClaim(event.id, event.leaseToken, {
        error,
        ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
        ...(input.retryDelayMs === undefined ? {} : { retryDelayMs: input.retryDelayMs }),
      });
      if (result === 'retry') summary.retried += 1;
      if (result === 'lost-lease') summary.lostLease += 1;
      if (result === 'dead-letter') {
        summary.deadLettered += 1;
        try {
          await input.onDeadLetter?.(event);
        } catch {
          // The event remains dead-lettered. Compensation is independently retryable.
        }
      }
    }
  }
  return summary;
}

function boundedDispatchLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('Knowledge graph outbox dispatch limit must be between 1 and 1000.');
  }
  return limit;
}

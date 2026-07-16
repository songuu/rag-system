import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RagRetrievalScope } from '../../security/retrieval-scope';
import type { RagKernelEnvelope } from './types';

export type DurableJsonPrimitive = string | number | boolean | null;
export type DurableJsonValue =
  | DurableJsonPrimitive
  | DurableJsonValue[]
  | { [key: string]: DurableJsonValue };
export type DurableJsonObject = { [key: string]: DurableJsonValue };

export const DURABLE_WORKFLOW_CHECKPOINT_VERSION = 'rag-durable-checkpoint-v2' as const;

export interface DurableWorkflowIdentity {
  threadId: string;
  tenantId: string;
  corpusId: string;
  allowedTrustLevels: string[];
  enforceIsolation: boolean;
  documentId: string;
  documentVersion: string;
}

export interface DurableWorkflowActiveStep {
  stepId: string;
  stepExecutionId: string;
  leaseOwnerId: string;
  leaseExpiresAt: string;
}

export type DurableWorkflowCheckpointStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DurableWorkflowCheckpoint<
  TJob extends DurableJsonObject = DurableJsonObject,
  TState extends DurableJsonObject = DurableJsonObject,
> {
  schemaVersion: typeof DURABLE_WORKFLOW_CHECKPOINT_VERSION;
  checkpointKey: string;
  workflowId: string;
  workflowVersion: string;
  identity: DurableWorkflowIdentity;
  idempotencyKey: string;
  jobFingerprint: string;
  integrityTag: string;
  job: TJob;
  state: TState;
  status: DurableWorkflowCheckpointStatus;
  nextStepIndex: number;
  completedStepIds: string[];
  activeStep?: DurableWorkflowActiveStep;
  lastFailureCode?:
    | 'STEP_EXECUTION_FAILED'
    | 'TERMINAL_STEP_FAILURE'
    | 'INVOCATION_ABORTED'
    | 'EXPIRED_LEASE_RELEASED';
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface DurableCheckpointStore {
  readonly providerId: string;
  readonly processPersistent: boolean;
  readonly maxSerializedBytes?: number;
  load(checkpointKey: string): Promise<DurableWorkflowCheckpoint | null>;
  save(
    checkpoint: DurableWorkflowCheckpoint,
    options: { expectedRevision: number | null }
  ): Promise<void>;
  /** Optional administrative lifecycle port. Implementations must fence deletes. */
  delete?(
    checkpointKey: string,
    options: { expectedRevision: number }
  ): Promise<boolean>;
}

export interface DurableWorkflowLeaseRenewal {
  leaseOwnerId: string;
  leaseExpiresAt: string;
  revision: number;
}

export interface DurableWorkflowStepContext<
  TJob extends DurableJsonObject,
  TState extends DurableJsonObject,
> {
  job: Readonly<TJob>;
  state: Readonly<TState>;
  identity: Readonly<DurableWorkflowIdentity>;
  stepExecutionId: string;
  /** Transient invocation cancellation; never serialized into a checkpoint. */
  signal: AbortSignal;
  /**
   * Extends this invocation's active lease using the checkpoint CAS fence.
   * Long-running steps should await this port before the current lease expires.
   */
  renewLease(): Promise<DurableWorkflowLeaseRenewal>;
}

export interface DurableWorkflowStep<
  TJob extends DurableJsonObject,
  TState extends DurableJsonObject,
> {
  id: string;
  execute(context: DurableWorkflowStepContext<TJob, TState>): Promise<TState>;
}

export interface DurableWorkflowDefinition<
  TJob extends DurableJsonObject,
  TState extends DurableJsonObject,
> {
  id: string;
  version: string;
  /** Explicit allowlist/projection for data that may enter durable storage. */
  projectJobForCheckpoint(job: Readonly<TJob>): TJob;
  /** Explicit allowlist/projection for state that may enter durable storage. */
  projectStateForCheckpoint(state: Readonly<TState>): TState;
  createInitialState(job: Readonly<TJob>): TState;
  steps: readonly DurableWorkflowStep<TJob, TState>[];
}

export interface DurableWorkflowInvocation<TJob extends DurableJsonObject> {
  threadId: string;
  idempotencyKey: string;
  scope: RagRetrievalScope;
  documentId: string;
  documentVersion: string;
  job: TJob;
  /** Transient cancellation only. AbortSignal is deliberately not persisted. */
  signal?: AbortSignal;
}

export interface DurableWorkflowResult<
  TJob extends DurableJsonObject,
  TState extends DurableJsonObject,
> {
  checkpoint: DurableWorkflowCheckpoint<TJob, TState>;
  resumed: boolean;
  idempotentReplay: boolean;
  executedStepIds: string[];
  checkpointProvider: string;
  processPersistent: boolean;
}

export interface DurableWorkflowAdapterOptions {
  now?: () => Date;
  ownerIdFactory?: () => string;
  leaseDurationMs?: number;
  maxSerializedBytes?: number;
  /** Required for process-persistent stores; never serialized. */
  integrityKey?: string;
  /** Explicit at-least-once recovery opt-in. Default false prevents duplicate side effects. */
  allowExpiredLeaseTakeover?: boolean;
}

export interface DurableWorkflowLeaseFence {
  expectedRevision: number;
  leaseOwnerId: string;
}

export interface DurableWorkflowLeaseRecoveryResult<
  TJob extends DurableJsonObject = DurableJsonObject,
  TState extends DurableJsonObject = DurableJsonObject,
> {
  checkpoint: DurableWorkflowCheckpoint<TJob, TState>;
  stepExecutionId: string;
  deliveryGuarantee: 'at_least_once';
}

export interface InMemoryDurableCheckpointStoreOptions {
  /** Terminal checkpoints remain replayable until this retention window elapses. */
  terminalRetentionMs?: number;
  now?: () => Date;
}

export class DurableWorkflowConflictError extends Error {
  readonly code = 'DURABLE_CHECKPOINT_CONFLICT';

  constructor(message = 'Durable workflow checkpoint revision conflict.') {
    super(message);
    this.name = 'DurableWorkflowConflictError';
  }
}

export class DurableWorkflowCapacityError extends Error {
  readonly code = 'DURABLE_CHECKPOINT_CAPACITY_EXCEEDED';

  constructor() {
    super('Durable checkpoint store capacity exceeded.');
    this.name = 'DurableWorkflowCapacityError';
  }
}

export class DurableWorkflowLeaseManagementError extends Error {
  readonly code = 'DURABLE_WORKFLOW_LEASE_MANAGEMENT_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'DurableWorkflowLeaseManagementError';
  }
}

export class DurableWorkflowBusyError extends Error {
  readonly code = 'DURABLE_WORKFLOW_BUSY';

  constructor(threadId: string) {
    super('Durable workflow thread is already running: ' + threadId);
    this.name = 'DurableWorkflowBusyError';
  }
}

export class DurableWorkflowResumeMismatchError extends Error {
  readonly code:
    | 'WORKFLOW_VERSION_MISMATCH'
    | 'SCOPE_MISMATCH'
    | 'DOCUMENT_ID_MISMATCH'
    | 'DOCUMENT_VERSION_MISMATCH'
    | 'IDEMPOTENCY_KEY_MISMATCH'
    | 'JOB_FINGERPRINT_MISMATCH';

  constructor(
    code: DurableWorkflowResumeMismatchError['code'],
    message: string
  ) {
    super(message);
    this.name = 'DurableWorkflowResumeMismatchError';
    this.code = code;
  }
}

export class DurableWorkflowStepError extends Error {
  readonly code = 'DURABLE_WORKFLOW_STEP_FAILED';
  readonly stepId: string;
  readonly cause: unknown;

  constructor(stepId: string, cause: unknown) {
    super('Durable workflow step failed: ' + stepId);
    this.name = 'DurableWorkflowStepError';
    this.stepId = stepId;
    this.cause = cause;
  }
}

export class DurableWorkflowCancelledError extends Error {
  readonly code = 'DURABLE_WORKFLOW_CANCELLED';
  readonly stepId?: string;

  constructor(stepId?: string) {
    super(
      stepId
        ? 'Durable workflow invocation was cancelled during step: ' + stepId
        : 'Durable workflow invocation was cancelled.'
    );
    this.name = 'DurableWorkflowCancelledError';
    this.stepId = stepId;
  }
}

export class DurableWorkflowTerminalStepError extends Error {
  readonly code = 'DURABLE_WORKFLOW_TERMINAL_STEP_FAILURE';
  readonly failureCode: string;

  constructor(failureCode: string, message = 'Durable workflow step failed permanently.') {
    super(message);
    this.name = 'DurableWorkflowTerminalStepError';
    this.failureCode = assertSafeIdentifier(failureCode, 'failureCode', 128);
  }
}

export class DurableWorkflowFailedError extends Error {
  readonly code = 'DURABLE_WORKFLOW_FAILED';

  constructor(threadId: string) {
    super('Durable workflow thread is in a terminal failed state: ' + threadId);
    this.name = 'DurableWorkflowFailedError';
  }
}

export type DurableRagKernelSnapshot = {
  traceId: string;
  policyId: string;
  status: 'completed';
  evidenceIds: string[];
  laneIds: string[];
};

/**
 * Thin durable-to-kernel seam. The full envelope remains the Kernel contract;
 * checkpoints retain only a scoped, non-content projection needed for resume.
 */
export function createDurableRagKernelStep<
  TJob extends DurableJsonObject,
  TState extends DurableJsonObject,
>(options: {
  id: string;
  executeKernel(input: {
    job: Readonly<TJob>;
    identity: Readonly<DurableWorkflowIdentity>;
    traceId: string;
    signal: AbortSignal;
  }): Promise<RagKernelEnvelope>;
  reduceState(
    state: Readonly<TState>,
    snapshot: Readonly<DurableRagKernelSnapshot>
  ): TState;
}): DurableWorkflowStep<TJob, TState> {
  const id = assertSafeIdentifier(options.id, 'stepId');
  return {
    id,
    async execute(context) {
      const envelope = await options.executeKernel({
        job: context.job,
        identity: context.identity,
        traceId: context.stepExecutionId,
        signal: context.signal,
      });
      const snapshot = projectDurableRagKernelEnvelope(
        envelope,
        context.identity,
        context.stepExecutionId
      );
      return options.reduceState(context.state, snapshot);
    },
  };
}

export class InMemoryDurableCheckpointStore implements DurableCheckpointStore {
  readonly providerId: string;
  readonly processPersistent = false;
  readonly maxSerializedBytes: number;
  readonly maxEntries: number;
  readonly terminalRetentionMs: number;
  private readonly checkpoints = new Map<string, DurableWorkflowCheckpoint>();
  private readonly terminalSince = new Map<string, number>();
  private readonly now: () => Date;

  constructor(
    providerId = 'in-memory-checkpoint-store',
    maxSerializedBytes = 1_048_576,
    maxEntries = 1_000,
    options: InMemoryDurableCheckpointStoreOptions = {}
  ) {
    this.providerId = assertSafeIdentifier(providerId, 'providerId');
    if (!Number.isInteger(maxSerializedBytes) || maxSerializedBytes < 1) {
      throw new Error('maxSerializedBytes must be a positive integer.');
    }
    this.maxSerializedBytes = maxSerializedBytes;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('maxEntries must be a positive integer.');
    }
    this.maxEntries = maxEntries;
    this.terminalRetentionMs = options.terminalRetentionMs ?? 86_400_000;
    if (
      !Number.isInteger(this.terminalRetentionMs)
      || this.terminalRetentionMs < 0
    ) {
      throw new Error('terminalRetentionMs must be a non-negative integer.');
    }
    this.now = options.now ?? (() => new Date());
    assertValidDate(this.now(), 'checkpoint store clock');
  }

  get size(): number {
    return this.checkpoints.size;
  }

  async load(checkpointKey: string): Promise<DurableWorkflowCheckpoint | null> {
    const checkpoint = this.checkpoints.get(checkpointKey);
    return checkpoint ? cloneDurableJson(checkpoint) : null;
  }

  async save(
    checkpoint: DurableWorkflowCheckpoint,
    options: { expectedRevision: number | null }
  ): Promise<void> {
    assertDurableWorkflowSerializable(checkpoint, {
      label: 'checkpoint',
      maxBytes: this.maxSerializedBytes,
    });
    const existing = this.checkpoints.get(checkpoint.checkpointKey);
    if (options.expectedRevision === null) {
      if (existing) {
        throw new DurableWorkflowConflictError('Checkpoint already exists.');
      }
      if (this.checkpoints.size >= this.maxEntries) {
        this.pruneTerminalCheckpoints();
        if (this.checkpoints.size >= this.maxEntries) {
          throw new DurableWorkflowCapacityError();
        }
      }
      if (checkpoint.revision !== 0) {
        throw new DurableWorkflowConflictError(
          'A new checkpoint must start at revision zero.'
        );
      }
    } else {
      if (!existing || existing.revision !== options.expectedRevision) {
        throw new DurableWorkflowConflictError();
      }
      if (checkpoint.revision !== options.expectedRevision + 1) {
        throw new DurableWorkflowConflictError(
          'Checkpoint revision must increment by one.'
        );
      }
    }
    this.checkpoints.set(checkpoint.checkpointKey, cloneDurableJson(checkpoint));
    if (isTerminalCheckpointStatus(checkpoint.status)) {
      if (!this.terminalSince.has(checkpoint.checkpointKey)) {
        this.terminalSince.set(
          checkpoint.checkpointKey,
          assertValidDate(this.now(), 'checkpoint store clock').getTime()
        );
      }
    } else {
      this.terminalSince.delete(checkpoint.checkpointKey);
    }
  }

  /** Removes terminal checkpoints whose configured replay-retention window elapsed. */
  pruneTerminalCheckpoints(): number {
    const nowMs = assertValidDate(this.now(), 'checkpoint store clock').getTime();
    let removed = 0;
    for (const [checkpointKey, checkpoint] of this.checkpoints) {
      if (!isTerminalCheckpointStatus(checkpoint.status)) continue;
      const terminalSince = this.terminalSince.get(checkpointKey);
      if (terminalSince === undefined) continue;
      if (nowMs - terminalSince < this.terminalRetentionMs) continue;
      this.checkpoints.delete(checkpointKey);
      this.terminalSince.delete(checkpointKey);
      removed += 1;
    }
    return removed;
  }

  /**
   * Explicit lifecycle operation. Only terminal checkpoints may be removed,
   * so an administrator cannot accidentally discard an active workflow.
   */
  async delete(
    checkpointKey: string,
    options: { expectedRevision: number }
  ): Promise<boolean> {
    if (!Number.isInteger(options.expectedRevision) || options.expectedRevision < 0) {
      throw new DurableWorkflowConflictError('Invalid checkpoint delete revision.');
    }
    const checkpoint = this.checkpoints.get(checkpointKey);
    if (!checkpoint) return false;
    if (checkpoint.revision !== options.expectedRevision) {
      throw new DurableWorkflowConflictError();
    }
    if (!isTerminalCheckpointStatus(checkpoint.status)) {
      throw new DurableWorkflowLeaseManagementError(
        'Only terminal checkpoints may be deleted by the safe lifecycle port.'
      );
    }
    this.terminalSince.delete(checkpointKey);
    return this.checkpoints.delete(checkpointKey);
  }
}

export class DurableRagWorkflowAdapter<
  TJob extends DurableJsonObject,
  TState extends DurableJsonObject,
> {
  private readonly definition: DurableWorkflowDefinition<TJob, TState>;
  private readonly store: DurableCheckpointStore;
  private readonly now: () => Date;
  private readonly ownerIdFactory: () => string;
  private readonly leaseDurationMs: number;
  private readonly maxSerializedBytes: number;
  private readonly integrityKey?: string;
  private readonly allowExpiredLeaseTakeover: boolean;

  constructor(
    definition: DurableWorkflowDefinition<TJob, TState>,
    store: DurableCheckpointStore,
    options: DurableWorkflowAdapterOptions = {}
  ) {
    validateDefinition(definition);
    this.definition = definition;
    this.store = store;
    this.now = options.now ?? (() => new Date());
    this.ownerIdFactory = options.ownerIdFactory ?? randomUUID;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.maxSerializedBytes = options.maxSerializedBytes ?? 262_144;
    this.integrityKey = options.integrityKey?.trim() || undefined;
    this.allowExpiredLeaseTakeover = options.allowExpiredLeaseTakeover ?? false;
    if (!Number.isInteger(this.leaseDurationMs) || this.leaseDurationMs < 1) {
      throw new Error('leaseDurationMs must be a positive integer.');
    }
    if (!Number.isInteger(this.maxSerializedBytes) || this.maxSerializedBytes < 1) {
      throw new Error('maxSerializedBytes must be a positive integer.');
    }
    if (this.integrityKey !== undefined && this.integrityKey.length < 32) {
      throw new Error('integrityKey must contain at least 32 characters.');
    }
    if (store.processPersistent && this.integrityKey === undefined) {
      throw new Error('Process-persistent checkpoint stores require an integrityKey.');
    }
    const requiredCheckpointBytes = Math.max(
      this.maxSerializedBytes * 3,
      1_048_576
    );
    if (
      store.maxSerializedBytes !== undefined
      && store.maxSerializedBytes < requiredCheckpointBytes
    ) {
      throw new Error(
        'Checkpoint store byte limit is smaller than the adapter checkpoint budget.'
      );
    }
  }

  async invoke(
    invocation: DurableWorkflowInvocation<TJob>
  ): Promise<DurableWorkflowResult<TJob, TState>> {
    const signal = invocation.signal ?? new AbortController().signal;
    assertAbortSignal(signal);
    const identity = normalizeInvocationIdentity(invocation);
    const idempotencyKey = assertSafeIdentifier(
      invocation.idempotencyKey,
      'idempotencyKey',
      256
    );
    assertDurableWorkflowSerializable(invocation.job, {
      label: 'input job',
      maxBytes: this.maxSerializedBytes,
      allowSensitiveFields: true,
    });
    const job = cloneDurableJson(
      this.definition.projectJobForCheckpoint(cloneDurableJson(invocation.job))
    );
    assertDurableWorkflowSerializable(job, {
      label: 'projected checkpoint job',
      maxBytes: this.maxSerializedBytes,
    });
    const jobFingerprint = fingerprintDurableJson(job);
    const checkpointKey = buildDurableCheckpointKey(
      this.definition.id,
      identity.threadId,
      identity.tenantId
    );
    const existing = await this.store.load(checkpointKey);
    const resumed = existing !== null;
    let checkpointCreatedByInvocation = false;
    let checkpoint: DurableWorkflowCheckpoint<TJob, TState>;
    if (existing) {
      checkpoint = this.validateAndTypeCheckpoint(existing, checkpointKey);
    } else {
      const creation = await this.createCheckpoint({
        checkpointKey,
        identity,
        idempotencyKey,
        jobFingerprint,
        job,
      });
      checkpoint = creation.checkpoint;
      checkpointCreatedByInvocation = creation.created;
    }

    assertResumeCompatible(checkpoint, {
      workflowVersion: this.definition.version,
      identity,
      idempotencyKey,
      jobFingerprint,
    });
    validateCheckpointProgress(checkpoint, this.definition.steps);
    if (checkpoint.status === 'completed') {
      return this.buildResult(checkpoint, true, true, []);
    }
    if (checkpoint.status === 'cancelled') {
      throw new DurableWorkflowCancelledError();
    }
    if (checkpoint.status === 'failed') {
      throw new DurableWorkflowFailedError(checkpoint.identity.threadId);
    }
    const ownerId = assertSafeIdentifier(
      this.ownerIdFactory(),
      'leaseOwnerId',
      256
    );
    assertCheckpointLeaseAvailable(
      checkpoint,
      this.now(),
      this.allowExpiredLeaseTakeover
    );
    if (signal.aborted) {
      if (checkpointCreatedByInvocation) {
        await this.cancelCheckpoint(checkpoint);
      }
      throw new DurableWorkflowCancelledError();
    }
    const executedStepIds: string[] = [];
    let mayPersistCancellation = checkpointCreatedByInvocation;

    while (checkpoint.nextStepIndex < this.definition.steps.length) {
      if (signal.aborted) {
        if (mayPersistCancellation) {
          checkpoint = await this.cancelCheckpoint(checkpoint);
        }
        throw new DurableWorkflowCancelledError();
      }
      const step = this.definition.steps[checkpoint.nextStepIndex];
      const stepExecutionId = createStepExecutionId(
        checkpoint.checkpointKey,
        checkpoint.idempotencyKey,
        step.id
      );
      const claimedAt = this.now();
      const claimedCheckpoint: DurableWorkflowCheckpoint<TJob, TState> = {
        ...checkpoint,
        status: 'running',
        activeStep: {
          stepId: step.id,
          stepExecutionId,
          leaseOwnerId: ownerId,
          leaseExpiresAt: new Date(
            claimedAt.getTime() + this.leaseDurationMs
          ).toISOString(),
        },
        revision: checkpoint.revision + 1,
        updatedAt: claimedAt.toISOString(),
      };
      delete claimedCheckpoint.lastFailureCode;
      await this.saveCheckpoint(claimedCheckpoint, checkpoint.revision);
      checkpoint = claimedCheckpoint;
      mayPersistCancellation = true;

      let stepSettled = false;
      let leaseRenewalQueue: Promise<void> = Promise.resolve();
      const renewLease = (): Promise<DurableWorkflowLeaseRenewal> => {
        let renewal: DurableWorkflowLeaseRenewal | undefined;
        const operation = leaseRenewalQueue.then(async () => {
          if (stepSettled) {
            throw new DurableWorkflowLeaseManagementError(
              'A settled durable workflow step cannot renew its lease.'
            );
          }
          if (signal.aborted) {
            throw new DurableWorkflowCancelledError(step.id);
          }
          const activeStep = checkpoint.activeStep;
          if (
            checkpoint.status !== 'running'
            || !activeStep
            || activeStep.stepId !== step.id
            || activeStep.stepExecutionId !== stepExecutionId
            || activeStep.leaseOwnerId !== ownerId
          ) {
            throw new DurableWorkflowLeaseManagementError(
              'The active durable workflow lease no longer belongs to this invocation.'
            );
          }
          const renewedAt = assertValidDate(this.now(), 'workflow clock');
          const currentExpiry = Date.parse(activeStep.leaseExpiresAt);
          if (!Number.isFinite(currentExpiry)) {
            throw new DurableWorkflowLeaseManagementError(
              'The active durable workflow lease has an invalid expiry.'
            );
          }
          if (currentExpiry <= renewedAt.getTime()) {
            throw new DurableWorkflowLeaseManagementError(
              'An expired durable workflow lease cannot be renewed.'
            );
          }
          const leaseExpiresAt = new Date(
            renewedAt.getTime() + this.leaseDurationMs
          ).toISOString();
          const renewedCheckpoint: DurableWorkflowCheckpoint<TJob, TState> = {
            ...checkpoint,
            activeStep: {
              ...activeStep,
              leaseExpiresAt,
            },
            revision: checkpoint.revision + 1,
            updatedAt: renewedAt.toISOString(),
          };
          await this.saveCheckpoint(renewedCheckpoint, checkpoint.revision);
          checkpoint = renewedCheckpoint;
          renewal = {
            leaseOwnerId: ownerId,
            leaseExpiresAt,
            revision: renewedCheckpoint.revision,
          };
        });
        leaseRenewalQueue = operation;
        return operation.then(() => {
          if (!renewal) {
            throw new DurableWorkflowLeaseManagementError(
              'Durable workflow lease renewal did not produce a result.'
            );
          }
          return renewal;
        });
      };

      try {
        const nextState = await executeDurableStepWithCancellation(
          () => step.execute({
            job: cloneDurableJson(checkpoint.job),
            state: cloneDurableJson(checkpoint.state),
            identity: cloneDurableJson(checkpoint.identity),
            stepExecutionId,
            signal,
            renewLease,
          }),
          signal,
          step.id
        );
        await leaseRenewalQueue;
        stepSettled = true;
        if (signal.aborted) {
          throw new DurableWorkflowCancelledError(step.id);
        }
        const projectedNextState = this.definition.projectStateForCheckpoint(
          cloneDurableJson(nextState)
        );
        assertDurableWorkflowSerializable(projectedNextState, {
          label: 'state returned by ' + step.id,
          maxBytes: this.maxSerializedBytes,
        });
        const nextStepIndex = checkpoint.nextStepIndex + 1;
        const completedCheckpoint: DurableWorkflowCheckpoint<TJob, TState> = {
          ...checkpoint,
          state: cloneDurableJson(projectedNextState),
          status: nextStepIndex === this.definition.steps.length
            ? 'completed'
            : 'pending',
          nextStepIndex,
          completedStepIds: [...checkpoint.completedStepIds, step.id],
          revision: checkpoint.revision + 1,
          updatedAt: this.now().toISOString(),
        };
        delete completedCheckpoint.activeStep;
        delete completedCheckpoint.lastFailureCode;
        await this.saveCheckpoint(completedCheckpoint, checkpoint.revision);
        checkpoint = completedCheckpoint;
        executedStepIds.push(step.id);
      } catch (error) {
        stepSettled = true;
        await leaseRenewalQueue.catch(() => undefined);
        if (error instanceof DurableWorkflowConflictError) throw error;
        const wasCancelled = signal.aborted
          || error instanceof DurableWorkflowCancelledError;
        const terminalFailure = error instanceof DurableWorkflowTerminalStepError;
        const pausedCheckpoint: DurableWorkflowCheckpoint<TJob, TState> = {
          ...checkpoint,
          status: wasCancelled
            ? 'cancelled'
            : terminalFailure
              ? 'failed'
              : 'paused',
          lastFailureCode: wasCancelled
            ? 'INVOCATION_ABORTED'
            : terminalFailure
              ? 'TERMINAL_STEP_FAILURE'
              : 'STEP_EXECUTION_FAILED',
          revision: checkpoint.revision + 1,
          updatedAt: this.now().toISOString(),
        };
        delete pausedCheckpoint.activeStep;
        try {
          await this.saveCheckpoint(pausedCheckpoint, checkpoint.revision);
        } catch (saveError) {
          if (!(saveError instanceof DurableWorkflowConflictError)) {
            throw saveError;
          }
        }
        if (wasCancelled) {
          throw new DurableWorkflowCancelledError(step.id);
        }
        if (terminalFailure) {
          throw new DurableWorkflowFailedError(checkpoint.identity.threadId);
        }
        throw new DurableWorkflowStepError(step.id, error);
      }
    }

    return this.buildResult(checkpoint, resumed, false, executedStepIds);
  }

  /**
   * Explicit management recovery for a crashed owner. Releasing an expired
   * lease can replay the same step, so callers must use stepExecutionId as the
   * downstream idempotency key. The revision/owner fence prevents stale admin
   * observations from releasing a newer lease.
   */
  async releaseExpiredLeaseForRecovery(
    invocation: DurableWorkflowInvocation<TJob>,
    fence: DurableWorkflowLeaseFence
  ): Promise<DurableWorkflowLeaseRecoveryResult<TJob, TState>> {
    if (!Number.isInteger(fence.expectedRevision) || fence.expectedRevision < 0) {
      throw new DurableWorkflowLeaseManagementError(
        'Expired-lease recovery requires a valid expected revision.'
      );
    }
    const expectedOwnerId = assertSafeIdentifier(
      fence.leaseOwnerId,
      'leaseOwnerId',
      256
    );
    const checkpoint = await this.loadCompatibleCheckpoint(invocation);
    const activeStep = checkpoint.activeStep;
    if (checkpoint.status !== 'running' || !activeStep) {
      throw new DurableWorkflowLeaseManagementError(
        'Expired-lease recovery requires a running checkpoint.'
      );
    }
    if (
      checkpoint.revision !== fence.expectedRevision
      || activeStep.leaseOwnerId !== expectedOwnerId
    ) {
      throw new DurableWorkflowConflictError(
        'Durable workflow lease recovery fence does not match.'
      );
    }
    const leaseExpiresAt = Date.parse(activeStep.leaseExpiresAt);
    if (!Number.isFinite(leaseExpiresAt)) {
      throw new DurableWorkflowLeaseManagementError(
        'Expired-lease recovery found an invalid lease expiry.'
      );
    }
    const recoveredAt = assertValidDate(this.now(), 'workflow clock');
    if (leaseExpiresAt > recoveredAt.getTime()) {
      throw new DurableWorkflowLeaseManagementError(
        'A live durable workflow lease cannot be released for recovery.'
      );
    }
    const recoveredCheckpoint: DurableWorkflowCheckpoint<TJob, TState> = {
      ...checkpoint,
      status: 'paused',
      lastFailureCode: 'EXPIRED_LEASE_RELEASED',
      revision: checkpoint.revision + 1,
      updatedAt: recoveredAt.toISOString(),
    };
    delete recoveredCheckpoint.activeStep;
    await this.saveCheckpoint(recoveredCheckpoint, checkpoint.revision);
    return {
      checkpoint: cloneDurableJson(recoveredCheckpoint),
      stepExecutionId: activeStep.stepExecutionId,
      deliveryGuarantee: 'at_least_once',
    };
  }

  private async cancelCheckpoint(
    checkpoint: DurableWorkflowCheckpoint<TJob, TState>
  ): Promise<DurableWorkflowCheckpoint<TJob, TState>> {
    const cancelledCheckpoint: DurableWorkflowCheckpoint<TJob, TState> = {
      ...checkpoint,
      status: 'cancelled',
      lastFailureCode: 'INVOCATION_ABORTED',
      revision: checkpoint.revision + 1,
      updatedAt: this.now().toISOString(),
    };
    delete cancelledCheckpoint.activeStep;
    await this.saveCheckpoint(cancelledCheckpoint, checkpoint.revision);
    return cancelledCheckpoint;
  }

  private async createCheckpoint(input: {
    checkpointKey: string;
    identity: DurableWorkflowIdentity;
    idempotencyKey: string;
    jobFingerprint: string;
    job: TJob;
  }): Promise<{
    checkpoint: DurableWorkflowCheckpoint<TJob, TState>;
    created: boolean;
  }> {
    const state = this.definition.projectStateForCheckpoint(
      this.definition.createInitialState(cloneDurableJson(input.job))
    );
    assertDurableWorkflowSerializable(state, {
      label: 'initial state',
      maxBytes: this.maxSerializedBytes,
    });
    const now = this.now().toISOString();
    const checkpoint: DurableWorkflowCheckpoint<TJob, TState> = {
      schemaVersion: DURABLE_WORKFLOW_CHECKPOINT_VERSION,
      checkpointKey: input.checkpointKey,
      workflowId: this.definition.id,
      workflowVersion: this.definition.version,
      identity: input.identity,
      idempotencyKey: input.idempotencyKey,
      jobFingerprint: input.jobFingerprint,
      integrityTag: '',
      job: cloneDurableJson(input.job),
      state: cloneDurableJson(state),
      status: 'pending',
      nextStepIndex: 0,
      completedStepIds: [],
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.saveCheckpoint(checkpoint, null);
      return { checkpoint, created: true };
    } catch (error) {
      if (!(error instanceof DurableWorkflowConflictError)) throw error;
      const winner = await this.store.load(input.checkpointKey);
      if (!winner) throw error;
      return {
        checkpoint: this.validateAndTypeCheckpoint(winner, input.checkpointKey),
        created: false,
      };
    }
  }

  private async loadCompatibleCheckpoint(
    invocation: DurableWorkflowInvocation<TJob>
  ): Promise<DurableWorkflowCheckpoint<TJob, TState>> {
    const identity = normalizeInvocationIdentity(invocation);
    const idempotencyKey = assertSafeIdentifier(
      invocation.idempotencyKey,
      'idempotencyKey',
      256
    );
    assertDurableWorkflowSerializable(invocation.job, {
      label: 'input job',
      maxBytes: this.maxSerializedBytes,
      allowSensitiveFields: true,
    });
    const job = cloneDurableJson(
      this.definition.projectJobForCheckpoint(cloneDurableJson(invocation.job))
    );
    assertDurableWorkflowSerializable(job, {
      label: 'projected checkpoint job',
      maxBytes: this.maxSerializedBytes,
    });
    const checkpointKey = buildDurableCheckpointKey(
      this.definition.id,
      identity.threadId,
      identity.tenantId
    );
    const loaded = await this.store.load(checkpointKey);
    if (!loaded) {
      throw new DurableWorkflowLeaseManagementError(
        'Durable workflow checkpoint does not exist.'
      );
    }
    const checkpoint = this.validateAndTypeCheckpoint(loaded, checkpointKey);
    assertResumeCompatible(checkpoint, {
      workflowVersion: this.definition.version,
      identity,
      idempotencyKey,
      jobFingerprint: fingerprintDurableJson(job),
    });
    validateCheckpointProgress(checkpoint, this.definition.steps);
    return checkpoint;
  }

  private validateAndTypeCheckpoint(
    checkpoint: DurableWorkflowCheckpoint,
    expectedKey: string
  ): DurableWorkflowCheckpoint<TJob, TState> {
    assertDurableWorkflowSerializable(checkpoint, {
      label: 'loaded checkpoint',
      maxBytes: Math.max(this.maxSerializedBytes * 3, 1_048_576),
    });
    if (checkpoint.schemaVersion !== DURABLE_WORKFLOW_CHECKPOINT_VERSION) {
      throw new Error('Unsupported durable workflow checkpoint schema.');
    }
    assertCheckpointIntegrity(checkpoint, this.integrityKey);
    if (checkpoint.checkpointKey !== expectedKey) {
      throw new Error('Durable workflow checkpoint key mismatch.');
    }
    if (checkpoint.workflowId !== this.definition.id) {
      throw new Error('Durable workflow checkpoint workflow mismatch.');
    }
    if (checkpoint.workflowVersion !== this.definition.version) {
      throw new DurableWorkflowResumeMismatchError(
        'WORKFLOW_VERSION_MISMATCH',
        'Durable workflow version changed since the checkpoint was created.'
      );
    }
    validateCheckpointShape(checkpoint);
    if (checkpoint.jobFingerprint !== fingerprintDurableJson(checkpoint.job)) {
      throw new Error('Durable workflow checkpoint job fingerprint is invalid.');
    }
    return cloneDurableJson(checkpoint) as unknown as DurableWorkflowCheckpoint<
      TJob,
      TState
    >;
  }

  private async saveCheckpoint(
    checkpoint: DurableWorkflowCheckpoint<TJob, TState>,
    expectedRevision: number | null
  ): Promise<void> {
    checkpoint.integrityTag = createCheckpointIntegrityTag(
      checkpoint,
      this.integrityKey
    );
    assertDurableWorkflowSerializable(checkpoint, {
      label: 'checkpoint',
      maxBytes: Math.max(this.maxSerializedBytes * 3, 1_048_576),
    });
    await this.store.save(
      checkpoint as DurableWorkflowCheckpoint,
      { expectedRevision }
    );
  }

  private buildResult(
    checkpoint: DurableWorkflowCheckpoint<TJob, TState>,
    resumed: boolean,
    idempotentReplay: boolean,
    executedStepIds: string[]
  ): DurableWorkflowResult<TJob, TState> {
    return {
      checkpoint: cloneDurableJson(checkpoint),
      resumed,
      idempotentReplay,
      executedStepIds: [...executedStepIds],
      checkpointProvider: this.store.providerId,
      processPersistent: this.store.processPersistent,
    };
  }
}

async function executeDurableStepWithCancellation<T>(
  execute: () => Promise<T>,
  signal: AbortSignal,
  stepId: string
): Promise<T> {
  if (signal.aborted) {
    throw new DurableWorkflowCancelledError(stepId);
  }

  let rejectCancellation: ((error: DurableWorkflowCancelledError) => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });
  const cancel = () => {
    rejectCancellation?.(new DurableWorkflowCancelledError(stepId));
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();

  const operation = Promise.resolve().then(() => {
    if (signal.aborted) {
      throw new DurableWorkflowCancelledError(stepId);
    }
    return execute();
  });
  try {
    // Promise.race installs rejection handlers on both inputs. If cancellation
    // wins and a non-cooperative step rejects later, that rejection is still
    // observed while the terminal checkpoint prevents replay of the step.
    return await Promise.race([operation, cancellation]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

export function buildDurableCheckpointKey(
  workflowId: string,
  threadId: string,
  tenantId: string
): string {
  const safeWorkflowId = assertSafeIdentifier(workflowId, 'workflowId');
  const safeThreadId = assertSafeIdentifier(threadId, 'threadId', 256);
  const safeTenantId = assertSafeIdentifier(tenantId, 'tenantId');
  return 'rag-durable/' + safeWorkflowId + '/'
    + sha256(safeTenantId + '\u0000' + safeThreadId);
}

export function assertDurableWorkflowSerializable(
  value: unknown,
  options: {
    label?: string;
    maxBytes?: number;
    allowSensitiveFields?: boolean;
  } = {}
): asserts value is DurableJsonValue {
  const label = options.label ?? 'workflow value';
  const seen = new Set<object>();
  let nodes = 0;

  function visit(item: unknown, path: string, depth: number): void {
    nodes += 1;
    if (nodes > 100_000) {
      throw new Error(label + ' contains too many values.');
    }
    if (depth > 32) {
      throw new Error(label + ' exceeds the maximum nesting depth.');
    }
    if (item === null || typeof item === 'string' || typeof item === 'boolean') {
      return;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) {
        throw new Error(label + ' contains a non-finite number at ' + path + '.');
      }
      return;
    }
    if (typeof item !== 'object') {
      throw new Error(label + ' contains a non-JSON value at ' + path + '.');
    }
    if (seen.has(item)) {
      throw new Error(label + ' contains a circular reference at ' + path + '.');
    }
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        const ownKeys = Reflect.ownKeys(item);
        if (
          ownKeys.some(key => typeof key !== 'string')
          || ownKeys.length !== item.length + 1
          || !ownKeys.includes('length')
        ) {
          throw new Error(
            label + ' contains a sparse or decorated array at ' + path + '.'
          );
        }
        for (let index = 0; index < item.length; index += 1) {
          const key = String(index);
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (
            !descriptor
            || !descriptor.enumerable
            || descriptor.get
            || descriptor.set
          ) {
            throw new Error(
              label + ' contains a sparse or decorated array at ' + path + '.'
            );
          }
          visit(descriptor.value, path + '[' + index + ']', depth + 1);
        }
        return;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(label + ' contains a non-plain object at ' + path + '.');
      }
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const ownKeys = Reflect.ownKeys(item);
      if (ownKeys.some(key => typeof key !== 'string')) {
        throw new Error(label + ' contains a symbol key at ' + path + '.');
      }
      for (const key of ownKeys as string[]) {
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || descriptor.get || descriptor.set) {
          throw new Error(
            label + ' contains a hidden or accessor field at ' + path + '.' + key + '.'
          );
        }
        if (
          !options.allowSensitiveFields
          && isForbiddenCheckpointField(key, descriptor.value)
        ) {
          throw new Error(
            label + ' contains forbidden field ' + path + '.' + key + '.'
          );
        }
        visit(descriptor.value, path + '.' + key, depth + 1);
      }
    } finally {
      seen.delete(item);
    }
  }

  visit(value, '$', 0);
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  const maxBytes = options.maxBytes ?? 262_144;
  if (bytes > maxBytes) {
    throw new Error(label + ' exceeds the serialized byte limit.');
  }
}

function validateDefinition<
  TJob extends DurableJsonObject,
  TState extends DurableJsonObject,
>(definition: DurableWorkflowDefinition<TJob, TState>): void {
  assertSafeIdentifier(definition.id, 'workflowId');
  assertSafeIdentifier(definition.version, 'workflowVersion');
  if (definition.steps.length === 0) {
    throw new Error('Durable workflow requires at least one step.');
  }
  if (
    typeof definition.projectJobForCheckpoint !== 'function'
    || typeof definition.projectStateForCheckpoint !== 'function'
  ) {
    throw new Error('Durable workflow requires explicit checkpoint projectors.');
  }
  const seen = new Set<string>();
  for (const step of definition.steps) {
    const id = assertSafeIdentifier(step.id, 'stepId');
    if (seen.has(id)) {
      throw new Error('Duplicate durable workflow step: ' + id);
    }
    seen.add(id);
  }
}

function normalizeInvocationIdentity<TJob extends DurableJsonObject>(
  invocation: DurableWorkflowInvocation<TJob>
): DurableWorkflowIdentity {
  const allowedTrustLevels = [
    ...new Set(invocation.scope.allowedTrustLevels),
  ].sort();
  if (allowedTrustLevels.length === 0) {
    throw new Error('Durable workflow scope must allow at least one trust level.');
  }
  if (
    allowedTrustLevels.some(level => (
      !['trusted', 'reviewed', 'external', 'quarantined'].includes(level)
    ))
  ) {
    throw new Error('Durable workflow scope contains an invalid trust level.');
  }
  if (typeof invocation.scope.enforceIsolation !== 'boolean') {
    throw new Error('Durable workflow scope isolation flag must be boolean.');
  }
  return {
    threadId: assertSafeIdentifier(invocation.threadId, 'threadId', 256),
    tenantId: assertSafeIdentifier(invocation.scope.tenantId, 'tenantId'),
    corpusId: assertSafeIdentifier(invocation.scope.corpusId, 'corpusId'),
    allowedTrustLevels,
    enforceIsolation: invocation.scope.enforceIsolation,
    documentId: assertSafeIdentifier(
      invocation.documentId,
      'documentId',
      256
    ),
    documentVersion: assertSafeIdentifier(
      invocation.documentVersion,
      'documentVersion',
      256
    ),
  };
}

function assertResumeCompatible(
  checkpoint: DurableWorkflowCheckpoint,
  expected: {
    workflowVersion: string;
    identity: DurableWorkflowIdentity;
    idempotencyKey: string;
    jobFingerprint: string;
  }
): void {
  if (checkpoint.workflowVersion !== expected.workflowVersion) {
    throw new DurableWorkflowResumeMismatchError(
      'WORKFLOW_VERSION_MISMATCH',
      'Durable workflow version changed since the checkpoint was created.'
    );
  }
  const currentScope = expected.identity;
  const priorScope = checkpoint.identity;
  if (
    priorScope.threadId !== currentScope.threadId
    || priorScope.tenantId !== currentScope.tenantId
    || priorScope.corpusId !== currentScope.corpusId
    || priorScope.enforceIsolation !== currentScope.enforceIsolation
    || priorScope.allowedTrustLevels.join('\u0000')
      !== currentScope.allowedTrustLevels.join('\u0000')
  ) {
    throw new DurableWorkflowResumeMismatchError(
      'SCOPE_MISMATCH',
      'Durable workflow scope changed; resume requires fresh authorization.'
    );
  }
  if (priorScope.documentVersion !== currentScope.documentVersion) {
    throw new DurableWorkflowResumeMismatchError(
      'DOCUMENT_VERSION_MISMATCH',
      'Durable workflow document version changed since checkpoint creation.'
    );
  }
  if (priorScope.documentId !== currentScope.documentId) {
    throw new DurableWorkflowResumeMismatchError(
      'DOCUMENT_ID_MISMATCH',
      'Durable workflow document identity changed since checkpoint creation.'
    );
  }
  if (checkpoint.idempotencyKey !== expected.idempotencyKey) {
    throw new DurableWorkflowResumeMismatchError(
      'IDEMPOTENCY_KEY_MISMATCH',
      'Durable workflow idempotency key does not match the checkpoint.'
    );
  }
  if (checkpoint.jobFingerprint !== expected.jobFingerprint) {
    throw new DurableWorkflowResumeMismatchError(
      'JOB_FINGERPRINT_MISMATCH',
      'Durable workflow job changed since checkpoint creation.'
    );
  }
}

function assertCheckpointLeaseAvailable(
  checkpoint: DurableWorkflowCheckpoint,
  now: Date,
  allowExpiredLeaseTakeover: boolean
): void {
  const activeStep = checkpoint.activeStep;
  if (checkpoint.status !== 'running' || !activeStep) return;
  const leaseExpiresAt = Date.parse(activeStep.leaseExpiresAt);
  if (!Number.isFinite(leaseExpiresAt)) {
    throw new Error('Durable workflow checkpoint has an invalid lease timestamp.');
  }
  if (leaseExpiresAt <= now.getTime() && allowExpiredLeaseTakeover) return;
  throw new DurableWorkflowBusyError(checkpoint.identity.threadId);
}

function validateCheckpointProgress(
  checkpoint: DurableWorkflowCheckpoint,
  steps: readonly { id: string }[]
): void {
  validateCheckpointShape(checkpoint);
  if (
    checkpoint.nextStepIndex > steps.length
  ) {
    throw new Error('Durable workflow checkpoint has an invalid step index.');
  }
  const expectedCompleted = steps
    .slice(0, checkpoint.nextStepIndex)
    .map(step => step.id);
  if (
    checkpoint.completedStepIds.join('\u0000')
    !== expectedCompleted.join('\u0000')
  ) {
    throw new Error(
      'Durable workflow checkpoint completed-step history is invalid.'
    );
  }
  if (
    checkpoint.status === 'completed'
    && checkpoint.nextStepIndex !== steps.length
  ) {
    throw new Error('Completed durable workflow checkpoint has pending steps.');
  }
  if (
    checkpoint.status !== 'completed'
    && checkpoint.nextStepIndex === steps.length
  ) {
    throw new Error('Non-completed durable workflow checkpoint has no pending steps.');
  }
  if (checkpoint.status === 'running') {
    const expectedStep = steps[checkpoint.nextStepIndex];
    if (!checkpoint.activeStep || checkpoint.activeStep.stepId !== expectedStep?.id) {
      throw new Error(
        'Running durable workflow checkpoint has an invalid active step.'
      );
    }
  } else if (checkpoint.activeStep) {
    throw new Error(
      'Non-running durable workflow checkpoint must not hold a lease.'
    );
  }
}

function validateCheckpointShape(checkpoint: DurableWorkflowCheckpoint): void {
  if (
    !['pending', 'running', 'paused', 'completed', 'failed', 'cancelled']
      .includes(checkpoint.status)
  ) {
    throw new Error('Durable workflow checkpoint has an invalid status.');
  }
  if (!Number.isInteger(checkpoint.revision) || checkpoint.revision < 0) {
    throw new Error('Durable workflow checkpoint has an invalid revision.');
  }
  if (!Number.isInteger(checkpoint.nextStepIndex) || checkpoint.nextStepIndex < 0) {
    throw new Error('Durable workflow checkpoint has an invalid step index.');
  }
  if (
    !Array.isArray(checkpoint.completedStepIds)
    || checkpoint.completedStepIds.some(stepId => typeof stepId !== 'string')
  ) {
    throw new Error('Durable workflow checkpoint has invalid completed steps.');
  }
  if (checkpoint.status === 'running') {
    if (!checkpoint.activeStep) {
      throw new Error('Running durable workflow checkpoint must hold a lease.');
    }
  } else if (checkpoint.activeStep) {
    throw new Error('Non-running durable workflow checkpoint must not hold a lease.');
  }
}

function projectDurableRagKernelEnvelope(
  envelope: RagKernelEnvelope,
  identity: Readonly<DurableWorkflowIdentity>,
  expectedTraceId: string
): DurableRagKernelSnapshot {
  if (envelope.trace_id !== expectedTraceId) {
    throw new Error('RAG Kernel trace does not match the durable step execution ID.');
  }
  if (envelope.status !== 'completed' || envelope.error !== undefined) {
    throw new Error('RAG Kernel did not return a completed canonical envelope.');
  }
  const evidenceIds = envelope.evidence.map(evidence => {
    if (
      evidence.tenantId !== identity.tenantId
      || evidence.corpusId !== identity.corpusId
      || evidence.documentId !== identity.documentId
      || evidence.documentVersion !== identity.documentVersion
      || evidence.trustLevel === 'quarantined'
      || !identity.allowedTrustLevels.includes(evidence.trustLevel)
    ) {
      throw new Error('RAG Kernel evidence does not match durable workflow identity.');
    }
    return assertSafeIdentifier(evidence.id, 'evidenceId', 256);
  });
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw new Error('RAG Kernel envelope contains duplicate evidence identity.');
  }
  const laneIds = envelope.lane_executions.map(lane => (
    assertSafeIdentifier(lane.laneId, 'laneId', 128)
  ));
  if (new Set(laneIds).size !== laneIds.length) {
    throw new Error('RAG Kernel envelope contains duplicate lane identity.');
  }
  return {
    traceId: expectedTraceId,
    policyId: assertSafeIdentifier(envelope.policy_id, 'policyId', 128),
    status: 'completed',
    evidenceIds,
    laneIds,
  };
}

function createStepExecutionId(
  checkpointKey: string,
  idempotencyKey: string,
  stepId: string
): string {
  return 'rag-step-' + sha256(
    checkpointKey + '\u0000' + idempotencyKey + '\u0000' + stepId
  ).slice(0, 32);
}

function fingerprintDurableJson(value: DurableJsonValue): string {
  return sha256(stableStringify(value));
}

function createCheckpointIntegrityTag(
  checkpoint: DurableWorkflowCheckpoint,
  integrityKey: string | undefined
): string {
  const payload = { ...checkpoint } as DurableWorkflowCheckpoint;
  delete (payload as Partial<DurableWorkflowCheckpoint>).integrityTag;
  const serialized = stableStringify(payload as unknown as DurableJsonValue);
  return integrityKey
    ? 'hmac-sha256:' + createHmac('sha256', integrityKey).update(serialized).digest('hex')
    : 'sha256:' + sha256(serialized);
}

function assertCheckpointIntegrity(
  checkpoint: DurableWorkflowCheckpoint,
  integrityKey: string | undefined
): void {
  if (typeof checkpoint.integrityTag !== 'string' || !checkpoint.integrityTag) {
    throw new Error('Durable workflow checkpoint integrity tag is missing.');
  }
  const expected = createCheckpointIntegrityTag(checkpoint, integrityKey);
  const actualBuffer = Buffer.from(checkpoint.integrityTag, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (
    actualBuffer.length !== expectedBuffer.length
    || !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new Error('Durable workflow checkpoint integrity validation failed.');
  }
}

function stableStringify(value: DurableJsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  return '{' + Object.keys(value)
    .sort()
    .map(key => JSON.stringify(key) + ':' + stableStringify(value[key]))
    .join(',') + '}';
}

function cloneDurableJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map(item => cloneDurableJson(item)) as T;
  }
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: cloneDurableJson((value as Record<string, unknown>)[key]),
    });
  }
  return clone as T;
}

function isTerminalCheckpointStatus(
  status: DurableWorkflowCheckpointStatus
): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function assertValidDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(label + ' must return a valid Date.');
  }
  return value;
}

function assertAbortSignal(signal: AbortSignal): void {
  if (
    !signal
    || typeof signal.aborted !== 'boolean'
    || typeof signal.addEventListener !== 'function'
    || typeof signal.removeEventListener !== 'function'
  ) {
    throw new Error('Durable workflow signal must be an AbortSignal.');
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertSafeIdentifier(
  value: string,
  field: string,
  maxLength = 128
): string {
  const normalized = value?.trim();
  const pattern = new RegExp(
    '^[A-Za-z0-9][A-Za-z0-9._:-]{0,' + (maxLength - 1) + '}$'
  );
  if (!normalized || !pattern.test(normalized)) {
    throw new Error(
      field + ' must be a safe identifier of at most ' + maxLength + ' characters.'
    );
  }
  return normalized;
}

const FORBIDDEN_CHECKPOINT_KEY_SEGMENTS = new Set([
  'secret',
  'secrets',
  'credential',
  'credentials',
  'cred',
  'creds',
  'password',
  'passwords',
  'passwd',
  'passphrase',
  'authorization',
  'authorisation',
  'authentication',
  'auth',
  'authn',
  'authz',
  'oauth',
  'oidc',
  'session',
  'sessions',
  'cookie',
  'cookies',
  'token',
  'tokens',
  'jwt',
  'bearer',
  'embedding',
  'embeddings',
  'vector',
  'vectors',
  'error',
  'errors',
  'stack',
]);

const FORBIDDEN_COMPACT_CHECKPOINT_KEYS = new Set([
  'apikey',
  'authtoken',
  'authenticationtoken',
  'authorizationtoken',
  'sessiontoken',
  'sessionid',
  'apitoken',
  'idtoken',
  'accesstoken',
  'refreshtoken',
  'bearertoken',
  'oauthtoken',
  'csrftoken',
  'xsrftoken',
  'jwttoken',
  'cookiejar',
  'setcookie',
  'privatekey',
  'keymaterial',
  'clientsecret',
  'clientcredential',
  'clientcredentials',
  'servicecredential',
  'servicecredentials',
]);

/**
 * Checkpoint projections are a persistence boundary, so credential-shaped keys
 * are denied recursively. The sole token exception is an explicitly numeric
 * `*TokenCount` metric; checking its value prevents a secret string from being
 * smuggled through a telemetry-looking key.
 */
function isForbiddenCheckpointField(key: string, value: unknown): boolean {
  const normalized = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  const segments = normalized.split('_').filter(Boolean);

  if (isSafeTokenCountField(segments, value)) return false;
  if (segments.some(segment => FORBIDDEN_CHECKPOINT_KEY_SEGMENTS.has(segment))) {
    return true;
  }

  const compact = segments.join('');
  if (FORBIDDEN_COMPACT_CHECKPOINT_KEYS.has(compact)) return true;
  if (
    segments.includes('api') && segments.includes('key')
    || segments.includes('private') && segments.includes('key')
    || segments.includes('key') && segments.includes('material')
  ) {
    return true;
  }

  return false;
}

function isSafeTokenCountField(segments: string[], value: unknown): boolean {
  if (
    segments.length < 2
    || segments.at(-1) !== 'count'
    || !segments.some(segment => segment === 'token' || segment === 'tokens')
  ) {
    return false;
  }
  const otherSensitiveSegments = segments.filter(
    segment => FORBIDDEN_CHECKPOINT_KEY_SEGMENTS.has(segment)
      && segment !== 'token'
      && segment !== 'tokens'
  );
  return otherSensitiveSegments.length === 0
    && Number.isSafeInteger(value)
    && (value as number) >= 0;
}

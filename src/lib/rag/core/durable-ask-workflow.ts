import { createHmac } from 'node:crypto';
import type { RagRetrievalScope } from '../../security/retrieval-scope';
import {
  DurableRagWorkflowAdapter,
  DurableWorkflowCancelledError,
  DurableWorkflowConflictError,
  DurableWorkflowLeaseManagementError,
  DurableWorkflowNotFoundError,
  assertDurableGenerationId,
  assertDurableWorkflowSerializable,
  buildDurableCheckpointKey,
  type DurableCheckpointStore,
  type DurableJsonObject,
  type DurableJsonValue,
  type DurableWorkflowAdapterOptions,
  type DurableWorkflowCheckpoint,
  type DurableWorkflowDefinition,
  type DurableWorkflowLeaseRecoveryResult,
  type DurableWorkflowResult,
} from './durable-workflow';
import {
  createDurableAskResultIdentity,
  type DurableAskResultArtifact,
  type DurableAskResultArtifactStore,
} from './durable-result-artifact-store';

export const DURABLE_ASK_WORKFLOW_ID = 'durable-ask';
export const DURABLE_ASK_WORKFLOW_VERSION = 'v2';
export const DURABLE_ASK_HTTP_RESULT_VERSION = 'rag-durable-ask-http-v1';
export const DURABLE_ASK_MINIMUM_LEASE_MS = 300;

export interface DurableAskCheckpointJob extends DurableJsonObject {
  queryDigest: string;
  requestDigest: string;
  routingDigest: string;
}

export interface DurableAskCheckpointState extends DurableJsonObject {
  resultArtifactId: string | null;
  responseStatus: number | null;
  kernelTraceId: string | null;
}

export interface DurableAskStoredHttpResult extends DurableJsonObject {
  schemaVersion: typeof DURABLE_ASK_HTTP_RESULT_VERSION;
  status: number;
  headers: { [key: string]: string };
  body: DurableJsonObject;
}

export interface DurableAskExecutionIdentity {
  threadId: string;
  idempotencyKey: string;
  scope: RagRetrievalScope;
  requestDigest: string;
  queryDigest: string;
  routingDigest: string;
}

export interface DurableAskInvocationResult {
  workflow: DurableWorkflowResult<
    DurableAskCheckpointJob,
    DurableAskCheckpointState
  >;
  artifact: DurableAskResultArtifact<DurableAskStoredHttpResult>;
}

export interface DurableAskDeleteResult {
  generationId: string;
  previousCheckpoint?: DurableWorkflowCheckpoint<
    DurableAskCheckpointJob,
    DurableAskCheckpointState
  >;
  checkpointDeleted: boolean;
  cleanupResumed: boolean;
  resultDeleted: boolean;
  resultDeletedCount: number;
  cleanupAcknowledged: true;
}

export interface DurableAskPublicCheckpoint {
  threadId: string;
  generationId: string;
  status: DurableWorkflowCheckpoint['status'];
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedStepIds: string[];
  lastFailureCode?: DurableWorkflowCheckpoint['lastFailureCode'];
  resultAvailable: boolean;
  activeStep?: {
    stepId: string;
    leaseExpiresAt: string;
  };
  deliveryGuarantee: 'at_least_once';
}

export interface DurableAskDigestInput {
  integrityKey: string;
  query: string;
  requestProjection: DurableJsonObject;
  routingProjection: DurableJsonObject;
}

export class DurableAskResultUnavailableError extends Error {
  readonly code = 'DURABLE_ASK_RESULT_UNAVAILABLE';

  constructor(message = 'Durable ask result artifact is unavailable.') {
    super(message);
    this.name = 'DurableAskResultUnavailableError';
  }
}

export class DurableAskIdempotencyKeyError extends Error {
  readonly code = 'DURABLE_ASK_IDEMPOTENCY_KEY_INVALID';

  constructor() {
    super('Durable ask requires a valid Idempotency-Key.');
    this.name = 'DurableAskIdempotencyKeyError';
  }
}

export function resolveDurableAskMode(
  env: NodeJS.ProcessEnv = process.env
): 'off' | 'active' {
  const mode = env.RAG_DURABLE_ASK_MODE?.trim().toLowerCase() || 'off';
  if (mode === 'off' || mode === 'active') return mode;
  throw new Error('Unsupported RAG_DURABLE_ASK_MODE: ' + mode);
}


export function resolveDurableAskLeaseDurationMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.RAG_DURABLE_WORKFLOW_LEASE_MS?.trim();
  if (!raw) return 30_000;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error('RAG_DURABLE_WORKFLOW_LEASE_MS must be a positive integer.');
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value)
    || value < DURABLE_ASK_MINIMUM_LEASE_MS
    || value > 900_000
  ) {
    throw new Error('RAG_DURABLE_WORKFLOW_LEASE_MS is outside its hard limit.');
  }
  return value;
}
export function normalizeDurableAskIdempotencyKey(value: string | null): string {
  const normalized = value?.trim();
  if (
    !normalized
    || normalized.length < 8
    || normalized.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]+$/.test(normalized)
  ) {
    throw new DurableAskIdempotencyKeyError();
  }
  return normalized;
}

export function resolveDurableAskIntegrityKey(
  env: NodeJS.ProcessEnv = process.env
): string {
  const key = env.RAG_DURABLE_WORKFLOW_INTEGRITY_KEY?.trim();
  return assertIntegrityKey(key);
}

export function createDurableAskThreadId(input: {
  integrityKey: string;
  tenantId: string;
  corpusId: string;
  actorId: string;
  idempotencyKey: string;
}): string {
  const integrityKey = assertIntegrityKey(input.integrityKey);
  const idempotencyKey = normalizeDurableAskIdempotencyKey(
    input.idempotencyKey
  );
  return 'rag-ask-' + hmac(
    integrityKey,
    'thread\u0000'
      + input.tenantId
      + '\u0000'
      + input.corpusId
      + '\u0000'
      + input.actorId
      + '\u0000'
      + idempotencyKey
  ).slice(0, 40);
}

export function createDurableAskDigests(
  input: DurableAskDigestInput
): Pick<
  DurableAskExecutionIdentity,
  'requestDigest' | 'queryDigest' | 'routingDigest'
> {
  const integrityKey = assertIntegrityKey(input.integrityKey);
  if (!input.query.trim()) {
    throw new Error('Durable ask query must not be empty.');
  }
  assertDurableWorkflowSerializable(input.requestProjection, {
    label: 'durable ask request projection',
    maxBytes: 64 * 1024,
    allowSensitiveFields: true,
  });
  assertDurableWorkflowSerializable(input.routingProjection, {
    label: 'durable ask routing projection',
    maxBytes: 32 * 1024,
    allowSensitiveFields: true,
  });
  return {
    queryDigest: 'hmac-sha256:' + hmac(
      integrityKey,
      'query\u0000' + input.query
    ),
    requestDigest: 'hmac-sha256:' + hmac(
      integrityKey,
      'request\u0000' + stableStringify(input.requestProjection)
    ),
    routingDigest: 'hmac-sha256:' + hmac(
      integrityKey,
      'routing\u0000' + stableStringify(input.routingProjection)
    ),
  };
}

export async function invokeDurableAsk(input: {
  identity: DurableAskExecutionIdentity;
  checkpointStore: DurableCheckpointStore;
  resultStore: DurableAskResultArtifactStore;
  integrityKey: string;
  signal?: AbortSignal;
  adapterOptions?: Omit<DurableWorkflowAdapterOptions, 'integrityKey'>;
  execute(input: {
    signal: AbortSignal;
    stepExecutionId: string;
  }): Promise<DurableAskStoredHttpResult>;
}): Promise<DurableAskInvocationResult> {
  let publishedArtifact: {
    artifactId: string;
    identity: DurableAskResultArtifact['identity'];
  } | null = null;
  let workflowRejected = false;

  const cleanupPublishedArtifact = async (publication: {
    artifactId: string;
    identity: DurableAskResultArtifact['identity'];
  }): Promise<void> => {
    try {
      const checkpoint = await inspectDurableAsk({
        threadId: input.identity.threadId,
        scope: input.identity.scope,
        checkpointStore: input.checkpointStore,
        resultStore: input.resultStore,
        integrityKey: input.integrityKey,
      });
      const shouldDelete = checkpoint === null
        || checkpoint.generationId !== publication.identity.generationId
        || checkpoint.status !== 'completed'
        || checkpoint.state.resultArtifactId !== publication.artifactId;
      if (shouldDelete) {
        await input.resultStore.delete(
          publication.identity,
          publication.artifactId,
          input.identity.scope
        );
      }
    } catch {
      // Cleanup is best-effort; preserve the primary workflow failure.
    }
  };

  const adapter = createDurableAskAdapter({
    checkpointStore: input.checkpointStore,
    resultStore: input.resultStore,
    integrityKey: input.integrityKey,
    execute: input.execute,
    adapterOptions: input.adapterOptions,
    async onResultPublished(publication) {
      publishedArtifact = publication;
      if (workflowRejected && input.signal?.aborted) {
        await cleanupPublishedArtifact(publication);
      }
    },
  });
  try {
    const workflow = await adapter.invoke(createInvocation(input.identity, input.signal));
    const artifact = await readDurableAskResult({
      checkpoint: workflow.checkpoint,
      resultStore: input.resultStore,
      scope: input.identity.scope,
    });
    return { workflow, artifact };
  } catch (error) {
    workflowRejected = true;
    if (publishedArtifact) {
      await cleanupPublishedArtifact(publishedArtifact);
    }
    throw error;
  }
}

export async function inspectDurableAsk(input: {
  threadId: string;
  scope: RagRetrievalScope;
  checkpointStore: DurableCheckpointStore;
  resultStore: DurableAskResultArtifactStore;
  integrityKey: string;
}): Promise<DurableWorkflowCheckpoint<
  DurableAskCheckpointJob,
  DurableAskCheckpointState
> | null> {
  return createManagementAdapter(input).inspectCheckpoint({
    threadId: input.threadId,
    scope: input.scope,
  });
}

export async function cancelDurableAsk(input: {
  threadId: string;
  scope: RagRetrievalScope;
  expectedRevision: number;
  expectedGenerationId: string;
  checkpointStore: DurableCheckpointStore;
  resultStore: DurableAskResultArtifactStore;
  integrityKey: string;
}): Promise<DurableWorkflowCheckpoint<
  DurableAskCheckpointJob,
  DurableAskCheckpointState
>> {
  return createManagementAdapter(input).cancelCheckpointForManagement({
    threadId: input.threadId,
    scope: input.scope,
  }, {
    expectedRevision: input.expectedRevision,
    expectedGenerationId: assertDurableGenerationId(
      input.expectedGenerationId
    ),
  });
}

export async function recoverDurableAsk(input: {
  threadId: string;
  scope: RagRetrievalScope;
  expectedRevision: number;
  expectedGenerationId: string;
  checkpointStore: DurableCheckpointStore;
  resultStore: DurableAskResultArtifactStore;
  integrityKey: string;
}): Promise<DurableWorkflowLeaseRecoveryResult<
  DurableAskCheckpointJob,
  DurableAskCheckpointState
>> {
  const adapter = createManagementAdapter(input);
  const checkpoint = await adapter.inspectCheckpoint({
    threadId: input.threadId,
    scope: input.scope,
  });
  if (!checkpoint) throw new DurableWorkflowNotFoundError();
  const expectedGenerationId = assertDurableGenerationId(
    input.expectedGenerationId
  );
  if (checkpoint.generationId !== expectedGenerationId) {
    throw new DurableWorkflowConflictError();
  }
  if (!checkpoint.activeStep) {
    throw new DurableWorkflowLeaseManagementError(
      'Expired-lease recovery requires an active durable ask step.'
    );
  }
  return adapter.releaseExpiredLeaseForManagement({
    threadId: input.threadId,
    scope: input.scope,
  }, {
    expectedRevision: input.expectedRevision,
    expectedGenerationId,
    leaseOwnerId: checkpoint.activeStep.leaseOwnerId,
  });
}

export async function deleteDurableAsk(input: {
  threadId: string;
  scope: RagRetrievalScope;
  expectedRevision: number;
  expectedGenerationId: string;
  checkpointStore: DurableCheckpointStore;
  resultStore: DurableAskResultArtifactStore;
  integrityKey: string;
}): Promise<DurableAskDeleteResult> {
  if (
    !input.checkpointStore.delete
    || !input.checkpointStore.hasDeletionTombstone
    || !input.checkpointStore.acknowledgeDeletionCleanup
    || !input.resultStore.deleteAll
  ) {
    throw new DurableWorkflowLeaseManagementError(
      'Durable ask deletion requires revision tombstones and exact identity cleanup.'
    );
  }
  const checkpointKey = buildDurableCheckpointKey(
    DURABLE_ASK_WORKFLOW_ID,
    input.threadId,
    input.scope.tenantId
  );
  const expectedGenerationId = assertDurableGenerationId(
    input.expectedGenerationId
  );
  const checkpoint = await createManagementAdapter(input).inspectCheckpoint({
    threadId: input.threadId,
    scope: input.scope,
  });
  let checkpointDeleted = false;
  let cleanupResumed = false;
  if (checkpoint) {
    if (checkpoint.checkpointKey !== checkpointKey) {
      throw new DurableWorkflowConflictError();
    }
    if (checkpoint.generationId !== expectedGenerationId) {
      cleanupResumed = await input.checkpointStore.hasDeletionTombstone(
        checkpointKey,
        {
          expectedRevision: input.expectedRevision,
          expectedGenerationId,
        }
      );
      if (!cleanupResumed) throw new DurableWorkflowConflictError();
    } else {
      if (checkpoint.revision !== input.expectedRevision) {
        throw new DurableWorkflowConflictError();
      }
      if (
        checkpoint.status !== 'completed'
        && checkpoint.status !== 'failed'
        && checkpoint.status !== 'cancelled'
      ) {
        throw new DurableWorkflowLeaseManagementError(
          'Only terminal durable ask workflows may be deleted.'
        );
      }
      checkpointDeleted = await input.checkpointStore.delete(
        checkpoint.checkpointKey,
        {
          expectedRevision: input.expectedRevision,
          expectedGenerationId,
        }
      );
      if (!checkpointDeleted) {
        cleanupResumed = await input.checkpointStore.hasDeletionTombstone(
          checkpointKey,
          {
            expectedRevision: input.expectedRevision,
            expectedGenerationId,
          }
        );
      }
    }
  } else {
    cleanupResumed = await input.checkpointStore.hasDeletionTombstone(
      checkpointKey,
      {
        expectedRevision: input.expectedRevision,
        expectedGenerationId,
      }
    );
  }
  if (!checkpointDeleted && !cleanupResumed) {
    throw new DurableWorkflowNotFoundError();
  }
  const resultDeletedCount = await input.resultStore.deleteAll(
    createDurableAskResultIdentity({
      generationId: expectedGenerationId,
      threadId: input.threadId,
      scope: input.scope,
    }),
    input.scope
  );
  await input.checkpointStore.acknowledgeDeletionCleanup(
    checkpointKey,
    {
      expectedRevision: input.expectedRevision,
      expectedGenerationId,
    }
  );
  return {
    generationId: expectedGenerationId,
    ...(checkpoint?.generationId === expectedGenerationId
      ? { previousCheckpoint: checkpoint }
      : {}),
    checkpointDeleted,
    cleanupResumed,
    resultDeleted: resultDeletedCount > 0,
    resultDeletedCount,
    cleanupAcknowledged: true,
  };
}

export async function readDurableAskResult(input: {
  checkpoint: DurableWorkflowCheckpoint<
    DurableAskCheckpointJob,
    DurableAskCheckpointState
  >;
  resultStore: DurableAskResultArtifactStore;
  scope: RagRetrievalScope;
}): Promise<DurableAskResultArtifact<DurableAskStoredHttpResult>> {
  const artifactId = input.checkpoint.state.resultArtifactId;
  if (input.checkpoint.status !== 'completed' || !artifactId) {
    throw new DurableAskResultUnavailableError(
      'Durable ask has not completed with a result artifact.'
    );
  }
  const artifact = await input.resultStore.get<DurableAskStoredHttpResult>(
    createDurableAskResultIdentity({
      generationId: input.checkpoint.generationId,
      threadId: input.checkpoint.identity.threadId,
      scope: {
        tenantId: input.checkpoint.identity.tenantId,
        corpusId: input.checkpoint.identity.corpusId,
        allowedTrustLevels: input.checkpoint.identity
          .allowedTrustLevels as RagRetrievalScope['allowedTrustLevels'],
        enforceIsolation: input.checkpoint.identity.enforceIsolation,
      },
    }),
    artifactId,
    input.scope
  );
  if (!artifact) throw new DurableAskResultUnavailableError();
  assertDurableAskStoredHttpResult(artifact.result);
  if (artifact.result.status !== input.checkpoint.state.responseStatus) {
    throw new DurableAskResultUnavailableError(
      'Durable ask checkpoint and result status do not match.'
    );
  }
  const traceId = artifact.result.headers['x-rag-trace-id'] ?? null;
  if (traceId !== input.checkpoint.state.kernelTraceId) {
    throw new DurableAskResultUnavailableError(
      'Durable ask checkpoint and result trace do not match.'
    );
  }
  return artifact;
}

export function projectDurableAskCheckpoint(
  checkpoint: DurableWorkflowCheckpoint<
    DurableAskCheckpointJob,
    DurableAskCheckpointState
  >
): DurableAskPublicCheckpoint {
  return {
    threadId: checkpoint.identity.threadId,
    generationId: checkpoint.generationId,
    status: checkpoint.status,
    revision: checkpoint.revision,
    createdAt: checkpoint.createdAt,
    updatedAt: checkpoint.updatedAt,
    completedStepIds: [...checkpoint.completedStepIds],
    ...(checkpoint.lastFailureCode
      ? { lastFailureCode: checkpoint.lastFailureCode }
      : {}),
    resultAvailable: checkpoint.status === 'completed'
      && typeof checkpoint.state.resultArtifactId === 'string',
    ...(checkpoint.activeStep
      ? {
          activeStep: {
            stepId: checkpoint.activeStep.stepId,
            leaseExpiresAt: checkpoint.activeStep.leaseExpiresAt,
          },
        }
      : {}),
    deliveryGuarantee: 'at_least_once',
  };
}

export function assertDurableAskStoredHttpResult(
  value: unknown
): asserts value is DurableAskStoredHttpResult {
  if (
    !isRecord(value)
    || value.schemaVersion !== DURABLE_ASK_HTTP_RESULT_VERSION
    || !Number.isInteger(value.status)
    || (value.status as number) < 100
    || (value.status as number) > 599
    || !isRecord(value.headers)
    || !isRecord(value.body)
  ) {
    throw new DurableAskResultUnavailableError(
      'Durable ask result artifact has an invalid HTTP projection.'
    );
  }
  const headers = value.headers as Record<string, unknown>;
  if (
    Object.keys(headers).length > 16
    || Object.entries(headers).some(([key, headerValue]) => (
      !DURABLE_ASK_RESPONSE_HEADERS.has(key)
      || typeof headerValue !== 'string'
      || headerValue.length > 512
    ))
  ) {
    throw new DurableAskResultUnavailableError(
      'Durable ask result artifact contains invalid response headers.'
    );
  }
  assertDurableWorkflowSerializable(value.body, {
    label: 'durable ask response body',
    maxBytes: 8 * 1024 * 1024,
    allowSensitiveFields: true,
  });
}

const DURABLE_ASK_RESPONSE_HEADERS = new Set([
  'x-rag-policy',
  'x-rag-trace-id',
  'x-rag-status',
  'x-langsmith-run-id',
  'x-langsmith-thread-id',
  'x-langsmith-project',
]);

function createDurableAskAdapter(input: {
  checkpointStore: DurableCheckpointStore;
  resultStore: DurableAskResultArtifactStore;
  integrityKey: string;
  execute(input: {
    signal: AbortSignal;
    stepExecutionId: string;
  }): Promise<DurableAskStoredHttpResult>;
  adapterOptions?: Omit<DurableWorkflowAdapterOptions, 'integrityKey'>;
  onResultPublished?(publication: {
    artifactId: string;
    identity: DurableAskResultArtifact['identity'];
  }): Promise<void> | void;
}): DurableRagWorkflowAdapter<
  DurableAskCheckpointJob,
  DurableAskCheckpointState
> {
  const integrityKey = assertIntegrityKey(input.integrityKey);
  const leaseDurationMs = assertDurableAskLeaseDurationMs(
    input.adapterOptions?.leaseDurationMs ?? 30_000
  );
  const definition: DurableWorkflowDefinition<
    DurableAskCheckpointJob,
    DurableAskCheckpointState
  > = {
    id: DURABLE_ASK_WORKFLOW_ID,
    version: DURABLE_ASK_WORKFLOW_VERSION,
    projectJobForCheckpoint(job) {
      return {
        queryDigest: assertDigest(job.queryDigest, 'queryDigest'),
        requestDigest: assertDigest(job.requestDigest, 'requestDigest'),
        routingDigest: assertDigest(job.routingDigest, 'routingDigest'),
      };
    },
    projectStateForCheckpoint(state) {
      return {
        resultArtifactId: optionalArtifactId(state.resultArtifactId),
        responseStatus: optionalResponseStatus(state.responseStatus),
        kernelTraceId: optionalTraceId(state.kernelTraceId),
      };
    },
    createInitialState() {
      return {
        resultArtifactId: null,
        responseStatus: null,
        kernelTraceId: null,
      };
    },
    steps: [{
      id: 'execute-ask',
      async execute(context) {
        const heartbeat = startDurableAskLeaseHeartbeat(
          context,
          leaseDurationMs
        );
        try {
          const result = await input.execute({
            signal: heartbeat.signal,
            stepExecutionId: context.stepExecutionId,
          });
          if (context.signal.aborted) {
            throw new DurableWorkflowCancelledError('execute-ask');
          }
          assertDurableAskStoredHttpResult(result);
          await context.renewLease();
          const publicationResult: DurableAskStoredHttpResult = {
            ...result,
            publicationAttemptDigest: 'hmac-sha256:' + hmac(
              integrityKey,
              'publication-attempt\u0000' + context.executionAttemptId
            ),
          };
          const artifact = await input.resultStore.put({
            identity: createDurableAskResultIdentity({
              generationId: context.generationId,
              threadId: context.identity.threadId,
              scope: {
                tenantId: context.identity.tenantId,
                corpusId: context.identity.corpusId,
                allowedTrustLevels: context.identity
                  .allowedTrustLevels as RagRetrievalScope['allowedTrustLevels'],
                enforceIsolation: context.identity.enforceIsolation,
              },
            }),
            result: publicationResult,
          });
          await input.onResultPublished?.({
            artifactId: artifact.artifactId,
            identity: artifact.identity,
          });
          if (context.signal.aborted) {
            throw new DurableWorkflowCancelledError('execute-ask');
          }
          await context.renewLease();
          const renewalError = await heartbeat.stop();
          if (renewalError) throw renewalError;
          return {
            resultArtifactId: artifact.artifactId,
            responseStatus: result.status,
            kernelTraceId: result.headers['x-rag-trace-id'] ?? null,
          };
        } catch (error) {
          const renewalError = await heartbeat.stop();
          if (renewalError) throw renewalError;
          throw error;
        }
      },
    }],
  };
  return new DurableRagWorkflowAdapter(definition, input.checkpointStore, {
    ...input.adapterOptions,
    leaseDurationMs,
    integrityKey,
  });
}

function assertDurableAskLeaseDurationMs(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value < DURABLE_ASK_MINIMUM_LEASE_MS
    || value > 900_000
  ) {
    throw new Error(
      'Durable ask lease duration must be between '
        + DURABLE_ASK_MINIMUM_LEASE_MS
        + ' and 900000 milliseconds.'
    );
  }
  return value;
}

function startDurableAskLeaseHeartbeat(
  context: {
    signal: AbortSignal;
    renewLease(): Promise<unknown>;
  },
  leaseDurationMs: number
): {
  signal: AbortSignal;
  stop(): Promise<unknown | null>;
} {
  const heartbeatController = new AbortController();
  const signal = AbortSignal.any([
    context.signal,
    heartbeatController.signal,
  ]);
  const intervalMs = Math.max(
    100,
    Math.min(10_000, Math.floor(leaseDurationMs / 3))
  );
  let stopped = false;
  let renewalPending = false;
  let renewalError: unknown | null = null;
  let renewalInFlight: Promise<void> = Promise.resolve();
  let stopPromise: Promise<unknown | null> | undefined;
  const timer = setInterval(() => {
    if (stopped || renewalPending) return;
    renewalPending = true;
    renewalInFlight = context.renewLease().then(
      () => undefined,
      error => {
        renewalError = error;
        stopped = true;
        clearInterval(timer);
        heartbeatController.abort(error);
      }
    ).finally(() => {
      renewalPending = false;
    });
  }, intervalMs);
  (timer as NodeJS.Timeout).unref?.();

  return {
    signal,
    stop() {
      if (!stopPromise) {
        stopped = true;
        clearInterval(timer);
        stopPromise = renewalInFlight.then(() => renewalError);
      }
      return stopPromise;
    },
  };
}
function createManagementAdapter(input: {
  checkpointStore: DurableCheckpointStore;
  resultStore: DurableAskResultArtifactStore;
  integrityKey: string;
}): DurableRagWorkflowAdapter<
  DurableAskCheckpointJob,
  DurableAskCheckpointState
> {
  return createDurableAskAdapter({
    ...input,
    async execute() {
      throw new DurableWorkflowLeaseManagementError(
        'Management-only durable ask adapters cannot execute a workflow step.'
      );
    },
  });
}

function createInvocation(
  identity: DurableAskExecutionIdentity,
  signal?: AbortSignal
) {
  return {
    threadId: identity.threadId,
    idempotencyKey: normalizeDurableAskIdempotencyKey(identity.idempotencyKey),
    scope: identity.scope,
    documentId: 'corpus:' + identity.scope.corpusId,
    documentVersion: assertDigest(identity.requestDigest, 'requestDigest'),
    job: {
      requestDigest: assertDigest(identity.requestDigest, 'requestDigest'),
      queryDigest: assertDigest(identity.queryDigest, 'queryDigest'),
      routingDigest: assertDigest(identity.routingDigest, 'routingDigest'),
    },
    signal,
  };
}

function assertIntegrityKey(value: string | undefined): string {
  const key = value?.trim();
  if (!key || key.length < 32 || key.length > 4096) {
    throw new Error(
      'RAG_DURABLE_WORKFLOW_INTEGRITY_KEY must contain between 32 and 4096 characters.'
    );
  }
  return key;
}

function assertDigest(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || !/^hmac-sha256:[a-f0-9]{64}$/.test(value)
  ) {
    throw new Error(field + ' must be a HMAC-SHA256 digest.');
  }
  return value;
}

function optionalArtifactId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error('resultArtifactId must be null or a SHA-256 artifact ID.');
  }
  return value;
}

function optionalResponseStatus(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || (value as number) < 100 || (value as number) > 599) {
    throw new Error('responseStatus must be null or a valid HTTP status.');
  }
  return value as number;
}

function optionalTraceId(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string'
    || value.length > 256
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new Error('kernelTraceId must be null or a safe trace identifier.');
  }
  return value;
}

function hmac(key: string, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

function stableStringify(value: DurableJsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  return '{' + Object.keys(value).sort().map(key => (
    JSON.stringify(key) + ':' + stableStringify(value[key])
  )).join(',') + '}';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

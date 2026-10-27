import { types as nodeTypes } from 'node:util';

export const DURABLE_FIRST_POST_DIAGNOSTIC_MARKER = '[ask-durable-first-post/v1] ';

const durableFirstPostCodes = new Set([
  'MODEL_LOADING', 'MODEL_LOAD_FAILED', 'RAG_INDEX_BUILDING', 'VECTOR_BACKEND_DISABLED',
  'RAG_REQUEST_ABORTED', 'RAG_GENERATION_TIMEOUT', 'RAG_LANE_TIMEOUT',
  'RAG_GENERATION_PROVIDER_BUSY', 'RAG_LANE_PROVIDER_BUSY',
  'AGENTIC_QUERY_FAILED', 'RAG_POLICY_FAILED',
  'DURABLE_ASK_DISABLED', 'DURABLE_ASK_INTERNAL_ERROR',
  'DURABLE_ASK_IDEMPOTENCY_KEY_INVALID', 'DURABLE_WORKFLOW_BUSY',
  'DURABLE_WORKFLOW_CANCELLED', 'DURABLE_WORKFLOW_FAILED',
  'DURABLE_CHECKPOINT_CONFLICT', 'DURABLE_WORKFLOW_LEASE_MANAGEMENT_REJECTED',
  'DURABLE_ASK_RESULT_CONFLICT', 'WORKFLOW_VERSION_MISMATCH', 'SCOPE_MISMATCH',
  'DOCUMENT_ID_MISMATCH', 'DOCUMENT_VERSION_MISMATCH',
  'IDEMPOTENCY_KEY_MISMATCH', 'JOB_FINGERPRINT_MISMATCH',
  'DURABLE_WORKFLOW_NOT_FOUND', 'DURABLE_WORKFLOW_PAUSED',
  'DURABLE_ASK_RESULT_UNAVAILABLE', 'DURABLE_ASK_RESULT_CAPACITY',
  'DURABLE_ASK_RESULT_INTEGRITY', 'DURABLE_CHECKPOINT_INTEGRITY',
  'DURABLE_WORKFLOW_CONFIGURATION_INVALID',
  'DURABLE_WORKFLOW_SHARED_CONTROL_PLANE_REQUIRED',
  'DURABLE_CHECKPOINT_SCAN_LIMIT', 'DURABLE_CHECKPOINT_CAPACITY_EXCEEDED',
]);
const durableFirstPostStatuses = new Set([
  'pending', 'running', 'paused', 'completed', 'cancelled', 'failed',
]);

function readDurableFirstPostData(value, key) {
  // A failure diagnostic must not execute arbitrary getters or Proxy traps.
  if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function durableFirstPostCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 'unknown';
}

export function formatDurableFirstPostDiagnostic(input) {
  return formatDurableFirstPostForCase(input, 'durable-agentic-replay-first-post/v1');
}

export function formatDurableBoundedFirstPostDiagnostic(input) {
  return formatDurableFirstPostForCase(input, 'durable-bounded-replay-first-post/v1');
}

function formatDurableFirstPostForCase(input, caseTag) {
  const status = readDurableFirstPostData(input, 'status');
  const body = readDurableFirstPostData(input, 'body');
  const bodyCode = readDurableFirstPostData(body, 'code');
  const durable = readDurableFirstPostData(body, 'durable');
  const durableStatus = readDurableFirstPostData(durable, 'status');
  const durableReplay = readDurableFirstPostData(durable, 'replay');
  const milvus = readDurableFirstPostData(input, 'milvusSignals');
  const model = readDurableFirstPostData(input, 'modelSignals');
  return DURABLE_FIRST_POST_DIAGNOSTIC_MARKER + JSON.stringify({
    caseTag,
    site: 'first-post-status',
    status: Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : 'unknown',
    bodyCode: typeof bodyCode === 'string' && durableFirstPostCodes.has(bodyCode) ? bodyCode : 'unknown',
    durableStatus: typeof durableStatus === 'string' && durableFirstPostStatuses.has(durableStatus) ? durableStatus : 'unknown',
    durableReplay: typeof durableReplay === 'boolean' ? durableReplay : 'unknown',
    milvusConnect: durableFirstPostCount(readDurableFirstPostData(milvus, 'connect')),
    milvusSearch: durableFirstPostCount(readDurableFirstPostData(milvus, 'search')),
    modelEmbed: durableFirstPostCount(readDurableFirstPostData(model, 'embed')),
    modelGenerate: durableFirstPostCount(readDurableFirstPostData(model, 'generate')),
    scopedAgentCalls: durableFirstPostCount(readDurableFirstPostData(input, 'scopedAgentCalls')),
  });
}

export function parseDurableFirstPostDiagnosticMessage(message) {
  if (typeof message !== 'string' || message.length > 4096
    || !message.startsWith(DURABLE_FIRST_POST_DIAGNOSTIC_MARKER)) return null;
  let record;
  try {
    record = JSON.parse(message.slice(DURABLE_FIRST_POST_DIAGNOSTIC_MARKER.length));
  } catch {
    return null;
  }
  // Only owner-defined sites select a formatter. Caller labels never create a
  // new diagnostic category or turn arbitrary response text into metadata.
  const caseTag = readDurableFirstPostData(record, 'caseTag');
  const formatter = caseTag === 'durable-agentic-replay-first-post/v1' ? formatDurableFirstPostDiagnostic
    : caseTag === 'durable-bounded-replay-first-post/v1' ? formatDurableBoundedFirstPostDiagnostic : null;
  if (formatter === null) return null;
  const canonical = formatter({
    status: readDurableFirstPostData(record, 'status'),
    body: {
      code: readDurableFirstPostData(record, 'bodyCode'),
      durable: {
        status: readDurableFirstPostData(record, 'durableStatus'),
        replay: readDurableFirstPostData(record, 'durableReplay'),
      },
    },
    milvusSignals: {
      connect: readDurableFirstPostData(record, 'milvusConnect'),
      search: readDurableFirstPostData(record, 'milvusSearch'),
    },
    modelSignals: {
      embed: readDurableFirstPostData(record, 'modelEmbed'),
      generate: readDurableFirstPostData(record, 'modelGenerate'),
    },
    scopedAgentCalls: readDurableFirstPostData(record, 'scopedAgentCalls'),
  });
  // Exact reconstruction rejects unknown/extra/duplicate keys and values instead
  // of carrying unchecked text from the assertion message into diagnostics.
  return canonical === message ? record : null;
}

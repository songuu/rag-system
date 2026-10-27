import { types } from 'node:util';

export type DurableDiagnosticChainTermination = 'end' | 'depth-limit' | 'cycle' | 'accessor' | 'proxy' | 'non-object' | 'uninspectable';
export interface DurableErrorDiagnostic {
  readonly codeChain: readonly string[];
  /** Safely inspected object/function levels; primitive and Proxy tails do not count. */
  readonly causeDepth: number;
  readonly chainTermination: DurableDiagnosticChainTermination;
}

export type DurableSystemCall = 'mkdir' | 'open' | 'read' | 'write' | 'writev' | 'fsync' | 'fdatasync'
  | 'close' | 'link' | 'rename' | 'unlink' | 'rmdir' | 'stat' | 'lstat' | 'scandir' | 'realpath';
export interface DurableIoErrorDiagnostic extends DurableErrorDiagnostic {
  readonly systemCall: DurableSystemCall | null;
}

const MAX_OBJECT_LEVELS = 8;
// Keep this private and exact. Provider text that resembles a code must not
// become a public diagnostic, nor does a listed code authenticate its issuer.
const allowedCodes = new Set<string>([
  'DURABLE_CHECKPOINT_CONFLICT', 'DURABLE_WORKFLOW_NOT_FOUND', 'DURABLE_CHECKPOINT_CAPACITY_EXCEEDED',
  'DURABLE_WORKFLOW_LEASE_MANAGEMENT_REJECTED', 'DURABLE_WORKFLOW_BUSY', 'DURABLE_WORKFLOW_STEP_FAILED', 'DURABLE_WORKFLOW_CANCELLED',
  'DURABLE_WORKFLOW_TERMINAL_STEP_FAILURE', 'DURABLE_WORKFLOW_FAILED', 'WORKFLOW_VERSION_MISMATCH', 'SCOPE_MISMATCH',
  'DOCUMENT_ID_MISMATCH', 'DOCUMENT_VERSION_MISMATCH', 'IDEMPOTENCY_KEY_MISMATCH', 'JOB_FINGERPRINT_MISMATCH',
  'DURABLE_ASK_RESULT_CAPACITY', 'DURABLE_ASK_RESULT_CONFLICT', 'DURABLE_ASK_RESULT_INTEGRITY', 'DURABLE_CHECKPOINT_INTEGRITY',
  'DURABLE_CHECKPOINT_SCAN_LIMIT', 'DURABLE_WORKFLOW_CONFIGURATION_INVALID', 'DURABLE_WORKFLOW_SHARED_CONTROL_PLANE_REQUIRED',
  'DURABLE_ASK_RESULT_UNAVAILABLE', 'DURABLE_ASK_IDEMPOTENCY_KEY_INVALID', 'DURABLE_ASK_DISABLED', 'DURABLE_WORKFLOW_PAUSED',
  'ASK_INTERNAL_ERROR', 'DURABLE_ASK_INTERNAL_ERROR', 'AGENTIC_QUERY_FAILED', 'RAG_AGENT_PROVIDER_FAILED',
  'ENOENT', 'EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOSPC', 'EIO',
]);
const filesystemCodes = new Set(['ENOENT', 'EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOSPC', 'EIO']);
const systemCalls = new Set<DurableSystemCall>([
  'mkdir', 'open', 'read', 'write', 'writev', 'fsync', 'fdatasync', 'close',
  'link', 'rename', 'unlink', 'rmdir', 'stat', 'lstat', 'scandir', 'realpath',
]);
const isProxy = types.isProxy;
const ownDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const freeze = Object.freeze;
const intrinsicApply = Reflect.apply;
const allowedHas = Set.prototype.has;

/** Bounded attribution metadata only. Never inspect name/message/stack, walk
 * prototypes, coerce input, or execute caller accessors/Proxy reflection hooks. */
export function safeDurableErrorDiagnostic(input: unknown): DurableErrorDiagnostic;
export function safeDurableErrorDiagnostic(input: unknown, includeSystemCall: true): DurableIoErrorDiagnostic;
export function safeDurableErrorDiagnostic(input: unknown, includeSystemCall = false): DurableErrorDiagnostic | DurableIoErrorDiagnostic {
  const withIo = includeSystemCall === true;
  let systemCall: DurableSystemCall | null = null;
  const codeChain: string[] = []; const seen = new Set<object>(); let causeDepth = 0; let current = input;
  const finish = (chainTermination: DurableDiagnosticChainTermination): DurableErrorDiagnostic | DurableIoErrorDiagnostic => {
    const diagnostic = { codeChain: freeze(codeChain), causeDepth, chainTermination };
    // Legacy callers retain their exact record shape; IO attribution is explicit and never authoritative.
    return withIo ? freeze({ ...diagnostic, systemCall }) : freeze(diagnostic);
  };
  for (;;) {
    if (causeDepth >= MAX_OBJECT_LEVELS) return finish('depth-limit');
    // This native predicate also recognizes revoked and callable Proxies.
    if (isProxy(current)) { codeChain.push('UNCLASSIFIED'); return finish('proxy'); }
    if (current === null || typeof current !== 'object' && typeof current !== 'function') {
      codeChain.push('UNCLASSIFIED'); return finish('non-object');
    }
    if (seen.has(current)) return finish('cycle'); seen.add(current);
    let code: PropertyDescriptor | undefined; let cause: PropertyDescriptor | undefined;
    try { code = ownDescriptor(current, 'code'); cause = ownDescriptor(current, 'cause'); }
    catch { codeChain.push('UNCLASSIFIED'); return finish('uninspectable'); }
    causeDepth++;
    const codeIsData = code !== undefined && hasOwn(code, 'value');
    const codeValue = code !== undefined && codeIsData && typeof code.value === 'string' && intrinsicApply(allowedHas, allowedCodes, [code.value]) ? code.value : 'UNCLASSIFIED';
    codeChain.push(codeValue);
    if (withIo && systemCall === null && intrinsicApply(allowedHas, filesystemCodes, [codeValue])) {
      let syscall: PropertyDescriptor | undefined;
      try { syscall = ownDescriptor(current, 'syscall'); }
      catch { return finish('uninspectable'); }
      if (syscall !== undefined && hasOwn(syscall, 'value') && typeof syscall.value === 'string'
        && intrinsicApply(allowedHas, systemCalls, [syscall.value])) systemCall = syscall.value as DurableSystemCall;
    }
    if (code !== undefined && !codeIsData || cause !== undefined && !hasOwn(cause, 'value')) return finish('accessor');
    if (cause === undefined || cause.value === null || cause.value === undefined) return finish('end');
    current = cause.value;
  }
}

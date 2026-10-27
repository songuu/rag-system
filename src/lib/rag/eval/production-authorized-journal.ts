import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { createReferenceApprovalVerifier, RECOVERY_ALLOWED_ACTIONS, validateAuthorizationEnvelope } from './production-authorization';
import type { AuthorizationEnvelope, ExecutionAuthorizationPayload, ReferenceApprovalVerifier } from './production-authorization';
import type { ArtifactReference, ProductionGateStage } from './production-gate-manifest';
import { createJournalEntry, createReferenceJournalStore, JOURNAL_SCHEMA_VERSION, validateJournalChain } from './production-run-journal';
import type { JournalAppendResult, JournalBinding, JournalEntry, JournalHead } from './production-run-journal';

export const REFERENCE_AUTHORIZED_JOURNAL_SCHEMA = 'kg-reference-authorized-journal/v1' as const;
export interface JournalPrincipal {
  readonly actorId: string;
  readonly roleId: string | null;
  readonly credentialRef: ArtifactReference | null;
}
export interface AuthorizedJournalWriteResult {
  readonly validationLevel: 'enterprise-authorized-write' | 'local-reference-authorized-write';
  readonly productionAccepted: false;
  readonly status: JournalAppendResult['status'];
  readonly entry: JournalEntry | null;
  readonly head: JournalHead;
}
export interface JournalAuthorizationRegistration {
  readonly validationLevel: 'enterprise-cryptographic' | 'local-reference-cryptographic';
  readonly productionAuthorized: boolean;
  readonly signatureVerified: true;
  readonly authorizationRef: ArtifactReference;
  readonly fencingGeneration: number;
}
export interface ReferenceJournalAuthorizationRegistration extends JournalAuthorizationRegistration {
  readonly validationLevel: 'local-reference-cryptographic';
  readonly productionAuthorized: false;
}
/** An append alone never proves stage acceptance. Enterprise implementations
 * must enforce approval/time/revocation/fencing at the transactional commit. */
export interface AuthorizedRunJournalPort {
  readonly executionProfile: 'enterprise' | 'local-reference';
  readonly productionCapable: boolean;
  authorizeExecution(input: unknown): Promise<JournalAuthorizationRegistration>;
  authorizeRecovery(input: unknown): Promise<JournalAuthorizationRegistration>;
  append(input: unknown): Promise<AuthorizedJournalWriteResult>;
  readHead(): Promise<JournalHead>;
  readEntries(): Promise<readonly JournalEntry[]>;
}
export interface ReferenceAuthorizedJournal extends AuthorizedRunJournalPort {
  readonly executionProfile: 'local-reference';
  readonly productionCapable: false;
  authorizeExecution(input: unknown): Promise<ReferenceJournalAuthorizationRegistration>;
  authorizeRecovery(input: unknown): Promise<ReferenceJournalAuthorizationRegistration>;
  /** Local conformance seams, not clock/IAM/lease/revocation authorities. */
  referenceAdvanceTime(time: string): void;
  referenceAdvanceFence(generation: number): Promise<JournalHead>;
  referenceRevokeAuthorization(digest: string): void;
  referenceRevokeSigner(keyId: string, keyVersion: string): void;
}
type Fields = Record<string, unknown>;
interface Grant { readonly ref: ArtifactReference; readonly envelope: AuthorizationEnvelope; readonly generation: number }
interface RoleReference { readonly role: string; readonly ref: ArtifactReference }
interface RecoveryPolicy {
  readonly schemaVersion: 'kg-safety-recovery-policy/v1'; readonly authorityId: string;
  readonly roleId: string; readonly scopeHash: string; readonly allowedActions: readonly string[];
  readonly lineage: { readonly predecessorRef: ArtifactReference; readonly targetRef: ArtifactReference; readonly expectedPointerRevision: number };
  readonly maxAuthorizationTtlMs: number; readonly credentialPolicyRef: ArtifactReference; readonly policyHash: string;
}
const APPEND_FIELDS = ['expectedHead', 'authorizationRef', 'principal', 'kind', 'idempotencyKey', 'action',
  'parametersDigest', 'beforeDigest', 'afterDigest', 'intentDigest', 'outcome'];
/** Shared by the writer and readback verifier: acceptance must not validate a
 * wider stage action set than the authoritative write path. */
export const STAGE_EXECUTION_ACTIONS: Readonly<Record<ProductionGateStage, readonly string[]>> = Object.freeze({
  T16: Object.freeze(['ask-off', 'ask-shadow', 'readback', 'seal-run']),
  T17: Object.freeze(['ask-off', 'ask-active', 'readback', 'publish-pointer', 'ack-outbox', 'set-off', 'activate',
    'increase-traffic', 'withdraw-traffic', 'inject-fault', 'revoke-existing-fault', 'rollback-to-predecessor', 'seal-run']),
  R18: Object.freeze(['readback', 'seal-run']),
});

/** Reference ownership is deliberate: a caller cannot replace a commit port
 * with an async wrapper between the final authority check and the atomic CAS.
 * Options/clock/identity/keyring are test data, not enterprise trust roots. */
export function createReferenceAuthorizedJournal(input: unknown): ReferenceAuthorizedJournal {
  const options = snapshot(input, 'options');
  exact(options, ['schemaVersion', 'executionProfile', 'expectedExecutionPayload', 'executionAuthorizationRef',
    'originalFencingGeneration', 'recoveryPolicy', 'recoveryActorId', 'initialTime', 'approvalOptions'], 'options');
  if (options.schemaVersion !== REFERENCE_AUTHORIZED_JOURNAL_SCHEMA || options.executionProfile !== 'local-reference') fail('options.profile', 'reference-only versioned configuration required');
  const expected = expectedExecution(options.expectedExecutionPayload);
  const executionRef = reference(options.executionAuthorizationRef, 'options.executionAuthorizationRef');
  const originalGeneration = integer(options.originalFencingGeneration, 1, Number.MAX_SAFE_INTEGER, 'options.originalFencingGeneration');
  if (expected.stage === 'T17' && originalGeneration === Number.MAX_SAFE_INTEGER) fail('options.fencing', 'canary requires a safe new recovery generation budget');
  const binding: JournalBinding = freeze({ ...expected.scope, scopeHash: canonicalJsonSha256(expected.scope),
    runNonce: expected.runNonce, manifestHash: expected.manifestHash });
  const policy = recoveryPolicy(options.recoveryPolicy, expected, binding.scopeHash);
  const frozenReferences: RoleReference[] = [{ role: 'execution-authorization', ref: executionRef },
    { role: 'registry', ref: expected.registryRef }, ...(policy ? [
      { role: 'credential-policy', ref: policy.credentialPolicyRef },
      { role: 'lineage-predecessor', ref: policy.lineage.predecessorRef },
      { role: 'lineage-target', ref: policy.lineage.targetRef }] : [])];
  assertReferenceRoles(frozenReferences);
  if (expected.stage === 'T17') {
    identifier(options.recoveryActorId, 'options.recoveryActorId');
    if (Object.values(expected.participants).includes(options.recoveryActorId as string)) fail('options.recoveryActorId', 'rescue principal must be independently assigned');
  } else if (options.recoveryActorId !== null) fail('options.recoveryActorId', 'non-canary stage has no rescue principal');
  const approvalOptions = record(options.approvalOptions, 'options.approvalOptions');
  if (approvalOptions.executionProfile !== 'local-reference') fail('options.approvalOptions', 'reference verifier required');
  integer(approvalOptions.maxConsumedNonces, 1, 17, 'options.approvalOptions.maxConsumedNonces');
  const verifier: ReferenceApprovalVerifier = checked('options.keyring', () => createReferenceApprovalVerifier(approvalOptions));
  const keys = approvalOptions.keys as Fields[];
  let now = timestamp(options.initialTime, 'options.initialTime');
  const grants = new Map<string, Grant>();
  const pending = new Map<string, { readonly ref: ArtifactReference; readonly credentialRef: ArtifactReference }>();
  const revoked = new Set<string>(); const revokedKeys = new Set<string>(); let revocationCapacityExhausted = false;
  const store = createReferenceJournalStore({ executionProfile: 'local-reference', binding, initialFencingGeneration: originalGeneration });
  // Functions are from our own frozen adapter, never caller-supplied capabilities.
  const { readHead, readEntries, compareAndAppend, advanceFence } = store;
  const signerIdentity = (keyId: string, keyVersion: string) => canonicalJson([keyId, keyVersion]);
  const registration = (grant: Grant): ReferenceJournalAuthorizationRegistration => freeze({
    validationLevel: 'local-reference-cryptographic', productionAuthorized: false, signatureVerified: true,
    authorizationRef: grant.ref, fencingGeneration: grant.generation });

  function assertLive(grant: Grant, generation: number): void {
    if (revocationCapacityExhausted) fail('authorization.revocation', 'revocation capacity exhausted; all authorizations fail closed');
    if (grant.generation !== generation) fail('append.fencing', 'authorization is bound to another fencing generation');
    const { payload, signature } = grant.envelope;
    if (revoked.has(grant.ref.sha256) || revokedKeys.has(signerIdentity(signature.keyId, signature.keyVersion))) fail('authorization.revocation', 'authorization or signer is revoked');
    if (now < Date.parse(payload.notBefore) || now >= Date.parse(payload.expiresAt)) fail('authorization.validity', 'authorization not effective or expired');
    if (grant.envelope.kind === 'execution') {
      const window = grant.envelope.payload.window;
      if (now < Date.parse(window.startsAt) || now >= Date.parse(window.endsAt)) fail('authorization.validity', 'execution window is closed');
    }
  }
  function verifyAndRegister(ref: ArtifactReference, envelope: AuthorizationEnvelope, expectedPayload: unknown, generation: number): ReferenceJournalAuthorizationRegistration {
    if (grants.has(ref.sha256) || [...grants.values()].some(grant => objectIdentity(grant.ref) === objectIdentity(ref))) fail('authorization.registration', 'authorization object already registered or aliased');
    if (grants.size >= 17) fail('authorization.registration', 'bounded grant capacity exhausted');
    const grant = freeze({ ref, envelope, generation }); assertLive(grant, generation);
    checked('authorization.signature', () => verifier.verifyOnce({ envelope, expectedPayload, observedAt: new Date(now).toISOString() }));
    // There is no await from final validity/revocation check through registration.
    grants.set(ref.sha256, grant); return registration(grant);
  }
  function principalFor(request: Fields, grant: Grant): JournalPrincipal {
    const principal = record(request.principal, 'append.principal'); exact(principal, ['actorId', 'roleId', 'credentialRef'], 'append.principal');
    identifier(principal.actorId, 'append.principal.actorId');
    if (grant.envelope.kind === 'execution') {
      if (principal.actorId !== expected.participants.executorId || principal.roleId !== null || principal.credentialRef !== null) fail('append.principal', 'executor identity/context differs from frozen duties');
    } else if (grant.envelope.kind === 'recovery') {
      if (principal.actorId !== options.recoveryActorId || principal.roleId !== policy?.roleId
        || !same(principal.credentialRef, grant.envelope.payload.credentialRef)) fail('append.principal', 'rescue identity/role/credential differs from signed context');
    } else fail('append.principal', 'result attestations never authorize journal writes');
    return principal as unknown as JournalPrincipal;
  }
  function assertAction(request: Fields, grant: Grant, entries: readonly JournalEntry[]): void {
    if (grant.envelope.kind === 'execution') {
      if (!STAGE_EXECUTION_ACTIONS[expected.stage].includes(request.action as string)) fail('append.action', 'action is not authorized for this stage');
      return;
    }
    if (grant.envelope.kind !== 'recovery') fail('append.action', 'non-execution/recovery authority cannot write');
    if (request.action === 'readback' || (request.kind === 'terminal' && request.action === 'seal-run')) return;
    if (grant.envelope.payload.allowedActions.includes(request.action as typeof RECOVERY_ALLOWED_ACTIONS[number])) return;
    // Recording failure of a pre-existing intent is not permission to perform
    // that risk-increasing action. A rescue cannot claim it completed.
    const pending = entries.find(entry => entry.kind === 'intent' && entry.digest === request.intentDigest
      && entry.idempotencyKey === request.idempotencyKey && entry.action === request.action);
    if (request.kind === 'result' && ['failed', 'aborted'].includes(request.outcome as string) && pending) return;
    fail('append.action', 'recovery permits only signed risk-reducing actions or failure records for existing intents');
  }
  function recoveryReferenceRoles(ref: ArtifactReference, credentialRef: ArtifactReference): void {
    const recoveryRefs = [...grants.values()].flatMap(grant => grant.envelope.kind === 'recovery' ? [
      { role: 'recovery-authorization', ref: grant.ref }, { role: 'credential', ref: grant.envelope.payload.credentialRef }] : []);
    const pendingRefs = [...pending.values()].flatMap(value => [
      { role: 'recovery-authorization', ref: value.ref }, { role: 'credential', ref: value.credentialRef }]);
    assertReferenceRoles([...frozenReferences, ...recoveryRefs, ...pendingRefs,
      { role: 'recovery-authorization', ref }, { role: 'credential', ref: credentialRef }]);
  }
  return Object.freeze({ executionProfile: 'local-reference', productionCapable: false,
    async authorizeExecution(input: unknown) {
      const request = snapshot(input, 'authorizeExecution'); exact(request, ['envelope'], 'authorizeExecution');
      const view = checked('authorization.schema', () => validateAuthorizationEnvelope(request.envelope));
      if (view.envelope.kind !== 'execution' || view.envelopeDigest !== executionRef.sha256
        || !same(view.envelope.payload, expected)) fail('authorization.execution', 'exact frozen execution envelope differs');
      const head = await readHead();
      if (head.fencingGeneration !== originalGeneration) fail('authorization.fencing', 'original execution cannot be registered on a new generation');
      return verifyAndRegister(executionRef, view.envelope, expected, originalGeneration);
    },
    async authorizeRecovery(input: unknown) {
      const request = snapshot(input, 'authorizeRecovery'); exact(request, ['envelope', 'authorizationRef'], 'authorizeRecovery');
      if (!policy) fail('authorization.recovery', 'stage has no frozen recovery policy');
      const original = grants.get(executionRef.sha256);
      // This non-durable factory cannot bootstrap a historical approval from
      // caller options. An expired/revoked original may still authorize rescue
      // provenance, but its signature must have actually been verified here.
      if (!original || original.envelope.kind !== 'execution' || !same(original.ref, executionRef)) fail('authorization.recovery.original-execution', 'original execution must have been verified before recovery');
      const view = checked('authorization.schema', () => validateAuthorizationEnvelope(request.envelope));
      const ref = reference(request.authorizationRef, 'authorization.recovery.ref');
      if (view.envelope.kind !== 'recovery' || view.envelopeDigest !== ref.sha256
        || objectIdentity(ref) === objectIdentity(executionRef)) fail('authorization.recovery', 'exact recovery envelope/ref required');
      const payload = view.envelope.payload;
      recoveryReferenceRoles(ref, payload.credentialRef);
      if (pending.has(ref.sha256) || grants.size + pending.size >= 17) fail('authorization.recovery.registration', 'duplicate pending authorization or bounded capacity exhausted');
      // Admit before the first await so a concurrent revoke can recognize the
      // exact ref. Pending entries grant no permission and always get removed.
      pending.set(ref.sha256, freeze({ ref, credentialRef: payload.credentialRef }));
      try {
        const head = await readHead();
        if (head.terminal || head.fencingGeneration <= originalGeneration) fail('authorization.recovery.fencing', 'recovery requires an open journal and actual new generation');
        if (payload.approvedMaxTtlMs > policy.maxAuthorizationTtlMs
          || payload.allowedActions.some(action => !policy.allowedActions.includes(action))) fail('authorization.recovery.policy', 'recovery exceeds frozen action/TTL policy');
        // Issuance IDs/time/nonce, narrowed actions and credential are chosen by
        // the recovery signer. Domain/policy/lineage/generation come independently
        // from the frozen contract and actual private store, never its claims.
        const expectedRecovery = { ...payload, stage: 'T17', scope: expected.scope, runNonce: expected.runNonce,
          manifestHash: expected.manifestHash, issuerId: policy.authorityId, participants: expected.participants,
          operation: 'safety-recovery', frozenPolicyHash: policy.policyHash, originalExecutionAuthorizationRef: executionRef,
          originalFencingGeneration: originalGeneration, fencingGeneration: head.fencingGeneration,
          lineage: policy.lineage, rollbackExpectedPointerRevision: policy.lineage.expectedPointerRevision + 1,
          roleId: policy.roleId };
        if (!same(payload, expectedRecovery)) fail('authorization.recovery', 'scope/run/frozen policy/lineage/fence/role differs');
        recoveryReferenceRoles(ref, payload.credentialRef);
        return verifyAndRegister(ref, view.envelope, expectedRecovery, head.fencingGeneration);
      } finally { pending.delete(ref.sha256); }
    },
    async append(input: unknown) {
      const request = snapshot(input, 'append'); exact(request, APPEND_FIELDS, 'append');
      const ref = reference(request.authorizationRef, 'append.authorizationRef'); const grant = grants.get(ref.sha256);
      if (!grant || !same(grant.ref, ref)) fail('append.authorization', 'exact registered authorization object required');
      const principal = principalFor(request, grant); const expectedHead = requestHead(request.expectedHead, binding);
      const firstHead = await readHead(); const entries = await readEntries(); const head = await readHead();
      assertLive(grant, head.fencingGeneration); assertAction(request, grant, entries);
      if (!same(firstHead, head)) return freeze({ validationLevel: 'local-reference-authorized-write', productionAccepted: false,
        status: 'conflict', entry: null, head }) as AuthorizedJournalWriteResult;
      checked('append.chain', () => validateJournalChain(entries, binding, head));
      const body = { schemaVersion: JOURNAL_SCHEMA_VERSION, binding, kind: request.kind,
        seq: expectedHead.entryCount + 1, prevDigest: expectedHead.rootDigest, fencingGeneration: expectedHead.fencingGeneration,
        idempotencyKey: request.idempotencyKey, actorId: principal.actorId, authorizationDigest: ref.sha256, action: request.action,
        parametersDigest: request.parametersDigest, beforeDigest: request.beforeDigest, afterDigest: request.afterDigest,
        intentDigest: request.intentDigest, outcome: request.outcome, trustedTime: new Date(now).toISOString() };
      let entry = checked('append.entry', () => createJournalEntry(body));
      const existing = entries.find(value => value.idempotencyKey === entry.idempotencyKey && value.kind === entry.kind);
      if (existing) {
        const existingBody = Object.fromEntries(Object.entries(existing).filter(([field]) => field !== 'digest'));
        if (!same({ ...body, trustedTime: existing.trustedTime }, existingBody)) fail('append.idempotency', 'existing operation differs; never refresh head/time or overwrite it');
        entry = existing;
      }
      // All reads above may yield. Re-check live authority immediately before
      // calling the owned adapter whose CAS body has no await. Clock/revocation
      // seams cannot interleave within this single-process commit region.
      assertLive(grant, head.fencingGeneration);
      const result = await checkedAsync('append.commit', () => compareAndAppend({ expectedHead, entry, fencingGeneration: head.fencingGeneration }));
      return freeze({ validationLevel: 'local-reference-authorized-write', productionAccepted: false,
        ...result, entry }) as AuthorizedJournalWriteResult;
    },
    readHead, readEntries,
    referenceAdvanceTime(input: string) {
      const next = timestamp(input, 'reference.clock'); if (next < now) fail('reference.clock', 'reference time cannot regress'); now = next;
    },
    referenceAdvanceFence: advanceFence,
    referenceRevokeAuthorization(input: string) {
      hex(input, 64, 'reference.revocation');
      if (input !== executionRef.sha256 && !grants.has(input) && !pending.has(input)) fail('reference.revocation', 'unknown authorization cannot be registered through a revoke seam');
      // Failed pending registrations may leave tombstones. Never evict them or
      // keep an existing grant writable if the revocation table cannot grow.
      if (!revoked.has(input) && revoked.size >= 64) { revocationCapacityExhausted = true; fail('reference.revocation', 'revocation capacity exhausted; writer fails closed'); }
      revoked.add(input);
    },
    referenceRevokeSigner(keyId: string, keyVersion: string) {
      identifier(keyId, 'reference.signer'); identifier(keyVersion, 'reference.signer');
      if (!keys.some(key => key.keyId === keyId && key.keyVersion === keyVersion)) fail('reference.signer', 'unknown signer key');
      revokedKeys.add(signerIdentity(keyId, keyVersion));
    },
  });
}

function expectedExecution(input: unknown): ExecutionAuthorizationPayload {
  const view = checked('options.execution', () => validateAuthorizationEnvelope({
    schemaVersion: 'kg-execution-authorization-envelope/v1', kind: 'execution', payload: input,
    signature: { algorithm: 'Ed25519', keyId: 'schema-only', keyVersion: 'v1', value: Buffer.alloc(64).toString('base64url') } }));
  if (view.envelope.kind !== 'execution') fail('options.execution', 'execution payload required'); return view.envelope.payload;
}
function recoveryPolicy(input: unknown, expected: ExecutionAuthorizationPayload, scopeHash: string): RecoveryPolicy | null {
  if (expected.stage !== 'T17') { if (input !== null) fail('options.recoveryPolicy', 'non-canary stage cannot carry recovery'); return null; }
  const policy = record(input, 'options.recoveryPolicy'); exact(policy, ['schemaVersion', 'authorityId', 'roleId', 'scopeHash',
    'allowedActions', 'lineage', 'maxAuthorizationTtlMs', 'credentialPolicyRef', 'policyHash'], 'options.recoveryPolicy');
  if (policy.schemaVersion !== 'kg-safety-recovery-policy/v1' || policy.authorityId !== expected.participants.recoveryAuthorityId
    || policy.scopeHash !== scopeHash) fail('options.recoveryPolicy', 'frozen policy schema/authority/scope differs');
  identifier(policy.roleId, 'options.recoveryPolicy.roleId'); reference(policy.credentialPolicyRef, 'options.recoveryPolicy.credentialPolicyRef');
  integer(policy.maxAuthorizationTtlMs, 1, 300000, 'options.recoveryPolicy.maxAuthorizationTtlMs');
  if (!Array.isArray(policy.allowedActions) || policy.allowedActions.length !== RECOVERY_ALLOWED_ACTIONS.length
    || new Set(policy.allowedActions).size !== RECOVERY_ALLOWED_ACTIONS.length
    || RECOVERY_ALLOWED_ACTIONS.some(action => !(policy.allowedActions as unknown[]).includes(action))) fail('options.recoveryPolicy', 'exact risk-reducing action set required');
  const lineage = record(policy.lineage, 'options.recoveryPolicy.lineage'); exact(lineage, ['predecessorRef', 'targetRef', 'expectedPointerRevision'], 'options.recoveryPolicy.lineage');
  const prior = reference(lineage.predecessorRef, 'options.recoveryPolicy.lineage'); const target = reference(lineage.targetRef, 'options.recoveryPolicy.lineage');
  if (objectIdentity(prior) === objectIdentity(target)) fail('options.recoveryPolicy.lineage', 'predecessor and target must be distinct object versions');
  integer(lineage.expectedPointerRevision, 0, Number.MAX_SAFE_INTEGER - 2, 'options.recoveryPolicy.lineage');
  hex(policy.policyHash, 64, 'options.recoveryPolicy.policyHash');
  const unsigned = Object.fromEntries(Object.entries(policy).filter(([field]) => field !== 'policyHash'));
  if (policy.policyHash !== canonicalJsonSha256(unsigned)) fail('options.recoveryPolicy', 'frozen policy digest differs');
  return policy as unknown as RecoveryPolicy;
}
function requestHead(input: unknown, binding: JournalBinding): JournalHead {
  const head = record(input, 'append.expectedHead'); exact(head, ['schemaVersion', 'kind', 'binding', 'entryCount', 'rootDigest', 'fencingGeneration', 'terminal'], 'append.expectedHead');
  if (head.schemaVersion !== JOURNAL_SCHEMA_VERSION || head.kind !== 'head' || !same(head.binding, binding)
    || typeof head.terminal !== 'boolean') fail('append.expectedHead', 'versioned same-run head required');
  integer(head.entryCount, 0, 10000, 'append.expectedHead.entryCount'); integer(head.fencingGeneration, 1, Number.MAX_SAFE_INTEGER, 'append.expectedHead.fencingGeneration');
  hex(head.rootDigest, 64, 'append.expectedHead.rootDigest'); return head as unknown as JournalHead;
}
function reference(input: unknown, path: string): ArtifactReference {
  const ref = record(input, path); exact(ref, ['objectId', 'objectVersion', 'sha256'], path);
  identifier(ref.objectId, path); identifier(ref.objectVersion, path); hex(ref.sha256, 64, path); return ref as unknown as ArtifactReference;
}
function objectIdentity(ref: ArtifactReference): string { return canonicalJson([ref.objectId, ref.objectVersion]); }
function assertReferenceRoles(references: readonly RoleReference[]): void {
  const known = new Map<string, RoleReference>();
  for (const current of references) {
    const identity = objectIdentity(current.ref); const prior = known.get(identity);
    // Repeated exact credential use (or redundant same-role evidence) is valid;
    // the same object version never changes its digest or semantic role.
    if (prior && (prior.role !== current.role || prior.ref.sha256 !== current.ref.sha256)) fail('authorization.references', 'object-version digest or semantic-role alias forbidden');
    known.set(identity, current);
  }
}
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
function snapshot(input: unknown, path: string): Fields {
  const encoded = checked(path, () => canonicalJson(input)); return freeze(record(JSON.parse(encoded), path));
}
function record(input: unknown, path: string): Fields {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(path, 'plain data object required'); return input as Fields;
}
function exact(input: Fields, fields: readonly string[], path: string): void {
  if (Object.keys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input, field))) fail(path, 'required fields absent or unsupported fields present');
}
function identifier(input: unknown, path: string): void {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input)) fail(path, 'bounded opaque identifier required');
}
function hex(input: unknown, length: number, path: string): void {
  if (typeof input !== 'string' || input.length !== length || !/^[a-f0-9]+$/.test(input)) fail(path, 'exact lowercase digest required');
}
function integer(input: unknown, min: number, max: number, path: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) fail(path, 'integer outside profile bounds'); return input;
}
function timestamp(input: unknown, path: string): number {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)
    || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input) fail(path, 'canonical UTC timestamp required'); return Date.parse(input);
}
function checked<T>(path: string, operation: () => T): T {
  try { return operation(); } catch { fail(path, 'validation/signature/key/nonce operation failed'); }
}
async function checkedAsync<T>(path: string, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch { fail(path, 'journal commit failed'); }
}
function freeze<T>(input: T): T {
  if (input !== null && typeof input === 'object') { Object.values(input).forEach(freeze); Object.freeze(input); } return input;
}
function fail(path: string, reason: string): never { throw new Error(`[authorized journal] ${path}: ${reason}`); }

import { types } from 'node:util';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';

export const JOURNAL_SCHEMA_VERSION = 'kg-gate-run-journal/v1' as const;
export const GENESIS_DIGEST = '0'.repeat(64);
const MAX_ENTRIES = 10000;
const MAX_CHAIN_BYTES = 16 * 1024 * 1024;
const ACTIONS = ['ask-off', 'ask-shadow', 'ask-active', 'readback', 'publish-pointer', 'ack-outbox',
  'set-off', 'activate', 'increase-traffic', 'withdraw-traffic', 'inject-fault', 'revoke-existing-fault',
  'rollback-to-predecessor', 'seal-run'] as const;
type Fields = Record<string, unknown>;

export interface JournalBinding {
  readonly environment: string;
  readonly tenantId: string;
  readonly corpusId: string;
  readonly scopeHash: string;
  readonly runNonce: string;
  readonly manifestHash: string;
}

export interface JournalEntryBody {
  readonly schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  readonly kind: 'intent' | 'result' | 'terminal';
  readonly binding: JournalBinding;
  readonly seq: number;
  readonly prevDigest: string;
  readonly fencingGeneration: number;
  readonly idempotencyKey: string;
  readonly actorId: string;
  readonly authorizationDigest: string;
  readonly action: typeof ACTIONS[number];
  readonly parametersDigest: string;
  readonly beforeDigest: string;
  readonly afterDigest: string | null;
  readonly intentDigest: string | null;
  readonly outcome: null | 'completed' | 'passed' | 'failed' | 'aborted';
  readonly trustedTime: string;
}

export interface JournalEntry extends JournalEntryBody { readonly digest: string }
export interface JournalHead {
  readonly schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  readonly kind: 'head';
  readonly binding: JournalBinding;
  readonly entryCount: number;
  readonly rootDigest: string;
  readonly fencingGeneration: number;
  readonly terminal: boolean;
}

export interface JournalValidation {
  readonly validationLevel: 'structural-only';
  readonly productionAccepted: false;
  readonly terminal: boolean;
  readonly entryCount: number;
  readonly rootDigest: string;
}

export interface JournalAppendRequest {
  readonly expectedHead: JournalHead;
  readonly entry: JournalEntry;
  readonly fencingGeneration: number;
}

export interface JournalAppendResult {
  readonly status: 'appended' | 'already-applied' | 'conflict' | 'stale-fence' | 'terminal';
  readonly head: JournalHead;
}

/** Real implementations need authoritative transactional CAS, not local mutexes. */
export interface RunJournalStorePort {
  readonly executionProfile: 'enterprise' | 'local-reference';
  readonly productionCapable: boolean;
  readHead(): Promise<JournalHead>;
  readEntries(): Promise<readonly JournalEntry[]>;
  compareAndAppend(request: JournalAppendRequest): Promise<JournalAppendResult>;
}

export interface ReferenceJournalStore extends RunJournalStorePort {
  readonly executionProfile: 'local-reference';
  readonly productionCapable: false;
  /** Test-only authority seam; real fencing comes from the deployment authority. */
  advanceFence(generation: number): Promise<JournalHead>;
}

const BODY_KEYS = ['schemaVersion', 'kind', 'binding', 'seq', 'prevDigest', 'fencingGeneration',
  'idempotencyKey', 'actorId', 'authorizationDigest', 'action', 'parametersDigest', 'beforeDigest',
  'afterDigest', 'intentDigest', 'outcome', 'trustedTime'];

export function createJournalEntry(input: unknown): JournalEntry {
  const body = snapshot(input, '$.entry');
  validateBody(body);
  return freeze({ ...body, digest: canonicalJsonSha256(body) }) as unknown as JournalEntry;
}

export function validateJournalChain(
  input: unknown, bindingInput: unknown, authoritativeHeadInput: unknown
): JournalValidation {
  const binding = validateBinding(snapshot(bindingInput, '$.binding'), '$.binding');
  const head = validateHead(snapshot(authoritativeHeadInput, '$.head'), binding);
  const entries = snapshotEntries(input);
  if (entries.length !== head.entryCount) fail('$.head', 'entry count differs from authoritative head');
  let previousDigest = GENESIS_DIGEST; let generation = 0; let time = -Infinity; let terminal = false;
  const intents = new Map<string, JournalEntry>();
  const usedKeys = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const path = `$.entries[${index}]`;
    if (terminal) fail(path, 'records after terminal are forbidden');
    if (canonicalJson(entry.binding) !== canonicalJson(binding)) fail(path, 'journal binding differs from expected run/scope');
    if (entry.seq !== index + 1 || entry.prevDigest !== previousDigest) fail(path, 'sequence or predecessor digest mismatch');
    if (entry.fencingGeneration < generation) fail(path, 'fencing generation regressed');
    const entryTime = Date.parse(entry.trustedTime);
    if (entryTime < time) fail(path, 'trusted time regressed');
    if (entry.kind === 'result') {
      const intent = intents.get(entry.idempotencyKey);
      if (!intent || intent.digest !== entry.intentDigest || intent.action !== entry.action
        || intent.parametersDigest !== entry.parametersDigest || intent.beforeDigest !== entry.beforeDigest) {
        fail(path, 'result does not match an unresolved intent');
      }
      intents.delete(entry.idempotencyKey);
    } else {
      if (usedKeys.has(entry.idempotencyKey)) fail(path, 'idempotency identity was reused');
      usedKeys.add(entry.idempotencyKey);
      if (entry.kind === 'intent') intents.set(entry.idempotencyKey, entry);
      else {
        if (intents.size > 0) fail(path, 'cannot seal unresolved intents');
        terminal = true;
      }
    }
    previousDigest = entry.digest; generation = entry.fencingGeneration; time = entryTime;
  }
  if (head.rootDigest !== previousDigest || head.terminal !== terminal || head.fencingGeneration < generation
    || (terminal && head.fencingGeneration !== generation)) {
    fail('$.head', 'root, terminal or fencing differs from authoritative head');
  }
  // A caller-supplied head proves no authority. W2 receipts must independently
  // read its exact object/version through trusted store and approval ports.
  return freeze({ validationLevel: 'structural-only' as const, productionAccepted: false as const,
    terminal, entryCount: entries.length, rootDigest: previousDigest });
}

export function createReferenceJournalStore(input: unknown): ReferenceJournalStore {
  const options = snapshot(input, '$.reference');
  exactKeys(options, ['binding', 'initialFencingGeneration', 'executionProfile'], '$.reference');
  if (options.executionProfile !== 'local-reference') fail('$.reference', 'reference adapters have no production profile');
  const binding = validateBinding(snapshot(options.binding, '$.reference.binding'), '$.reference.binding');
  const initial = positiveInteger(options.initialFencingGeneration, '$.reference.initialFencingGeneration');
  let head: JournalHead = freeze({ schemaVersion: JOURNAL_SCHEMA_VERSION, kind: 'head', binding,
    entryCount: 0, rootDigest: GENESIS_DIGEST, fencingGeneration: initial, terminal: false });
  const entries: JournalEntry[] = [];
  // Admission detached and deeply froze these private values. Re-encoding them
  // on every read adds no validation; keep old heads as immutable snapshots.
  const readHead = (): JournalHead => head;
  return Object.freeze({
    executionProfile: 'local-reference' as const,
    productionCapable: false as const,
    async readHead() { return readHead(); },
    async readEntries() { return Object.freeze([...entries]); },
    async advanceFence(inputGeneration: number) {
      const generation = positiveInteger(inputGeneration, '$.fencingGeneration');
      if (head.terminal || generation <= head.fencingGeneration) fail('$.fencingGeneration', 'new generation must strictly increase an open journal');
      head = freeze({ ...head, fencingGeneration: generation });
      return readHead();
    },
    async compareAndAppend(requestInput: JournalAppendRequest) {
      const request = snapshot(requestInput, '$.append');
      exactKeys(request, ['expectedHead', 'entry', 'fencingGeneration'], '$.append');
      const token = positiveInteger(request.fencingGeneration, '$.append.fencingGeneration');
      const entry = parseEntry(snapshot(request.entry, '$.append.entry'));
      const expected = validateHead(snapshot(request.expectedHead, '$.append.expectedHead'), binding);
      const result = (status: JournalAppendResult['status']): JournalAppendResult => freeze({ status, head: readHead() });
      // Fence validation precedes even idempotent acknowledgements.
      if (token !== head.fencingGeneration) return result('stale-fence');
      if (entries.some(existing => existing.digest === entry.digest)) return result('already-applied');
      if (head.terminal) return result('terminal');
      if (canonicalJson(expected) !== canonicalJson(head)) return result('conflict');
      if (entry.fencingGeneration !== token) fail('$.append.entry', 'entry fencing differs from current token');
      const nextHead: JournalHead = { ...head, entryCount: head.entryCount + 1,
        rootDigest: entry.digest, terminal: entry.kind === 'terminal' };
      validateJournalChain([...entries, entry], binding, nextHead);
      // No await inside the compare/validate/append region: local conformance
      // tests get atomic JS CAS, never a claim of distributed durability.
      entries.push(entry); head = freeze(nextHead);
      return result('appended');
    },
  });
}

function parseEntry(input: Fields): JournalEntry {
  exactKeys(input, [...BODY_KEYS, 'digest'], '$.entry');
  digest(input.digest, '$.entry.digest');
  const body = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'digest'));
  validateBody(body);
  if (canonicalJsonSha256(body) !== input.digest) fail('$.entry.digest', 'canonical entry digest mismatch');
  return freeze(input) as unknown as JournalEntry;
}

function validateBody(body: Fields): void {
  exactKeys(body, BODY_KEYS, '$.entry');
  if (body.schemaVersion !== JOURNAL_SCHEMA_VERSION) fail('$.entry.schemaVersion', 'unsupported schema');
  const kind = select(body.kind, ['intent', 'result', 'terminal'], '$.entry.kind');
  validateBinding(record(body.binding, '$.entry.binding'), '$.entry.binding');
  positiveInteger(body.seq, '$.entry.seq', MAX_ENTRIES);
  positiveInteger(body.fencingGeneration, '$.entry.fencingGeneration');
  for (const field of ['prevDigest', 'authorizationDigest', 'parametersDigest', 'beforeDigest']) digest(body[field], `$.entry.${field}`);
  for (const field of ['idempotencyKey', 'actorId']) identifier(body[field], `$.entry.${field}`);
  select(body.action, ACTIONS, '$.entry.action');
  timestamp(body.trustedTime, '$.entry.trustedTime');
  if (kind === 'intent') {
    if (body.afterDigest !== null || body.intentDigest !== null || body.outcome !== null || body.action === 'seal-run') {
      fail('$.entry', 'intent cannot contain a result or terminal action');
    }
  } else {
    digest(body.afterDigest, '$.entry.afterDigest');
    if (kind === 'result') {
      digest(body.intentDigest, '$.entry.intentDigest');
      select(body.outcome, ['completed', 'failed', 'aborted'], '$.entry.outcome');
      if (body.action === 'seal-run') fail('$.entry.action', 'terminal action requires terminal kind');
    } else {
      select(body.outcome, ['passed', 'failed', 'aborted'], '$.entry.outcome');
      if (body.action !== 'seal-run' || body.intentDigest !== null || body.beforeDigest !== body.prevDigest) {
        fail('$.entry', 'terminal must seal its exact prior root');
      }
    }
  }
}

function validateBinding(input: Fields, path: string): JournalBinding {
  exactKeys(input, ['environment', 'tenantId', 'corpusId', 'scopeHash', 'runNonce', 'manifestHash'], path);
  for (const key of ['environment', 'tenantId', 'corpusId']) identifier(input[key], `${path}.${key}`);
  hex(input.runNonce, 32, `${path}.runNonce`); digest(input.manifestHash, `${path}.manifestHash`);
  digest(input.scopeHash, `${path}.scopeHash`);
  if (input.scopeHash !== canonicalJsonSha256({ environment: input.environment, tenantId: input.tenantId, corpusId: input.corpusId })) {
    fail(`${path}.scopeHash`, 'scope identity mismatch');
  }
  return freeze(input) as unknown as JournalBinding;
}

function validateHead(input: Fields, binding: JournalBinding): JournalHead {
  exactKeys(input, ['schemaVersion', 'kind', 'binding', 'entryCount', 'rootDigest', 'fencingGeneration', 'terminal'], '$.head');
  if (input.schemaVersion !== JOURNAL_SCHEMA_VERSION || input.kind !== 'head') fail('$.head', 'unsupported head schema');
  validateBinding(record(input.binding, '$.head.binding'), '$.head.binding');
  if (canonicalJson(input.binding) !== canonicalJson(binding)) fail('$.head.binding', 'head belongs to another run/scope');
  if (typeof input.entryCount !== 'number' || !Number.isSafeInteger(input.entryCount)
    || input.entryCount < 0 || input.entryCount > MAX_ENTRIES) fail('$.head.entryCount', 'entry count outside profile bounds');
  digest(input.rootDigest, '$.head.rootDigest'); positiveInteger(input.fencingGeneration, '$.head.fencingGeneration');
  if (typeof input.terminal !== 'boolean') fail('$.head.terminal', 'must be a boolean');
  if (input.entryCount === 0 && (input.rootDigest !== GENESIS_DIGEST || input.terminal)) fail('$.head', 'empty journal must have an open genesis head');
  return freeze(input) as unknown as JournalHead;
}

function snapshotEntries(input: unknown): JournalEntry[] {
  // A chain can exceed one canonical object's 256 KiB limit. Reflect only on
  // an ordinary non-Proxy array, then apply the same strict profile per entry.
  if (input === null || typeof input !== 'object' || types.isProxy(input)
    || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > MAX_ENTRIES) {
    fail('$.entries', 'must be a bounded ordinary array');
  }
  if (Reflect.ownKeys(input).some(key => key !== 'length'
    && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length))) {
    fail('$.entries', 'extra array properties are forbidden');
  }
  const entries: JournalEntry[] = []; let bytes = 0;
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('$.entries', 'holes and accessors are forbidden');
    const encoded = canonicalJson(descriptor.value);
    bytes += Buffer.byteLength(encoded, 'utf8');
    if (bytes > MAX_CHAIN_BYTES) fail('$.entries', 'chain bytes exceed profile bounds');
    entries.push(parseEntry(record(JSON.parse(encoded), `$.entries[${index}]`)));
  }
  return entries;
}

function snapshot(input: unknown, path: string): Fields { return record(JSON.parse(canonicalJson(input)), path); }
function record(input: unknown, path: string): Fields {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(path, 'required object is absent');
  return input as Fields;
}
function exactKeys(input: Fields, expected: readonly string[], path: string): void {
  if (expected.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !expected.includes(key))) {
    fail(path, 'required fields are absent or unsupported fields are present');
  }
}
function positiveInteger(input: unknown, path: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1 || input > maximum) fail(path, 'integer outside profile bounds');
  return input;
}
function identifier(input: unknown, path: string): void {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input)) fail(path, 'must be a bounded opaque identifier');
}
function hex(input: unknown, length: number, path: string): void {
  if (typeof input !== 'string' || input.length !== length || !/^[a-f0-9]+$/.test(input)) fail(path, 'must be an exact lowercase hexadecimal identity');
}
function digest(input: unknown, path: string): void { hex(input, 64, path); }
function select(input: unknown, allowed: readonly string[], path: string): string {
  if (typeof input !== 'string' || !allowed.includes(input)) fail(path, 'outside the closed set');
  return input;
}
function timestamp(input: unknown, path: string): void {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)
    || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input) fail(path, 'must be a valid canonical UTC timestamp');
}
function freeze<T>(input: T): T {
  if (input !== null && typeof input === 'object') {
    for (const child of Object.values(input)) freeze(child);
    Object.freeze(input);
  }
  return input;
}
function fail(path: string, reason: string): never { throw new Error(`[production run journal] ${path}: ${reason}`); }

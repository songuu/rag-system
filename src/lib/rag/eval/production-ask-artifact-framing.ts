import { createHash } from 'node:crypto';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { createReferenceProductionAskDatasetBinding } from './production-ask-dataset-binding';
import { validateArtifactAad } from './production-controlled-artifacts';
import type { ArtifactAad } from './production-controlled-artifacts';

type Fields = Record<string, unknown>;
type FramingErrorCode = 'invalid-config' | 'invalid-payload' | 'invalid-readback';
type AskBodyType = 'request' | 'gold' | 'response' | 'error' | 'telemetry';
const PART_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_JSON_BYTES = 24 * 1024 * 1024;
const BODY_TYPES: readonly AskBodyType[] = ['request', 'gold', 'response', 'error', 'telemetry'];

export class ProductionAskArtifactFramingError extends Error {
  readonly code: FramingErrorCode;
  readonly productionAuthorized = false;
  readonly automaticRetryAllowed = false;
  constructor(code: FramingErrorCode) {
    const safeCode = code === 'invalid-payload' || code === 'invalid-readback' ? code : 'invalid-config';
    super('[production Ask artifact framing] ' + safeCode);
    this.name = 'ProductionAskArtifactFramingError';
    this.code = safeCode;
    Object.freeze(this);
  }
}

export interface AskBodyFragment {
  readonly partIndex: number;
  readonly offset: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly aad: ArtifactAad;
  readonly aadSha256: string;
}

export interface ReferenceAskArtifactLayout {
  readonly schemaVersion: 'kg-ask-artifact-layout/v1';
  readonly classification: 'confidential';
  readonly validationLevel: 'local-reference-complete-body-framing';
  readonly productionAuthorized: false;
  readonly stageAcceptanceComplete: false;
  readonly bodySourceAuthenticated: false;
  readonly encryptionAuthenticated: false;
  readonly bindingHash: string;
  readonly requestPlanHash: string;
  readonly artifactType: AskBodyType;
  readonly bodyByteLength: number;
  readonly bodySha256: string;
  readonly partByteLimit: number;
  readonly fragmentRootSha256: string;
  readonly parts: readonly AskBodyFragment[];
  readonly layoutHash: string;
}

export interface ReferenceAskArtifactReadbackProof {
  readonly schemaVersion: 'kg-ask-body-readback/v1';
  readonly classification: 'confidential';
  readonly validationLevel: 'local-reference-complete-bytes';
  readonly productionAuthorized: false;
  readonly stageAcceptanceComplete: false;
  readonly bodySourceAuthenticated: false;
  readonly encryptionAuthenticated: false;
  readonly readbackMatched: true;
  readonly layoutHash: string;
  readonly bindingHash: string;
  readonly requestPlanHash: string;
  readonly bodySha256: string;
  readonly byteLength: number;
  readonly partCount: number;
  readonly fragmentRootSha256: string;
  readonly proofHash: string;
}

/** Confidential in-memory framing, NOT an Ask producer or an encrypted writer.
 * Ordinary layout/proof objects contain no plaintext. forEncryption is an
 * explicit private handoff to the existing KMS port, never a log/receipt API.
 * Complete bytes are retained; no Unicode decoding or truncation is used. */
export function createReferenceProductionAskArtifactFramer(
  inputOptions: unknown,
  actualDatasetJson: unknown,
  ...extraInputs: unknown[]
) {
  try {
    if (extraInputs.length !== 0) throw new Error();
    const options = freezeDeep(JSON.parse(canonicalJson(inputOptions))) as Fields;
    const binding = createReferenceProductionAskDatasetBinding(options, actualDatasetJson);
    const manifest = record(options.manifest);
    const base = record(manifest.base);
    const firstCase = (record(base.dataset).roster as string[])[0];
    const initial = binding.planRequest({ caseId: firstCase, rolloutMode: 'off', phase: 'trial', ordinal: 0 });
    const stage = initial.requestPlan.stage;
    const sampling = record(record(manifest[stage === 'T16' ? 't16' : 't17']).sampling);
    const trialCount = sampling.trialCount as number;
    const warmupCount = sampling.warmupCount as number;
    const perArm = trialCount + warmupCount;
    const treatment = stage === 'T16' ? 'shadow' : 'active';
    const network = initial.requestPlan.target.networkPolicy;
    // AAD ordinal is bounded at 1,000,000. The actual frozen sampling profile
    // has <=1,100 slots/arm: 2 * 1,100 * 256 parts fits the unchanged contract.
    if ((2 * perArm * 256) - 1 > 1_000_000) throw new Error();
    return Object.freeze({
      executionProfile: 'local-reference' as const,
      productionCapable: false as const,
      bindingProof: binding.bindingProof,
      frame(input: unknown, ...extraPayloads: unknown[]) {
        try {
          if (extraPayloads.length !== 0) throw new Error();
          const payload = record(parseJson(input));
          exact(payload, ['schemaVersion', 'request', 'artifactType', 'payloadBase64url']);
          if (payload.schemaVersion !== 'kg-reference-ask-artifact-payload/v1'
            || !BODY_TYPES.includes(payload.artifactType as AskBodyType)) throw new Error();
          const plan = binding.planRequest(payload.request);
          const identity = plan.requestPlan.requestIdentity;
          const armIndex = identity.rolloutMode === 'off' ? 0 : identity.rolloutMode === treatment ? 1 : -1;
          if (armIndex < 0) throw new Error();
          const artifactType = payload.artifactType as AskBodyType;
          const bodyLimit = artifactType === 'request' ? 64 * 1024
            : artifactType === 'gold' ? binding.bindingProof.resourceBudget.maxJsonBytes
            : artifactType === 'telemetry' ? network.maxStreamBytes : network.maxResponseBytes;
          const body = decodeBytes(payload.payloadBase64url, Math.min(bodyLimit, MAX_BODY_BYTES));
          const bodySha256 = sha(body);
          const sampleIndex = identity.phase === 'warmup' ? identity.ordinal : warmupCount + identity.ordinal;
          const slot = armIndex * perArm + sampleIndex;
          const partCount = Math.max(1, Math.ceil(body.byteLength / PART_BYTES));
          const parts: AskBodyFragment[] = [];
          const root = createHash('sha256').update('kg-ask-body-fragments/v1\0')
            .update(plan.planHash).update('\0').update(String(partCount)).update('\0');
          for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
            const offset = partIndex * PART_BYTES;
            const bytes = body.subarray(offset, Math.min(body.byteLength, offset + PART_BYTES));
            const artifactId = 'ask-part-' + canonicalJsonSha256({
              schemaVersion: 'kg-ask-body-fragment-identity/v1', requestPlanHash: plan.planHash,
              artifactType, bodySha256, bodyByteLength: body.byteLength, partIndex,
            });
            const aad = validateArtifactAad({ ...binding.bindingProof.binding, artifactType,
              artifactId, caseId: identity.caseId, ordinal: slot * 256 + partIndex,
              schemaVersion: 'kg-ask-body-fragment/v1' });
            const part = freezeDeep({ partIndex, offset, byteLength: bytes.byteLength,
              sha256: sha(bytes), aad, aadSha256: canonicalJsonSha256(aad) });
            parts.push(part);
            root.update(canonicalJsonSha256(part));
          }
          const header = {
            schemaVersion: 'kg-ask-artifact-layout/v1' as const,
            classification: 'confidential' as const,
            validationLevel: 'local-reference-complete-body-framing' as const,
            productionAuthorized: false as const,
            stageAcceptanceComplete: false as const,
            bodySourceAuthenticated: false as const,
            encryptionAuthenticated: false as const,
            bindingHash: binding.bindingProof.bindingHash,
            requestPlanHash: plan.planHash,
            artifactType, bodyByteLength: body.byteLength, bodySha256,
            partByteLimit: PART_BYTES, fragmentRootSha256: root.digest('hex'),
          };
          // Fold small per-part projections: even maximum-sized metadata must
          // not force the body into the 256KiB canonical control-object budget.
          const layout: ReferenceAskArtifactLayout = freezeDeep({
            ...header, parts, layoutHash: canonicalJsonSha256(header),
          });
          return Object.freeze({
            executionProfile: 'local-reference' as const,
            productionCapable: false as const,
            layout,
            forEncryption(partIndex: unknown, ...extraParts: unknown[]) {
              try {
                if (extraParts.length !== 0 || !Number.isInteger(partIndex)
                  || typeof partIndex !== 'number' || partIndex < 0 || partIndex >= parts.length) throw new Error();
                const part = parts[partIndex];
                return Object.freeze({ aad: part.aad,
                  plaintextBase64url: body.subarray(part.offset, part.offset + part.byteLength).toString('base64url') });
              } catch { throw new ProductionAskArtifactFramingError('invalid-payload'); }
            },
            verifyDecryptedParts(inputReadback: unknown, ...extraReadbacks: unknown[]): ReferenceAskArtifactReadbackProof {
              try {
                if (extraReadbacks.length !== 0) throw new Error();
                const readback = record(parseJson(inputReadback));
                exact(readback, ['schemaVersion', 'layoutHash', 'parts']);
                if (readback.schemaVersion !== 'kg-ask-decrypted-body-parts/v1'
                  || readback.layoutHash !== layout.layoutHash || !Array.isArray(readback.parts)
                  || readback.parts.length !== parts.length) throw new Error();
                const complete = createHash('sha256');
                let total = 0;
                for (const [index, value] of readback.parts.entries()) {
                  const part = record(value);
                  exact(part, ['partIndex', 'aad', 'plaintextBase64url']);
                  const expected = parts[index];
                  if (part.partIndex !== index || expected.offset !== total
                    || canonicalJsonSha256(validateArtifactAad(part.aad)) !== expected.aadSha256) throw new Error();
                  const bytes = decodeBytes(part.plaintextBase64url, PART_BYTES);
                  try {
                    if (bytes.byteLength !== expected.byteLength || sha(bytes) !== expected.sha256) throw new Error();
                    total += bytes.byteLength;
                    complete.update(bytes);
                  } finally { bytes.fill(0); }
                }
                if (total !== layout.bodyByteLength || complete.digest('hex') !== layout.bodySha256) throw new Error();
                const core = { schemaVersion: 'kg-ask-body-readback/v1', classification: 'confidential',
                  validationLevel: 'local-reference-complete-bytes', productionAuthorized: false,
                  stageAcceptanceComplete: false, encryptionAuthenticated: false, bodySourceAuthenticated: false,
                  readbackMatched: true, layoutHash: layout.layoutHash, bindingHash: layout.bindingHash,
                  requestPlanHash: layout.requestPlanHash, bodySha256: layout.bodySha256,
                  byteLength: total, partCount: parts.length, fragmentRootSha256: layout.fragmentRootSha256 } as const;
                return freezeDeep({ ...core, proofHash: canonicalJsonSha256(core) });
              } catch { throw new ProductionAskArtifactFramingError('invalid-readback'); }
            },
          });
        } catch { throw new ProductionAskArtifactFramingError('invalid-payload'); }
      },
    });
  } catch { throw new ProductionAskArtifactFramingError('invalid-config'); }
}

function sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

function decodeBytes(value: unknown, maximum: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4
    || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.byteLength > maximum || bytes.toString('base64url') !== value) { bytes.fill(0); throw new Error(); }
  return bytes;
}

function parseJson(input: unknown): unknown {
  if (typeof input !== 'string' || input.length > MAX_JSON_BYTES
    || Buffer.byteLength(input, 'utf8') > MAX_JSON_BYTES) throw new Error();
  const value: unknown = JSON.parse(input);
  let nodes = 0;
  const visit = (current: unknown, depth: number) => {
    if (++nodes > 100_000 || depth > 64
      || typeof current === 'number' && !Number.isFinite(current)) throw new Error();
    if (current && typeof current === 'object') for (const child of Object.values(current)) visit(child, depth + 1);
  };
  visit(value, 0);
  return value;
}

function record(value: unknown): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  return value as Fields;
}
function exact(value: Fields, keys: string[]): void {
  if (keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key))) throw new Error();
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

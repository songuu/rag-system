import { createHash } from 'node:crypto';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { createReferenceProductionAskDatasetBinding } from './production-ask-dataset-binding';
import { validateArtifactAad } from './production-controlled-artifacts';
import type { AskBodyFragment } from './production-ask-artifact-framing';
import type { ShadowSideEffectReadbackRequest } from './production-ask-transport-ports';

type Fields = Record<string, unknown>;
const PART_BYTES = 65536, MAX_BODY_BYTES = 8 * 1024 * 1024, MAX_INPUT_BYTES = 12 * 1024 * 1024;
const PARTS_PER_OBSERVATION = 128, MAX_OBSERVATIONS = 5000;
const SELECTOR_FIELDS = ['schemaVersion', 'binding', 'actorId', 'authorizationDigest', 'providerRegistrationHash',
  'requestNonce', 'observedAt', 'point', 'requestPlanHash', 'requestBodySha256', 'responseBodySha256'] as const;

export class ShadowArtifactFramingError extends Error {
  readonly code: 'invalid-config' | 'invalid-payload' | 'invalid-readback';
  readonly productionAuthorized = false; readonly automaticRetryAllowed = false;
  constructor(code: 'invalid-config' | 'invalid-payload' | 'invalid-readback') {
    const safe = code === 'invalid-payload' || code === 'invalid-readback' ? code : 'invalid-config';
    super('[shadow artifact framing] ' + safe); this.name = 'ShadowArtifactFramingError'; this.code = safe; Object.freeze(this);
  }
}
export interface ReferenceShadowArtifactLayout {
  readonly schemaVersion: 'kg-shadow-artifact-layout/v1'; readonly classification: 'confidential';
  readonly validationLevel: 'local-reference-complete-state-framing';
  readonly productionAuthorized: false; readonly stageAcceptanceComplete: false;
  readonly bodySourceAuthenticated: false; readonly encryptionAuthenticated: false;
  readonly bindingHash: string; readonly requestHash: string; readonly observationIndex: number;
  readonly readbackPoint: ShadowSideEffectReadbackRequest['point']; readonly artifactType: 'readback-proof';
  readonly bodyByteLength: number; readonly bodySha256: string; readonly partByteLimit: 65536;
  readonly fragmentRootSha256: string; readonly parts: readonly AskBodyFragment[]; readonly layoutHash: string;
}
export interface ReferenceShadowArtifactByteProof {
  readonly schemaVersion: 'kg-shadow-state-readback/v1'; readonly classification: 'confidential';
  readonly productionAuthorized: false; readonly stageAcceptanceComplete: false;
  readonly bodySourceAuthenticated: false; readonly encryptionAuthenticated: false; readonly readbackMatched: true;
  readonly layoutHash: string; readonly bindingHash: string; readonly requestHash: string;
  readonly observationIndex: number; readonly bodySha256: string; readonly byteLength: number;
  readonly partCount: number; readonly fragmentRootSha256: string; readonly proofHash: string;
}

/** Full bytes, not a source attestation. The original tuple namespace keeps
 * receipt readback-proof/null/0; Ask body types are separate. Two nonces per
 * state bound the original 10,000-challenge consumer to 5,000 observations.
 * Its dedicated slots 1..640000 fit the UNCHANGED million-ordinal contract. */
export function createReferenceShadowArtifactFramer(inputOptions: unknown, datasetJson: unknown, ...extras: unknown[]) {
  try {
    if (extras.length) throw new Error();
    const options = record(JSON.parse(canonicalJson(inputOptions))), binding = createReferenceProductionAskDatasetBinding(options, datasetJson);
    const manifest = record(options.manifest), base = record(manifest.base), roster = record(base.dataset).roster as string[];
    if (binding.planRequest({ caseId: roster[0], rolloutMode: 'off', phase: 'trial', ordinal: 0 }).requestPlan.stage !== 'T16') throw new Error();
    const effects = record(record(manifest.t16).sideEffectPolicy);
    const registration = (record(options.deploymentPolicy).registrations as Fields[]).find(p => p.purpose === 'publication-readback' && p.providerId === effects.readbackProviderId);
    const selected = (record(base.providers).bindings as Fields[]).find(p => p.purpose === 'publication-readback');
    if (!registration || !selected) throw new Error();
    for (const key of ['providerId', 'adapterDigest', 'version', 'configHash']) same(registration[key], selected[key]);
    const providerHash = canonicalJsonSha256(registration), execution = record(options.expectedExecutionPayload);
    const readerId = record(execution.participants).readOnlyId, digest = record(options.executionAuthorizationRef).sha256;
    const window = record(execution.window), starts = Math.max(timestamp(window.startsAt), timestamp(execution.notBefore)), ends = Math.min(timestamp(window.endsAt), timestamp(execution.expiresAt));
    return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false as const, bindingProof: binding.bindingProof,
      frame(input: unknown, ...extraPayloads: unknown[]) {
        try {
          if (extraPayloads.length) throw new Error(); const payload = record(parse(input));
          exact(payload, ['schemaVersion', 'observationIndex', 'request', 'payloadBase64url']);
          if (payload.schemaVersion !== 'kg-reference-shadow-artifact-payload/v1') throw new Error();
          const index = integer(payload.observationIndex, 0, MAX_OBSERVATIONS - 1), request = record(payload.request); exact(request, SELECTOR_FIELDS);
          if (request.schemaVersion !== 'kg-reference-shadow-state-request/v1' || request.actorId !== readerId
            || request.authorizationDigest !== digest || request.providerRegistrationHash !== providerHash
            || typeof request.requestNonce !== 'string' || !/^[a-f0-9]{32}$/.test(request.requestNonce)) throw new Error();
          same(request.binding, binding.bindingProof.binding);
          const at = timestamp(request.observedAt); if (at < starts || at >= ends) throw new Error();
          const point = request.point;
          if (!['run-before', 'post-before', 'post-after', 'run-after'].includes(point as string)) throw new Error();
          if (point === 'run-before' || point === 'run-after') {
            if ([request.requestPlanHash, request.requestBodySha256, request.responseBodySha256].some(v => v !== null)) throw new Error();
          } else {
            hex(request.requestPlanHash); hex(request.requestBodySha256);
            if (point === 'post-after') hex(request.responseBodySha256); else if (request.responseBodySha256 !== null) throw new Error();
          }
          const body = decode(payload.payloadBase64url, MAX_BODY_BYTES), bodyHash = sha(body), requestHash = canonicalJsonSha256(request);
          const count = Math.max(1, Math.ceil(body.byteLength / PART_BYTES)), parts: AskBodyFragment[] = [];
          const root = createHash('sha256').update('kg-shadow-state-fragments/v1\0' + requestHash + '\0' + index + '\0' + count + '\0');
          for (let partIndex = 0; partIndex < count; partIndex++) {
            const offset = partIndex * PART_BYTES, bytes = body.subarray(offset, Math.min(body.byteLength, offset + PART_BYTES));
            const artifactId = 'shadow-part-' + canonicalJsonSha256({ requestHash, observationIndex: index, bodyHash, byteLength: body.byteLength, partIndex });
            const aad = validateArtifactAad({ ...binding.bindingProof.binding, artifactType: 'readback-proof', artifactId,
              caseId: null, ordinal: 1 + index * PARTS_PER_OBSERVATION + partIndex, schemaVersion: 'kg-shadow-state-fragment/v1' });
            const part = freeze({ partIndex, offset, byteLength: bytes.byteLength, sha256: sha(bytes), aad, aadSha256: canonicalJsonSha256(aad) });
            parts.push(part); root.update(canonicalJsonSha256(part));
          }
          const header = { schemaVersion: 'kg-shadow-artifact-layout/v1' as const, classification: 'confidential' as const,
            validationLevel: 'local-reference-complete-state-framing' as const, productionAuthorized: false as const,
            stageAcceptanceComplete: false as const, bodySourceAuthenticated: false as const, encryptionAuthenticated: false as const,
            bindingHash: binding.bindingProof.bindingHash, requestHash, observationIndex: index,
            readbackPoint: point as ShadowSideEffectReadbackRequest['point'], artifactType: 'readback-proof' as const,
            bodyByteLength: body.byteLength, bodySha256: bodyHash, partByteLimit: PART_BYTES as 65536, fragmentRootSha256: root.digest('hex') };
          const layout: ReferenceShadowArtifactLayout = freeze({ ...header, parts, layoutHash: canonicalJsonSha256(header) });
          return Object.freeze({ executionProfile: 'local-reference' as const, productionCapable: false as const, layout,
            forEncryption(partIndex: unknown, ...extraParts: unknown[]) {
              try {
                if (extraParts.length) throw new Error(); const part = parts[integer(partIndex, 0, parts.length - 1)];
                return Object.freeze({ aad: part.aad, plaintextBase64url: body.subarray(part.offset, part.offset + part.byteLength).toString('base64url') });
              } catch { throw new ShadowArtifactFramingError('invalid-payload'); }
            },
            verifyDecryptedParts(inputReadback: unknown, ...extraReadbacks: unknown[]): ReferenceShadowArtifactByteProof {
              try {
                if (extraReadbacks.length) throw new Error(); const actual = record(parse(inputReadback)); exact(actual, ['schemaVersion', 'layoutHash', 'parts']);
                if (actual.schemaVersion !== 'kg-shadow-decrypted-state-parts/v1' || actual.layoutHash !== layout.layoutHash
                  || !Array.isArray(actual.parts) || actual.parts.length !== parts.length) throw new Error();
                let total = 0; const complete = createHash('sha256');
                for (const [i, inputPart] of actual.parts.entries()) {
                  const part = record(inputPart), expected = parts[i]; exact(part, ['partIndex', 'aad', 'plaintextBase64url']);
                  if (part.partIndex !== i || expected.offset !== total || canonicalJsonSha256(validateArtifactAad(part.aad)) !== expected.aadSha256) throw new Error();
                  const bytes = decode(part.plaintextBase64url, PART_BYTES);
                  try { if (bytes.byteLength !== expected.byteLength || sha(bytes) !== expected.sha256) throw new Error(); total += bytes.byteLength; complete.update(bytes); }
                  finally { bytes.fill(0); }
                }
                if (total !== body.byteLength || complete.digest('hex') !== bodyHash) throw new Error();
                const core = { schemaVersion: 'kg-shadow-state-readback/v1' as const, classification: 'confidential' as const,
                  productionAuthorized: false as const, stageAcceptanceComplete: false as const, bodySourceAuthenticated: false as const,
                  encryptionAuthenticated: false as const, readbackMatched: true as const, layoutHash: layout.layoutHash,
                  bindingHash: layout.bindingHash, requestHash, observationIndex: index, bodySha256: bodyHash, byteLength: total,
                  partCount: parts.length, fragmentRootSha256: layout.fragmentRootSha256 };
                return freeze({ ...core, proofHash: canonicalJsonSha256(core) });
              } catch { throw new ShadowArtifactFramingError('invalid-readback'); }
            } });
        } catch { throw new ShadowArtifactFramingError('invalid-payload'); }
      } });
  } catch { throw new ShadowArtifactFramingError('invalid-config'); }
}
function parse(input: unknown): unknown {
  if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new Error();
  const value = JSON.parse(input); let nodes = 0;
  const visit = (v: unknown, depth: number) => { if (++nodes > 200000 || depth > 64 || typeof v === 'number' && !Number.isFinite(v)) throw new Error();
    if (v && typeof v === 'object') Object.values(v).forEach(child => visit(child, depth + 1)); }; visit(value, 0); return value;
}
function decode(input: unknown, maximum: number): Buffer {
  if (typeof input !== 'string' || input.length > 4 * Math.ceil(maximum / 3) || !/^[a-zA-Z0-9_-]*$/.test(input)) throw new Error();
  const bytes = Buffer.from(input, 'base64url'); if (bytes.byteLength > maximum || bytes.toString('base64url') !== input) { bytes.fill(0); throw new Error(); } return bytes;
}
function record(input: unknown): Fields { if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(); return input as Fields; }
function exact(input: Fields, keys: readonly string[]): void { if (Object.keys(input).length !== keys.length || keys.some(k => !Object.hasOwn(input, k))) throw new Error(); }
function same(a: unknown, b: unknown): void { if (canonicalJson(a) !== canonicalJson(b)) throw new Error(); }
function integer(v: unknown, min: number, max: number): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw new Error(); return v; }
function timestamp(v: unknown): number { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) || new Date(v).toISOString() !== v) throw new Error(); return Date.parse(v); }
function hex(v: unknown): void { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) throw new Error(); }
function sha(v: Uint8Array): string { return createHash('sha256').update(v).digest('hex'); }
function freeze<T>(v: T): T { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }

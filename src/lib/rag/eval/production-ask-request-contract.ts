import { canonicalJson } from './canonical-json';
import { types } from 'node:util';
import type { ReferenceProductionAskRequestPlan } from './production-ask-target';
import { REQUEST_LIMITS, validateAskInput } from '../../security/request-validation';

type Fields = Record<string, unknown>;
type Code = 'invalid-body' | 'invalid-deployment';
export class ProductionAskRequestContractError extends Error {
  readonly code: Code;
  readonly productionAuthorized = false;
  constructor(code: Code) {
    const safe = code === 'invalid-deployment' ? code : 'invalid-body';
    super('[production Ask request contract] ' + safe);
    this.name = 'ProductionAskRequestContractError'; this.code = safe;
    Object.freeze(this);
  }
}

/** The owned producer and native transport must agree on actual body bytes.
 * This is the original request validator, not an execution/registry permit. */
export function buildReferenceAskRequestBody(input: unknown, ...extras: unknown[]): Buffer {
  try {
    if (extras.length) throw new Error();
    const value = bodyFields(input);
    exact(value, ['question', 'topK', 'corpusId', 'llmModel', 'embeddingModel']);
    const llm = value.llmModel, embedding = value.embeddingModel;
    if (typeof llm !== 'string' || typeof embedding !== 'string') throw new Error();
    const raw = { question: value.question, topK: value.topK, corpusId: value.corpusId,
      llmModel: llm, embeddingModel: embedding, storageBackend: 'milvus', executionMode: 'sync', maxRetries: 0 };
    const validated = validateAskInput(raw, { NODE_ENV: 'test', MODEL_PROVIDER: 'custom', CUSTOM_LLM_MODEL: llm,
      EMBEDDING_PROVIDER: 'custom', CUSTOM_EMBEDDING_MODEL: embedding,
      RAG_ALLOWED_LLM_MODELS: llm, RAG_ALLOWED_EMBEDDING_MODELS: embedding });
    const bytes = Buffer.from(JSON.stringify({ ...raw, question: validated.question }), 'utf8');
    if (bytes.byteLength > REQUEST_LIMITS.askJsonBytes) throw new Error();
    return bytes;
  } catch { throw new ProductionAskRequestContractError('invalid-body'); }
}

/** Preserve the original closed deployment projection. All inputs must still
 * come from the private complete manifest/binder; matching labels do not
 * authenticate a running server, registry, models or measurements. */
export function validateReferenceAskDeployment(input: unknown, inputPlan: ReferenceProductionAskRequestPlan, inputBase: unknown, ...extras: unknown[]): void {
  try {
    if (extras.length) throw new Error();
    const value = snapshot(input), plan = snapshot(inputPlan), base = snapshot(inputBase);
    exact(value, ['schemaVersion', 'requestPlanHash', 'origin', 'providerRegistrationHash', 'scope', 'rolloutMode', 'sharedConfigHash', 'armConfigHash', 'models', 'parameters']);
    const r = record(plan.requestIdentity), target = record(plan.target), model = record(base.models);
    const expected = { schemaVersion: 'kg-reference-ask-deployment/v1', requestPlanHash: plan.planHash, origin: target.origin,
      providerRegistrationHash: plan.providerRegistrationHash, scope: plan.binding, rolloutMode: r.rolloutMode,
      sharedConfigHash: r.sharedConfigHash, armConfigHash: r.armConfigHash,
      models: { llm: record(model.llm).id, embedding: record(model.embedding).id }, parameters: base.parameters };
    if (canonicalJson(value) !== canonicalJson(expected)) throw new Error();
  } catch { throw new ProductionAskRequestContractError('invalid-deployment'); }
}

/** Body strings use the original validator/JSON escaping, not the stricter
 * control-plane canonical Unicode profile. Capture primitives without hooks. */
function bodyFields(input: unknown): Fields {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)
    || ![null, Object.prototype].includes(Object.getPrototypeOf(input))) throw new Error();
  const keys = ['question', 'topK', 'corpusId', 'llmModel', 'embeddingModel'];
  const value: Fields = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !keys.includes(key)) throw new Error();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== (key === 'topK' ? 'number' : 'string')) throw new Error();
    value[key] = descriptor.value;
  }
  exact(value, keys); return Object.freeze(value);
}
function snapshot(input: unknown): Fields { return record(JSON.parse(canonicalJson(input))); }
function record(input: unknown): Fields { if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(); return input as Fields; }
function exact(input: Fields, required: readonly string[]): void {
  if (required.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !required.includes(key))) throw new Error();
}

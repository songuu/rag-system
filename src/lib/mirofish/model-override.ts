/**
 * 模型覆盖辅助
 *
 * 允许在运行时（每个请求/项目级别）覆盖全局 ModelFactory 配置，
 * 不修改单例全局状态，避免影响其他模块。
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createLLM, isOllamaProvider } from '../model-config';
import type { ModelOverride, Project } from './types';

interface LLMOverrideDefaults {
  temperature?: number;
  ollamaOptions?: Record<string, unknown>;
}

const HTTP_MODEL_OVERRIDE_FORBIDDEN_CODE = 'MIROFISH_HTTP_MODEL_OVERRIDE_FORBIDDEN';
const HTTP_MODEL_OVERRIDE_INVALID_CODE = 'MIROFISH_HTTP_MODEL_OVERRIDE_INVALID';
const MAX_HTTP_MODEL_NAME_LENGTH = 200;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export class MiroFishHttpModelOverrideValidationError extends Error {
  readonly code: string;
  readonly status = 400;

  constructor(kind: 'forbidden' | 'invalid' = 'forbidden') {
    super(kind === 'forbidden'
      ? '客户端 modelOverride 不允许包含 baseUrl 或 apiKey'
      : 'modelOverride 格式无效');
    this.name = 'MiroFishHttpModelOverrideValidationError';
    this.code = kind === 'forbidden'
      ? HTTP_MODEL_OVERRIDE_FORBIDDEN_CODE
      : HTTP_MODEL_OVERRIDE_INVALID_CODE;
  }
}

/**
 * 根据 override 创建 LLM；override 为空时走默认工厂。
 */
export function createLLMFromOverride(
  override?: ModelOverride,
  defaults: LLMOverrideDefaults = {}
): BaseChatModel {
  const temperature = override?.temperature ?? defaults.temperature ?? 0.7;

  if (!override) {
    return createLLM(undefined, {
      temperature,
      options: isOllamaProvider() ? defaults.ollamaOptions : undefined,
    });
  }

  // Model selection may come from a safe HTTP selector, while credentials and
  // endpoints remain server-owned. The shared factory resolves missing
  // secrets from the selected provider's environment configuration. Trusted
  // internal overrides can still explicitly supply those fields.
  return createLLM(override.modelName, {
    provider: override.provider,
    temperature,
    apiKey: override.apiKey,
    baseUrl: override.baseUrl,
    options: override.provider === 'ollama'
      ? normalizeOllamaOptions(defaults.ollamaOptions)
      : undefined,
  });
}

function normalizeOllamaOptions(options: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!options) return {};
  const normalized = { ...options };
  const numCtx = normalized.numCtx ?? normalized.num_ctx;
  delete normalized.num_ctx;

  if (typeof numCtx === 'number') {
    normalized.numCtx = numCtx;
  }

  return normalized;
}

/**
 * Normalize a trusted, server-managed model override.
 *
 * This compatibility parser understands explicit endpoints and credentials.
 * Never use it for HTTP bodies or persisted project data; those boundaries
 * must use the strict validators below.
 */
export function validateModelOverride(input: unknown): ModelOverride | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;

  const provider = obj.provider;
  if (provider !== 'ollama' && provider !== 'openai' && provider !== 'custom') return null;

  if (typeof obj.modelName !== 'string' || !obj.modelName.trim()) return null;

  const result: ModelOverride = {
    provider,
    modelName: obj.modelName.trim(),
  };

  if (typeof obj.baseUrl === 'string' && obj.baseUrl.trim()) {
    result.baseUrl = obj.baseUrl.trim();
  }
  if (typeof obj.apiKey === 'string' && obj.apiKey.trim()) {
    result.apiKey = obj.apiKey.trim();
  }
  if (typeof obj.temperature === 'number' && obj.temperature >= 0 && obj.temperature <= 2) {
    result.temperature = obj.temperature;
  }

  return result;
}

/**
 * Validate model selection received directly from an untrusted HTTP body.
 *
 * `validateModelOverride` remains the trusted internal/project-normalization
 * boundary and therefore still understands endpoint and credential fields.
 * Public request handlers must use this narrower function so callers cannot
 * turn any MiroFish feature into an SSRF proxy or submit secrets for storage.
 */
export function validateHttpModelOverride(input: unknown): ModelOverride | null {
  return validateUntrustedModelOverride(input);
}

/**
 * Revalidate project data at the point where it becomes executable.
 *
 * Older stores can contain endpoint or credential fields written before the
 * HTTP boundary became restrictive. Treat that data as untrusted too: a type
 * assertion or successful deserialization must never make it executable.
 */
export function validatePersistedModelOverride(input: unknown): ModelOverride | null {
  return validateUntrustedModelOverride(input);
}

function validateUntrustedModelOverride(input: unknown): ModelOverride | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new MiroFishHttpModelOverrideValidationError('invalid');
  }

  const object = input as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(object, 'baseUrl')
    || Object.prototype.hasOwnProperty.call(object, 'apiKey')
  ) {
    throw new MiroFishHttpModelOverrideValidationError();
  }

  const allowedFields = new Set(['provider', 'modelName', 'temperature']);
  if (Object.keys(object).some(field => !allowedFields.has(field))) {
    throw new MiroFishHttpModelOverrideValidationError('invalid');
  }

  const provider = object.provider;
  const rawModelName = object.modelName;
  const modelName = typeof rawModelName === 'string' ? rawModelName.trim() : '';
  if (
    (provider !== 'ollama' && provider !== 'openai' && provider !== 'custom')
    || modelName.length === 0
    || modelName.length > MAX_HTTP_MODEL_NAME_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(modelName)
  ) {
    throw new MiroFishHttpModelOverrideValidationError('invalid');
  }

  const temperature = object.temperature;
  if (
    temperature !== undefined
    && (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)
  ) {
    throw new MiroFishHttpModelOverrideValidationError('invalid');
  }

  return {
    provider,
    modelName,
    ...(temperature !== undefined ? { temperature } : {}),
  };
}

/**
 * Build the public project representation without reflecting historical
 * endpoint or credential fields back to clients. Invalid legacy overrides are
 * omitted; execution paths independently reject them instead of silently
 * using a default provider.
 */
export function createPublicProjectProjection(project: Project): Project {
  const projection = { ...project };
  try {
    const modelConfig = validatePersistedModelOverride(project.model_config);
    if (modelConfig) {
      projection.model_config = modelConfig;
    } else {
      delete projection.model_config;
    }
  } catch {
    delete projection.model_config;
  }
  return projection;
}

export function getHttpModelOverrideErrorResponse(error: unknown): {
  status: number;
  body: {
    success: false;
    error: string;
    code: string;
  };
} | null {
  if (!(error instanceof MiroFishHttpModelOverrideValidationError)) return null;
  return {
    status: error.status,
    body: {
      success: false,
      error: error.message,
      code: error.code,
    },
  };
}

/**
 * Create a credential- and endpoint-free summary for administrative display.
 */
export function maskModelOverride(override: ModelOverride | undefined): (
  Omit<ModelOverride, 'apiKey' | 'baseUrl'> & { hasApiKey: boolean; hasBaseUrl: boolean }
) | undefined {
  if (!override) return undefined;
  const { apiKey, baseUrl, ...rest } = override;
  return { ...rest, hasApiKey: Boolean(apiKey), hasBaseUrl: Boolean(baseUrl) };
}

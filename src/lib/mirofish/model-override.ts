/**
 * 模型覆盖辅助
 *
 * 允许在运行时（每个请求/项目级别）覆盖全局 ModelFactory 配置，
 * 不修改单例全局状态，避免影响其他模块。
 */

import { ChatOllama } from '@langchain/ollama';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createLLM } from '../model-config';
import type { ModelOverride } from './types';

/**
 * 根据 override 创建 LLM；override 为空时走默认工厂。
 */
export function createLLMFromOverride(
  override?: ModelOverride,
  defaults: { temperature?: number } = {}
): BaseChatModel {
  const temperature = override?.temperature ?? defaults.temperature ?? 0.7;

  if (!override) {
    return createLLM(undefined, { temperature });
  }

  switch (override.provider) {
    case 'ollama':
      return new ChatOllama({
        baseUrl: override.baseUrl || 'http://localhost:11434',
        model: override.modelName,
        temperature,
      });

    case 'openai': {
      if (!override.apiKey) {
        throw new Error('OpenAI 提供商需要 API Key');
      }
      return new ChatOpenAI({
        openAIApiKey: override.apiKey,
        modelName: override.modelName,
        temperature,
        configuration: override.baseUrl ? { baseURL: override.baseUrl } : undefined,
      });
    }

    case 'custom': {
      if (!override.apiKey || !override.baseUrl) {
        throw new Error('Custom 提供商需要 API Key 和 Base URL');
      }
      return new ChatOpenAI({
        apiKey: override.apiKey,
        model: override.modelName,
        temperature,
        configuration: { baseURL: override.baseUrl },
      });
    }

    default: {
      const exhaustive: never = override.provider;
      throw new Error(`不支持的模型提供商: ${exhaustive}`);
    }
  }
}

/**
 * 校验并归一化来自外部输入的 modelOverride。
 * 返回 null 表示无效输入（调用方应走默认配置）。
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
 * 从 PUT 请求中移除 apiKey 便于返回给前端（安全）。
 * 前端用 hasApiKey 布尔判断是否已配置。
 */
export function maskModelOverride(override: ModelOverride | undefined): (Omit<ModelOverride, 'apiKey'> & { hasApiKey: boolean }) | undefined {
  if (!override) return undefined;
  const { apiKey, ...rest } = override;
  return { ...rest, hasApiKey: !!apiKey };
}

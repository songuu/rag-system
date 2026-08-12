'use client';

import React, { useState, useEffect } from 'react';

// LLM 配置
interface LLMConfig {
  provider: string;
  model: string;
  reasoningModel: string;
  fastModel: string;
  rerankerModel: string;
  requestPolicy: { timeoutMs: number; maxRetries: number };
  reasoningRequestPolicy: { timeoutMs: number; maxRetries: number };
  baseUrl: string;
  hasApiKey: boolean;
}

// Embedding 配置 (独立)
interface EmbeddingConfig {
  provider: string;
  model: string;
  dimension: number;
  baseUrl: string;
  hasApiKey: boolean;
}

// 完整配置
interface ModelConfigSummary {
  llm: LLMConfig;
  embedding: EmbeddingConfig;
  registeredModels: Array<{
    id: string;
    type: string;
    provider: string;
    modelName: string;
    description?: string;
    createdAt: number;
  }>;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

interface ModelConfigResponse {
  success: boolean;
  config: ModelConfigSummary;
  validation: {
    llm: ValidationResult;
    embedding: ValidationResult;
    overall: ValidationResult;
  };
  timestamp: string;
  error?: string;
}

export function ModelConfigPanel() {
  const [config, setConfig] = useState<ModelConfigSummary | null>(null);
  const [validation, setValidation] = useState<{ llm: ValidationResult; embedding: ValidationResult; overall: ValidationResult } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const fetchConfig = async () => {
    try {
      setLoading(true);
      const response = await fetch('/rag-api/model-config');
      const data: ModelConfigResponse = await response.json();
      
      if (data.success) {
        setConfig(data.config);
        setValidation(data.validation);
        setError(null);
      } else {
        setError(data.error || '获取配置失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '网络错误');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConfig();
  }, []);

  const handleReloadConfig = async () => {
    try {
      const response = await fetch('/rag-api/model-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reload' }),
      });
      const data = await response.json();
      
      if (data.success) {
        await fetchConfig();
      } else {
        setError(data.error || '重新加载配置失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '网络错误');
    }
  };

  const getProviderBadgeColor = (provider: string) => {
    switch (provider) {
      case 'ollama':
        return 'bg-green-900/50 text-green-400 border-green-700';
      case 'openai':
        return 'bg-blue-900/50 text-blue-400 border-blue-700';
      case 'azure':
        return 'bg-purple-900/50 text-purple-400 border-purple-700';
      case 'siliconflow':
        return 'bg-cyan-900/50 text-cyan-400 border-cyan-700';
      case 'custom':
        return 'bg-orange-900/50 text-orange-400 border-orange-700';
      default:
        return 'bg-gray-900/50 text-gray-400 border-gray-700';
    }
  };

  const getProviderIcon = (provider: string) => {
    switch (provider) {
      case 'ollama':
        return '🦙';
      case 'openai':
        return '🤖';
      case 'azure':
        return '☁️';
      case 'siliconflow':
        return '⚡';
      case 'custom':
        return '🔧';
      default:
        return '❓';
    }
  };

  if (loading) {
    return (
      <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700">
        <div className="flex items-center gap-2 text-slate-400">
          <div className="animate-spin w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full" />
          <span>加载配置中...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-900/20 rounded-lg p-4 border border-red-800">
        <div className="flex items-center gap-2 text-red-400">
          <span>❌</span>
          <span>{error}</span>
          <button
            onClick={fetchConfig}
            className="ml-auto px-2 py-1 text-xs bg-red-800 hover:bg-red-700 rounded"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  if (!config) return null;

  const llmProvider = config.llm?.provider || 'unknown';
  const embeddingProvider = config.embedding?.provider || 'unknown';

  return (
    <div className="bg-slate-800/50 rounded-lg border border-slate-700 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-slate-700/30 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-lg">{getProviderIcon(llmProvider)}</span>
          <span className="font-medium text-slate-200">模型配置</span>
          <span className={`px-2 py-0.5 text-xs font-medium rounded border ${getProviderBadgeColor(llmProvider)}`}>
            LLM: {llmProvider.toUpperCase()}
          </span>
          <span className={`px-2 py-0.5 text-xs font-medium rounded border ${getProviderBadgeColor(embeddingProvider)}`}>
            EMB: {embeddingProvider.toUpperCase()}
          </span>
          {validation && !validation.overall?.valid && (
            <span className="px-2 py-0.5 text-xs font-medium rounded bg-red-900/50 text-red-400 border border-red-700">
              ⚠️ 配置错误
            </span>
          )}
        </div>
        <span className="text-slate-400 text-sm">
          {expanded ? '▲' : '▼'}
        </span>
      </button>

      {/* Content */}
      {expanded && (
        <div className="px-4 pb-4 space-y-4">
          {/* 验证错误 */}
          {validation && !validation.overall?.valid && (
            <div className="bg-red-900/20 rounded p-3 border border-red-800">
              <div className="text-red-400 text-sm font-medium mb-2">配置错误:</div>
              <ul className="list-disc list-inside text-red-300 text-sm space-y-1">
                {validation.overall?.errors?.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </div>
          )}

          {/* LLM 配置 */}
          <div className="bg-slate-900/50 rounded p-3 border border-slate-700">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-medium text-slate-300">🤖 LLM 配置</span>
              <span className={`px-2 py-0.5 text-xs rounded border ${getProviderBadgeColor(llmProvider)}`}>
                {llmProvider}
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-slate-500 mb-1">对话模型</div>
                <div className="text-slate-200 font-mono text-sm truncate" title={config.llm?.model}>
                  {config.llm?.model || '-'}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1">推理模型</div>
                <div className="text-slate-200 font-mono text-sm truncate" title={config.llm?.reasoningModel}>
                  {config.llm?.reasoningModel || '-'}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1">快速模型</div>
                <div className="text-slate-200 font-mono text-sm truncate" title={config.llm?.fastModel}>
                  {config.llm?.fastModel || '-'}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1">重排模型</div>
                <div className="text-slate-200 font-mono text-sm truncate" title={config.llm?.rerankerModel}>
                  {config.llm?.rerankerModel || '-'}
                </div>
              </div>
            </div>
            <div className="mt-3 rounded border border-slate-700 bg-slate-950/60 px-3 py-2 text-xs text-slate-400">
              普通单次调用 {Math.round((config.llm?.requestPolicy?.timeoutMs || 0) / 1000)} 秒，
              最多重试 {config.llm?.requestPolicy?.maxRetries ?? 0} 次；深度推理单次{' '}
              {Math.round((config.llm?.reasoningRequestPolicy?.timeoutMs || 0) / 1000)} 秒。
            </div>
            <div className="mt-2 flex items-center justify-between">
              <div className="text-xs text-slate-500">
                端点: <span className="text-slate-400 font-mono">{config.llm?.baseUrl || '-'}</span>
              </div>
              {config.llm?.hasApiKey ? (
                <span className="px-2 py-0.5 text-xs bg-green-900/50 text-green-400 rounded border border-green-700">
                  ✓ API Key
                </span>
              ) : llmProvider === 'ollama' ? (
                <span className="px-2 py-0.5 text-xs bg-blue-900/50 text-blue-400 rounded border border-blue-700">
                  本地模式
                </span>
              ) : (
                <span className="px-2 py-0.5 text-xs bg-yellow-900/50 text-yellow-400 rounded border border-yellow-700">
                  ⚠️ 无 Key
                </span>
              )}
            </div>
          </div>

          {/* Embedding 配置 (独立) */}
          <div className="bg-slate-900/50 rounded p-3 border border-slate-700">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-medium text-slate-300">📊 Embedding 配置</span>
              <span className={`px-2 py-0.5 text-xs rounded border ${getProviderBadgeColor(embeddingProvider)}`}>
                {embeddingProvider}
              </span>
              {embeddingProvider === 'siliconflow' && (
                <span className="px-2 py-0.5 text-xs bg-cyan-900/50 text-cyan-400 rounded border border-cyan-700">
                  ⭐ 硅基流动
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-slate-500 mb-1">模型</div>
                <div className="text-slate-200 font-mono text-sm truncate" title={config.embedding?.model}>
                  {config.embedding?.model || '-'}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1">向量维度</div>
                <div className="text-slate-200 font-mono text-sm">
                  {config.embedding?.dimension || '-'}
                </div>
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <div className="text-xs text-slate-500">
                端点: <span className="text-slate-400 font-mono">{config.embedding?.baseUrl || '-'}</span>
              </div>
              {config.embedding?.hasApiKey ? (
                <span className="px-2 py-0.5 text-xs bg-green-900/50 text-green-400 rounded border border-green-700">
                  ✓ API Key
                </span>
              ) : embeddingProvider === 'ollama' ? (
                <span className="px-2 py-0.5 text-xs bg-blue-900/50 text-blue-400 rounded border border-blue-700">
                  本地模式
                </span>
              ) : (
                <span className="px-2 py-0.5 text-xs bg-yellow-900/50 text-yellow-400 rounded border border-yellow-700">
                  ⚠️ 无 Key
                </span>
              )}
            </div>
          </div>

          {/* 动态注册的模型 */}
          {config.registeredModels && config.registeredModels.length > 0 && (
            <div className="bg-slate-900/50 rounded p-3 border border-slate-700">
              <div className="text-xs text-slate-500 mb-2">动态注册的模型 ({config.registeredModels.length})</div>
              <div className="space-y-2">
                {config.registeredModels.map((model) => (
                  <div key={model.id} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span className={`px-1.5 py-0.5 text-xs rounded ${
                        model.type === 'llm' ? 'bg-blue-900/50 text-blue-400' :
                        model.type === 'embedding' ? 'bg-green-900/50 text-green-400' :
                        'bg-purple-900/50 text-purple-400'
                      }`}>
                        {model.type}
                      </span>
                      <span className="text-slate-200 font-mono">{model.id}</span>
                    </div>
                    <span className="text-slate-500 text-xs">
                      {new Date(model.createdAt).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex items-center gap-2 pt-2">
            <button
              onClick={handleReloadConfig}
              className="px-3 py-1.5 text-sm bg-slate-700 hover:bg-slate-600 text-slate-200 rounded transition-colors"
            >
              🔄 重新加载配置
            </button>
            <button
              onClick={fetchConfig}
              className="px-3 py-1.5 text-sm bg-slate-700 hover:bg-slate-600 text-slate-200 rounded transition-colors"
            >
              ↻ 刷新
            </button>
          </div>

          {/* 配置说明 */}
          <div className="text-xs text-slate-500 pt-2 border-t border-slate-700 space-y-1">
            <p>
              <code className="bg-slate-900 px-1 rounded">MODEL_PROVIDER</code> 控制 LLM 提供商
            </p>
            <p>
              <code className="bg-slate-900 px-1 rounded">EMBEDDING_PROVIDER</code> 独立控制 Embedding 提供商
            </p>
            <p className="text-slate-600">
              支持: ollama | siliconflow | openai | azure | custom
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

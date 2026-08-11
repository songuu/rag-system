'use client';

import React, { useState } from 'react';
import ModelManagementPanel from './ModelManagementPanel';
interface ParameterControlsProps {
  topK: number;
  threshold: number;
  llmModel: string;
  embeddingModel: string;
  onTopKChange: (value: number) => void;
  onThresholdChange: (value: number) => void;
  onLLMModelChange: (value: string) => void;
  onEmbeddingModelChange: (value: string) => void;
  showParams: boolean;
  onToggle: () => void;
}

interface RuntimeModelOption {
  name: string;
  displayName?: string;
  sizeFormatted?: string;
  tag?: string;
}

interface AvailableModelsResponse {
  success: boolean;
  llmModels: RuntimeModelOption[];
  embeddingModels: RuntimeModelOption[];
  error?: string;
  status?: {
    ready?: boolean;
    hasRecommendedLLM?: boolean;
    hasRecommendedEmbedding?: boolean;
  };
}

export default function ParameterControls({

  topK,
  threshold,
  llmModel,
  embeddingModel,
  onTopKChange,
  onThresholdChange,
  onLLMModelChange,
  onEmbeddingModelChange,
  showParams,
  onToggle
}: ParameterControlsProps) {
  const [activeTab, setActiveTab] = useState<'retrieval' | 'model' | 'manage'>('retrieval');
  const [availableModels, setAvailableModels] = useState<AvailableModelsResponse | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  const loadAvailableModels = async () => {
    setLoadingModels(true);
    try {
      const response = await fetch('/api/ollama/models', {
        signal: AbortSignal.timeout(5_000),
      });
      const data = await response.json() as AvailableModelsResponse;
      if (!response.ok || !data.success) {
        throw new Error(data.error || '模型列表加载失败');
      }
      setAvailableModels(data);
    } catch (error) {
      console.error('Failed to load models:', error);
      setAvailableModels({
        success: false,
        llmModels: [],
        embeddingModels: [],
        error: error instanceof DOMException && error.name === 'TimeoutError'
          ? '模型列表加载超过 5 秒，请检查模型服务'
          : error instanceof Error ? error.message : '模型列表加载失败',
      });
    } finally {
      setLoadingModels(false);
    }
  };

  if (!showParams) {
    return (
      <div className="mb-4">
        <button 
          onClick={onToggle}
          className="text-xs text-blue-600 hover:text-blue-800"
        >
          <i className="fas fa-chevron-down mr-1"></i>展开参数设置
        </button>
      </div>
    );
  }

  return (
    <div className="mb-4 p-4 bg-gray-50 rounded-lg">
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab('retrieval')}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${
              activeTab === 'retrieval' 
                ? 'bg-blue-600 text-white' 
                : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'
            }`}
          >
            检索参数
          </button>
          <button
            onClick={() => {
              setActiveTab('model');
              void loadAvailableModels();
            }}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${
              activeTab === 'model' 
                ? 'bg-blue-600 text-white' 
                : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'
            }`}
          >
            模型选择
          </button>
          <button
            onClick={() => setActiveTab('manage')}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${
              activeTab === 'manage' 
                ? 'bg-purple-600 text-white' 
                : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'
            }`}
          >
            🔧 模型管理
          </button>
        </div>
        <button 
          onClick={onToggle}
          className="text-xs text-blue-600 hover:text-blue-800"
        >
          <i className="fas fa-chevron-up"></i> 收起
        </button>
      </div>

      {activeTab === 'retrieval' && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-600 mb-1">Top-K 文档数</label>
            <input 
              type="range" 
              min="1" 
              max="100" 
              value={topK} 
              onChange={(e) => onTopKChange(parseInt(e.target.value))}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
            />
            <div className="flex justify-between text-xs text-gray-500">
              <span>1</span>
              <span className="font-medium">{topK}</span>
              <span>100</span>
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">相似度阈值</label>
            <input 
              type="range" 
              min="0" 
              max="1" 
              step="0.01" 
              value={threshold} 
              onChange={(e) => onThresholdChange(parseFloat(e.target.value))}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
            />
            <div className="flex justify-between text-xs text-gray-500">
              <span>0.0</span>
              <span className="font-medium">{threshold.toFixed(2)}</span>
              <span>1.0</span>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'model' && (
        <div className="space-y-4">
          {loadingModels ? (
            <div className="text-center py-8">
              <div className="animate-spin h-8 w-8 border-4 border-purple-600 border-t-transparent rounded-full mx-auto mb-2"></div>
              <p className="text-xs text-gray-500">正在检测本地 Ollama 模型...</p>
            </div>
          ) : availableModels && availableModels.success ? (
            <>
              {/* LLM 模型选择 */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs text-gray-600 font-medium flex items-center gap-2">
                    🤖 LLM 模型
                    {availableModels.llmModels.length === 0 && (
                      <span className="text-red-600">(未安装)</span>
                    )}
                  </label>
                  <button
                    onClick={loadAvailableModels}
                    className="text-xs text-blue-600 hover:text-blue-800 underline"
                  >
                    刷新
                  </button>
                </div>
                {availableModels.llmModels.length > 0 ? (
                  <>
                    <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto p-1">
                      {availableModels.llmModels.map((model: any) => (
                        <button
                          key={model.name}
                          onClick={() => onLLMModelChange(model.name)}
                          className={`p-3 text-left rounded-lg border-2 transition-all ${
                            llmModel === model.name
                              ? 'border-purple-500 bg-purple-50 shadow-md'
                              : 'border-gray-200 hover:border-purple-300 hover:bg-gray-50'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <div className="text-sm font-semibold text-gray-800 truncate">
                              {model.displayName}
                            </div>
                            {llmModel === model.name && (
                              <svg className="w-4 h-4 text-purple-600" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                              </svg>
                            )}
                          </div>
                          <div className="text-[10px] text-gray-500">{model.sizeFormatted}</div>
                          <div className="text-[10px] text-gray-400 truncate">{model.tag}</div>
                        </button>
                      ))}
                    </div>
                    <div className="mt-2 text-xs text-gray-600 bg-purple-50 p-2 rounded border border-purple-200">
                      当前使用: <span className="font-semibold text-purple-700">{llmModel}</span>
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-gray-600 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                    <div className="flex items-start gap-2 mb-2">
                      <span className="text-lg">⚠️</span>
                      <div>
                        <div className="font-medium text-yellow-800 mb-1">未检测到 LLM 模型</div>
                        <div className="text-yellow-700 mb-2">请安装至少一个 LLM 模型才能使用系统</div>
                        <button
                          onClick={() => setActiveTab('manage')}
                          className="px-3 py-1 bg-yellow-600 hover:bg-yellow-700 text-white rounded text-xs transition-colors"
                        >
                          去安装模型 →
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Embedding 模型选择 */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs text-gray-600 font-medium flex items-center gap-2">
                    🧬 Embedding 模型
                    {availableModels.embeddingModels.length === 0 && (
                      <span className="text-red-600">(未安装)</span>
                    )}
                  </label>
                </div>
                {availableModels.embeddingModels.length > 0 ? (
                  <>
                    <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto p-1">
                      {availableModels.embeddingModels.map((model: any) => (
                        <button
                          key={model.name}
                          onClick={() => onEmbeddingModelChange(model.name)}
                          className={`p-3 text-left rounded-lg border-2 transition-all ${
                            embeddingModel === model.name
                              ? 'border-blue-500 bg-blue-50 shadow-md'
                              : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <div className="text-sm font-semibold text-gray-800 truncate">
                              {model.displayName}
                            </div>
                            {embeddingModel === model.name && (
                              <svg className="w-4 h-4 text-blue-600" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                              </svg>
                            )}
                          </div>
                          <div className="text-[10px] text-gray-500">{model.sizeFormatted}</div>
                          <div className="text-[10px] text-gray-400 truncate">{model.tag}</div>
                        </button>
                      ))}
                    </div>
                    <div className="mt-2 text-xs text-gray-600 bg-blue-50 p-2 rounded border border-blue-200">
                      当前使用: <span className="font-semibold text-blue-700">{embeddingModel}</span>
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-gray-600 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                    <div className="flex items-start gap-2 mb-2">
                      <span className="text-lg">⚠️</span>
                      <div>
                        <div className="font-medium text-yellow-800 mb-1">未检测到 Embedding 模型</div>
                        <div className="text-yellow-700 mb-2">Embedding 模型用于文本向量化，是 RAG 系统的核心</div>
                        <button
                          onClick={() => setActiveTab('manage')}
                          className="px-3 py-1 bg-yellow-600 hover:bg-yellow-700 text-white rounded text-xs transition-colors"
                        >
                          去安装模型 →
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* 系统状态提示 */}
              {availableModels.status && (
                <div className={`p-3 rounded-lg text-xs border-2 ${
                  availableModels.status.ready
                    ? 'bg-green-50 text-green-700 border-green-300'
                    : 'bg-yellow-50 text-yellow-700 border-yellow-300'
                }`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-base">
                      {availableModels.status.ready ? '✅' : '⚠️'}
                    </span>
                    <span className="font-semibold">
                      {availableModels.status.ready ? '系统就绪' : '需要安装推荐模型'}
                    </span>
                  </div>
                  {!availableModels.status.ready && (
                    <div className="ml-6 text-[10px]">
                      {!availableModels.status.hasRecommendedLLM && <div>• 缺少 LLM 模型</div>}
                      {!availableModels.status.hasRecommendedEmbedding && <div>• 缺少 Embedding 模型</div>}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="font-semibold mb-2">⚠️ 无法加载模型列表</div>
              <div className="text-red-700 mb-3">
                {availableModels?.error || '请确保 Ollama 服务正在运行'}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={loadAvailableModels}
                  className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-xs transition-colors"
                >
                  重试
                </button>
                <button
                  onClick={() => setActiveTab('manage')}
                  className="px-3 py-1 bg-gray-600 hover:bg-gray-700 text-white rounded text-xs transition-colors"
                >
                  查看详情
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'manage' && (
        <ModelManagementPanel
          currentLLM={llmModel}
          currentEmbedding={embeddingModel}
          onModelSelect={(type, name) => {
            if (type === 'llm') {
              onLLMModelChange(name);
            } else {
              onEmbeddingModelChange(name);
            }
            loadAvailableModels(); // 刷新模型列表
            setActiveTab('model'); // 切换回模型选择标签
          }}
        />
      )}
    </div>
  );
}
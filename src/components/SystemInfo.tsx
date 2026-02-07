/*
 * @Author: songyu
 * @Date: 2026-01-12 20:38:58
 * @LastEditTime: 2026-01-27 10:00:00
 * @LastEditor: songyu
 */
'use client';

import React, { useState, useEffect } from 'react';

interface ModelConfig {
  llm: {
    provider: string;
    model: string;
  };
  embedding: {
    provider: string;
    model: string;
    dimension: number;
  };
}

interface SystemInfoProps {
  docCount: number;
  embeddingDim: number;
  systemStatus: string;
  llmModel: string;
  embeddingModel: string;
  modelConfig?: ModelConfig;
  onReinitialize: () => void;
  onModelChange: (llmModel: string, embeddingModel: string) => void;
}

interface ModelInfo {
  name: string;
  displayName: string;
  category: string;
  sizeFormatted?: string;
  tag?: string;
}

// 提供商显示名称和颜色
const PROVIDER_INFO: Record<string, { name: string; color: string; bgColor: string }> = {
  ollama: { name: 'Ollama', color: 'text-gray-700', bgColor: 'bg-gray-100' },
  openai: { name: 'OpenAI', color: 'text-green-700', bgColor: 'bg-green-100' },
  azure: { name: 'Azure', color: 'text-blue-700', bgColor: 'bg-blue-100' },
  siliconflow: { name: 'SiliconFlow', color: 'text-purple-700', bgColor: 'bg-purple-100' },
  custom: { name: 'Custom', color: 'text-orange-700', bgColor: 'bg-orange-100' },
};

export default function SystemInfo({ 
  docCount, 
  embeddingDim, 
  systemStatus, 
  llmModel,
  embeddingModel,
  modelConfig,
  onReinitialize,
  onModelChange
}: SystemInfoProps) {
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [availableModels, setAvailableModels] = useState<any>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [selectedLLM, setSelectedLLM] = useState(llmModel);
  const [selectedEmbedding, setSelectedEmbedding] = useState(embeddingModel);

  // 获取提供商信息
  const llmProvider = modelConfig?.llm?.provider || 'ollama';
  const embeddingProvider = modelConfig?.embedding?.provider || 'ollama';
  const isOllamaLLM = llmProvider === 'ollama';
  const isOllamaEmbedding = embeddingProvider === 'ollama';

  // 加载可用模型（仅 Ollama 时可用）
  const loadModels = async () => {
    if (!isOllamaLLM && !isOllamaEmbedding) {
      // 非 Ollama 提供商，不需要加载本地模型
      setAvailableModels({
        success: true,
        isRemoteProvider: true,
        llmModels: [],
        embeddingModels: [],
      });
      return;
    }

    setLoadingModels(true);
    try {
      const response = await fetch('/api/ollama/models');
      const data = await response.json();
      setAvailableModels({
        ...data,
        isRemoteProvider: false,
      });
    } catch (error) {
      console.error('Failed to load models:', error);
      setAvailableModels({
        success: false,
        error: '无法加载模型列表',
        isRemoteProvider: false,
      });
    } finally {
      setLoadingModels(false);
    }
  };

  // 打开模型选择器时加载模型
  useEffect(() => {
    if (showModelSelector) {
      loadModels();
      setSelectedLLM(llmModel);
      setSelectedEmbedding(embeddingModel);
    }
  }, [showModelSelector, llmModel, embeddingModel]);

  // 应用模型变更
  const handleApplyModelChange = () => {
    if (selectedLLM !== llmModel || selectedEmbedding !== embeddingModel) {
      onModelChange(selectedLLM, selectedEmbedding);
      setShowModelSelector(false);
    } else {
      setShowModelSelector(false);
    }
  };

  // 格式化模型名称
  const formatModelName = (name: string) => {
    if (!name) return '-';
    // 对于 SiliconFlow 等远程模型，显示完整名称
    if (name.includes('/')) {
      return name.split('/').pop() || name;
    }
    return name.split(':')[0];
  };

  // 获取提供商样式
  const getProviderStyle = (provider: string) => {
    return PROVIDER_INFO[provider] || PROVIDER_INFO.custom;
  };

  // 渲染提供商标签
  const renderProviderBadge = (provider: string) => {
    const style = getProviderStyle(provider);
    return (
      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${style.bgColor} ${style.color}`}>
        {style.name}
      </span>
    );
  };

  return (
    <>
      <div className="bg-white rounded-lg shadow-sm border">
        <div className="border-b px-6 py-4">
          <h3 className="text-lg font-medium text-gray-900">系统信息</h3>
        </div>
        
        <div className="p-6 space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">文档数量:</span>
            <span className="font-medium">{docCount || '-'}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">向量维度:</span>
            <span className="font-medium">{embeddingDim || '-'}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">系统状态:</span>
            <span className={`font-medium ${
              systemStatus === '运行中' ? 'text-green-600' : 
              systemStatus === '重新初始化中...' ? 'text-yellow-600' : 
              'text-gray-600'
            }`}>{systemStatus}</span>
          </div>
          
          {/* 模型信息 - 显示提供商和模型 */}
          <div className="pt-3 border-t">
            {/* LLM 模型 */}
            <div className="flex justify-between items-center text-sm mb-2">
              <span className="text-gray-600">LLM 模型:</span>
              <div className="flex items-center gap-2">
                {renderProviderBadge(llmProvider)}
                <span className="font-medium text-xs text-purple-700" title={llmModel}>
                  {formatModelName(llmModel)}
                </span>
              </div>
            </div>
            
            {/* Embedding 模型 */}
            <div className="flex justify-between items-center text-sm">
              <span className="text-gray-600">嵌入模型:</span>
              <div className="flex items-center gap-2">
                {renderProviderBadge(embeddingProvider)}
                <span className="font-medium text-xs text-blue-700" title={embeddingModel}>
                  {formatModelName(embeddingModel)}
                </span>
              </div>
            </div>
            
            {/* 只有 Ollama 提供商时才显示切换按钮 */}
            {(isOllamaLLM || isOllamaEmbedding) ? (
              <button
                onClick={() => setShowModelSelector(true)}
                className="w-full mt-3 px-3 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm transition-colors"
              >
                <i className="fas fa-exchange-alt mr-2"></i>
                切换模型
              </button>
            ) : (
              <div className="mt-3 px-3 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm text-center">
                <i className="fas fa-info-circle mr-2"></i>
                通过环境变量配置模型
              </div>
            )}
          </div>
          
          <button 
            onClick={onReinitialize}
            disabled={systemStatus === '重新初始化中...'}
            className="w-full mt-4 px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <i className="fas fa-redo mr-2"></i>
            重新初始化
          </button>
        </div>
      </div>

      {/* 模型选择模态框 */}
      {showModelSelector && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            {/* 标题 */}
            <div className="px-6 py-4 border-b flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">选择模型</h3>
              <button
                onClick={() => setShowModelSelector(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* 内容 */}
            <div className="flex-1 overflow-y-auto p-6">
              {loadingModels ? (
                <div className="flex items-center justify-center py-12">
                  <div className="text-center">
                    <div className="animate-spin h-8 w-8 border-4 border-purple-600 border-t-transparent rounded-full mx-auto mb-3"></div>
                    <p className="text-sm text-gray-500">正在加载模型列表...</p>
                  </div>
                </div>
              ) : availableModels?.isRemoteProvider ? (
                // 远程提供商的配置信息显示
                <div className="space-y-6">
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <div className="flex items-start">
                      <div className="flex-shrink-0">
                        <svg className="h-5 w-5 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                        </svg>
                      </div>
                      <div className="ml-3">
                        <h3 className="text-sm font-medium text-blue-800">远程模型提供商</h3>
                        <p className="mt-1 text-sm text-blue-700">
                          当前使用的是远程模型服务，模型配置需要通过环境变量进行更改。
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* LLM 配置显示 */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-3">
                      🤖 LLM 模型配置
                    </label>
                    <div className="p-4 rounded-lg border-2 border-gray-200 bg-gray-50">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            {renderProviderBadge(llmProvider)}
                            <span className="font-medium text-gray-900">{llmModel}</span>
                          </div>
                          <p className="text-xs text-gray-500">
                            配置变量: MODEL_PROVIDER, {llmProvider === 'openai' ? 'OPENAI_LLM_MODEL' : 'OLLAMA_LLM_MODEL'}
                          </p>
                        </div>
                        <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                        </svg>
                      </div>
                    </div>
                  </div>

                  {/* Embedding 配置显示 */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-3">
                      🧬 Embedding 模型配置
                    </label>
                    <div className="p-4 rounded-lg border-2 border-gray-200 bg-gray-50">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            {renderProviderBadge(embeddingProvider)}
                            <span className="font-medium text-gray-900">{embeddingModel}</span>
                          </div>
                          <p className="text-xs text-gray-500">
                            配置变量: EMBEDDING_PROVIDER, {embeddingProvider === 'siliconflow' ? 'SILICONFLOW_EMBEDDING_MODEL' : 'OLLAMA_EMBEDDING_MODEL'}
                          </p>
                          {modelConfig?.embedding?.dimension && (
                            <p className="text-xs text-gray-500 mt-1">
                              向量维度: {modelConfig.embedding.dimension}
                            </p>
                          )}
                        </div>
                        <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                        </svg>
                      </div>
                    </div>
                  </div>

                  <div className="text-xs text-gray-500 bg-gray-100 p-3 rounded-lg">
                    <p className="font-medium mb-1">如何更改模型配置：</p>
                    <ol className="list-decimal list-inside space-y-1">
                      <li>修改 <code className="bg-white px-1 rounded">.env.local</code> 文件中的相关变量</li>
                      <li>重启应用程序以应用更改</li>
                      <li>点击"重新初始化"更新系统状态</li>
                    </ol>
                  </div>
                </div>
              ) : availableModels && availableModels.success ? (
                <div className="space-y-6">
                  {/* LLM 模型选择 (仅 Ollama) */}
                  {isOllamaLLM && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-3">
                        🤖 LLM 模型 ({availableModels.llmModels?.length || 0})
                      </label>
                      {availableModels.llmModels && availableModels.llmModels.length > 0 ? (
                        <div className="grid grid-cols-2 gap-3">
                          {availableModels.llmModels.map((model: ModelInfo) => (
                            <button
                              key={model.name}
                              onClick={() => setSelectedLLM(model.name)}
                              className={`p-3 rounded-lg border-2 text-left transition-all ${
                                selectedLLM === model.name
                                  ? 'border-purple-500 bg-purple-50'
                                  : 'border-gray-200 hover:border-purple-300 bg-white'
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium text-sm text-gray-900 truncate">
                                    {model.displayName}
                                  </div>
                                  <div className="text-xs text-gray-500 mt-0.5">
                                    {model.sizeFormatted || model.tag}
                                  </div>
                                </div>
                                {selectedLLM === model.name && (
                                  <svg className="w-5 h-5 text-purple-600 ml-2 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                  </svg>
                                )}
                              </div>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="text-sm text-gray-500 bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-center">
                          未检测到 LLM 模型，请先安装模型
                        </div>
                      )}
                    </div>
                  )}
                  
                  {/* 非 Ollama LLM 配置显示 */}
                  {!isOllamaLLM && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-3">
                        🤖 LLM 模型配置 (远程)
                      </label>
                      <div className="p-4 rounded-lg border-2 border-gray-200 bg-gray-50">
                        <div className="flex items-center gap-2">
                          {renderProviderBadge(llmProvider)}
                          <span className="font-medium text-gray-900">{llmModel}</span>
                        </div>
                        <p className="text-xs text-gray-500 mt-2">通过环境变量配置</p>
                      </div>
                    </div>
                  )}

                  {/* Embedding 模型选择 (仅 Ollama) */}
                  {isOllamaEmbedding && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-3">
                        🧬 Embedding 模型 ({availableModels.embeddingModels?.length || 0})
                      </label>
                      {availableModels.embeddingModels && availableModels.embeddingModels.length > 0 ? (
                        <div className="grid grid-cols-2 gap-3">
                          {availableModels.embeddingModels.map((model: ModelInfo) => (
                            <button
                              key={model.name}
                              onClick={() => setSelectedEmbedding(model.name)}
                              className={`p-3 rounded-lg border-2 text-left transition-all ${
                                selectedEmbedding === model.name
                                  ? 'border-blue-500 bg-blue-50'
                                  : 'border-gray-200 hover:border-blue-300 bg-white'
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium text-sm text-gray-900 truncate">
                                    {model.displayName}
                                  </div>
                                  <div className="text-xs text-gray-500 mt-0.5">
                                    {model.sizeFormatted || model.tag}
                                  </div>
                                </div>
                                {selectedEmbedding === model.name && (
                                  <svg className="w-5 h-5 text-blue-600 ml-2 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                  </svg>
                                )}
                              </div>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="text-sm text-gray-500 bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-center">
                          未检测到 Embedding 模型，请先安装模型
                        </div>
                      )}
                    </div>
                  )}
                  
                  {/* 非 Ollama Embedding 配置显示 */}
                  {!isOllamaEmbedding && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-3">
                        🧬 Embedding 模型配置 (远程)
                      </label>
                      <div className="p-4 rounded-lg border-2 border-gray-200 bg-gray-50">
                        <div className="flex items-center gap-2">
                          {renderProviderBadge(embeddingProvider)}
                          <span className="font-medium text-gray-900">{embeddingModel}</span>
                        </div>
                        <p className="text-xs text-gray-500 mt-2">
                          通过环境变量配置
                          {modelConfig?.embedding?.dimension && ` | 维度: ${modelConfig.embedding.dimension}`}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-12">
                  <div className="text-red-600 mb-4">
                    <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                  </div>
                  <p className="text-sm text-gray-600 mb-4">{availableModels?.error || '无法加载模型列表'}</p>
                  <button
                    onClick={loadModels}
                    className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm transition-colors"
                  >
                    重试
                  </button>
                </div>
              )}
            </div>

            {/* 底部按钮 */}
            <div className="px-6 py-4 border-t bg-gray-50 flex items-center justify-between">
              <div className="text-xs text-gray-500">
                {availableModels?.isRemoteProvider ? (
                  <span className="text-blue-600 font-medium">ℹ️ 远程模型通过环境变量配置</span>
                ) : selectedLLM !== llmModel || selectedEmbedding !== embeddingModel ? (
                  <span className="text-yellow-600 font-medium">⚠️ 应用后将重新初始化系统</span>
                ) : (
                  <span>未做任何更改</span>
                )}
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowModelSelector(false)}
                  className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-100 text-sm transition-colors"
                >
                  {availableModels?.isRemoteProvider ? '关闭' : '取消'}
                </button>
                {!availableModels?.isRemoteProvider && (isOllamaLLM || isOllamaEmbedding) && (
                  <button
                    onClick={handleApplyModelChange}
                    disabled={!availableModels?.success || (selectedLLM === llmModel && selectedEmbedding === embeddingModel)}
                    className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    应用更改
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

'use client';

import React, { useState, useEffect } from 'react';

interface ModelInfo {
  name: string;
  displayName: string;
  tag: string;
  size: number;
  sizeFormatted: string;
  category: 'llm' | 'embedding' | 'unknown';
  modifiedAt: string;
}

interface RecommendedModel {
  name: string;
  displayName: string;
  description: string;
  size?: string;
  dimension?: number;
  contextLength?: number;
  recommended: boolean;
  installed?: boolean;
}

interface ModelData {
  success: boolean;
  hasModels: boolean;
  llmModels: ModelInfo[];
  embeddingModels: ModelInfo[];
  unknownModels?: ModelInfo[];
  recommended: {
    llm: RecommendedModel[];
    embedding: RecommendedModel[];
  };
  status: {
    hasRecommendedLLM: boolean;
    hasRecommendedEmbedding: boolean;
    ready: boolean;
  };
  warnings?: string[];
  error?: string;
  code?: string;
  suggestion?: string;
}

interface ModelManagementPanelProps {
  onModelSelect?: (type: 'llm' | 'embedding', modelName: string) => void;
  currentLLM?: string;
  currentEmbedding?: string;
}

export default function ModelManagementPanel({
  onModelSelect,
  currentLLM,
  currentEmbedding
}: ModelManagementPanelProps) {
  const [modelData, setModelData] = useState<ModelData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'installed' | 'recommended'>('installed');
  const [selectedModel, setSelectedModel] = useState<{ type: 'llm' | 'embedding'; name: string } | null>(null);

  // 加载模型列表
  const loadModels = async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      const response = await fetch('/api/ollama/models');
      const data = await response.json();
      
      if (!data.success) {
        setError(data.error || '加载失败');
        setModelData(data);
      } else {
        setModelData(data);
      }
    } catch (err) {
      setError('无法连接到服务器');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadModels();
  }, []);

  // 安装模型（打开终端命令）
  const handleInstallModel = (modelName: string) => {
    const command = `ollama pull ${modelName}`;
    navigator.clipboard.writeText(command);
    alert(`安装命令已复制到剪贴板:\n${command}\n\n请在终端中运行此命令`);
  };

  // 选择模型
  const handleSelectModel = (type: 'llm' | 'embedding', modelName: string) => {
    setSelectedModel({ type, name: modelName });
    if (onModelSelect) {
      onModelSelect(type, modelName);
    }
  };

  // Ollama 离线状态
  if (error && modelData?.code === 'OLLAMA_OFFLINE') {
    return (
      <div className="bg-red-50 border-2 border-red-200 rounded-xl p-6">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 bg-red-500 rounded-full flex items-center justify-center flex-shrink-0">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-bold text-red-800 mb-2">Ollama 服务未运行</h3>
            <p className="text-sm text-red-700 mb-4">{modelData.suggestion}</p>
            
            <div className="bg-white rounded-lg p-4 mb-4">
              <div className="text-sm font-medium text-gray-700 mb-2">启动步骤：</div>
              <ol className="text-sm text-gray-600 space-y-2 list-decimal list-inside">
                <li>打开终端（Terminal / CMD / PowerShell）</li>
                <li>运行命令: <code className="px-2 py-1 bg-gray-100 rounded font-mono">ollama serve</code></li>
                <li>等待服务启动（看到 "Listening on ..." 信息）</li>
                <li>刷新此页面</li>
              </ol>
            </div>
            
            <div className="flex gap-3">
              <button
                onClick={loadModels}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors"
              >
                重新检测
              </button>
              <a
                href="https://ollama.ai/download"
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded-lg font-medium transition-colors"
              >
                下载 Ollama
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 加载中
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <svg className="animate-spin h-8 w-8 text-purple-600 mx-auto mb-3" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p className="text-sm text-gray-600">正在检测 Ollama 模型...</p>
        </div>
      </div>
    );
  }

  // 无模型状态
  if (modelData && !modelData.hasModels) {
    return (
      <div className="bg-yellow-50 border-2 border-yellow-200 rounded-xl p-6">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 bg-yellow-500 rounded-full flex items-center justify-center flex-shrink-0">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-bold text-yellow-800 mb-2">未检测到已安装的模型</h3>
            <p className="text-sm text-yellow-700 mb-4">需要安装至少一个 LLM 模型和一个 Embedding 模型才能使用 RAG 系统</p>
            
            <div className="bg-white rounded-lg p-4 mb-4">
              <div className="text-sm font-semibold text-gray-800 mb-3">推荐安装组合：</div>
              
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 bg-purple-50 rounded-lg">
                  <div>
                    <div className="font-medium text-purple-900">Llama 3.1</div>
                    <div className="text-xs text-purple-700">LLM 模型 · 4.7 GB</div>
                  </div>
                  <button
                    onClick={() => handleInstallModel('llama3.1')}
                    className="px-3 py-1 bg-purple-600 hover:bg-purple-700 text-white rounded text-sm transition-colors"
                  >
                    复制安装命令
                  </button>
                </div>
                
                <div className="flex items-center justify-between p-3 bg-blue-50 rounded-lg">
                  <div>
                    <div className="font-medium text-blue-900">Nomic Embed Text</div>
                    <div className="text-xs text-blue-700">Embedding 模型 · 274 MB</div>
                  </div>
                  <button
                    onClick={() => handleInstallModel('nomic-embed-text')}
                    className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm transition-colors"
                  >
                    复制安装命令
                  </button>
                </div>
              </div>
            </div>
            
            <div className="text-xs text-yellow-600 mb-3">
              💡 提示：复制命令后，在终端中粘贴并运行，然后刷新此页面
            </div>
            
            <button
              onClick={loadModels}
              className="px-4 py-2 bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg font-medium transition-colors"
            >
              刷新检测
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 有模型，正常显示
  return (
    <div className="space-y-4">
      {/* 状态概览 */}
      {modelData && modelData.status && (
        <div className={`p-4 rounded-lg border-2 ${
          modelData.status.ready 
            ? 'bg-green-50 border-green-200' 
            : 'bg-yellow-50 border-yellow-200'
        }`}>
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
              modelData.status.ready ? 'bg-green-500' : 'bg-yellow-500'
            }`}>
              {modelData.status.ready ? (
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              )}
            </div>
            <div className="flex-1">
              <div className="font-semibold text-sm">
                {modelData.status.ready ? '✅ 系统就绪' : '⚠️ 需要安装推荐模型'}
              </div>
              <div className="text-xs mt-1">
                LLM: {modelData.llmModels.length} 个 | Embedding: {modelData.embeddingModels.length} 个
              </div>
            </div>
            <button
              onClick={loadModels}
              className="px-3 py-1 bg-white border border-gray-300 rounded text-sm hover:bg-gray-50 transition-colors"
            >
              刷新
            </button>
          </div>
          
          {/* 警告信息 */}
          {modelData.warnings && modelData.warnings.length > 0 && (
            <div className="mt-3 space-y-1">
              {modelData.warnings.map((warning, index) => (
                <div key={index} className="text-xs text-yellow-700 flex items-start gap-2">
                  <span>⚠️</span>
                  <span>{warning}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 标签页 */}
      <div className="flex gap-2 border-b">
        <button
          onClick={() => setActiveTab('installed')}
          className={`px-4 py-2 font-medium transition-colors ${
            activeTab === 'installed'
              ? 'text-purple-600 border-b-2 border-purple-600'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          已安装模型 ({(modelData?.llmModels.length || 0) + (modelData?.embeddingModels.length || 0)})
        </button>
        <button
          onClick={() => setActiveTab('recommended')}
          className={`px-4 py-2 font-medium transition-colors ${
            activeTab === 'recommended'
              ? 'text-purple-600 border-b-2 border-purple-600'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          推荐模型
        </button>
      </div>

      {/* 已安装模型 */}
      {activeTab === 'installed' && modelData && (
        <div className="space-y-4">
          {/* LLM 模型 */}
          <div>
            <h4 className="text-sm font-semibold text-gray-800 mb-2 flex items-center gap-2">
              <span className="text-lg">🤖</span>
              LLM 模型 ({modelData.llmModels.length})
            </h4>
            {modelData.llmModels.length === 0 ? (
              <div className="text-sm text-gray-500 bg-gray-50 rounded-lg p-4 text-center">
                未安装 LLM 模型，请切换到"推荐模型"标签页查看安装建议
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                {modelData.llmModels.map((model) => (
                  <div
                    key={model.name}
                    className={`p-3 rounded-lg border-2 transition-all cursor-pointer ${
                      currentLLM === model.name
                        ? 'border-purple-500 bg-purple-50'
                        : 'border-gray-200 hover:border-purple-300 bg-white'
                    }`}
                    onClick={() => handleSelectModel('llm', model.name)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <div className="font-medium text-sm">{model.displayName}</div>
                        <div className="text-xs text-gray-500 mt-1">
                          {model.sizeFormatted} · {model.tag}
                        </div>
                      </div>
                      {currentLLM === model.name && (
                        <div className="w-6 h-6 bg-purple-500 rounded-full flex items-center justify-center">
                          <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Embedding 模型 */}
          <div>
            <h4 className="text-sm font-semibold text-gray-800 mb-2 flex items-center gap-2">
              <span className="text-lg">🧬</span>
              Embedding 模型 ({modelData.embeddingModels.length})
            </h4>
            {modelData.embeddingModels.length === 0 ? (
              <div className="text-sm text-gray-500 bg-gray-50 rounded-lg p-4 text-center">
                未安装 Embedding 模型，请切换到"推荐模型"标签页查看安装建议
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                {modelData.embeddingModels.map((model) => (
                  <div
                    key={model.name}
                    className={`p-3 rounded-lg border-2 transition-all cursor-pointer ${
                      currentEmbedding === model.name
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:border-blue-300 bg-white'
                    }`}
                    onClick={() => handleSelectModel('embedding', model.name)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <div className="font-medium text-sm">{model.displayName}</div>
                        <div className="text-xs text-gray-500 mt-1">
                          {model.sizeFormatted} · {model.tag}
                        </div>
                      </div>
                      {currentEmbedding === model.name && (
                        <div className="w-6 h-6 bg-blue-500 rounded-full flex items-center justify-center">
                          <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 推荐模型 */}
      {activeTab === 'recommended' && modelData && (
        <div className="space-y-4">
          {/* LLM 推荐 */}
          <div>
            <h4 className="text-sm font-semibold text-gray-800 mb-2">🤖 推荐的 LLM 模型</h4>
            <div className="space-y-2">
              {modelData.recommended.llm.map((model) => (
                <div
                  key={model.name}
                  className={`p-4 rounded-lg border ${
                    model.installed
                      ? 'border-green-300 bg-green-50'
                      : model.recommended
                      ? 'border-purple-300 bg-purple-50'
                      : 'border-gray-200 bg-white'
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold text-sm">{model.displayName}</span>
                        {model.recommended && !model.installed && (
                          <span className="px-2 py-0.5 bg-purple-200 text-purple-800 rounded text-xs">推荐</span>
                        )}
                        {model.installed && (
                          <span className="px-2 py-0.5 bg-green-200 text-green-800 rounded text-xs">已安装</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-600 mb-2">{model.description}</p>
                      <div className="flex gap-4 text-xs text-gray-500">
                        <span>大小: {model.size}</span>
                        {model.contextLength && <span>上下文: {model.contextLength.toLocaleString()} tokens</span>}
                      </div>
                    </div>
                    {!model.installed && (
                      <button
                        onClick={() => handleInstallModel(model.name)}
                        className="px-3 py-1 bg-purple-600 hover:bg-purple-700 text-white rounded text-sm transition-colors whitespace-nowrap"
                      >
                        安装
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Embedding 推荐 */}
          <div>
            <h4 className="text-sm font-semibold text-gray-800 mb-2">🧬 推荐的 Embedding 模型</h4>
            <div className="space-y-2">
              {modelData.recommended.embedding.map((model) => (
                <div
                  key={model.name}
                  className={`p-4 rounded-lg border ${
                    model.installed
                      ? 'border-green-300 bg-green-50'
                      : model.recommended
                      ? 'border-blue-300 bg-blue-50'
                      : 'border-gray-200 bg-white'
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold text-sm">{model.displayName}</span>
                        {model.recommended && !model.installed && (
                          <span className="px-2 py-0.5 bg-blue-200 text-blue-800 rounded text-xs">推荐</span>
                        )}
                        {model.installed && (
                          <span className="px-2 py-0.5 bg-green-200 text-green-800 rounded text-xs">已安装</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-600 mb-2">{model.description}</p>
                      <div className="flex gap-4 text-xs text-gray-500">
                        <span>大小: {model.size}</span>
                        {model.dimension && <span>维度: {model.dimension}</span>}
                      </div>
                    </div>
                    {!model.installed && (
                      <button
                        onClick={() => handleInstallModel(model.name)}
                        className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm transition-colors whitespace-nowrap"
                      >
                        安装
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

'use client';

import React, { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import AgenticWorkflowPanel from '@/components/AgenticWorkflowPanel';
import LangSmithTraceViewer from '@/components/LangSmithTraceViewer';

interface AgentState {
  query: string;
  answer: string;
  workflow?: {
    steps: any[];
    totalDuration?: number;
    retryCount?: number;
  };
  queryAnalysis?: any;
  retrievalDetails?: {
    documents: any[];
    quality?: any;
    selfReflection?: any;
  };
  retrievalGrade?: {
    isRelevant: boolean;
    score: number;
    keywordMatchScore: number;
    semanticScore: number;
    hasAnswerSignals: boolean;
    reasoning: string;
  };
  debugInfo?: {
    milvusQueryVector?: number[];
    milvusRawScores?: number[];
    embeddingModel?: string;
    collectionDimension?: number;
  };
  hallucinationCheck?: any;
  error?: string;
}

interface ModelInfo {
  name: string;
  size: number;
  modified_at: string;
}

interface AvailableModels {
  success: boolean;
  llmModels: ModelInfo[];
  embeddingModels: ModelInfo[];
}

// 推荐的 Embedding 模型配置（用于显示维度信息）
const EMBEDDING_MODEL_DIMENSIONS: Record<string, number> = {
  // Ollama 本地模型
  'nomic-embed-text': 768,
  'nomic-embed-text-v2-moe': 768,
  'bge-m3': 1024,
  'bge-large': 1024,
  'mxbai-embed-large': 1024,
  'snowflake-arctic-embed': 1024,
  'all-minilm': 384,
  'qwen3-embedding': 1024,
  // SiliconFlow 云端模型
  'BAAI/bge-m3': 1024,
  'BAAI/bge-large-zh-v1.5': 1024,
  'BAAI/bge-large-en-v1.5': 1024,
  'Pro/BAAI/bge-m3': 1024,
  'Qwen/Qwen3-Embedding-8B': 4096,
  'Qwen/Qwen3-Embedding-4B': 2560,
  'Qwen/Qwen3-Embedding-0.6B': 1024,
  'netease-youdao/bce-embedding-base_v1': 768,
  // OpenAI 模型
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

export default function AgenticRAGPage() {
  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState(5);
  const [similarityThreshold, setSimilarityThreshold] = useState(0.3);
  const [maxRetries, setMaxRetries] = useState(2);
  const [llmModel, setLlmModel] = useState('llama3.1');
  const [embeddingModel, setEmbeddingModel] = useState('nomic-embed-text');
  
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<AgentState | null>(null);
  const [history, setHistory] = useState<AgentState[]>([]);
  
  // 模型列表状态
  const [availableModels, setAvailableModels] = useState<AvailableModels | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  
  // 模型提供商配置
  const [embeddingProvider, setEmbeddingProvider] = useState<string>('ollama');
  const [embeddingDimension, setEmbeddingDimension] = useState<number>(768);
  const isRemoteEmbedding = embeddingProvider !== 'ollama';

  // 获取可用模型列表
  const loadAvailableModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      // 首先获取系统配置
      const healthResponse = await fetch('/api/health');
      const healthData = await healthResponse.json();
      
      if (healthData.modelConfig?.embedding) {
        const embConfig = healthData.modelConfig.embedding;
        setEmbeddingProvider(embConfig.provider || 'ollama');
        setEmbeddingDimension(embConfig.dimension || 768);
        
        // 如果是远程 Embedding 提供商，使用配置的模型
        if (embConfig.provider && embConfig.provider !== 'ollama') {
          setEmbeddingModel(embConfig.model);
          setAvailableModels(prev => ({
            ...prev,
            success: true,
            llmModels: prev?.llmModels || [],
            embeddingModels: [{
              name: embConfig.model,
              displayName: embConfig.model.split('/').pop() || embConfig.model,
              sizeFormatted: `${embConfig.dimension}D`,
            }],
          }));
        }
      }
      
      // 加载本地 Ollama 模型
      const response = await fetch('/api/ollama/models');
      const data = await response.json();
      if (data.success) {
        // 如果是远程 Embedding，保留之前设置的 embeddingModels
        if (isRemoteEmbedding) {
          setAvailableModels(prev => ({
            ...data,
            embeddingModels: prev?.embeddingModels || data.embeddingModels,
          }));
        } else {
          setAvailableModels(data);
        }
        
        // 如果当前选中的 LLM 模型不在列表中，选择第一个可用的
        if (data.llmModels?.length > 0 && !data.llmModels.some((m: ModelInfo) => m.name === llmModel)) {
          setLlmModel(data.llmModels[0].name);
        }
        // 只有 Ollama Embedding 时才自动切换
        if (!isRemoteEmbedding && data.embeddingModels?.length > 0 && !data.embeddingModels.some((m: ModelInfo) => m.name === embeddingModel)) {
          setEmbeddingModel(data.embeddingModels[0].name);
        }
      }
    } catch (error) {
      console.error('Failed to load models:', error);
    } finally {
      setLoadingModels(false);
    }
  }, [llmModel, embeddingModel, isRemoteEmbedding]);

  // 初始化时加载模型
  useEffect(() => {
    loadAvailableModels();
  }, []);

  // 格式化文件大小
  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  // 获取模型维度（支持 Ollama、SiliconFlow、OpenAI 模型）
  const getModelDimension = (modelName: string): number | undefined => {
    // 首先精确匹配（支持 SiliconFlow 的 BAAI/bge-m3 格式）
    if (EMBEDDING_MODEL_DIMENSIONS[modelName]) {
      return EMBEDDING_MODEL_DIMENSIONS[modelName];
    }
    
    // 移除 :latest 标签后匹配
    const baseName = modelName.split(':')[0];
    if (EMBEDDING_MODEL_DIMENSIONS[baseName]) {
      return EMBEDDING_MODEL_DIMENSIONS[baseName];
    }
    
    // 小写匹配
    const lowerName = baseName.toLowerCase();
    for (const [key, value] of Object.entries(EMBEDDING_MODEL_DIMENSIONS)) {
      if (key.toLowerCase() === lowerName) {
        return value;
      }
    }
    
    return undefined;
  };

  // 执行 Agentic RAG 查询
  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim() || isLoading) return;

    setIsLoading(true);
    setResult(null);

    try {
      const response = await fetch('/api/agentic-rag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: query.trim(),
          topK,
          similarityThreshold,
          maxRetries,
          llmModel,
          embeddingModel,
        }),
      });

      const data = await response.json();

      const newResult: AgentState = {
        query: query.trim(),
        answer: data.answer || '',
        workflow: data.workflow,
        queryAnalysis: data.queryAnalysis,
        retrievalDetails: data.retrievalDetails,
        retrievalGrade: data.retrievalGrade,
        debugInfo: data.debugInfo,
        hallucinationCheck: data.hallucinationCheck,
        error: data.error,
      };

      setResult(newResult);
      setHistory(prev => [newResult, ...prev].slice(0, 10)); // 保留最近10条
    } catch (error) {
      setResult({
        query: query.trim(),
        answer: '',
        error: error instanceof Error ? error.message : '请求失败',
      });
    } finally {
      setIsLoading(false);
    }
  }, [query, topK, similarityThreshold, maxRetries, llmModel, embeddingModel, isLoading]);

  // 快速示例查询
  const exampleQueries = [
    '什么是人工智能？',
    '机器学习和深度学习有什么区别？',
    '如何使用向量数据库？',
    'RAG 系统的工作原理是什么？',
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
      {/* 导航栏 */}
      <nav className="bg-black/30 backdrop-blur-sm border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-14">
            <div className="flex items-center gap-4">
              <Link href="/" className="flex items-center gap-2 text-white hover:text-purple-300 transition-colors">
                <i className="fas fa-arrow-left"></i>
                <span className="text-sm">返回主页</span>
              </Link>
              <div className="w-px h-6 bg-white/20"></div>
              <div className="flex items-center gap-2">
                <i className="fas fa-robot text-purple-400 text-xl"></i>
                <h1 className="text-lg font-semibold text-white">Agentic RAG</h1>
                <span className="px-2 py-0.5 bg-purple-500/30 text-purple-300 text-xs rounded-full">
                  LangGraph
                </span>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <Link 
                href="/reasoning-rag"
                className="px-3 py-1.5 bg-pink-500/20 text-pink-300 rounded-lg hover:bg-pink-500/30 transition-colors text-sm flex items-center gap-2"
              >
                🧠 Reasoning RAG
              </Link>
              <Link 
                href="/self-corrective-rag"
                className="px-3 py-1.5 bg-teal-500/20 text-teal-300 rounded-lg hover:bg-teal-500/30 transition-colors text-sm flex items-center gap-2"
              >
                🔄 Self-Corrective
              </Link>
              <Link 
                href="/self-rag"
                className="px-3 py-1.5 bg-indigo-500/20 text-indigo-300 rounded-lg hover:bg-indigo-500/30 transition-colors text-sm flex items-center gap-2"
              >
                🔁 Self-RAG
              </Link>
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 左侧：查询输入和参数 */}
          <div className="lg:col-span-1 space-y-6">
            {/* 查询输入 */}
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-6 border border-white/10">
              <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <i className="fas fa-search text-purple-400"></i>
                智能查询
              </h2>
              
              <form onSubmit={handleSubmit} className="space-y-4">
                <textarea
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="输入您的问题..."
                  className="w-full h-32 px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white placeholder-white/40 focus:ring-2 focus:ring-purple-500 focus:border-transparent resize-none"
                  disabled={isLoading}
                />
                
                <button
                  type="submit"
                  disabled={isLoading || !query.trim()}
                  className="w-full py-3 bg-gradient-to-r from-purple-600 to-blue-600 text-white font-medium rounded-lg hover:from-purple-700 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                >
                  {isLoading ? (
                    <>
                      <i className="fas fa-spinner fa-spin"></i>
                      处理中...
                    </>
                  ) : (
                    <>
                      <i className="fas fa-robot"></i>
                      执行 Agent 查询
                    </>
                  )}
                </button>
              </form>

              {/* 快速示例 */}
              <div className="mt-4">
                <div className="text-xs text-white/40 mb-2">快速示例:</div>
                <div className="flex flex-wrap gap-2">
                  {exampleQueries.map((q, i) => (
                    <button
                      key={i}
                      onClick={() => setQuery(q)}
                      className="px-2 py-1 bg-white/5 text-white/60 text-xs rounded hover:bg-white/10 hover:text-white transition-colors"
                    >
                      {q.length > 15 ? q.substring(0, 15) + '...' : q}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 参数配置 */}
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-6 border border-white/10">
              <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <i className="fas fa-sliders-h text-blue-400"></i>
                参数配置
              </h2>
              
              <div className="space-y-4">
                {/* Top-K */}
                <div>
                  <label className="block text-sm text-white/60 mb-1">检索数量 (Top-K)</label>
                  <input
                    type="range"
                    min="1"
                    max="10"
                    value={topK}
                    onChange={(e) => setTopK(parseInt(e.target.value))}
                    className="w-full accent-purple-500"
                  />
                  <div className="text-right text-sm text-white/80">{topK}</div>
                </div>

                {/* 相似度阈值 */}
                <div>
                  <label className="block text-sm text-white/60 mb-1">相似度阈值</label>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={similarityThreshold}
                    onChange={(e) => setSimilarityThreshold(parseFloat(e.target.value))}
                    className="w-full accent-purple-500"
                  />
                  <div className="text-right text-sm text-white/80">{similarityThreshold.toFixed(1)}</div>
                </div>

                {/* 最大重试次数 */}
                <div>
                  <label className="block text-sm text-white/60 mb-1">最大重试次数</label>
                  <input
                    type="range"
                    min="0"
                    max="5"
                    value={maxRetries}
                    onChange={(e) => setMaxRetries(parseInt(e.target.value))}
                    className="w-full accent-purple-500"
                  />
                  <div className="text-right text-sm text-white/80">{maxRetries}</div>
                </div>

                {/* LLM 模型 */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 text-sm text-white/70">
                      <i className="fas fa-brain text-purple-400"></i>
                      LLM 模型
                    </label>
                    <button
                      onClick={loadAvailableModels}
                      disabled={loadingModels}
                      className="text-xs text-purple-400 hover:text-purple-300 transition-colors disabled:opacity-50"
                    >
                      <i className={`fas ${loadingModels ? 'fa-spinner fa-spin' : 'fa-sync-alt'} mr-1`}></i>
                      刷新
                    </button>
                  </div>
                  <div className="relative">
                    <select
                      value={llmModel}
                      onChange={(e) => setLlmModel(e.target.value)}
                      disabled={loadingModels}
                      className="w-full px-4 py-2.5 bg-gradient-to-r from-purple-900/40 to-blue-900/40 border border-purple-500/30 rounded-xl text-white focus:ring-2 focus:ring-purple-500 focus:border-purple-400 appearance-none cursor-pointer transition-all hover:border-purple-400/50 disabled:opacity-50"
                    >
                      {loadingModels ? (
                        <option>加载中...</option>
                      ) : availableModels?.llmModels?.length ? (
                        availableModels.llmModels.map((model) => (
                          <option key={model.name} value={model.name} className="bg-slate-800">
                            {model.name} ({formatSize(model.size)})
                          </option>
                        ))
                      ) : (
                        <>
                          <option value="llama3.1" className="bg-slate-800">Llama 3.1</option>
                          <option value="llama3.2" className="bg-slate-800">Llama 3.2</option>
                          <option value="qwen2.5" className="bg-slate-800">Qwen 2.5</option>
                          <option value="mistral" className="bg-slate-800">Mistral</option>
                        </>
                      )}
                    </select>
                    <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                      <i className="fas fa-chevron-down text-purple-400/60 text-xs"></i>
                    </div>
                  </div>
                  {availableModels?.llmModels?.length ? (
                    <div className="text-xs text-white/40 flex items-center gap-1">
                      <i className="fas fa-check-circle text-green-400"></i>
                      {availableModels.llmModels.length} 个 LLM 模型可用
                    </div>
                  ) : !loadingModels && (
                    <div className="text-xs text-yellow-400/60 flex items-center gap-1">
                      <i className="fas fa-exclamation-triangle"></i>
                      使用默认模型列表
                    </div>
                  )}
                </div>

                {/* Embedding 模型 */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-2 text-sm text-white/70">
                        <i className="fas fa-vector-square text-blue-400"></i>
                        Embedding 模型
                      </label>
                      {/* 提供商徽章 */}
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        embeddingProvider === 'ollama' ? 'bg-gray-500/30 text-gray-300' :
                        embeddingProvider === 'siliconflow' ? 'bg-purple-500/30 text-purple-300' :
                        embeddingProvider === 'openai' ? 'bg-green-500/30 text-green-300' :
                        'bg-orange-500/30 text-orange-300'
                      }`}>
                        {embeddingProvider === 'ollama' ? 'Ollama' :
                         embeddingProvider === 'siliconflow' ? 'SiliconFlow' :
                         embeddingProvider === 'openai' ? 'OpenAI' :
                         embeddingProvider}
                      </span>
                    </div>
                    {(isRemoteEmbedding ? embeddingDimension : getModelDimension(embeddingModel)) && (
                      <span className="text-xs px-2 py-0.5 bg-blue-500/20 text-blue-300 rounded-full">
                        {isRemoteEmbedding ? embeddingDimension : getModelDimension(embeddingModel)}D
                      </span>
                    )}
                  </div>
                  {isRemoteEmbedding ? (
                    /* 远程提供商：显示只读配置信息 */
                    <div className="px-4 py-2.5 bg-gradient-to-r from-blue-900/40 to-cyan-900/40 border border-blue-500/30 rounded-xl">
                      <div className="flex items-center justify-between">
                        <span className="text-white">{embeddingModel}</span>
                        <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" title="通过环境变量配置">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                        </svg>
                      </div>
                      <div className="text-xs text-white/40 mt-1">通过环境变量配置</div>
                    </div>
                  ) : (
                    <div className="relative">
                      <select
                        value={embeddingModel}
                        onChange={(e) => setEmbeddingModel(e.target.value)}
                        disabled={loadingModels}
                        className="w-full px-4 py-2.5 bg-gradient-to-r from-blue-900/40 to-cyan-900/40 border border-blue-500/30 rounded-xl text-white focus:ring-2 focus:ring-blue-500 focus:border-blue-400 appearance-none cursor-pointer transition-all hover:border-blue-400/50 disabled:opacity-50"
                      >
                        {loadingModels ? (
                          <option>加载中...</option>
                        ) : availableModels?.embeddingModels?.length ? (
                          availableModels.embeddingModels.map((model) => {
                            const dim = getModelDimension(model.name);
                            return (
                              <option key={model.name} value={model.name} className="bg-slate-800">
                                {model.name} {dim ? `(${dim}D)` : ''} - {formatSize(model.size)}
                              </option>
                            );
                          })
                        ) : (
                          <>
                            <option value="nomic-embed-text" className="bg-slate-800">Nomic Embed Text (768D)</option>
                            <option value="bge-m3" className="bg-slate-800">BGE-M3 (1024D)</option>
                            <option value="bge-large" className="bg-slate-800">BGE Large (1024D)</option>
                            <option value="mxbai-embed-large" className="bg-slate-800">MxBai Embed Large (1024D)</option>
                          </>
                        )}
                      </select>
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                        <i className="fas fa-chevron-down text-blue-400/60 text-xs"></i>
                      </div>
                    </div>
                  )}
                  {isRemoteEmbedding ? (
                    <div className="text-xs text-purple-400/60 flex items-center gap-1">
                      <i className="fas fa-cloud"></i>
                      使用远程 Embedding 服务
                    </div>
                  ) : availableModels?.embeddingModels?.length ? (
                    <div className="text-xs text-white/40 flex items-center gap-1">
                      <i className="fas fa-check-circle text-green-400"></i>
                      {availableModels.embeddingModels.length} 个 Embedding 模型可用
                    </div>
                  ) : !loadingModels && (
                    <div className="text-xs text-yellow-400/60 flex items-center gap-1">
                      <i className="fas fa-exclamation-triangle"></i>
                      使用默认模型列表
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* 系统说明 */}
            <div className="bg-gradient-to-br from-purple-500/20 to-blue-500/20 rounded-xl p-6 border border-purple-500/30">
              <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                <i className="fas fa-lightbulb text-yellow-400"></i>
                Agentic RAG 特性
              </h3>
              <ul className="text-xs text-white/70 space-y-2">
                <li className="flex items-start gap-2">
                  <i className="fas fa-check text-green-400 mt-0.5"></i>
                  <span><strong>查询优化</strong>：自动分析和改写查询以提高检索效果</span>
                </li>
                <li className="flex items-start gap-2">
                  <i className="fas fa-check text-green-400 mt-0.5"></i>
                  <span><strong>自省评分</strong>：对每个检索结果进行相关性、有用性评分</span>
                </li>
                <li className="flex items-start gap-2">
                  <i className="fas fa-check text-green-400 mt-0.5"></i>
                  <span><strong>质量评估</strong>：评估整体检索质量，自动决定是否重试</span>
                </li>
                <li className="flex items-start gap-2">
                  <i className="fas fa-check text-green-400 mt-0.5"></i>
                  <span><strong>幻觉检查</strong>：验证生成内容是否与检索结果一致</span>
                </li>
              </ul>
            </div>
          </div>

          {/* 右侧：结果展示 */}
          <div className="lg:col-span-2 space-y-6">
            {/* 工作流面板 */}
            {(result || isLoading) && (
              <AgenticWorkflowPanel
                workflow={result?.workflow}
                queryAnalysis={result?.queryAnalysis}
                retrievalQuality={result?.retrievalDetails?.quality}
                selfReflection={result?.retrievalDetails?.selfReflection}
                hallucinationCheck={result?.hallucinationCheck}
                isLoading={isLoading}
              />
            )}

            {/* LangSmith 追踪可视化 */}
            {result?.workflow?.steps && result.workflow.steps.length > 0 && (
              <LangSmithTraceViewer
                workflowSteps={result.workflow.steps}
                queryAnalysis={result.queryAnalysis}
                retrievalGrade={result.retrievalGrade}
                debugInfo={result.debugInfo}
                totalDuration={result.workflow.totalDuration}
                defaultExpanded={false}
              />
            )}

            {/* 答案展示 */}
            {result?.answer && (
              <div className="bg-white rounded-xl shadow-lg overflow-hidden">
                <div className="px-6 py-4 bg-gradient-to-r from-green-500 to-emerald-500 text-white">
                  <div className="flex items-center gap-2">
                    <i className="fas fa-comment-dots text-xl"></i>
                    <h3 className="font-semibold">生成的回答</h3>
                  </div>
                </div>
                <div className="p-6">
                  <div className="prose prose-sm max-w-none text-gray-700 whitespace-pre-wrap">
                    {result.answer}
                  </div>
                </div>
              </div>
            )}

            {/* 检索文档 */}
            {result?.retrievalDetails?.documents && result.retrievalDetails.documents.length > 0 && (
              <div className="bg-white rounded-xl shadow-lg overflow-hidden">
                <div className="px-6 py-4 bg-gradient-to-r from-blue-500 to-cyan-500 text-white">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <i className="fas fa-file-alt text-xl"></i>
                      <h3 className="font-semibold">检索到的文档</h3>
                    </div>
                    <span className="px-2 py-1 bg-white/20 rounded-full text-sm">
                      {result.retrievalDetails.documents.length} 个结果
                    </span>
                  </div>
                </div>
                <div className="p-6 space-y-4">
                  {result.retrievalDetails.documents.map((doc: any, i: number) => (
                    <div key={i} className="p-4 bg-gray-50 rounded-lg border border-gray-200">
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-medium text-gray-700">文档 {i + 1}</span>
                        <div className="flex items-center gap-2">
                          {doc.relevanceScore !== undefined && (
                            <span className={`px-2 py-0.5 text-xs rounded-full ${
                              doc.relevanceScore >= 0.7 ? 'bg-green-100 text-green-700' :
                              doc.relevanceScore >= 0.4 ? 'bg-yellow-100 text-yellow-700' :
                              'bg-red-100 text-red-700'
                            }`}>
                              相关性: {(doc.relevanceScore * 100).toFixed(0)}%
                            </span>
                          )}
                          <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full">
                            相似度: {(doc.similarity * 100).toFixed(1)}%
                          </span>
                        </div>
                      </div>
                      <p className="text-sm text-gray-600 line-clamp-3">
                        {doc.content}
                      </p>
                      {doc.metadata?.source && (
                        <div className="mt-2 text-xs text-gray-400">
                          来源: {doc.metadata.source}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 错误展示 */}
            {result?.error && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-6">
                <div className="flex items-center gap-2 text-red-600 mb-2">
                  <i className="fas fa-exclamation-circle"></i>
                  <span className="font-semibold">处理出错</span>
                </div>
                <p className="text-red-700">{result.error}</p>
              </div>
            )}

            {/* 空状态 */}
            {!result && !isLoading && (
              <div className="bg-white/10 backdrop-blur-sm rounded-xl p-12 text-center border border-white/10">
                <i className="fas fa-robot text-6xl text-purple-400/50 mb-4"></i>
                <h3 className="text-xl font-semibold text-white mb-2">准备就绪</h3>
                <p className="text-white/60">
                  输入您的问题，Agentic RAG 将自动优化查询、检索文档、评估质量并生成回答
                </p>
              </div>
            )}

            {/* 历史记录 */}
            {history.length > 1 && (
              <div className="bg-white/10 backdrop-blur-sm rounded-xl p-6 border border-white/10">
                <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                  <i className="fas fa-history text-gray-400"></i>
                  查询历史
                </h3>
                <div className="space-y-2">
                  {history.slice(1).map((item, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        setQuery(item.query);
                        setResult(item);
                      }}
                      className="w-full text-left p-3 bg-white/5 rounded-lg hover:bg-white/10 transition-colors"
                    >
                      <div className="text-sm text-white truncate">{item.query}</div>
                      <div className="text-xs text-white/40 mt-1">
                        {item.workflow?.totalDuration 
                          ? `耗时: ${(item.workflow.totalDuration / 1000).toFixed(2)}s`
                          : ''}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

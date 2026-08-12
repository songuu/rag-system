'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import KnowledgeGraphViewer from '@/components/KnowledgeGraphViewer';

// ==================== 类型定义 ====================

interface ExtractionConfig {
  chunkSize: number;
  chunkOverlap: number;
  enableGleaning: boolean;
  gleaningRounds: number;
  minEntityMentions: number;
  similarityThreshold: number;
  communityResolution: number;
  llmModel: string;
  embeddingModel: string;
  // 超时配置
  maxTotalTimeout: number;   // 总体最大超时（毫秒）
  maxChunkTimeout: number;   // 单块最大超时（毫秒）
}

interface FileInfo {
  name: string;
  path: string;
  size: number;
}

interface ExtractionProgress {
  stage: string;
  current: number;
  total: number;
  message: string;
}

interface KnowledgeGraph {
  entities: Array<{
    id: string;
    name: string;
    type: string;
    description: string;
    aliases: string[];
    mentions: number;
    sourceChunks: string[];
  }>;
  relations: Array<{
    id: string;
    source: string;
    target: string;
    type: string;
    description: string;
    weight: number;
    sourceChunks: string[];
  }>;
  communities: Array<{
    id: string;
    name: string;
    entities: string[];
    relations: string[];
    summary: string;
    keywords: string[];
    level: number;
  }>;
  metadata: {
    documentId: string;
    createdAt: string;
    entityCount: number;
    relationCount: number;
    communityCount: number;
  };
}

interface LLMModel {
  name: string;
  displayName: string;
  sizeFormatted?: string;
}

interface EmbeddingModel {
  name: string;
  displayName: string;
  dimension?: number;
}

// ==================== 默认配置 ====================

const DEFAULT_CONFIG: ExtractionConfig = {
  chunkSize: 500,
  chunkOverlap: 100,
  enableGleaning: true,
  gleaningRounds: 1,
  minEntityMentions: 1,
  similarityThreshold: 0.85,
  communityResolution: 1.0,
  llmModel: 'qwen2.5:0.5b',
  embeddingModel: 'nomic-embed-text',
  // 超时配置
  maxTotalTimeout: 10 * 60 * 1000,  // 默认最大 10 分钟
  maxChunkTimeout: 60 * 1000,        // 单块最大 60 秒
};

// ==================== 主组件 ====================

export default function EntityExtractionPage() {
  // 状态
  const [config, setConfig] = useState<ExtractionConfig>(DEFAULT_CONFIG);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [customText, setCustomText] = useState('');
  const [inputMode, setInputMode] = useState<'files' | 'text'>('files');
  
  const [isExtracting, setIsExtracting] = useState(false);
  const [progress, setProgress] = useState<ExtractionProgress | null>(null);
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  const [llmModels, setLlmModels] = useState<LLMModel[]>([]);
  const [embeddingModels, setEmbeddingModels] = useState<EmbeddingModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  
  const [showConfig, setShowConfig] = useState(true);
  const [activeTab, setActiveTab] = useState<'graph' | 'entities' | 'relations' | 'communities'>('graph');

  // 加载可用文件
  const loadFiles = useCallback(async () => {
    try {
      const response = await fetch('/rag-api/entity-extraction?action=files');
      const data = await response.json();
      if (data.success) {
        setFiles(data.files || []);
      }
    } catch (error) {
      console.error('加载文件失败:', error);
    }
  }, []);

  // 加载模型列表
  const loadModels = useCallback(async () => {
    try {
      const response = await fetch('/rag-api/ollama/models');
      if (!response.ok) {
        console.error('Ollama API 请求失败:', response.status);
        return;
      }
      const data = await response.json();
      if (data.success) {
        // 合并 LLM 和推理模型作为可选的 LLM 模型
        const allLlmModels = [
          ...(data.llmModels || []),
          ...(data.reasoningModels || []),
        ];
        setLlmModels(allLlmModels);
        setEmbeddingModels(data.embeddingModels || []);
        
        // 如果当前配置的模型不在列表中，自动选择第一个
        if (allLlmModels.length > 0 && !allLlmModels.some(m => m.name === config.llmModel)) {
          setConfig(prev => ({ ...prev, llmModel: allLlmModels[0].name }));
        }
        if (data.embeddingModels?.length > 0 && !data.embeddingModels.some((m: EmbeddingModel) => m.name === config.embeddingModel)) {
          setConfig(prev => ({ ...prev, embeddingModel: data.embeddingModels[0].name }));
        }
      }
    } catch (error) {
      console.error('加载模型失败:', error);
    }
  }, [config.llmModel, config.embeddingModel]);

  // 加载已有图谱
  const loadExistingGraph = useCallback(async () => {
    try {
      const response = await fetch('/rag-api/entity-extraction?action=graph');
      const data = await response.json();
      if (data.success && data.hasGraph) {
        setGraph(data.graph);
      }
    } catch (error) {
      console.error('加载图谱失败:', error);
    }
  }, []);

  // 初始化
  useEffect(() => {
    loadFiles();
    loadModels();
    loadExistingGraph();
  }, [loadFiles, loadModels, loadExistingGraph]);

  // 轮询抽取状态
  useEffect(() => {
    if (!isExtracting) return;

    const pollStatus = async () => {
      try {
        const response = await fetch('/rag-api/entity-extraction?action=status');
        const data = await response.json();
        if (data.success) {
          if (data.progress) {
            setProgress(data.progress);
          }
          if (!data.inProgress) {
            setIsExtracting(false);
            // 重新加载图谱
            loadExistingGraph();
          }
        }
      } catch (error) {
        console.error('获取状态失败:', error);
      }
    };

    const interval = setInterval(pollStatus, 1000);
    return () => clearInterval(interval);
  }, [isExtracting, loadExistingGraph]);

  // 执行抽取
  const handleExtract = async () => {
    setError(null);
    setIsExtracting(true);
    setProgress({ stage: 'starting', current: 0, total: 1, message: '正在初始化...' });

    try {
      const body: Record<string, unknown> = { config };
      
      if (inputMode === 'files') {
        if (selectedFiles.length === 0) {
          throw new Error('请选择至少一个文件');
        }
        body.files = selectedFiles;
      } else {
        if (!customText.trim()) {
          throw new Error('请输入文本内容');
        }
        body.text = customText;
      }

      const response = await fetch('/rag-api/entity-extraction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || '抽取失败');
      }

      setGraph(data.graph);
      setProgress(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : '抽取失败');
      setProgress(null);
    } finally {
      setIsExtracting(false);
    }
  };

  // 清除图谱
  const handleClearGraph = async () => {
    if (!confirm('确定要清除当前知识图谱吗？')) return;

    try {
      await fetch('/rag-api/entity-extraction', { method: 'DELETE' });
      setGraph(null);
    } catch (error) {
      console.error('清除图谱失败:', error);
    }
  };

  // 文件选择切换
  const toggleFileSelection = (path: string) => {
    setSelectedFiles(prev => 
      prev.includes(path) 
        ? prev.filter(p => p !== path)
        : [...prev, path]
    );
  };

  // 获取进度百分比
  const getProgressPercent = () => {
    if (!progress || progress.total === 0) return 0;
    
    const stageWeights: Record<string, number> = {
      starting: 0,
      chunking: 10,
      extracting: 40,
      gleaning: 60,
      resolving: 75,
      community: 85,
      summarizing: 95,
      completed: 100,
    };

    const basePercent = stageWeights[progress.stage] || 0;
    const stageProgress = (progress.current / progress.total) * 
      ((stageWeights[progress.stage] || 0) - (stageWeights[Object.keys(stageWeights)[Object.keys(stageWeights).indexOf(progress.stage) - 1]] || 0));
    
    return Math.min(100, basePercent + stageProgress);
  };

  // 格式化文件大小
  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
      {/* 顶部导航 */}
      <nav className="bg-slate-900/80 backdrop-blur-sm border-b border-slate-700/50 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-14">
            <div className="flex items-center gap-4">
              <Link href="/" className="flex items-center gap-2 text-white hover:text-purple-300 transition-colors">
                <span className="text-xl">←</span>
                <span className="text-sm">返回首页</span>
              </Link>
              <div className="h-6 w-px bg-slate-700" />
              <h1 className="text-lg font-semibold text-white flex items-center gap-2">
                <span className="text-2xl">🕸️</span>
                实体抽取 & 知识图谱
              </h1>
            </div>

            <div className="flex items-center gap-3">
              <Link 
                href="/reasoning-rag" 
                className="px-3 py-1.5 text-sm bg-purple-600/20 text-purple-300 rounded-lg hover:bg-purple-600/30 transition-colors"
              >
                🧠 推理问答
              </Link>
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* 左侧控制面板 */}
          <div className="lg:col-span-1 space-y-4">
            {/* 输入选择 */}
            <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
              <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                📄 输入数据
              </h3>
              
              {/* 输入模式切换 */}
              <div className="flex gap-2 mb-4">
                <button
                  onClick={() => setInputMode('files')}
                  className={`flex-1 py-2 text-sm rounded-lg transition-colors ${
                    inputMode === 'files' 
                      ? 'bg-purple-600 text-white' 
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  📁 选择文件
                </button>
                <button
                  onClick={() => setInputMode('text')}
                  className={`flex-1 py-2 text-sm rounded-lg transition-colors ${
                    inputMode === 'text' 
                      ? 'bg-purple-600 text-white' 
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  ✏️ 输入文本
                </button>
              </div>

              {inputMode === 'files' ? (
                <div className="space-y-2 max-h-48 overflow-auto">
                  {files.length === 0 ? (
                    <div className="text-center text-slate-400 py-4 text-sm">
                      暂无可用文件
                    </div>
                  ) : (
                    files.map(file => (
                      <label
                        key={file.path}
                        className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-colors ${
                          selectedFiles.includes(file.path)
                            ? 'bg-purple-600/20 border border-purple-500/50'
                            : 'bg-slate-700/50 hover:bg-slate-700'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedFiles.includes(file.path)}
                          onChange={() => toggleFileSelection(file.path)}
                          className="rounded border-slate-500 text-purple-500 focus:ring-purple-500"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-white truncate">{file.name}</div>
                          <div className="text-xs text-slate-400">{formatSize(file.size)}</div>
                        </div>
                      </label>
                    ))
                  )}
                </div>
              ) : (
                <textarea
                  value={customText}
                  onChange={e => setCustomText(e.target.value)}
                  placeholder="请输入或粘贴要分析的文本..."
                  className="w-full h-48 px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
                />
              )}
            </div>

            {/* 配置面板 */}
            <div className="bg-slate-800/50 rounded-xl border border-slate-700">
              <button
                onClick={() => setShowConfig(!showConfig)}
                className="w-full p-4 flex items-center justify-between text-white"
              >
                <span className="font-semibold flex items-center gap-2">
                  ⚙️ 抽取配置
                </span>
                <span className={`transform transition-transform ${showConfig ? 'rotate-180' : ''}`}>
                  ▼
                </span>
              </button>
              
              {showConfig && (
                <div className="px-4 pb-4 space-y-4">
                  {/* LLM 模型 */}
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">LLM 模型</label>
                    {llmModels.length === 0 ? (
                      <div className="w-full px-3 py-2 bg-amber-900/30 border border-amber-500/30 rounded-lg text-amber-300 text-sm">
                        ⚠️ 未检测到 LLM 模型，请检查 Ollama 服务
                      </div>
                    ) : (
                      <select
                        value={config.llmModel}
                        onChange={e => setConfig(prev => ({ ...prev, llmModel: e.target.value }))}
                        className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                      >
                        {llmModels.map((model, index) => (
                          <option key={`llm-${model.name}-${index}`} value={model.name}>
                            {model.displayName || model.name} {model.sizeFormatted ? `(${model.sizeFormatted})` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* Embedding 模型 */}
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Embedding 模型</label>
                    {embeddingModels.length === 0 ? (
                      <div className="w-full px-3 py-2 bg-amber-900/30 border border-amber-500/30 rounded-lg text-amber-300 text-sm">
                        ⚠️ 未检测到 Embedding 模型
                      </div>
                    ) : (
                      <select
                        value={config.embeddingModel}
                        onChange={e => setConfig(prev => ({ ...prev, embeddingModel: e.target.value }))}
                        className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                      >
                        {embeddingModels.map(model => (
                          <option key={`embedding-${model.name}`} value={model.name}>
                            {model.displayName || model.name} {model.dimension ? `(${model.dimension}D)` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* 切分配置 */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">块大小</label>
                      <input
                        type="number"
                        value={config.chunkSize}
                        onChange={e => setConfig(prev => ({ ...prev, chunkSize: parseInt(e.target.value) || 500 }))}
                        className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">重叠大小</label>
                      <input
                        type="number"
                        value={config.chunkOverlap}
                        onChange={e => setConfig(prev => ({ ...prev, chunkOverlap: parseInt(e.target.value) || 100 }))}
                        className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                    </div>
                  </div>

                  {/* Gleaning 开关 */}
                  <div className="flex items-center justify-between">
                    <div>
                      <label className="text-sm text-white">启用二次检查 (Gleaning)</label>
                      <p className="text-xs text-slate-400">提取后再检查遗漏</p>
                    </div>
                    <button
                      onClick={() => setConfig(prev => ({ ...prev, enableGleaning: !prev.enableGleaning }))}
                      className={`w-12 h-6 rounded-full transition-colors ${
                        config.enableGleaning ? 'bg-purple-600' : 'bg-slate-600'
                      }`}
                    >
                      <div className={`w-5 h-5 rounded-full bg-white transition-transform ${
                        config.enableGleaning ? 'translate-x-6' : 'translate-x-0.5'
                      }`} />
                    </button>
                  </div>

                  {/* 相似度阈值 */}
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      实体合并相似度阈值: {config.similarityThreshold.toFixed(2)}
                    </label>
                    <input
                      type="range"
                      min="0.5"
                      max="0.99"
                      step="0.01"
                      value={config.similarityThreshold}
                      onChange={e => setConfig(prev => ({ ...prev, similarityThreshold: parseFloat(e.target.value) }))}
                      className="w-full"
                    />
                  </div>

                  {/* 超时配置 */}
                  <div className="pt-3 border-t border-slate-600">
                    <h4 className="text-xs font-medium text-slate-300 mb-3 flex items-center gap-1">
                      ⏱️ 超时设置
                    </h4>
                    
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">
                          最大总时间: {Math.round(config.maxTotalTimeout / 60000)} 分钟
                        </label>
                        <input
                          type="range"
                          min="60000"
                          max="1800000"
                          step="60000"
                          value={config.maxTotalTimeout}
                          onChange={e => setConfig(prev => ({ ...prev, maxTotalTimeout: parseInt(e.target.value) }))}
                          className="w-full"
                        />
                        <div className="flex justify-between text-[10px] text-slate-500">
                          <span>1分钟</span>
                          <span>30分钟</span>
                        </div>
                      </div>
                      
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">
                          单块超时: {Math.round(config.maxChunkTimeout / 1000)} 秒
                        </label>
                        <input
                          type="range"
                          min="10000"
                          max="180000"
                          step="5000"
                          value={config.maxChunkTimeout}
                          onChange={e => setConfig(prev => ({ ...prev, maxChunkTimeout: parseInt(e.target.value) }))}
                          className="w-full"
                        />
                        <div className="flex justify-between text-[10px] text-slate-500">
                          <span>10秒</span>
                          <span>180秒</span>
                        </div>
                      </div>
                    </div>
                    
                    <p className="text-[10px] text-slate-500 mt-2">
                      💡 较大的模型和更长的文本需要更多时间。超时会根据文本长度自动调整。
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* 操作按钮 */}
            <div className="space-y-2">
              <button
                onClick={handleExtract}
                disabled={isExtracting || (inputMode === 'files' ? selectedFiles.length === 0 : !customText.trim())}
                className={`w-full py-3 rounded-xl font-semibold transition-all ${
                  isExtracting || (inputMode === 'files' ? selectedFiles.length === 0 : !customText.trim())
                    ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                    : 'bg-gradient-to-r from-purple-600 to-pink-600 text-white hover:from-purple-500 hover:to-pink-500 shadow-lg shadow-purple-500/25'
                }`}
              >
                {isExtracting ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="animate-spin">⏳</span>
                    正在抽取...
                  </span>
                ) : (
                  <span className="flex items-center justify-center gap-2">
                    🚀 开始实体抽取
                  </span>
                )}
              </button>

              {graph && (
                <button
                  onClick={handleClearGraph}
                  className="w-full py-2 text-sm bg-red-500/20 text-red-400 rounded-lg hover:bg-red-500/30 transition-colors"
                >
                  🗑️ 清除图谱
                </button>
              )}
            </div>

            {/* 进度显示 */}
            {progress && (
              <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-white">{progress.message}</span>
                  <span className="text-xs text-purple-400">{Math.round(getProgressPercent())}%</span>
                </div>
                <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-gradient-to-r from-purple-500 to-pink-500 transition-all duration-300"
                    style={{ width: `${getProgressPercent()}%` }}
                  />
                </div>
                <div className="mt-2 text-xs text-slate-400">
                  阶段: {progress.stage} | 进度: {progress.current}/{progress.total}
                </div>
              </div>
            )}

            {/* 错误提示 */}
            {error && (
              <div className="bg-red-500/20 border border-red-500/50 rounded-xl p-4">
                <div className="flex items-center gap-2 text-red-400">
                  <span>❌</span>
                  <span className="text-sm">{error}</span>
                </div>
              </div>
            )}

            {/* 统计信息 */}
            {graph && (
              <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
                <h3 className="text-sm font-semibold text-white mb-3">📊 图谱统计</h3>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="bg-slate-700/50 rounded-lg p-2">
                    <div className="text-2xl font-bold text-blue-400">{graph.metadata.entityCount}</div>
                    <div className="text-xs text-slate-400">实体</div>
                  </div>
                  <div className="bg-slate-700/50 rounded-lg p-2">
                    <div className="text-2xl font-bold text-purple-400">{graph.metadata.relationCount}</div>
                    <div className="text-xs text-slate-400">关系</div>
                  </div>
                  <div className="bg-slate-700/50 rounded-lg p-2">
                    <div className="text-2xl font-bold text-pink-400">{graph.metadata.communityCount}</div>
                    <div className="text-xs text-slate-400">社区</div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 右侧可视化区域 */}
          <div className="lg:col-span-3">
            {/* 标签页切换 */}
            {graph && (
              <div className="flex gap-2 mb-4">
                {[
                  { id: 'graph', label: '🕸️ 图谱视图', desc: '可视化知识图谱' },
                  { id: 'entities', label: '👤 实体列表', desc: `${graph.metadata.entityCount} 个实体` },
                  { id: 'relations', label: '🔗 关系列表', desc: `${graph.metadata.relationCount} 个关系` },
                  { id: 'communities', label: '🏘️ 社区摘要', desc: `${graph.metadata.communityCount} 个社区` },
                ].map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as typeof activeTab)}
                    className={`flex-1 p-3 rounded-xl transition-all ${
                      activeTab === tab.id
                        ? 'bg-purple-600/30 border border-purple-500/50 text-white'
                        : 'bg-slate-800/50 border border-slate-700 text-slate-400 hover:text-white hover:bg-slate-800'
                    }`}
                  >
                    <div className="text-sm font-medium">{tab.label}</div>
                    <div className="text-xs opacity-70">{tab.desc}</div>
                  </button>
                ))}
              </div>
            )}

            {/* 内容区域 */}
            {activeTab === 'graph' && (
              <KnowledgeGraphViewer graph={graph} />
            )}

            {activeTab === 'entities' && graph && (
              <div className="bg-slate-800/50 rounded-xl border border-slate-700 overflow-hidden">
                <div className="overflow-auto max-h-[700px]">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-slate-800 text-left text-slate-400">
                      <tr>
                        <th className="px-4 py-3">类型</th>
                        <th className="px-4 py-3">名称</th>
                        <th className="px-4 py-3">描述</th>
                        <th className="px-4 py-3">别名</th>
                        <th className="px-4 py-3">出现次数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {graph.entities.map(entity => (
                        <tr key={entity.id} className="border-t border-slate-700/50 hover:bg-slate-700/30">
                          <td className="px-4 py-3">
                            <span className="px-2 py-1 bg-blue-500/20 text-blue-300 rounded text-xs">
                              {entity.type}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-white font-medium">{entity.name}</td>
                          <td className="px-4 py-3 text-slate-400 max-w-md truncate">{entity.description}</td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1">
                              {entity.aliases.slice(0, 3).map((alias, i) => (
                                <span key={i} className="px-1.5 py-0.5 bg-slate-600 text-slate-300 rounded text-xs">
                                  {alias}
                                </span>
                              ))}
                              {entity.aliases.length > 3 && (
                                <span className="text-xs text-slate-500">+{entity.aliases.length - 3}</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-slate-300">{entity.mentions}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {activeTab === 'relations' && graph && (
              <div className="bg-slate-800/50 rounded-xl border border-slate-700 overflow-hidden">
                <div className="overflow-auto max-h-[700px]">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-slate-800 text-left text-slate-400">
                      <tr>
                        <th className="px-4 py-3">源实体</th>
                        <th className="px-4 py-3">关系类型</th>
                        <th className="px-4 py-3">目标实体</th>
                        <th className="px-4 py-3">描述</th>
                        <th className="px-4 py-3">权重</th>
                      </tr>
                    </thead>
                    <tbody>
                      {graph.relations.map(relation => {
                        const source = graph.entities.find(e => e.id === relation.source);
                        const target = graph.entities.find(e => e.id === relation.target);
                        return (
                          <tr key={relation.id} className="border-t border-slate-700/50 hover:bg-slate-700/30">
                            <td className="px-4 py-3 text-white">{source?.name || relation.source}</td>
                            <td className="px-4 py-3">
                              <span className="px-2 py-1 bg-yellow-500/20 text-yellow-300 rounded text-xs">
                                {relation.type}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-white">{target?.name || relation.target}</td>
                            <td className="px-4 py-3 text-slate-400 max-w-md truncate">{relation.description}</td>
                            <td className="px-4 py-3 text-slate-300">{relation.weight.toFixed(2)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {activeTab === 'communities' && graph && (
              <div className="space-y-4 max-h-[700px] overflow-auto">
                {graph.communities.map(community => (
                  <div key={community.id} className="bg-slate-800/50 rounded-xl border border-slate-700 p-5">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h4 className="text-lg font-semibold text-white">{community.name}</h4>
                        <div className="flex items-center gap-3 mt-1 text-xs text-slate-400">
                          <span>📊 {community.entities.length} 实体</span>
                          <span>🔗 {community.relations.length} 关系</span>
                        </div>
                      </div>
                      <span className="px-2 py-1 bg-purple-500/20 text-purple-300 rounded text-xs">
                        Level {community.level}
                      </span>
                    </div>

                    <p className="text-slate-300 mb-4">{community.summary}</p>

                    {community.keywords.length > 0 && (
                      <div className="mb-4">
                        <div className="text-xs text-slate-400 mb-2">关键词</div>
                        <div className="flex flex-wrap gap-2">
                          {community.keywords.map((keyword, i) => (
                            <span key={i} className="px-2 py-1 bg-blue-500/20 text-blue-300 rounded-full text-xs">
                              {keyword}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    <div>
                      <div className="text-xs text-slate-400 mb-2">成员实体</div>
                      <div className="flex flex-wrap gap-1">
                        {community.entities.slice(0, 15).map(entityId => {
                          const entity = graph.entities.find(e => e.id === entityId);
                          return entity ? (
                            <span
                              key={entityId}
                              className="px-2 py-0.5 bg-slate-700 text-slate-300 rounded text-xs"
                            >
                              {entity.name}
                            </span>
                          ) : null;
                        })}
                        {community.entities.length > 15 && (
                          <span className="px-2 py-0.5 text-xs text-slate-500">
                            +{community.entities.length - 15} 更多
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 空状态 */}
            {!graph && !isExtracting && (
              <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-12 text-center">
                <div className="text-6xl mb-4">🕸️</div>
                <h3 className="text-2xl font-bold text-white mb-2">知识图谱构建</h3>
                <p className="text-slate-400 mb-6 max-w-md mx-auto">
                  上传文档或输入文本，使用 LLM 自动抽取实体和关系，构建结构化的知识图谱。
                  支持 Gleaning（二次检查）和实体消歧功能。
                </p>
                <div className="flex justify-center gap-3">
                  <div className="px-4 py-2 bg-slate-700 rounded-lg text-sm text-slate-300">
                    <span className="text-lg mr-2">📄</span>
                    智能切分
                  </div>
                  <div className="px-4 py-2 bg-slate-700 rounded-lg text-sm text-slate-300">
                    <span className="text-lg mr-2">🔍</span>
                    实体抽取
                  </div>
                  <div className="px-4 py-2 bg-slate-700 rounded-lg text-sm text-slate-300">
                    <span className="text-lg mr-2">🔗</span>
                    关系构建
                  </div>
                  <div className="px-4 py-2 bg-slate-700 rounded-lg text-sm text-slate-300">
                    <span className="text-lg mr-2">🏘️</span>
                    社区发现
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 功能说明 */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-slate-800/30 rounded-xl border border-slate-700/50 p-6">
          <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            📖 GraphRAG 实体抽取流程
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {[
              {
                icon: '📄',
                title: '1. 智能切分',
                desc: '按语义边界切分文本，保留重叠区域确保跨句子关系不丢失。',
              },
              {
                icon: '🔍',
                title: '2. LLM 提取',
                desc: '使用 LLM 从每个文本块中提取实体和关系，支持 Gleaning 二次检查遗漏。',
              },
              {
                icon: '🧹',
                title: '3. 实体消歧',
                desc: '基于向量相似度和 LLM 判断合并同义实体（如 "马斯克" 和 "Elon Musk"）。',
              },
              {
                icon: '🏘️',
                title: '4. 社区摘要',
                desc: '发现紧密关联的实体社区，生成摘要报告用于高效的图谱检索。',
              },
            ].map((step, i) => (
              <div key={i} className="bg-slate-800/50 rounded-lg p-4">
                <div className="text-3xl mb-2">{step.icon}</div>
                <h4 className="font-medium text-white mb-1">{step.title}</h4>
                <p className="text-sm text-slate-400">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

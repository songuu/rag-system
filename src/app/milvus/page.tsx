'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Link from 'next/link';

interface MilvusStats {
  name: string;
  rowCount: number;
  embeddingDimension: number;
  indexType: string;
  metricType: string;
  loaded: boolean;
}

interface MilvusHealth {
  healthy: boolean;
  message: string;
}

interface MilvusConfig {
  address: string;
  database: string;
  collectionName: string;
  embeddingDimension: number;
  indexType: string;
  metricType: string;
}

interface SearchResult {
  id: string;
  content: string;
  metadata: Record<string, any>;
  score: number;
  distance: number;
}

interface ProcessingResult {
  filename?: string;
  documentId?: string;
  chunks: number;
  success: boolean;
  error?: string;
  metadata?: any;
}

interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}

// 数据源类型图标
const sourceIcons: Record<string, { icon: string; color: string; label: string }> = {
  text: { icon: '📄', color: 'blue', label: '文本' },
  pdf: { icon: '📕', color: 'red', label: 'PDF' },
  docx: { icon: '📘', color: 'blue', label: 'Word' },
  url: { icon: '🌐', color: 'green', label: '网页' },
  youtube: { icon: '📺', color: 'red', label: 'YouTube' },
};

// 推荐的 Embedding 模型（包含 Ollama 和 SiliconFlow）
const RECOMMENDED_EMBEDDING_MODELS = [
  // Ollama 本地模型
  { name: 'nomic-embed-text', description: '高质量通用嵌入', dimension: 768, size: '274 MB' },
  { name: 'bge-m3', description: 'BGE-M3 多语言', dimension: 1024, size: '2.2 GB' },
  { name: 'bge-large', description: 'BGE 中英双语', dimension: 1024, size: '1.3 GB' },
  { name: 'mxbai-embed-large', description: '大型高精度嵌入', dimension: 1024, size: '669 MB' },
  { name: 'snowflake-arctic-embed', description: 'Snowflake 嵌入', dimension: 1024, size: '669 MB' },
  { name: 'qwen3-embedding', description: 'Qwen3 嵌入', dimension: 1024, size: '1.2 GB' },
  // SiliconFlow 云端模型
  { name: 'BAAI/bge-m3', description: 'SiliconFlow BGE-M3', dimension: 1024, size: '云端' },
  { name: 'BAAI/bge-large-zh-v1.5', description: 'SiliconFlow BGE 中文', dimension: 1024, size: '云端' },
  { name: 'BAAI/bge-large-en-v1.5', description: 'SiliconFlow BGE 英文', dimension: 1024, size: '云端' },
  { name: 'Pro/BAAI/bge-m3', description: 'SiliconFlow BGE-M3 Pro', dimension: 1024, size: '云端' },
  { name: 'Qwen/Qwen3-Embedding-8B', description: 'SiliconFlow Qwen3 8B', dimension: 4096, size: '云端' },
  { name: 'Qwen/Qwen3-Embedding-4B', description: 'SiliconFlow Qwen3 4B', dimension: 2560, size: '云端' },
  { name: 'Qwen/Qwen3-Embedding-0.6B', description: 'SiliconFlow Qwen3 0.6B', dimension: 1024, size: '云端' },
  { name: 'netease-youdao/bce-embedding-base_v1', description: 'SiliconFlow 网易有道', dimension: 768, size: '云端' },
  // OpenAI 模型
  { name: 'text-embedding-3-small', description: 'OpenAI Small', dimension: 1536, size: '云端' },
  { name: 'text-embedding-3-large', description: 'OpenAI Large', dimension: 3072, size: '云端' },
  { name: 'text-embedding-ada-002', description: 'OpenAI Ada', dimension: 1536, size: '云端' },
];

export default function MilvusPage() {
  // 状态管理
  const [connected, setConnected] = useState(false);
  const [health, setHealth] = useState<MilvusHealth | null>(null);
  const [stats, setStats] = useState<MilvusStats | null>(null);
  const [config, setConfig] = useState<MilvusConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notification, setNotification] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  // Embedding 模型
  const [embeddingModels, setEmbeddingModels] = useState<OllamaModel[]>([]);
  const [selectedEmbeddingModel, setSelectedEmbeddingModel] = useState('nomic-embed-text');
  const [loadingModels, setLoadingModels] = useState(false);
  
  // 模型提供商配置
  const [embeddingProvider, setEmbeddingProvider] = useState<string>('ollama');
  const [embeddingDimension, setEmbeddingDimension] = useState<number>(768);
  const isRemoteEmbedding = embeddingProvider !== 'ollama';

  // 搜索
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [topK, setTopK] = useState(5);
  const [threshold, setThreshold] = useState(0.0);

  // 导入
  const [importText, setImportText] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResults, setImportResults] = useState<ProcessingResult[]>([]);
  const [chunkSize, setChunkSize] = useState(500);
  const [chunkOverlap, setChunkOverlap] = useState(50);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 配置
  const [newAddress, setNewAddress] = useState('');
  const [newCollection, setNewCollection] = useState('');
  const [selectedIndexType, setSelectedIndexType] = useState('IVF_FLAT');
  const [selectedMetricType, setSelectedMetricType] = useState('COSINE');

  // 标签页
  const [activeTab, setActiveTab] = useState<'dashboard' | 'pipeline' | 'search' | 'visualize' | 'config'>('dashboard');
  const [importTab, setImportTab] = useState<'text' | 'file' | 'url' | 'youtube'>('text');

  // 可视化状态
  const [vectorSpace, setVectorSpace] = useState<{
    points: Array<{ id: string; x: number; y: number; z?: number; content: string; source: string; cluster: number }>;
    clusters: Array<{ id: number; name: string; color: string }>;
  } | null>(null);
  const [similarityDist, setSimilarityDist] = useState<{
    distribution: Record<string, number>;
    statistics: { mean: number; max: number; min: number; median: number };
    results: any[];
  } | null>(null);
  const [queryPath, setQueryPath] = useState<{
    nodes: any[];
    edges: any[];
    timing: { embedding: number; search: number; total: number };
  } | null>(null);
  const [visualizeQuery, setVisualizeQuery] = useState('');
  const [loadingVisualize, setLoadingVisualize] = useState(false);
  const [selectedPoint, setSelectedPoint] = useState<any>(null);

  // 显示通知
  const showNotification = (type: 'success' | 'error' | 'info', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 5000);
  };

  // 加载模型配置（先检查系统配置，再加载 Ollama 模型）
  const loadOllamaModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      // 首先获取系统配置，确定使用哪个提供商
      const healthResponse = await fetch('/api/health');
      const healthData = await healthResponse.json();
      
      if (healthData.modelConfig?.embedding) {
        const embConfig = healthData.modelConfig.embedding;
        setEmbeddingProvider(embConfig.provider || 'ollama');
        setEmbeddingDimension(embConfig.dimension || 768);
        
        // 如果是远程提供商，直接使用配置的模型
        if (embConfig.provider && embConfig.provider !== 'ollama') {
          setSelectedEmbeddingModel(embConfig.model);
          setEmbeddingModels([{
            name: embConfig.model,
            size: 0,
            modified_at: new Date().toISOString(),
          }]);
          setLoadingModels(false);
          return;
        }
      }
      
      // Ollama 提供商：从本地加载模型列表
      const response = await fetch('/api/ollama/models');
      const data = await response.json();

      if (data.success && data.embeddingModels) {
        setEmbeddingModels(data.embeddingModels);
        // 如果当前选择的模型不在列表中，选择第一个
        if (data.embeddingModels.length > 0) {
          const modelNames = data.embeddingModels.map((m: OllamaModel) => m.name);
          if (!modelNames.includes(selectedEmbeddingModel)) {
            setSelectedEmbeddingModel(data.embeddingModels[0].name);
          }
        }
      }
    } catch (err) {
      console.error('Failed to load Ollama models:', err);
    } finally {
      setLoadingModels(false);
    }
  }, [selectedEmbeddingModel]);

  // 加载状态
  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/milvus?action=status');
      const data = await response.json();

      if (data.success) {
        setConnected(data.connected);
        setHealth(data.health);
        setStats(data.stats);
        setConfig(data.config);
        setNewAddress(data.config?.address || '');
        setNewCollection(data.config?.collectionName || '');
        setSelectedIndexType(data.config?.indexType || 'IVF_FLAT');
        setSelectedMetricType(data.config?.metricType || 'COSINE');
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    loadOllamaModels();
  }, [loadStatus, loadOllamaModels]);

  // 连接/断开
  const handleConnect = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/milvus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'connect',
          config: {
            address: newAddress || undefined,
            collectionName: newCollection || undefined,
            indexType: selectedIndexType,
            metricType: selectedMetricType,
          },
        }),
      });

      const data = await response.json();

      if (data.success) {
        showNotification('success', '成功连接到 Milvus');
        await loadStatus();
      } else {
        showNotification('error', data.error);
      }
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/milvus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'disconnect' }),
      });

      const data = await response.json();

      if (data.success) {
        showNotification('info', '已断开 Milvus 连接');
        setConnected(false);
        setStats(null);
      } else {
        showNotification('error', data.error);
      }
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : 'Disconnect failed');
    } finally {
      setLoading(false);
    }
  };

  // 获取选定模型的维度（支持 Ollama、SiliconFlow、OpenAI 模型）
  const getModelDimension = (modelName: string): number => {
    // 首先精确匹配（支持 SiliconFlow 的 BAAI/bge-m3 格式）
    const exactMatch = RECOMMENDED_EMBEDDING_MODELS.find(m => 
      m.name === modelName || m.name.toLowerCase() === modelName.toLowerCase()
    );
    if (exactMatch) {
      return exactMatch.dimension;
    }
    
    // 移除 :latest 或其他标签后缀进行匹配
    const baseName = modelName.split(':')[0].toLowerCase().trim();
    
    // 精确匹配去掉标签的名称
    const baseMatch = RECOMMENDED_EMBEDDING_MODELS.find(m => 
      m.name.toLowerCase() === baseName
    );
    if (baseMatch) {
      return baseMatch.dimension;
    }

    // 模糊匹配推荐模型列表
    const fuzzyMatch = RECOMMENDED_EMBEDDING_MODELS.find(m =>
      baseName.includes(m.name.toLowerCase()) ||
      m.name.toLowerCase().includes(baseName)
    );
    if (fuzzyMatch) {
      return fuzzyMatch.dimension;
    }

    // 根据模型名称模式推断维度（按优先级排序）
    // SiliconFlow Qwen3 系列
    if (baseName.includes('qwen3-embedding-8b')) return 4096;
    if (baseName.includes('qwen3-embedding-4b')) return 2560;
    if (baseName.includes('qwen3-embedding')) return 1024;
    
    // BGE 系列
    if (baseName.includes('bge-m3') || baseName.includes('baai/bge-m3')) return 1024;
    if (baseName.includes('bge') && (baseName.includes('large') || baseName.includes('base'))) return 1024;
    
    // OpenAI 系列
    if (baseName.includes('text-embedding-3-large')) return 3072;
    if (baseName.includes('text-embedding-3-small') || baseName.includes('ada-002')) return 1536;
    
    // 其他常见模型
    if (baseName.includes('nomic') || baseName.includes('embed-text')) return 768;
    if (baseName.includes('mxbai') || baseName.includes('snowflake')) return 1024;
    if (baseName.includes('e5-large') || baseName.includes('gte-large')) return 1024;
    if (baseName.includes('bce-embedding')) return 768;

    // 默认返回 768
    console.warn(`[getModelDimension] No match found for "${modelName}", defaulting to 768D`);
    return 768;
  };

  // 获取当前选中模型的维度（支持远程提供商）
  const getCurrentModelDimension = useCallback(() => {
    if (isRemoteEmbedding) {
      return embeddingDimension;
    }
    return getModelDimension(selectedEmbeddingModel);
  }, [isRemoteEmbedding, embeddingDimension, selectedEmbeddingModel]);

  // 检查维度是否匹配
  const isDimensionMismatch = useMemo(() => {
    if (!stats?.embeddingDimension) {
      console.log('[isDimensionMismatch] No stats or embeddingDimension, returning false');
      return false;
    }
    const selectedDimension = getCurrentModelDimension();
    const mismatch = stats.embeddingDimension !== selectedDimension;
    console.log(`[isDimensionMismatch] Collection: ${stats.embeddingDimension}D, Selected model (${selectedEmbeddingModel}): ${selectedDimension}D, Mismatch: ${mismatch}, Provider: ${embeddingProvider}`);
    return mismatch;
  }, [stats?.embeddingDimension, selectedEmbeddingModel, getCurrentModelDimension, embeddingProvider]);

  // 搜索
  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      showNotification('error', '请输入搜索内容');
      return;
    }

    // 维度不匹配警告
    if (isDimensionMismatch && stats?.rowCount && stats.rowCount > 0) {
      const selectedDimension = getCurrentModelDimension();
      showNotification('error', `⚠️ 维度不匹配! 集合: ${stats.embeddingDimension}维, 模型: ${selectedDimension}维。请选择正确的模型或清空集合后重新导入。`);
      return;
    }

    setSearching(true);
    setSearchResults([]);

    try {
      const response = await fetch('/api/milvus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'search',
          query: searchQuery,
          topK,
          threshold,
          embeddingModel: selectedEmbeddingModel,
        }),
      });

      const data = await response.json();

      console.log("data", data);

      if (data.success) {
        setSearchResults(data.results);
        const modelInfo = data.embeddingModel ? ` (${data.embeddingModel}, ${data.dimension}D)` : '';
        const collectionInfo = data.collectionDimension ? ` 集合: ${data.collectionDimension}D` : '';
        showNotification('success', `✅ 找到 ${data.results.length} 个结果${modelInfo}${collectionInfo}`);
        console.log('[Search Success]', { 
          results: data.results.length, 
          model: data.embeddingModel, 
          dimension: data.dimension,
          collectionDimension: data.collectionDimension 
        });
      } else {
        // 显示详细错误信息
        console.error('[Search Error]', data);
        if (data.collectionDimension && data.queryDimension) {
          showNotification('error', `❌ 维度不匹配! 集合: ${data.collectionDimension}维, 查询: ${data.queryDimension}维。请求模型: ${data.requestedModel || '默认'}, 实际使用: ${data.actualModel || '?'}。${data.suggestion || ''}`);
        } else {
          showNotification('error', `❌ ${data.error}`);
        }
      }
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : 'Search failed');
    } finally {
      setSearching(false);
    }
  };

  // 导入文本
  const handleImportText = async () => {
    if (!importText.trim()) {
      showNotification('error', '请输入要导入的文本内容');
      return;
    }

    setImporting(true);
    setImportResults([]);

    try {
      const response = await fetch('/api/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'process-text',
          text: importText,
          source: `text-import-${Date.now()}`,
          chunkSize,
          chunkOverlap,
          embeddingModel: selectedEmbeddingModel,
        }),
      });

      const data = await response.json();

      if (data.success) {
        showNotification('success', `成功导入 ${data.chunks} 个文档块`);
        setImportResults([{ ...data, success: true }]);
        setImportText('');
        await loadStatus();
      } else {
        showNotification('error', data.error);
        setImportResults([{ chunks: 0, success: false, error: data.error }]);
      }
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  // 导入 URL
  const handleImportUrl = async () => {
    if (!importUrl.trim()) {
      showNotification('error', '请输入 URL');
      return;
    }

    setImporting(true);
    setImportResults([]);

    try {
      const isYouTube = importUrl.includes('youtube.com') || importUrl.includes('youtu.be');

      const response = await fetch('/api/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: isYouTube ? 'process-youtube' : 'process-url',
          [isYouTube ? 'videoUrl' : 'url']: importUrl,
          chunkSize,
          chunkOverlap,
          embeddingModel: selectedEmbeddingModel,
        }),
      });

      const data = await response.json();

      if (data.success) {
        showNotification('success', `成功导入 ${data.chunks} 个文档块`);
        setImportResults([{ ...data, success: true }]);
        setImportUrl('');
        await loadStatus();
      } else {
        showNotification('error', data.error);
        setImportResults([{ chunks: 0, success: false, error: data.error }]);
      }
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  // 导入文件
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setImporting(true);
    setImportResults([]);

    try {
      const formData = new FormData();
      Array.from(files).forEach(file => {
        formData.append('files', file);
      });
      formData.append('chunkSize', String(chunkSize));
      formData.append('chunkOverlap', String(chunkOverlap));
      formData.append('embeddingModel', selectedEmbeddingModel);

      const response = await fetch('/api/pipeline', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

      if (data.success) {
        showNotification('success', `成功导入 ${data.totalChunks} 个文档块`);
        setImportResults(data.results);
        await loadStatus();
      } else {
        showNotification('error', data.error);
      }
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setImporting(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // 清空集合
  const handleClear = async () => {
    if (!confirm('确定要清空所有文档吗？此操作不可撤销！')) {
      return;
    }

    setLoading(true);

    try {
      const response = await fetch('/api/milvus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear' }),
      });

      const data = await response.json();

      if (data.success) {
        showNotification('success', '集合已清空');
        await loadStatus();
      } else {
        showNotification('error', data.error);
      }
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : 'Clear failed');
    } finally {
      setLoading(false);
    }
  };

  // 加载向量空间数据
  const loadVectorSpace = async () => {
    setLoadingVisualize(true);
    try {
      const response = await fetch('/api/milvus/visualize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'vector-space', sampleSize: 100 }),
      });
      const data = await response.json();
      if (data.success) {
        setVectorSpace({ points: data.points, clusters: data.clusters });
      } else {
        showNotification('error', data.error);
      }
    } catch (err) {
      showNotification('error', '加载向量空间失败');
    } finally {
      setLoadingVisualize(false);
    }
  };

  // 查询相似度分布
  const loadSimilarityDistribution = async () => {
    if (!visualizeQuery.trim()) {
      showNotification('error', '请输入查询文本');
      return;
    }

    setLoadingVisualize(true);
    try {
      const response = await fetch('/api/milvus/visualize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'similarity-distribution', query: visualizeQuery, topK: 50 }),
      });
      const data = await response.json();
      if (data.success) {
        setSimilarityDist({
          distribution: data.distribution,
          statistics: data.statistics,
          results: data.results,
        });
      } else {
        showNotification('error', data.error);
      }
    } catch (err) {
      showNotification('error', '加载相似度分布失败');
    } finally {
      setLoadingVisualize(false);
    }
  };

  // 查询路径可视化
  const loadQueryPath = async () => {
    if (!visualizeQuery.trim()) {
      showNotification('error', '请输入查询文本');
      return;
    }

    setLoadingVisualize(true);
    try {
      const response = await fetch('/api/milvus/visualize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'query-path', query: visualizeQuery, topK: 10 }),
      });
      const data = await response.json();
      if (data.success) {
        setQueryPath({
          nodes: data.visualization.nodes,
          edges: data.visualization.edges,
          timing: data.timing,
        });
      } else {
        showNotification('error', data.error);
      }
    } catch (err) {
      showNotification('error', '加载查询路径失败');
    } finally {
      setLoadingVisualize(false);
    }
  };

  // 格式化分数
  const formatScore = (score: number) => `${(score * 100).toFixed(2)}%`;

  // 格式化文件大小
  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  };

  // 相似度分布数据
  const similarityDistribution = useMemo(() => {
    if (searchResults.length === 0) return null;

    const ranges = [
      { label: '90-100%', min: 0.9, max: 1.0, color: '#22c55e' },
      { label: '80-90%', min: 0.8, max: 0.9, color: '#84cc16' },
      { label: '70-80%', min: 0.7, max: 0.8, color: '#eab308' },
      { label: '60-70%', min: 0.6, max: 0.7, color: '#f97316' },
      { label: '50-60%', min: 0.5, max: 0.6, color: '#ef4444' },
      { label: '<50%', min: 0, max: 0.5, color: '#dc2626' },
    ];

    return ranges.map(range => ({
      ...range,
      count: searchResults.filter(r => r.score >= range.min && r.score < range.max).length,
    }));
  }, [searchResults]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
      {/* 导航栏 */}
      <nav className="bg-black/30 backdrop-blur-sm border-b border-white/10 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-6">
              <Link href="/" className="text-gray-400 hover:text-white transition-colors flex items-center gap-2">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
                返回主页
              </Link>
              <span className="text-gray-600">|</span>
              <span className="text-lg font-bold text-white flex items-center gap-2">
                <span className="text-2xl">🗄️</span>
                Milvus RAG Pipeline
              </span>
            </div>

              <div className="flex items-center gap-4">
              {/* Embedding 模型选择 */}
              <div className="flex items-center gap-2">
                <span className="text-gray-400 text-sm">嵌入模型:</span>
                {/* 提供商徽章 */}
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                  embeddingProvider === 'ollama' ? 'bg-gray-500/30 text-gray-300' :
                  embeddingProvider === 'siliconflow' ? 'bg-purple-500/30 text-purple-300' :
                  embeddingProvider === 'openai' ? 'bg-green-500/30 text-green-300' :
                  'bg-orange-500/30 text-orange-300'
                }`}>
                  {embeddingProvider === 'ollama' ? 'Ollama' :
                   embeddingProvider === 'siliconflow' ? 'SiliconFlow' :
                   embeddingProvider === 'openai' ? 'OpenAI' :
                   embeddingProvider.charAt(0).toUpperCase() + embeddingProvider.slice(1)}
                </span>
                {isRemoteEmbedding ? (
                  /* 远程提供商：显示只读模型名称 */
                  <div className="px-3 py-1.5 bg-black/30 border border-white/20 rounded-lg text-white text-sm flex items-center gap-2">
                    <span>{selectedEmbeddingModel}</span>
                    <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" title="通过环境变量配置">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                  </div>
                ) : (
                  /* Ollama 提供商：可选择的下拉框 */
                  <select
                    value={selectedEmbeddingModel}
                    onChange={(e) => {
                      console.log(`[Model Change] From: "${selectedEmbeddingModel}" To: "${e.target.value}"`);
                      setSelectedEmbeddingModel(e.target.value);
                    }}
                    className={`px-3 py-1.5 bg-black/30 border rounded-lg text-white text-sm focus:outline-none ${isDimensionMismatch && stats?.rowCount && stats.rowCount > 0
                      ? 'border-red-500/50 focus:border-red-500'
                      : 'border-white/20 focus:border-purple-500'
                      }`}
                  >
                    {embeddingModels.length > 0 ? (
                      embeddingModels.map(model => {
                        const dimension = getModelDimension(model.name);
                        return (
                          <option key={model.name} value={model.name}>
                            {model.name} ({dimension}D)
                          </option>
                        );
                      })
                    ) : (
                      RECOMMENDED_EMBEDDING_MODELS.map(model => (
                        <option key={model.name} value={model.name}>
                          {model.name} ({model.dimension}D)
                        </option>
                      ))
                    )}
                  </select>
                )}
                {/* 显示选中模型的维度 */}
                <div className={`px-2 py-1 rounded text-xs font-mono ${
                  isDimensionMismatch && stats?.rowCount && stats.rowCount > 0
                    ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                    : 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                }`}>
                  {isRemoteEmbedding ? embeddingDimension : getModelDimension(selectedEmbeddingModel)}D
                </div>
                {/* 显示集合维度 */}
                {stats?.embeddingDimension && (
                  <div className="px-2 py-1 rounded text-xs font-mono bg-green-500/20 text-green-400 border border-green-500/30" title="集合维度">
                    集合: {stats.embeddingDimension}D
                  </div>
                )}
                {isDimensionMismatch && stats && stats?.rowCount > 0 && (
                  <span className="text-xs text-red-400 flex items-center gap-1 font-medium" title={`集合: ${stats.embeddingDimension}D, 模型: ${getCurrentModelDimension()}D`}>
                    ⚠️ 不匹配
                  </span>
                )}
                <button
                  onClick={loadOllamaModels}
                  disabled={loadingModels}
                  className="p-1.5 text-gray-400 hover:text-white transition-colors"
                  title="刷新模型列表"
                >
                  <svg className={`w-4 h-4 ${loadingModels ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
              </div>

              <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium ${connected
                ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                : 'bg-red-500/20 text-red-400 border border-red-500/30'
                }`}>
                <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`}></span>
                {connected ? '已连接' : '未连接'}
              </div>
            </div>
          </div>
        </div>
      </nav>

      {/* 通知 */}
      {notification && (
        <div className={`fixed top-20 right-6 z-50 px-6 py-4 rounded-xl shadow-2xl border backdrop-blur-sm transition-all ${notification.type === 'success' ? 'bg-green-500/20 border-green-500/30 text-green-300' :
          notification.type === 'error' ? 'bg-red-500/20 border-red-500/30 text-red-300' :
            'bg-blue-500/20 border-blue-500/30 text-blue-300'
          }`}>
          <div className="flex items-center gap-3">
            <span className="text-xl">
              {notification.type === 'success' ? '✓' : notification.type === 'error' ? '✕' : 'ℹ'}
            </span>
            {notification.message}
          </div>
        </div>
      )}

      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* 标签页 */}
        <div className="flex gap-2 mb-8 overflow-x-auto">
          {[
            { id: 'dashboard', label: '📊 仪表盘' },
            { id: 'pipeline', label: '📥 导入' },
            { id: 'search', label: '🔍 搜索' },
            { id: 'visualize', label: '🎨 可视化' },
            { id: 'config', label: '⚙️ 配置' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`px-6 py-3 rounded-xl font-medium transition-all ${activeTab === tab.id
                ? 'bg-purple-600 text-white shadow-lg shadow-purple-500/30'
                : 'bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white'
                }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* 仪表盘页 */}
        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            {/* Pipeline 流程图 */}
            <div className="bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10 p-6">
              <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                <span className="text-xl">🔄</span>
                RAG Pipeline 架构
              </h2>
              <div className="relative">
                {/* 流程图 */}
                <div className="flex items-center justify-between overflow-x-auto py-6 px-4">
                  {/* 数据源 */}
                  <div className="flex flex-col items-center gap-2 min-w-[120px]">
                    <div className="bg-gradient-to-br from-blue-500/20 to-blue-600/20 border-2 border-blue-500/40 rounded-2xl p-5 text-center shadow-lg shadow-blue-500/10">
                      <div className="text-4xl mb-2">📁</div>
                      <div className="text-sm text-white font-bold">数据源</div>
                      <div className="text-xs text-gray-400 mt-1 space-y-0.5">
                        <div>📄 Word</div>
                        <div>📕 PDF</div>
                        <div>🌐 URL</div>
                        <div>📺 YouTube</div>
                      </div>
                    </div>
                  </div>

                  {/* 箭头 */}
                  <div className="flex items-center px-2">
                    <div className="w-12 h-0.5 bg-gradient-to-r from-blue-500 to-purple-500"></div>
                    <div className="w-0 h-0 border-t-[6px] border-t-transparent border-b-[6px] border-b-transparent border-l-[10px] border-l-purple-500"></div>
                  </div>

                  {/* Loader */}
                  <div className="flex flex-col items-center gap-2 min-w-[120px]">
                    <div className="bg-gradient-to-br from-purple-500/20 to-purple-600/20 border-2 border-purple-500/40 rounded-2xl p-5 text-center shadow-lg shadow-purple-500/10">
                      <div className="text-4xl mb-2">📥</div>
                      <div className="text-sm text-white font-bold">Loader</div>
                      <div className="text-xs text-gray-400 mt-1">
                        文档加载器
                      </div>
                    </div>
                  </div>

                  {/* 箭头 */}
                  <div className="flex items-center px-2">
                    <div className="w-12 h-0.5 bg-gradient-to-r from-purple-500 to-green-500"></div>
                    <div className="w-0 h-0 border-t-[6px] border-t-transparent border-b-[6px] border-b-transparent border-l-[10px] border-l-green-500"></div>
                  </div>

                  {/* TextSplitter */}
                  <div className="flex flex-col items-center gap-2 min-w-[120px]">
                    <div className="bg-gradient-to-br from-green-500/20 to-green-600/20 border-2 border-green-500/40 rounded-2xl p-5 text-center shadow-lg shadow-green-500/10">
                      <div className="text-4xl mb-2">✂️</div>
                      <div className="text-sm text-white font-bold">TextSplitter</div>
                      <div className="text-xs text-gray-400 mt-1">
                        <div>块大小: {chunkSize}</div>
                        <div>重叠: {chunkOverlap}</div>
                      </div>
                    </div>
                  </div>

                  {/* 箭头 */}
                  <div className="flex items-center px-2">
                    <div className="w-12 h-0.5 bg-gradient-to-r from-green-500 to-orange-500"></div>
                    <div className="w-0 h-0 border-t-[6px] border-t-transparent border-b-[6px] border-b-transparent border-l-[10px] border-l-orange-500"></div>
                  </div>

                  {/* 嵌入模型 */}
                  <div className="flex flex-col items-center gap-2 min-w-[120px]">
                    <div className="bg-gradient-to-br from-orange-500/20 to-orange-600/20 border-2 border-orange-500/40 rounded-2xl p-5 text-center shadow-lg shadow-orange-500/10">
                      <div className="text-4xl mb-2">🧠</div>
                      <div className="text-sm text-white font-bold">嵌入模型</div>
                      <div className="text-xs text-orange-400 mt-1 font-mono">
                        {selectedEmbeddingModel}
                      </div>
                      <div className="text-xs text-gray-400">
                        维度: {stats?.embeddingDimension || config?.embeddingDimension || 768}
                      </div>
                    </div>
                  </div>

                  {/* 箭头 */}
                  <div className="flex items-center px-2">
                    <div className="w-12 h-0.5 bg-gradient-to-r from-orange-500 to-cyan-500"></div>
                    <div className="w-0 h-0 border-t-[6px] border-t-transparent border-b-[6px] border-b-transparent border-l-[10px] border-l-cyan-500"></div>
                  </div>

                  {/* 向量数据库 */}
                  <div className="flex flex-col items-center gap-2 min-w-[120px]">
                    <div className="bg-gradient-to-br from-cyan-500/20 to-cyan-600/20 border-2 border-cyan-500/40 rounded-2xl p-5 text-center shadow-lg shadow-cyan-500/10 relative">
                      {connected && (
                        <div className="absolute -top-2 -right-2 w-4 h-4 bg-green-500 rounded-full animate-pulse"></div>
                      )}
                      <div className="text-4xl mb-2">🗄️</div>
                      <div className="text-sm text-white font-bold">Milvus</div>
                      <div className="text-xs text-cyan-400 mt-1 font-bold">
                        {stats?.rowCount?.toLocaleString() || 0} 文档
                      </div>
                      <div className="text-xs text-gray-400">
                        {stats?.indexType || config?.indexType || 'IVF_FLAT'}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* 维度不匹配警告 */}
            {isDimensionMismatch && stats && stats.rowCount > 0 && (
              <div className="bg-red-500/10 border-2 border-red-500/30 rounded-2xl p-4 flex items-center gap-4">
                <div className="text-4xl">⚠️</div>
                <div className="flex-1">
                  <div className="text-red-400 font-bold text-lg mb-1">向量维度不匹配</div>
                  <div className="text-red-300/80 text-sm">
                    集合中的文档使用 <span className="font-bold">{stats.embeddingDimension}</span> 维向量，
                    但当前选择的模型 <span className="font-bold">{selectedEmbeddingModel}</span> 生成 <span className="font-bold">{getCurrentModelDimension()}</span> 维向量。
                  </div>
                  <div className="text-gray-400 text-xs mt-2">
                    {isRemoteEmbedding ? (
                      <>解决方案：修改环境变量配置使用正确维度的模型，或清空集合后重新导入文档</>
                    ) : (
                      <>解决方案：1) 选择 {stats.embeddingDimension === 768 ? 'nomic-embed-text' : 'mxbai-embed-large 或 bge-large'} 模型
                      2) 或清空集合后使用新模型重新导入文档</>
                    )}
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  {!isRemoteEmbedding && (
                    <button
                      onClick={() => {
                        const recommendedModel = stats.embeddingDimension === 768 ? 'nomic-embed-text' : 'mxbai-embed-large';
                        if (embeddingModels.some(m => m.name === recommendedModel) || RECOMMENDED_EMBEDDING_MODELS.some(m => m.name === recommendedModel)) {
                          setSelectedEmbeddingModel(recommendedModel);
                          showNotification('success', `已切换到 ${recommendedModel}`);
                        }
                      }}
                      className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition-all"
                    >
                      使用匹配模型
                    </button>
                  )}
                  <button
                    onClick={handleClear}
                    className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-all"
                  >
                    清空集合
                  </button>
                </div>
              </div>
            )}

            {/* 统计卡片 */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-gradient-to-br from-blue-500/10 to-blue-600/10 rounded-2xl p-6 border border-blue-500/20">
                <div className="flex items-center justify-between mb-4">
                  <div className="text-3xl">📊</div>
                  <div className={`w-3 h-3 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`}></div>
                </div>
                <div className="text-3xl font-bold text-white mb-1">
                  {stats?.rowCount?.toLocaleString() || '0'}
                </div>
                <div className="text-sm text-gray-400">文档总数</div>
              </div>

              <div className="bg-gradient-to-br from-purple-500/10 to-purple-600/10 rounded-2xl p-6 border border-purple-500/20">
                <div className="flex items-center justify-between mb-4">
                  <div className="text-3xl">📐</div>
                </div>
                <div className="text-3xl font-bold text-white mb-1">
                  {stats?.embeddingDimension || config?.embeddingDimension || '768'}
                </div>
                <div className="text-sm text-gray-400">向量维度</div>
              </div>

              <div className="bg-gradient-to-br from-green-500/10 to-green-600/10 rounded-2xl p-6 border border-green-500/20">
                <div className="flex items-center justify-between mb-4">
                  <div className="text-3xl">🔍</div>
                </div>
                <div className="text-xl font-bold text-white mb-1 font-mono">
                  {stats?.indexType || config?.indexType || 'IVF_FLAT'}
                </div>
                <div className="text-sm text-gray-400">索引类型</div>
              </div>

              <div className="bg-gradient-to-br from-orange-500/10 to-orange-600/10 rounded-2xl p-6 border border-orange-500/20">
                <div className="flex items-center justify-between mb-4">
                  <div className="text-3xl">📏</div>
                </div>
                <div className="text-xl font-bold text-white mb-1 font-mono">
                  {stats?.metricType || config?.metricType || 'COSINE'}
                </div>
                <div className="text-sm text-gray-400">度量类型</div>
              </div>
            </div>

            {/* 模型信息和连接状态 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Embedding 模型信息 */}
              <div className="bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10 p-6">
                <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                  <span className="text-xl">🧠</span>
                  当前 Embedding 模型
                </h3>
                <div className="bg-gradient-to-r from-orange-500/10 to-yellow-500/10 rounded-xl p-4 border border-orange-500/20">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-2xl font-bold text-white">{selectedEmbeddingModel}</span>
                    <span className="px-3 py-1 bg-orange-500/20 text-orange-400 rounded-full text-sm font-medium">
                      {embeddingModels.find(m => m.name === selectedEmbeddingModel) ? '已安装' : '推荐'}
                    </span>
                  </div>

                  {/* 模型详情 */}
                  <div className="grid grid-cols-2 gap-3 mt-4">
                    <div className="bg-black/20 rounded-lg p-3">
                      <div className="text-xs text-gray-400">维度</div>
                      <div className="text-lg font-bold text-white">
                        {RECOMMENDED_EMBEDDING_MODELS.find(m => m.name === selectedEmbeddingModel)?.dimension || stats?.embeddingDimension || 768}
                      </div>
                    </div>
                    <div className="bg-black/20 rounded-lg p-3">
                      <div className="text-xs text-gray-400">大小</div>
                      <div className="text-lg font-bold text-white">
                        {RECOMMENDED_EMBEDDING_MODELS.find(m => m.name === selectedEmbeddingModel)?.size ||
                          (embeddingModels.find(m => m.name === selectedEmbeddingModel) ?
                            formatSize(embeddingModels.find(m => m.name === selectedEmbeddingModel)!.size) : 'N/A')}
                      </div>
                    </div>
                  </div>
                </div>

                {/* 可用模型列表 */}
                <div className="mt-4">
                  <div className="text-sm text-gray-400 mb-2">已安装的模型 ({embeddingModels.length})</div>
                  <div className="flex flex-wrap gap-2">
                    {embeddingModels.length > 0 ? (
                      embeddingModels.map(model => (
                        <button
                          key={model.name}
                          onClick={() => setSelectedEmbeddingModel(model.name)}
                          className={`px-3 py-1.5 rounded-lg text-sm transition-all ${selectedEmbeddingModel === model.name
                            ? 'bg-orange-500 text-white'
                            : 'bg-white/10 text-gray-300 hover:bg-white/20'
                            }`}
                        >
                          {model.name}
                        </button>
                      ))
                    ) : (
                      <span className="text-gray-500 text-sm">没有检测到已安装的 Embedding 模型</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Milvus 连接状态 */}
              <div className="bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10 p-6">
                <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                  <span className="text-xl">🔌</span>
                  Milvus 连接状态
                </h3>

                {loading ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="animate-spin h-8 w-8 border-4 border-purple-500 border-t-transparent rounded-full"></div>
                  </div>
                ) : (
                  <>
                    <div className={`rounded-xl p-4 border ${connected
                      ? 'bg-green-500/10 border-green-500/30'
                      : 'bg-red-500/10 border-red-500/30'
                      }`}>
                      <div className="flex items-center gap-3 mb-3">
                        <div className={`w-4 h-4 rounded-full ${connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></div>
                        <span className={`text-lg font-bold ${connected ? 'text-green-400' : 'text-red-400'}`}>
                          {connected ? '已连接' : '未连接'}
                        </span>
                      </div>

                      {config && (
                        <div className="grid grid-cols-2 gap-2 text-sm">
                          <div className="bg-black/20 rounded-lg px-3 py-2">
                            <span className="text-gray-400">地址:</span>
                            <span className="text-white ml-2 font-mono">{config.address}</span>
                          </div>
                          <div className="bg-black/20 rounded-lg px-3 py-2">
                            <span className="text-gray-400">集合:</span>
                            <span className="text-white ml-2 font-mono">{config.collectionName}</span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* 操作按钮 */}
                    <div className="flex gap-3 mt-4">
                      {!connected ? (
                        <button
                          onClick={handleConnect}
                          disabled={loading}
                          className="flex-1 px-4 py-2.5 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white font-medium rounded-xl transition-all disabled:opacity-50"
                        >
                          连接 Milvus
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={loadStatus}
                            disabled={loading}
                            className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-all disabled:opacity-50"
                          >
                            刷新
                          </button>
                          <button
                            onClick={handleClear}
                            disabled={loading}
                            className="px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white font-medium rounded-xl transition-all disabled:opacity-50"
                          >
                            清空
                          </button>
                          <button
                            onClick={handleDisconnect}
                            disabled={loading}
                            className="px-4 py-2.5 bg-gray-600 hover:bg-gray-700 text-white font-medium rounded-xl transition-all disabled:opacity-50"
                          >
                            断开
                          </button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* 推荐 Embedding 模型 */}
            <div className="bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10 p-6">
              <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                <span className="text-xl">⭐</span>
                推荐 Embedding 模型
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {RECOMMENDED_EMBEDDING_MODELS.map(model => {
                  const isInstalled = embeddingModels.some(m => m.name === model.name);
                  const isSelected = selectedEmbeddingModel === model.name;

                  return (
                    <div
                      key={model.name}
                      onClick={() => isInstalled && setSelectedEmbeddingModel(model.name)}
                      className={`rounded-xl p-4 border transition-all ${isSelected
                        ? 'bg-orange-500/20 border-orange-500/50 cursor-default'
                        : isInstalled
                          ? 'bg-white/5 border-white/10 hover:border-orange-500/30 cursor-pointer'
                          : 'bg-black/20 border-white/10 opacity-60'
                        }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-white font-bold text-sm">{model.name}</span>
                        {isInstalled ? (
                          <span className="text-xs px-2 py-0.5 bg-green-500/20 text-green-400 rounded-full">已安装</span>
                        ) : (
                          <span className="text-xs px-2 py-0.5 bg-gray-500/20 text-gray-400 rounded-full">未安装</span>
                        )}
                      </div>
                      <div className="text-xs text-gray-400 mb-2">{model.description}</div>
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-purple-400">维度: {model.dimension}</span>
                        <span className="text-cyan-400">{model.size}</span>
                      </div>
                      {!isInstalled && (
                        <div className="mt-3 text-xs text-gray-500 font-mono bg-black/30 rounded-lg px-2 py-1">
                          ollama pull {model.name}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* 导入页 */}
        {activeTab === 'pipeline' && (
          <div className="space-y-6">
            {/* 分块参数 */}
            <div className="bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10 p-6">
              <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                <span className="text-xl">⚙️</span>
                Pipeline 配置
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="bg-black/30 rounded-xl p-4 border border-white/10">
                  <label className="block text-sm text-gray-400 mb-2">块大小 (Chunk Size)</label>
                  <input
                    type="number"
                    value={chunkSize}
                    onChange={(e) => setChunkSize(parseInt(e.target.value) || 500)}
                    min={100}
                    max={2000}
                    className="w-full px-4 py-2 bg-black/30 border border-white/20 rounded-lg text-white focus:border-purple-500 focus:outline-none"
                  />
                  <div className="text-xs text-gray-500 mt-2">每个文档块的最大字符数</div>
                </div>
                <div className="bg-black/30 rounded-xl p-4 border border-white/10">
                  <label className="block text-sm text-gray-400 mb-2">重叠 (Overlap)</label>
                  <input
                    type="number"
                    value={chunkOverlap}
                    onChange={(e) => setChunkOverlap(parseInt(e.target.value) || 20)}
                    min={0}
                    max={500}
                    className="w-full px-4 py-2 bg-black/30 border border-white/20 rounded-lg text-white focus:border-purple-500 focus:outline-none"
                  />
                  <div className="text-xs text-gray-500 mt-2">相邻块之间的重叠字符数</div>
                </div>
                <div className="bg-black/30 rounded-xl p-4 border border-white/10">
                  <label className="block text-sm text-gray-400 mb-2">Embedding 模型</label>
                  <select
                    value={selectedEmbeddingModel}
                    onChange={(e) => setSelectedEmbeddingModel(e.target.value)}
                    className="w-full px-4 py-2 bg-black/30 border border-white/20 rounded-lg text-white focus:border-purple-500 focus:outline-none"
                  >
                    {embeddingModels.length > 0 ? (
                      embeddingModels.map(model => (
                        <option key={model.name} value={model.name}>{model.name}</option>
                      ))
                    ) : (
                      RECOMMENDED_EMBEDDING_MODELS.map(model => (
                        <option key={model.name} value={model.name}>{model.name}</option>
                      ))
                    )}
                  </select>
                  <div className="text-xs text-gray-500 mt-2">用于生成向量的模型</div>
                </div>
              </div>
            </div>

            {/* 导入类型选择 */}
            <div className="bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10 p-6">
              <div className="flex gap-2 mb-6">
                {[
                  { id: 'text', icon: '📄', label: '文本' },
                  { id: 'file', icon: '📁', label: '文件' },
                  { id: 'url', icon: '🌐', label: 'URL' },
                  { id: 'youtube', icon: '📺', label: 'YouTube' },
                ].map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setImportTab(tab.id as any)}
                    className={`px-5 py-2.5 rounded-xl font-medium transition-all flex items-center gap-2 ${importTab === tab.id
                      ? 'bg-purple-600 text-white shadow-lg shadow-purple-500/30'
                      : 'bg-black/30 text-gray-400 hover:bg-black/50 hover:text-white'
                      }`}
                  >
                    <span className="text-lg">{tab.icon}</span>
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* 文本导入 */}
              {importTab === 'text' && (
                <div className="space-y-4">
                  <textarea
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    placeholder="粘贴要导入的文本内容..."
                    rows={12}
                    className="w-full px-4 py-3 bg-black/30 border border-white/20 rounded-xl text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none resize-none font-mono text-sm"
                  />
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-gray-400">
                      字符数: {importText.length.toLocaleString()} | 预计块数: ~{Math.ceil(importText.length / chunkSize)}
                    </div>
                    <button
                      onClick={handleImportText}
                      disabled={importing || !connected || !importText.trim()}
                      className="px-6 py-3 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 text-white font-medium rounded-xl transition-all disabled:opacity-50 flex items-center gap-2"
                    >
                      {importing ? (
                        <>
                          <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full"></div>
                          处理中...
                        </>
                      ) : (
                        <>📥 导入到 Milvus</>
                      )}
                    </button>
                  </div>
                </div>
              )}

              {/* 文件上传 */}
              {importTab === 'file' && (
                <div className="space-y-4">
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className="border-2 border-dashed border-white/20 rounded-xl p-12 text-center cursor-pointer hover:border-purple-500/50 transition-colors bg-black/20"
                  >
                    <div className="text-5xl mb-4">📁</div>
                    <div className="text-white font-medium mb-2">点击或拖拽上传文件</div>
                    <div className="text-sm text-gray-400">支持 .txt, .pdf, .docx 格式</div>
                    <div className="flex justify-center gap-4 mt-4">
                      <span className="px-3 py-1 bg-blue-500/20 text-blue-400 rounded-full text-xs">📄 TXT</span>
                      <span className="px-3 py-1 bg-red-500/20 text-red-400 rounded-full text-xs">📕 PDF</span>
                      <span className="px-3 py-1 bg-purple-500/20 text-purple-400 rounded-full text-xs">📘 DOCX</span>
                    </div>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept=".txt,.pdf,.docx,.doc"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                  {importing && (
                    <div className="flex items-center justify-center gap-3 text-purple-400 py-4">
                      <div className="animate-spin h-5 w-5 border-2 border-purple-500 border-t-transparent rounded-full"></div>
                      正在处理文件...
                    </div>
                  )}
                </div>
              )}

              {/* URL 导入 */}
              {importTab === 'url' && (
                <div className="space-y-4">
                  <div className="flex gap-4">
                    <input
                      type="url"
                      value={importUrl}
                      onChange={(e) => setImportUrl(e.target.value)}
                      placeholder="输入网页 URL (例如: https://example.com/article)"
                      className="flex-1 px-4 py-3 bg-black/30 border border-white/20 rounded-xl text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none"
                    />
                    <button
                      onClick={handleImportUrl}
                      disabled={importing || !connected || !importUrl.trim()}
                      className="px-6 py-3 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 text-white font-medium rounded-xl transition-all disabled:opacity-50 flex items-center gap-2"
                    >
                      {importing ? (
                        <>
                          <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full"></div>
                          处理中...
                        </>
                      ) : (
                        <>🌐 导入网页</>
                      )}
                    </button>
                  </div>
                  <div className="text-sm text-gray-400">
                    系统将自动提取网页正文内容，移除导航、广告等无关元素
                  </div>
                </div>
              )}

              {/* YouTube 导入 */}
              {importTab === 'youtube' && (
                <div className="space-y-4">
                  <div className="flex gap-4">
                    <input
                      type="url"
                      value={importUrl}
                      onChange={(e) => setImportUrl(e.target.value)}
                      placeholder="输入 YouTube 视频 URL (例如: https://www.youtube.com/watch?v=xxx)"
                      className="flex-1 px-4 py-3 bg-black/30 border border-white/20 rounded-xl text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none"
                    />
                    <button
                      onClick={handleImportUrl}
                      disabled={importing || !connected || !importUrl.trim()}
                      className="px-6 py-3 bg-gradient-to-r from-red-600 to-pink-600 hover:from-red-700 hover:to-pink-700 text-white font-medium rounded-xl transition-all disabled:opacity-50 flex items-center gap-2"
                    >
                      {importing ? (
                        <>
                          <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full"></div>
                          处理中...
                        </>
                      ) : (
                        <>📺 导入字幕</>
                      )}
                    </button>
                  </div>
                  <div className="text-sm text-gray-400">
                    支持 youtube.com 和 youtu.be 链接，将自动提取视频字幕或描述
                  </div>
                </div>
              )}

              {!connected && (
                <div className="mt-4 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-xl text-yellow-400 text-sm flex items-center gap-3">
                  <span className="text-xl">⚠️</span>
                  请先连接到 Milvus 服务
                </div>
              )}
            </div>

            {/* 导入结果 */}
            {importResults.length > 0 && (
              <div className="bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10 p-6">
                <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                  <span className="text-xl">📋</span>
                  导入结果
                </h3>
                <div className="space-y-3">
                  {importResults.map((result, index) => (
                    <div
                      key={index}
                      className={`p-4 rounded-xl border ${result.success
                        ? 'bg-green-500/10 border-green-500/30'
                        : 'bg-red-500/10 border-red-500/30'
                        }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className="text-2xl">
                            {result.success ? '✅' : '❌'}
                          </span>
                          <div>
                            <div className="text-white font-medium">
                              {result.filename || result.documentId || '文档'}
                            </div>
                            {result.success ? (
                              <div className="text-sm text-gray-400">
                                成功导入 {result.chunks} 个文档块
                              </div>
                            ) : (
                              <div className="text-sm text-red-400">
                                {result.error}
                              </div>
                            )}
                          </div>
                        </div>
                        {result.metadata?.type && (
                          <span className={`px-3 py-1 rounded-full text-xs font-medium bg-${sourceIcons[result.metadata.type]?.color || 'gray'}-500/20 text-${sourceIcons[result.metadata.type]?.color || 'gray'}-400`}>
                            {sourceIcons[result.metadata.type]?.icon} {sourceIcons[result.metadata.type]?.label}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 搜索页 */}
        {activeTab === 'search' && (
          <div className="space-y-6">
            <div className="bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10 p-6">
              <h2 className="text-xl font-bold text-white mb-6 flex items-center gap-2">
                <span className="text-2xl">🔍</span>
                向量相似度搜索
              </h2>

              <div className="space-y-4">
                {/* 搜索输入 */}
                <div className="flex gap-4">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    placeholder="输入搜索内容..."
                    className="flex-1 px-4 py-3 bg-black/30 border border-white/20 rounded-xl text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none text-lg"
                  />
                  <button
                    onClick={handleSearch}
                    disabled={searching || !connected}
                    className="px-8 py-3 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white font-medium rounded-xl transition-all disabled:opacity-50 flex items-center gap-2"
                  >
                    {searching ? (
                      <>
                        <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full"></div>
                        搜索中...
                      </>
                    ) : (
                      <>🔍 搜索</>
                    )}
                  </button>
                </div>

                {/* 搜索参数 */}
                <div className="flex gap-6 text-sm">
                  <div className="flex items-center gap-3">
                    <label className="text-gray-400">返回数量 (Top K):</label>
                    <input
                      type="number"
                      value={topK}
                      onChange={(e) => setTopK(parseInt(e.target.value) || 5)}
                      min={1}
                      max={100}
                      className="w-20 px-3 py-2 bg-black/30 border border-white/20 rounded-lg text-white focus:border-purple-500 focus:outline-none"
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="text-gray-400">相似度阈值:</label>
                    <input
                      type="number"
                      value={threshold}
                      onChange={(e) => setThreshold(parseFloat(e.target.value) || 0)}
                      min={0}
                      max={1}
                      step={0.1}
                      className="w-20 px-3 py-2 bg-black/30 border border-white/20 rounded-lg text-white focus:border-purple-500 focus:outline-none"
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="text-gray-400">Embedding 模型:</label>
                    <span className="text-orange-400 font-mono">{selectedEmbeddingModel}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* 搜索结果可视化 */}
            {searchResults.length > 0 && (
              <>
                {/* 相似度分布图 */}
                <div className="bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10 p-6">
                  <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                    <span className="text-xl">📊</span>
                    相似度分布
                  </h3>
                  <div className="flex items-end gap-2 h-32">
                    {similarityDistribution?.map((range, index) => {
                      const maxCount = Math.max(...(similarityDistribution?.map(r => r.count) || [1]));
                      const height = range.count > 0 ? (range.count / maxCount) * 100 : 5;

                      return (
                        <div key={index} className="flex-1 flex flex-col items-center gap-2">
                          <div
                            className="w-full rounded-t-lg transition-all duration-500"
                            style={{
                              height: `${height}%`,
                              backgroundColor: range.color,
                              minHeight: '8px'
                            }}
                          ></div>
                          <div className="text-xs text-gray-400 text-center">{range.label}</div>
                          <div className="text-sm font-bold text-white">{range.count}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 搜索结果列表 */}
                <div className="bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10 p-6">
                  <h3 className="text-lg font-bold text-white mb-4">
                    搜索结果 ({searchResults.length})
                  </h3>
                  <div className="space-y-4">
                    {searchResults.map((result, index) => (
                      <div
                        key={result.id}
                        className="bg-black/30 rounded-xl p-5 border border-white/10 hover:border-purple-500/50 transition-all"
                      >
                        <div className="flex items-start justify-between mb-4">
                          <div className="flex items-center gap-3">
                            <span className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shadow-lg ${index === 0 ? 'bg-gradient-to-br from-yellow-400 to-yellow-600 text-black' :
                              index === 1 ? 'bg-gradient-to-br from-gray-300 to-gray-500 text-black' :
                                index === 2 ? 'bg-gradient-to-br from-orange-400 to-orange-600 text-white' :
                                  'bg-gray-700 text-white'
                              }`}>
                              {index + 1}
                            </span>
                            <div>
                              <div className="text-sm text-gray-400">{result.metadata?.source || 'Unknown'}</div>
                              <div className="text-xs text-gray-500 font-mono">ID: {result.id.slice(0, 24)}...</div>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className={`text-2xl font-bold ${result.score >= 0.9 ? 'text-green-400' :
                              result.score >= 0.8 ? 'text-lime-400' :
                                result.score >= 0.7 ? 'text-yellow-400' :
                                  result.score >= 0.6 ? 'text-orange-400' :
                                    'text-red-400'
                              }`}>
                              {formatScore(result.score)}
                            </div>
                            <div className="text-xs text-gray-500">距离: {result.distance.toFixed(6)}</div>
                          </div>
                        </div>

                        {/* 相似度条 */}
                        <div className="mb-4">
                          <div className="h-2 bg-black/30 rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-500"
                              style={{
                                width: `${result.score * 100}%`,
                                background: result.score >= 0.8
                                  ? 'linear-gradient(to right, #22c55e, #84cc16)'
                                  : result.score >= 0.6
                                    ? 'linear-gradient(to right, #eab308, #f97316)'
                                    : 'linear-gradient(to right, #ef4444, #dc2626)'
                              }}
                            ></div>
                          </div>
                        </div>

                        <div className="text-white/90 text-sm leading-relaxed bg-black/20 rounded-lg p-4">
                          {result.content}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* 可视化页 */}
        {activeTab === 'visualize' && (
          <div className="space-y-6">
            {/* 查询输入 */}
            <div className="bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10 p-6">
              <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                <span className="text-2xl">🎨</span>
                向量空间可视化
              </h2>

              <div className="flex gap-4 mb-6">
                <input
                  type="text"
                  value={visualizeQuery}
                  onChange={(e) => setVisualizeQuery(e.target.value)}
                  placeholder="输入查询文本进行可视化分析..."
                  className="flex-1 px-4 py-3 bg-black/30 border border-white/20 rounded-xl text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none"
                  onKeyDown={(e) => e.key === 'Enter' && loadQueryPath()}
                />
                <button
                  onClick={loadQueryPath}
                  disabled={loadingVisualize || !visualizeQuery.trim()}
                  className="px-6 py-3 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium rounded-xl transition-all flex items-center gap-2"
                >
                  {loadingVisualize ? (
                    <span className="animate-spin">⏳</span>
                  ) : (
                    <span>🔍</span>
                  )}
                  分析
                </button>
                <button
                  onClick={loadVectorSpace}
                  disabled={loadingVisualize}
                  className="px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white font-medium rounded-xl transition-all flex items-center gap-2"
                >
                  <span>🌐</span>
                  加载空间
                </button>
              </div>

              {/* 快速查询建议 */}
              <div className="flex flex-wrap gap-2">
                {['人工智能技术', '商业策略分析', '日常生活健康', '科学研究方法', '历史文化艺术'].map(q => (
                  <button
                    key={q}
                    onClick={() => setVisualizeQuery(q)}
                    className="px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm text-gray-400 hover:text-white transition-all"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>

            {/* 查询路径可视化 */}
            {queryPath && (
              <div className="bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10 p-6">
                <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                  <span className="text-xl">🎯</span>
                  查询路径可视化
                  <span className="ml-auto text-sm text-gray-400">
                    耗时: {queryPath.timing.total}ms (嵌入: {queryPath.timing.embedding}ms, 搜索: {queryPath.timing.search}ms)
                  </span>
                </h3>

                {/* 可视化画布 */}
                <div className="relative bg-black/30 rounded-xl border border-white/10 h-[500px] overflow-hidden">
                  <svg className="w-full h-full" viewBox="-5 -5 10 10">
                    {/* 背景网格 */}
                    <defs>
                      <pattern id="grid" width="1" height="1" patternUnits="userSpaceOnUse">
                        <path d="M 1 0 L 0 0 0 1" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="0.02" />
                      </pattern>
                    </defs>
                    <rect x="-5" y="-5" width="10" height="10" fill="url(#grid)" />

                    {/* 连接线 */}
                    {queryPath.edges.map((edge, i) => {
                      const source = queryPath.nodes.find(n => n.id === edge.source);
                      const target = queryPath.nodes.find(n => n.id === edge.target);
                      if (!source || !target) return null;
                      return (
                        <line
                          key={i}
                          x1={source.x}
                          y1={source.y}
                          x2={target.x}
                          y2={target.y}
                          stroke={`rgba(139, 92, 246, ${edge.weight})`}
                          strokeWidth={0.05 + edge.weight * 0.1}
                          strokeDasharray={edge.weight < 0.5 ? "0.1 0.1" : undefined}
                        />
                      );
                    })}

                    {/* 节点 */}
                    {queryPath.nodes.map((node, i) => (
                      <g key={node.id} transform={`translate(${node.x}, ${node.y})`}>
                        {/* 节点圆圈 */}
                        <circle
                          r={node.type === 'query' ? 0.4 : 0.25}
                          fill={node.type === 'query' ? '#8B5CF6' : `rgba(59, 130, 246, ${node.score || 0.5})`}
                          stroke={selectedPoint?.id === node.id ? '#fff' : 'rgba(255,255,255,0.3)'}
                          strokeWidth={selectedPoint?.id === node.id ? 0.06 : 0.02}
                          className="cursor-pointer transition-all hover:stroke-white"
                          onClick={() => setSelectedPoint(node)}
                        />
                        {/* 相似度标签 */}
                        {node.type === 'document' && node.score && (
                          <text
                            y={-0.35}
                            textAnchor="middle"
                            fill="white"
                            fontSize="0.2"
                            className="pointer-events-none"
                          >
                            {(node.score * 100).toFixed(0)}%
                          </text>
                        )}
                        {/* 查询标签 */}
                        {node.type === 'query' && (
                          <text
                            y={-0.55}
                            textAnchor="middle"
                            fill="#8B5CF6"
                            fontSize="0.25"
                            fontWeight="bold"
                            className="pointer-events-none"
                          >
                            Query
                          </text>
                        )}
                      </g>
                    ))}
                  </svg>

                  {/* 图例 */}
                  <div className="absolute top-4 left-4 bg-black/50 backdrop-blur-sm rounded-lg p-3 text-xs text-gray-400">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-3 h-3 rounded-full bg-purple-500"></div>
                      <span>查询向量</span>
                    </div>
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-3 h-3 rounded-full bg-blue-500"></div>
                      <span>文档向量</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-0.5 bg-purple-500/50"></div>
                      <span>相似度连线</span>
                    </div>
                  </div>

                  {/* 选中节点详情 */}
                  {selectedPoint && selectedPoint.type === 'document' && (
                    <div className="absolute bottom-4 right-4 left-4 bg-black/80 backdrop-blur-sm rounded-lg p-4 border border-white/10">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-white font-medium">📄 {selectedPoint.source || '文档'}</span>
                        <span className="text-purple-400 font-bold">{(selectedPoint.score * 100).toFixed(1)}%</span>
                      </div>
                      <p className="text-gray-400 text-sm line-clamp-2">{selectedPoint.label}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 相似度分布图 */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* 相似度分布 */}
              <div className="bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-bold text-white flex items-center gap-2">
                    <span className="text-xl">📊</span>
                    相似度分布
                  </h3>
                  <button
                    onClick={loadSimilarityDistribution}
                    disabled={loadingVisualize || !visualizeQuery.trim()}
                    className="px-4 py-2 bg-purple-600/20 hover:bg-purple-600/30 text-purple-400 text-sm rounded-lg transition-all disabled:opacity-50"
                  >
                    更新分布
                  </button>
                </div>

                {similarityDist ? (
                  <div className="space-y-4">
                    {/* 分布直方图 */}
                    <div className="space-y-2">
                      {Object.entries(similarityDist.distribution).reverse().map(([range, count]) => (
                        <div key={range} className="flex items-center gap-3">
                          <span className="text-xs text-gray-500 w-16">{range}</span>
                          <div className="flex-1 bg-black/30 rounded-full h-6 overflow-hidden">
                            <div
                              className="h-full bg-gradient-to-r from-purple-600 to-blue-500 rounded-full transition-all flex items-center justify-end pr-2"
                              style={{ width: `${Math.max((count / 50) * 100, count > 0 ? 10 : 0)}%` }}
                            >
                              {count > 0 && <span className="text-xs text-white font-medium">{count}</span>}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* 统计信息 */}
                    <div className="grid grid-cols-4 gap-4 pt-4 border-t border-white/10">
                      <div className="text-center">
                        <div className="text-2xl font-bold text-green-400">{(similarityDist.statistics.max * 100).toFixed(1)}%</div>
                        <div className="text-xs text-gray-500">最高</div>
                      </div>
                      <div className="text-center">
                        <div className="text-2xl font-bold text-blue-400">{(similarityDist.statistics.mean * 100).toFixed(1)}%</div>
                        <div className="text-xs text-gray-500">平均</div>
                      </div>
                      <div className="text-center">
                        <div className="text-2xl font-bold text-purple-400">{(similarityDist.statistics.median * 100).toFixed(1)}%</div>
                        <div className="text-xs text-gray-500">中位数</div>
                      </div>
                      <div className="text-center">
                        <div className="text-2xl font-bold text-red-400">{(similarityDist.statistics.min * 100).toFixed(1)}%</div>
                        <div className="text-xs text-gray-500">最低</div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-center text-gray-500 py-12">
                    输入查询并点击"更新分布"查看相似度分布
                  </div>
                )}
              </div>

              {/* 向量空间 */}
              <div className="bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10 p-6">
                <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                  <span className="text-xl">🌐</span>
                  向量空间概览
                </h3>

                {vectorSpace ? (
                  <div className="space-y-4">
                    {/* 2D 散点图 */}
                    <div className="relative bg-black/30 rounded-xl border border-white/10 h-[300px] overflow-hidden">
                      <svg className="w-full h-full" viewBox="-1.5 -1.5 3 3">
                        {/* 背景 */}
                        <rect x="-1.5" y="-1.5" width="3" height="3" fill="rgba(0,0,0,0.3)" />

                        {/* 数据点 */}
                        {vectorSpace.points.map(point => {
                          const cluster = vectorSpace.clusters.find(c => c.id === point.cluster);
                          return (
                            <circle
                              key={point.id}
                              cx={point.x}
                              cy={point.y}
                              r={selectedPoint?.id === point.id ? 0.08 : 0.05}
                              fill={cluster?.color || '#8B5CF6'}
                              opacity={0.7}
                              className="cursor-pointer hover:opacity-100 transition-opacity"
                              onClick={() => setSelectedPoint(point)}
                            />
                          );
                        })}
                      </svg>

                      {/* 聚类图例 */}
                      <div className="absolute top-2 right-2 bg-black/50 backdrop-blur-sm rounded-lg p-2 text-xs">
                        {vectorSpace.clusters.map(cluster => (
                          <div key={cluster.id} className="flex items-center gap-2 mb-1 last:mb-0">
                            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: cluster.color }}></div>
                            <span className="text-gray-400">{cluster.name}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* 点数统计 */}
                    <div className="text-center text-gray-500 text-sm">
                      共 {vectorSpace.points.length} 个数据点，{vectorSpace.clusters.length} 个聚类
                    </div>
                  </div>
                ) : (
                  <div className="text-center text-gray-500 py-12">
                    点击"加载空间"查看向量分布
                  </div>
                )}
              </div>
            </div>

            {/* 相似结果详情 */}
            {similarityDist && similarityDist.results.length > 0 && (
              <div className="bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10 p-6">
                <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                  <span className="text-xl">📋</span>
                  Top 10 相似结果
                </h3>
                <div className="space-y-3">
                  {similarityDist.results.map((result, i) => (
                    <div key={result.id} className="bg-black/20 rounded-xl p-4 border border-white/5">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-white font-medium flex items-center gap-2">
                          <span className="text-purple-400">{['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'][i]}</span>
                          {result.metadata?.source || '文档'}
                        </span>
                        <span className={`font-bold ${result.score >= 0.8 ? 'text-green-400' : result.score >= 0.5 ? 'text-blue-400' : 'text-yellow-400'}`}>
                          {(result.score * 100).toFixed(2)}%
                        </span>
                      </div>
                      <p className="text-gray-400 text-sm line-clamp-2">{result.content}</p>
                      <div className="mt-2 bg-black/30 rounded-full h-2 overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-purple-600 to-blue-500"
                          style={{ width: `${result.score * 100}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 使用说明 */}
            <div className="bg-gradient-to-r from-purple-500/10 to-blue-500/10 rounded-2xl border border-purple-500/20 p-6">
              <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                <span className="text-xl">💡</span>
                可视化功能说明
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="space-y-2">
                  <h4 className="text-purple-400 font-medium">🎯 查询路径可视化</h4>
                  <p className="text-gray-400 text-sm">
                    展示查询向量与检索结果的空间关系。中心是查询，周围是匹配文档，连线粗细表示相似度。
                  </p>
                </div>
                <div className="space-y-2">
                  <h4 className="text-blue-400 font-medium">📊 相似度分布</h4>
                  <p className="text-gray-400 text-sm">
                    统计 Top-K 结果的相似度分布，帮助您设定合适的阈值。查看均值、中位数等关键指标。
                  </p>
                </div>
                <div className="space-y-2">
                  <h4 className="text-green-400 font-medium">🌐 向量空间概览</h4>
                  <p className="text-gray-400 text-sm">
                    将高维向量投影到 2D 空间，观察数据分布。不同颜色代表不同的语义聚类。
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 配置页 */}
        {activeTab === 'config' && (
          <div className="space-y-6">
            <div className="bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10 p-6">
              <h2 className="text-xl font-bold text-white mb-6 flex items-center gap-2">
                <span className="text-2xl">⚙️</span>
                Milvus 连接配置
              </h2>

              <div className="grid grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Milvus 地址</label>
                  <input
                    type="text"
                    value={newAddress}
                    onChange={(e) => setNewAddress(e.target.value)}
                    placeholder="localhost:19530"
                    className="w-full px-4 py-3 bg-black/30 border border-white/20 rounded-xl text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-2">集合名称</label>
                  <input
                    type="text"
                    value={newCollection}
                    onChange={(e) => setNewCollection(e.target.value)}
                    placeholder="rag_documents"
                    className="w-full px-4 py-3 bg-black/30 border border-white/20 rounded-xl text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-2">索引类型</label>
                  <select
                    value={selectedIndexType}
                    onChange={(e) => setSelectedIndexType(e.target.value)}
                    className="w-full px-4 py-3 bg-black/30 border border-white/20 rounded-xl text-white focus:border-purple-500 focus:outline-none"
                  >
                    <option value="FLAT">FLAT (暴力搜索)</option>
                    <option value="IVF_FLAT">IVF_FLAT (推荐)</option>
                    <option value="IVF_SQ8">IVF_SQ8 (量化压缩)</option>
                    <option value="IVF_PQ">IVF_PQ (高压缩)</option>
                    <option value="HNSW">HNSW (高性能)</option>
                    <option value="ANNOY">ANNOY</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-2">度量类型</label>
                  <select
                    value={selectedMetricType}
                    onChange={(e) => setSelectedMetricType(e.target.value)}
                    className="w-full px-4 py-3 bg-black/30 border border-white/20 rounded-xl text-white focus:border-purple-500 focus:outline-none"
                  >
                    <option value="COSINE">COSINE (余弦相似度)</option>
                    <option value="L2">L2 (欧几里得距离)</option>
                    <option value="IP">IP (内积)</option>
                  </select>
                </div>
              </div>

              <div className="mt-6">
                <button
                  onClick={handleConnect}
                  disabled={loading}
                  className="px-8 py-3 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white font-medium rounded-xl transition-all disabled:opacity-50"
                >
                  应用配置并连接
                </button>
              </div>
            </div>

            {/* 索引说明 */}
            <div className="bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10 p-6">
              <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                <span className="text-xl">📖</span>
                索引类型说明
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div className="bg-black/30 rounded-xl p-4 border border-white/10">
                  <div className="text-purple-400 font-bold mb-2 flex items-center gap-2">
                    <span>FLAT</span>
                  </div>
                  <div className="text-gray-400">暴力搜索，100% 准确，适合小数据集 (&lt;10K)</div>
                  <div className="mt-2 flex gap-2">
                    <span className="px-2 py-0.5 bg-green-500/20 text-green-400 rounded text-xs">准确率: 100%</span>
                    <span className="px-2 py-0.5 bg-red-500/20 text-red-400 rounded text-xs">速度: 慢</span>
                  </div>
                </div>
                <div className="bg-black/30 rounded-xl p-4 border border-purple-500/30">
                  <div className="text-purple-400 font-bold mb-2 flex items-center gap-2">
                    <span>IVF_FLAT</span>
                    <span className="text-xs px-2 py-0.5 bg-purple-500/20 text-purple-300 rounded">推荐</span>
                  </div>
                  <div className="text-gray-400">倒排索引，平衡准确性和速度</div>
                  <div className="mt-2 flex gap-2">
                    <span className="px-2 py-0.5 bg-yellow-500/20 text-yellow-400 rounded text-xs">准确率: ~95%</span>
                    <span className="px-2 py-0.5 bg-green-500/20 text-green-400 rounded text-xs">速度: 快</span>
                  </div>
                </div>
                <div className="bg-black/30 rounded-xl p-4 border border-white/10">
                  <div className="text-purple-400 font-bold mb-2">HNSW</div>
                  <div className="text-gray-400">图索引，高性能，适合大数据集</div>
                  <div className="mt-2 flex gap-2">
                    <span className="px-2 py-0.5 bg-yellow-500/20 text-yellow-400 rounded text-xs">准确率: ~95%</span>
                    <span className="px-2 py-0.5 bg-green-500/20 text-green-400 rounded text-xs">速度: 很快</span>
                  </div>
                </div>
                <div className="bg-black/30 rounded-xl p-4 border border-white/10">
                  <div className="text-purple-400 font-bold mb-2">IVF_PQ</div>
                  <div className="text-gray-400">乘积量化，高压缩比，适合内存受限场景</div>
                  <div className="mt-2 flex gap-2">
                    <span className="px-2 py-0.5 bg-orange-500/20 text-orange-400 rounded text-xs">准确率: ~80%</span>
                    <span className="px-2 py-0.5 bg-green-500/20 text-green-400 rounded text-xs">速度: 最快</span>
                  </div>
                </div>
              </div>
            </div>

            {/* 度量类型说明 */}
            <div className="bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10 p-6">
              <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                <span className="text-xl">📏</span>
                度量类型说明
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                <div className="bg-black/30 rounded-xl p-4 border border-green-500/30">
                  <div className="text-green-400 font-bold mb-2 flex items-center gap-2">
                    <span>COSINE</span>
                    <span className="text-xs px-2 py-0.5 bg-green-500/20 text-green-300 rounded">推荐</span>
                  </div>
                  <div className="text-gray-400 mb-2">余弦相似度，计算向量夹角</div>
                  <div className="font-mono text-xs text-gray-500">sim = A·B / (|A||B|)</div>
                  <div className="mt-2 text-xs text-cyan-400">适合: 文本相似度</div>
                </div>
                <div className="bg-black/30 rounded-xl p-4 border border-white/10">
                  <div className="text-blue-400 font-bold mb-2">L2</div>
                  <div className="text-gray-400 mb-2">欧几里得距离，计算空间距离</div>
                  <div className="font-mono text-xs text-gray-500">dist = √Σ(Ai-Bi)²</div>
                  <div className="mt-2 text-xs text-cyan-400">适合: 图像、空间数据</div>
                </div>
                <div className="bg-black/30 rounded-xl p-4 border border-white/10">
                  <div className="text-orange-400 font-bold mb-2">IP</div>
                  <div className="text-gray-400 mb-2">内积，计算向量点乘</div>
                  <div className="font-mono text-xs text-gray-500">ip = A·B = ΣAi×Bi</div>
                  <div className="mt-2 text-xs text-cyan-400">适合: 推荐系统</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

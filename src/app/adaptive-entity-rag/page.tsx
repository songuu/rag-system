'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import CognitiveParsingPanel from '@/components/CognitiveParsingPanel';

// ==================== 类型定义 ====================

type EntityType = 'PERSON' | 'ORGANIZATION' | 'LOCATION' | 'PRODUCT' | 'DATE' | 'EVENT' | 'CONCEPT' | 'OTHER';
type IntentType = 'factual' | 'conceptual' | 'comparison' | 'procedural' | 'exploratory';
type LogicalOperator = 'AND' | 'OR' | 'NOT';

interface ExtractedEntity {
  name: string;
  type: EntityType;
  value: string;
  confidence: number;
  normalizedName?: string;
  isValid?: boolean;
  matchScore?: number;
  suggestions?: string[];
}

interface LogicalRelation {
  operator: LogicalOperator;
  entities: string[];
  description: string;
}

interface WorkflowStep {
  step: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  duration?: number;
  details?: any;
  error?: string;
}

interface QueryAnalysis {
  originalQuery: string;
  intent: IntentType;
  complexity: string;
  confidence: number;
  entities: ExtractedEntity[];
  keywords: string[];
  logicalRelations?: LogicalRelation[];
}

interface RoutingDecision {
  action: string;
  reason: string;
  constraints: any[];
  relaxedConstraints: string[];
  retryCount: number;
}

interface RetrievalResult {
  id: string;
  score: number;
  rerankedScore: number;
  relevanceExplanation: string;
  contentPreview: string;
  matchType: string;
}

interface QueryResponse {
  success: boolean;
  answer: string;
  workflow: {
    steps: WorkflowStep[];
    totalDuration: number;
  };
  queryAnalysis: QueryAnalysis;
  entityValidation: ExtractedEntity[];
  routingDecision: RoutingDecision;
  retrievalDetails: {
    searchResultCount: number;
    rankedResultCount: number;
    topResults: RetrievalResult[];
  };
  duration: number;
}

interface EntityMetadata {
  standardName: string;
  type: EntityType;
  aliases: string[];
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

// ==================== 常量 ====================

const ENTITY_TYPE_COLORS: Record<EntityType, { bg: string; text: string; border: string }> = {
  PERSON: { bg: 'bg-pink-100', text: 'text-pink-700', border: 'border-pink-300' },
  ORGANIZATION: { bg: 'bg-purple-100', text: 'text-purple-700', border: 'border-purple-300' },
  LOCATION: { bg: 'bg-green-100', text: 'text-green-700', border: 'border-green-300' },
  PRODUCT: { bg: 'bg-blue-100', text: 'text-blue-700', border: 'border-blue-300' },
  DATE: { bg: 'bg-yellow-100', text: 'text-yellow-700', border: 'border-yellow-300' },
  EVENT: { bg: 'bg-orange-100', text: 'text-orange-700', border: 'border-orange-300' },
  CONCEPT: { bg: 'bg-cyan-100', text: 'text-cyan-700', border: 'border-cyan-300' },
  OTHER: { bg: 'bg-gray-100', text: 'text-gray-700', border: 'border-gray-300' },
};

const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  PERSON: '👤 人物',
  ORGANIZATION: '🏢 组织',
  LOCATION: '📍 地点',
  PRODUCT: '📦 产品',
  DATE: '📅 日期',
  EVENT: '🎯 事件',
  CONCEPT: '💡 概念',
  OTHER: '📝 其他',
};

const INTENT_LABELS: Record<IntentType, { label: string; icon: string; color: string }> = {
  factual: { label: '事实查询', icon: '🔍', color: 'text-blue-600' },
  conceptual: { label: '概念解释', icon: '📖', color: 'text-purple-600' },
  comparison: { label: '比较分析', icon: '⚖️', color: 'text-orange-600' },
  procedural: { label: '操作指导', icon: '📋', color: 'text-green-600' },
  exploratory: { label: '探索发现', icon: '🔭', color: 'text-cyan-600' },
};

const STEP_STATUS_STYLES: Record<string, { icon: string; color: string }> = {
  pending: { icon: '○', color: 'text-gray-400' },
  running: { icon: '◐', color: 'text-blue-500 animate-pulse' },
  completed: { icon: '●', color: 'text-green-500' },
  failed: { icon: '✗', color: 'text-red-500' },
  skipped: { icon: '◌', color: 'text-gray-300' },
};

// ==================== 主组件 ====================

export default function AdaptiveEntityRAGPage() {
  // 状态
  const [question, setQuestion] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<QueryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // 配置
  const [llmModel, setLlmModel] = useState('qwen2.5:7b');
  const [embeddingModel, setEmbeddingModel] = useState('nomic-embed-text');
  const [maxRetries, setMaxRetries] = useState(3);
  const [enableReranking, setEnableReranking] = useState(true);
  const [topK, setTopK] = useState(5);
  const [similarityThreshold, setSimilarityThreshold] = useState(0.3);
  
  // 模型列表状态
  const [availableModels, setAvailableModels] = useState<AvailableModels | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  
  // 实体库
  const [entities, setEntities] = useState<EntityMetadata[]>([]);
  const [showEntityManager, setShowEntityManager] = useState(false);
  const [newEntity, setNewEntity] = useState({ standardName: '', type: 'OTHER' as EntityType, aliases: '' });
  
  // 知识库管理状态
  const [uploadedFiles, setUploadedFiles] = useState<Array<{ name: string; size: number; modified: string }>>([]);
  const [knowledgeStats, setKnowledgeStats] = useState<{ 
    documentCount: number; 
    connected: boolean; 
    embeddingDimension: number | null;  // 集合的向量维度
  } | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isVectorizing, setIsVectorizing] = useState(false);
  const [vectorizeProgress, setVectorizeProgress] = useState<string | null>(null);
  const [showKnowledgePanel, setShowKnowledgePanel] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [textInput, setTextInput] = useState('');
  const [textFilename, setTextFilename] = useState('');
  
  // 视图模式
  const [activeTab, setActiveTab] = useState<'query' | 'cognitive' | 'workflow' | 'results'>('cognitive');
  
  // 示例问题
  const exampleQuestions = [
    '马斯克创办的公司有哪些？',
    '2024年苹果发布的产品',
    '北京和上海的区别是什么？',
    'ChatGPT 是什么？如何使用？',
    '特斯拉在中国的工厂在哪里？',
  ];

  // 获取可用模型列表
  const loadAvailableModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const response = await fetch('/api/ollama/models');
      const data = await response.json();
      if (data.success) {
        setAvailableModels(data);
        // 如果当前选中的模型不在列表中，选择第一个可用的
        if (data.llmModels?.length > 0 && !data.llmModels.some((m: ModelInfo) => m.name === llmModel)) {
          setLlmModel(data.llmModels[0].name);
        }
        if (data.embeddingModels?.length > 0 && !data.embeddingModels.some((m: ModelInfo) => m.name === embeddingModel)) {
          setEmbeddingModel(data.embeddingModels[0].name);
        }
      }
    } catch (error) {
      console.error('加载模型列表失败:', error);
    } finally {
      setLoadingModels(false);
    }
  }, [llmModel, embeddingModel]);

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

  // 根据集合维度过滤兼容的 embedding 模型
  const getCompatibleEmbeddingModels = useCallback((models: ModelInfo[] | undefined) => {
    if (!models || models.length === 0) return [];
    
    const collectionDim = knowledgeStats?.embeddingDimension;
    
    // 如果集合没有维度信息（集合为空或未创建），返回所有模型
    if (!collectionDim) {
      return models;
    }
    
    // 过滤出与集合维度匹配的模型
    const compatible = models.filter(model => {
      const modelDim = getModelDimension(model.name);
      // 如果无法获取模型维度，也包含在内（用户可能自己清楚）
      return !modelDim || modelDim === collectionDim;
    });
    
    // 如果没有兼容的模型，返回所有模型（让用户知道需要重建知识库）
    return compatible.length > 0 ? compatible : models;
  }, [knowledgeStats?.embeddingDimension]);

  // 检查当前 embedding 模型是否与集合兼容
  const isEmbeddingModelCompatible = useCallback((modelName: string): boolean => {
    const collectionDim = knowledgeStats?.embeddingDimension;
    if (!collectionDim) return true; // 集合为空，任何模型都兼容
    
    const modelDim = getModelDimension(modelName);
    if (!modelDim) return true; // 无法确定模型维度，假设兼容
    
    return modelDim === collectionDim;
  }, [knowledgeStats?.embeddingDimension]);

  // 加载实体库
  const loadEntities = useCallback(async () => {
    try {
      const res = await fetch('/api/adaptive-entity-rag?action=entities');
      const data = await res.json();
      if (data.success) {
        setEntities(data.entities || []);
      }
    } catch (err) {
      console.error('加载实体库失败:', err);
    }
  }, []);

  // 加载知识库状态
  const loadKnowledgeStatus = useCallback(async () => {
    try {
      const [statusRes, filesRes] = await Promise.all([
        fetch('/api/adaptive-entity-rag?action=status'),
        fetch('/api/adaptive-entity-rag?action=files'),
      ]);
      
      const statusData = await statusRes.json();
      const filesData = await filesRes.json();
      
      if (statusData.success) {
        setKnowledgeStats(statusData.knowledgeBase || { 
          documentCount: 0, 
          connected: false, 
          embeddingDimension: null 
        });
      }
      
      if (filesData.success) {
        setUploadedFiles(filesData.files || []);
      }
    } catch (err) {
      console.error('加载知识库状态失败:', err);
    }
  }, []);

  // 上传文本内容
  const handleTextUpload = async () => {
    if (!textInput.trim() || !textFilename.trim()) {
      setError('请输入文本内容和文件名');
      return;
    }
    
    setIsUploading(true);
    try {
      const res = await fetch('/api/adaptive-entity-rag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upload',
          content: textInput.trim(),
          filename: textFilename.trim(),
        }),
      });
      
      const data = await res.json();
      if (data.success) {
        setTextInput('');
        setTextFilename('');
        await loadKnowledgeStatus();
      } else {
        setError(data.error || '上传失败');
      }
    } catch (err) {
      setError('上传失败');
    } finally {
      setIsUploading(false);
    }
  };

  // 上传文件
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    setIsUploading(true);
    try {
      for (const file of Array.from(files)) {
        const content = await file.text();
        const res = await fetch('/api/adaptive-entity-rag', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'upload',
            content,
            filename: file.name,
          }),
        });
        
        const data = await res.json();
        if (!data.success) {
          setError(data.error || `上传 ${file.name} 失败`);
        }
      }
      await loadKnowledgeStatus();
    } catch (err) {
      setError('文件上传失败');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // 向量化文档
  const handleVectorize = async () => {
    if (uploadedFiles.length === 0) {
      setError('没有可向量化的文件，请先上传文档');
      return;
    }
    
    setIsVectorizing(true);
    setVectorizeProgress('正在向量化...');
    try {
      const res = await fetch('/api/adaptive-entity-rag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'vectorize',
          embeddingModel,
          chunkSize: 500,
          chunkOverlap: 50,
        }),
      });
      
      const data = await res.json();
      if (data.success) {
        setVectorizeProgress(`完成: ${data.stats.chunksInserted} 个文本块已入库`);
        await loadKnowledgeStatus();
      } else {
        setError(data.error || '向量化失败');
        setVectorizeProgress(null);
      }
    } catch (err) {
      setError('向量化失败');
      setVectorizeProgress(null);
    } finally {
      setIsVectorizing(false);
    }
  };

  // 删除文件
  const handleDeleteFile = async (filename: string) => {
    try {
      const res = await fetch('/api/adaptive-entity-rag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'delete-file',
          filename,
        }),
      });
      
      const data = await res.json();
      if (data.success) {
        await loadKnowledgeStatus();
      } else {
        setError(data.error || '删除失败');
      }
    } catch (err) {
      setError('删除失败');
    }
  };

  // 清空知识库
  const handleClearCollection = async () => {
    if (!confirm('确定要清空知识库吗？此操作不可恢复。')) return;
    
    try {
      const res = await fetch('/api/adaptive-entity-rag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'clear-collection',
          embeddingModel,
        }),
      });
      
      const data = await res.json();
      if (data.success) {
        setVectorizeProgress(null);
        await loadKnowledgeStatus();
      } else {
        setError(data.error || '清空失败');
      }
    } catch (err) {
      setError('清空失败');
    }
  };

  useEffect(() => {
    loadEntities();
    loadKnowledgeStatus();
  }, [loadEntities, loadKnowledgeStatus]);

  // 提交查询
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim() || isLoading) return;

    setIsLoading(true);
    setError(null);
    setResponse(null);
    setActiveTab('workflow');

    try {
      const res = await fetch('/api/adaptive-entity-rag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'query',
          question: question.trim(),
          topK,
          llmModel,
          embeddingModel,
          maxRetries,
          enableReranking,
          similarityThreshold,
        }),
      });

      const data = await res.json();
      
      if (data.success) {
        setResponse(data);
        setActiveTab('results');
      } else {
        setError(data.error || '查询失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '请求失败');
    } finally {
      setIsLoading(false);
    }
  };

  // 添加实体
  const handleAddEntity = async () => {
    if (!newEntity.standardName.trim()) return;

    try {
      const res = await fetch('/api/adaptive-entity-rag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add-entity',
          standardName: newEntity.standardName.trim(),
          type: newEntity.type,
          aliases: newEntity.aliases.split(',').map(a => a.trim()).filter(a => a),
        }),
      });

      const data = await res.json();
      if (data.success) {
        setNewEntity({ standardName: '', type: 'OTHER', aliases: '' });
        loadEntities();
      }
    } catch (err) {
      console.error('添加实体失败:', err);
    }
  };

  // 删除实体
  const handleRemoveEntity = async (standardName: string) => {
    if (!confirm(`确定要删除实体 "${standardName}" 吗？`)) return;

    try {
      const res = await fetch('/api/adaptive-entity-rag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'remove-entity',
          standardName,
        }),
      });

      const data = await res.json();
      if (data.success) {
        loadEntities();
      }
    } catch (err) {
      console.error('删除实体失败:', err);
    }
  };

  // 重置实体库
  const handleResetEntities = async () => {
    if (!confirm('确定要重置实体库为默认映射吗？所有自定义实体将被删除。')) return;

    try {
      const res = await fetch('/api/adaptive-entity-rag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reset-entities',
        }),
      });

      const data = await res.json();
      if (data.success) {
        loadEntities();
      }
    } catch (err) {
      console.error('重置实体库失败:', err);
    }
  };

  // 渲染实体标签
  const renderEntityTag = (entity: ExtractedEntity, showDetails = false) => {
    const colors = ENTITY_TYPE_COLORS[entity.type] || ENTITY_TYPE_COLORS.OTHER;
    return (
      <span
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm ${colors.bg} ${colors.text} border ${colors.border}`}
      >
        <span className="font-medium">{entity.name}</span>
        {entity.normalizedName && entity.normalizedName !== entity.name && (
          <span className="text-xs opacity-75">→ {entity.normalizedName}</span>
        )}
        {showDetails && (
          <span className="text-xs bg-white/50 px-1.5 rounded-full">
            {(entity.confidence * 100).toFixed(0)}%
          </span>
        )}
      </span>
    );
  };

  // 渲染工作流步骤（增强版，显示详细操作）
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());
  
  const toggleStepExpand = (index: number) => {
    setExpandedSteps(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };
  
  const renderWorkflowSteps = (steps: WorkflowStep[]) => (
    <div className="space-y-2">
      {steps.map((step, index) => {
        const style = STEP_STATUS_STYLES[step.status];
        const isExpanded = expandedSteps.has(index);
        const hasOperations = step.details?.operations && Array.isArray(step.details.operations);
        
        return (
          <div
            key={`step-${index}-${step.step}`}
            className={`rounded-lg transition-all overflow-hidden ${
              step.status === 'running' ? 'bg-blue-50 border border-blue-200' :
              step.status === 'completed' ? 'bg-green-50 border border-green-200' :
              step.status === 'failed' ? 'bg-red-50 border border-red-200' :
              step.status === 'skipped' ? 'bg-gray-100 border border-gray-200' :
              'bg-gray-50 border border-gray-200'
            }`}
          >
            {/* 步骤头部 */}
            <div 
              className={`flex items-start gap-3 p-3 ${hasOperations ? 'cursor-pointer hover:bg-black/5' : ''}`}
              onClick={() => hasOperations && toggleStepExpand(index)}
            >
              <span className={`text-lg ${style.color}`}>{style.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-800">{step.step}</span>
                    {hasOperations && (
                      <span className="text-gray-400 text-sm">
                        {isExpanded ? '▼' : '▶'}
                      </span>
                    )}
                  </div>
                  {step.duration !== undefined && (
                    <span className="text-xs text-gray-500 bg-white/50 px-2 py-0.5 rounded">{step.duration}ms</span>
                  )}
                </div>
                
                {/* 简要统计信息 */}
                {step.details && typeof step.details === 'object' && !isExpanded && (
                  <div className="mt-1 text-xs text-gray-600 flex flex-wrap gap-2">
                    {step.details.entityCount !== undefined && (
                      <span className="bg-white/50 px-2 py-0.5 rounded">实体: {step.details.entityCount}</span>
                    )}
                    {step.details.intent && (
                      <span className="bg-white/50 px-2 py-0.5 rounded">意图: {step.details.intent}</span>
                    )}
                    {step.details.validatedCount !== undefined && (
                      <span className="bg-white/50 px-2 py-0.5 rounded">校验: {step.details.validatedCount}/{step.details.totalCount}</span>
                    )}
                    {step.details.action && (
                      <span className="bg-white/50 px-2 py-0.5 rounded">动作: {step.details.actionName || step.details.action}</span>
                    )}
                    {step.details.resultCount !== undefined && (
                      <span className="bg-white/50 px-2 py-0.5 rounded">结果: {step.details.resultCount}</span>
                    )}
                    {step.details.inputCount !== undefined && step.details.outputCount !== undefined && (
                      <span className="bg-white/50 px-2 py-0.5 rounded">{step.details.inputCount} → {step.details.outputCount}</span>
                    )}
                    {step.details.responseLength !== undefined && (
                      <span className="bg-white/50 px-2 py-0.5 rounded">响应: {step.details.responseLength}字</span>
                    )}
                  </div>
                )}
                
                {step.error && (
                  <div className="mt-1 text-xs text-red-600 bg-red-50 px-2 py-1 rounded">{step.error}</div>
                )}
              </div>
            </div>
            
            {/* 展开的详细操作 */}
            {isExpanded && hasOperations && (
              <div className="border-t border-gray-200 bg-white/50 p-3">
                <div className="text-xs font-medium text-gray-500 mb-2">执行详情</div>
                <div className="space-y-1 font-mono text-xs">
                  {(step.details.operations as string[]).map((op, opIndex) => (
                    <div 
                      key={`op-${index}-${opIndex}`}
                      className={`py-1 px-2 rounded ${
                        op.startsWith('---') ? 'bg-gray-100 text-gray-600 font-medium' :
                        op.startsWith('✓') ? 'text-green-700 bg-green-50' :
                        op.startsWith('✗') ? 'text-red-700 bg-red-50' :
                        op.startsWith('⚠️') ? 'text-amber-700 bg-amber-50' :
                        op.startsWith('[') ? 'text-blue-700 bg-blue-50' :
                        'text-gray-700'
                      }`}
                    >
                      {op}
                    </div>
                  ))}
                </div>
                
                {/* 显示额外的结构化数据 */}
                {step.details.extractedEntities && step.details.extractedEntities.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-gray-200">
                    <div className="text-xs font-medium text-gray-500 mb-2">提取的实体</div>
                    <div className="flex flex-wrap gap-2">
                      {(step.details.extractedEntities as Array<{name: string; type: string; confidence: number}>).map((e, eIndex) => (
                        <span 
                          key={`entity-${index}-${eIndex}`}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs bg-purple-100 text-purple-700"
                        >
                          {e.name}
                          <span className="text-purple-500">({e.type})</span>
                          <span className="bg-purple-200 px-1 rounded">{(e.confidence * 100).toFixed(0)}%</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                
                {step.details.validatedEntities && step.details.validatedEntities.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-gray-200">
                    <div className="text-xs font-medium text-gray-500 mb-2">校验结果</div>
                    <div className="space-y-1">
                      {(step.details.validatedEntities as Array<{original: string; normalized: string; type: string; isValid: boolean; matchScore: number}>).map((e, eIndex) => (
                        <div 
                          key={`validated-${index}-${eIndex}`}
                          className={`flex items-center gap-2 text-xs px-2 py-1 rounded ${e.isValid ? 'bg-green-50' : 'bg-red-50'}`}
                        >
                          <span className={e.isValid ? 'text-green-600' : 'text-red-600'}>
                            {e.isValid ? '✓' : '✗'}
                          </span>
                          <span className="font-medium">{e.original}</span>
                          {e.normalized && e.normalized !== e.original && (
                            <>
                              <span className="text-gray-400">→</span>
                              <span className="text-blue-600">{e.normalized}</span>
                            </>
                          )}
                          <span className="text-gray-400">({e.type})</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                
                {step.details.topResults && step.details.topResults.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-gray-200">
                    <div className="text-xs font-medium text-gray-500 mb-2">检索结果预览</div>
                    <div className="space-y-2">
                      {(step.details.topResults as Array<{id: string; score: number; contentPreview: string; matchType: string}>).map((r, rIndex) => (
                        <div 
                          key={`result-${index}-${rIndex}`}
                          className="text-xs bg-white p-2 rounded border border-gray-200"
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-medium text-gray-700">#{rIndex + 1}</span>
                            <span className="text-blue-600">{(r.score * 100).toFixed(1)}%</span>
                          </div>
                          <div className="text-gray-600 line-clamp-2">{r.contentPreview}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900">
      {/* 导航栏 */}
      <nav className="bg-slate-900/80 backdrop-blur-md border-b border-slate-700/50 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-4">
              <Link href="/" className="flex items-center gap-2 text-white hover:text-blue-400 transition-colors">
                <i className="fas fa-arrow-left"></i>
                <span className="text-sm">返回</span>
              </Link>
              <div className="h-6 w-px bg-slate-700"></div>
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center">
                  <i className="fas fa-route text-white text-sm"></i>
                </div>
                <h1 className="text-lg font-semibold text-white">自适应实体路由 RAG</h1>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">Adaptive Entity-Routing RAG</span>
              <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></div>
            </div>
          </div>
        </div>
      </nav>

      {/* 主内容 */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* 左侧：查询面板 */}
          <div className="lg:col-span-2 space-y-4">
            
            {/* 架构说明卡片 */}
            <div className="bg-gradient-to-r from-slate-800/90 to-indigo-900/90 rounded-xl border border-slate-700/50 p-4 backdrop-blur-sm">
              <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                <i className="fas fa-layer-group text-cyan-400"></i>
                四层架构设计
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {[
                  { name: '认知解析层', icon: '🧠', desc: '实体提取与意图分类', color: 'from-pink-500 to-rose-500' },
                  { name: '策略控制层', icon: '🎯', desc: '校验、路由、约束松弛', color: 'from-purple-500 to-indigo-500' },
                  { name: '执行检索层', icon: '🔍', desc: '结构化/语义/混合检索', color: 'from-blue-500 to-cyan-500' },
                  { name: '数据基础层', icon: '💾', desc: '向量数据库 + 元数据', color: 'from-green-500 to-emerald-500' },
                ].map((layer, i) => (
                  <div
                    key={i}
                    className={`relative overflow-hidden rounded-lg p-3 bg-gradient-to-br ${layer.color} bg-opacity-20`}
                  >
                    <div className="text-2xl mb-1">{layer.icon}</div>
                    <div className="text-xs font-medium text-white">{layer.name}</div>
                    <div className="text-[10px] text-white/70 mt-0.5">{layer.desc}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* 查询输入 */}
            <div className="bg-slate-800/90 rounded-xl border border-slate-700/50 p-4 backdrop-blur-sm">
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    <i className="fas fa-question-circle mr-2 text-cyan-400"></i>
                    输入您的问题
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      placeholder="例如：马斯克创办的公司有哪些？"
                      className="w-full px-4 py-3 bg-slate-900/80 border border-slate-600 rounded-lg text-white placeholder-slate-500 focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                      disabled={isLoading}
                    />
                    {isLoading && (
                      <div className="absolute right-3 top-1/2 -translate-y-1/2">
                        <div className="w-5 h-5 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin"></div>
                      </div>
                    )}
                  </div>
                </div>

                {/* 示例问题 */}
                <div>
                  <div className="text-xs text-slate-400 mb-2">示例问题：</div>
                  <div className="flex flex-wrap gap-2">
                    {exampleQuestions.map((q, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setQuestion(q)}
                        className="px-2.5 py-1 text-xs bg-slate-700/50 hover:bg-slate-600/50 text-slate-300 rounded-full transition-colors"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 配置选项 */}
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    {/* LLM 模型 */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="flex items-center gap-2 text-xs text-slate-400">
                          <i className="fas fa-brain text-purple-400"></i>
                          LLM 模型
                        </label>
                        <button
                          onClick={loadAvailableModels}
                          disabled={loadingModels}
                          className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors disabled:opacity-50"
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
                          className="w-full px-3 py-2 bg-slate-900/80 border border-purple-500/30 rounded-lg text-sm text-white focus:ring-2 focus:ring-purple-500 focus:border-purple-400 appearance-none cursor-pointer transition-all hover:border-purple-400/50 disabled:opacity-50"
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
                              <option value="qwen2.5:7b" className="bg-slate-800">Qwen 2.5 7B</option>
                              <option value="llama3.1" className="bg-slate-800">Llama 3.1</option>
                              <option value="deepseek-r1:7b" className="bg-slate-800">DeepSeek R1 7B</option>
                            </>
                          )}
                        </select>
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                          <i className="fas fa-chevron-down text-purple-400/60 text-xs"></i>
                        </div>
                      </div>
                      {availableModels?.llmModels?.length ? (
                        <div className="text-xs text-slate-500 flex items-center gap-1">
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
                        <label className="flex items-center gap-2 text-xs text-slate-400">
                          <i className="fas fa-vector-square text-blue-400"></i>
                          Embedding 模型
                        </label>
                        <div className="flex items-center gap-2">
                          {knowledgeStats?.embeddingDimension && (
                            <span className="text-xs px-2 py-0.5 bg-emerald-500/20 text-emerald-300 rounded-full" title="知识库向量维度">
                              知识库: {knowledgeStats.embeddingDimension}D
                            </span>
                          )}
                          {getModelDimension(embeddingModel) && (
                            <span className={`text-xs px-2 py-0.5 rounded-full ${
                              isEmbeddingModelCompatible(embeddingModel) 
                                ? 'bg-blue-500/20 text-blue-300' 
                                : 'bg-red-500/20 text-red-300'
                            }`}>
                              {getModelDimension(embeddingModel)}D
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="relative">
                        <select
                          value={embeddingModel}
                          onChange={(e) => setEmbeddingModel(e.target.value)}
                          disabled={loadingModels}
                          className={`w-full px-3 py-2 bg-slate-900/80 border rounded-lg text-sm text-white focus:ring-2 appearance-none cursor-pointer transition-all disabled:opacity-50 ${
                            isEmbeddingModelCompatible(embeddingModel)
                              ? 'border-blue-500/30 focus:ring-blue-500 focus:border-blue-400 hover:border-blue-400/50'
                              : 'border-red-500/50 focus:ring-red-500 focus:border-red-400 hover:border-red-400/50'
                          }`}
                        >
                          {loadingModels ? (
                            <option>加载中...</option>
                          ) : (() => {
                            const compatibleModels = getCompatibleEmbeddingModels(availableModels?.embeddingModels);
                            return compatibleModels.length > 0 ? (
                              compatibleModels.map((model) => {
                                const dim = getModelDimension(model.name);
                                const isCompatible = !knowledgeStats?.embeddingDimension || dim === knowledgeStats.embeddingDimension;
                                return (
                                  <option key={model.name} value={model.name} className="bg-slate-800">
                                    {model.name} {dim ? `(${dim}D)` : ''} - {formatSize(model.size)}
                                    {!isCompatible ? ' ⚠️' : ''}
                                  </option>
                                );
                              })
                            ) : (
                              <>
                                <option value="nomic-embed-text" className="bg-slate-800">Nomic Embed Text (768D)</option>
                                <option value="bge-m3" className="bg-slate-800">BGE-M3 (1024D)</option>
                                <option value="bge-large" className="bg-slate-800">BGE Large (1024D)</option>
                              </>
                            );
                          })()}
                        </select>
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                          <i className="fas fa-chevron-down text-blue-400/60 text-xs"></i>
                        </div>
                      </div>
                      {/* 兼容性提示 */}
                      {!isEmbeddingModelCompatible(embeddingModel) && knowledgeStats?.embeddingDimension ? (
                        <div className="text-xs text-red-400 flex items-center gap-1">
                          <i className="fas fa-exclamation-triangle"></i>
                          维度不匹配！知识库需要 {knowledgeStats.embeddingDimension}D 模型
                        </div>
                      ) : knowledgeStats?.embeddingDimension ? (
                        <div className="text-xs text-emerald-400/70 flex items-center gap-1">
                          <i className="fas fa-check-circle"></i>
                          仅显示与知识库 ({knowledgeStats.embeddingDimension}D) 兼容的模型
                        </div>
                      ) : availableModels?.embeddingModels?.length ? (
                        <div className="text-xs text-slate-500 flex items-center gap-1">
                          <i className="fas fa-info-circle text-blue-400"></i>
                          知识库为空，向量化后将锁定维度
                        </div>
                      ) : !loadingModels && (
                        <div className="text-xs text-yellow-400/60 flex items-center gap-1">
                          <i className="fas fa-exclamation-triangle"></i>
                          使用默认模型列表
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 其他参数 */}
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">最大重试</label>
                      <input
                        type="number"
                        min="0"
                        max="5"
                        value={maxRetries}
                        onChange={(e) => setMaxRetries(parseInt(e.target.value) || 0)}
                        className="w-full px-3 py-2 bg-slate-900/80 border border-slate-600 rounded-lg text-sm text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Top K</label>
                      <input
                        type="number"
                        min="1"
                        max="20"
                        value={topK}
                        onChange={(e) => setTopK(parseInt(e.target.value) || 5)}
                        className="w-full px-3 py-2 bg-slate-900/80 border border-slate-600 rounded-lg text-sm text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">
                        相似度阈值 <span className="text-cyan-400">{similarityThreshold.toFixed(2)}</span>
                      </label>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={similarityThreshold}
                        onChange={(e) => setSimilarityThreshold(parseFloat(e.target.value))}
                        className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                      />
                      <div className="flex justify-between text-[10px] text-slate-500 mt-1">
                        <span>0.0</span>
                        <span>0.5</span>
                        <span>1.0</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={enableReranking}
                      onChange={(e) => setEnableReranking(e.target.checked)}
                      className="w-4 h-4 rounded border-slate-600 text-cyan-500 focus:ring-cyan-500 bg-slate-900"
                    />
                    <span className="text-sm text-slate-300">启用混合重排序</span>
                  </label>
                  <button
                    type="submit"
                    disabled={isLoading || !question.trim()}
                    className="px-6 py-2.5 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                  >
                    {isLoading ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                        处理中...
                      </>
                    ) : (
                      <>
                        <i className="fas fa-search"></i>
                        智能检索
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>

            {/* 结果显示区域 */}
            {(response || isLoading || error) && (
              <div className="bg-slate-800/90 rounded-xl border border-slate-700/50 backdrop-blur-sm overflow-hidden">
                {/* Tab 切换 */}
                <div className="flex border-b border-slate-700/50">
                  {[
                    { id: 'cognitive', label: '认知解析', icon: 'fa-brain' },
                    { id: 'workflow', label: '工作流', icon: 'fa-stream' },
                    { id: 'results', label: '检索结果', icon: 'fa-list-alt' },
                  ].map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id as any)}
                      className={`flex-1 px-4 py-3 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                        activeTab === tab.id
                          ? 'text-cyan-400 bg-slate-700/30 border-b-2 border-cyan-400'
                          : 'text-slate-400 hover:text-white hover:bg-slate-700/20'
                      }`}
                    >
                      <i className={`fas ${tab.icon}`}></i>
                      {tab.label}
                    </button>
                  ))}
                </div>

                <div className="p-4">
                  {error && (
                    <div className="p-4 bg-red-900/30 border border-red-500/50 rounded-lg text-red-300">
                      <i className="fas fa-exclamation-circle mr-2"></i>
                      {error}
                    </div>
                  )}

                  {/* 工作流 Tab */}
                  {activeTab === 'workflow' && response?.workflow && (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-medium text-white">执行流程</h4>
                        <span className="text-xs text-slate-400">
                          总耗时: {response.workflow.totalDuration}ms
                        </span>
                      </div>
                      {renderWorkflowSteps(response.workflow.steps)}

                      {/* 路由决策 */}
                      {response.routingDecision && (
                        <div className="mt-4 p-3 bg-indigo-900/30 rounded-lg border border-indigo-500/30">
                          <h5 className="text-xs font-medium text-indigo-300 mb-2">
                            <i className="fas fa-code-branch mr-1.5"></i>
                            路由决策
                          </h5>
                          <div className="space-y-1 text-sm">
                            <div className="flex items-center gap-2">
                              <span className="text-slate-400">动作:</span>
                              <span className="px-2 py-0.5 bg-indigo-800/50 rounded text-indigo-200">
                                {response.routingDecision.action}
                              </span>
                            </div>
                            <div className="text-slate-300">{response.routingDecision.reason}</div>
                            {response.routingDecision.relaxedConstraints?.length > 0 && (
                              <div className="text-xs text-yellow-400">
                                <i className="fas fa-unlock mr-1"></i>
                                已松弛约束: {response.routingDecision.relaxedConstraints.join(', ')}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* 认知解析 Tab */}
                  {activeTab === 'cognitive' && (
                    <CognitiveParsingPanel
                      queryAnalysis={response?.queryAnalysis || null}
                      validatedEntities={response?.entityValidation}
                      isLoading={isLoading && !response}
                    />
                  )}

                  {/* 检索结果 Tab */}
                  {activeTab === 'results' && response && (
                    <div className="space-y-4">
                      {/* 回答 */}
                      <div className="p-4 bg-gradient-to-br from-cyan-900/30 to-blue-900/30 rounded-lg border border-cyan-500/30">
                        <h5 className="text-xs font-medium text-cyan-300 mb-2">
                          <i className="fas fa-robot mr-1.5"></i>
                          AI 回答
                        </h5>
                        <div className="text-sm text-white whitespace-pre-wrap leading-relaxed">
                          {response.answer}
                        </div>
                      </div>

                      {/* 检索统计 */}
                      <div className="flex items-center gap-4 text-xs text-slate-400">
                        <span>
                          <i className="fas fa-search mr-1"></i>
                          检索: {response.retrievalDetails?.searchResultCount || 0} 个
                        </span>
                        <span>
                          <i className="fas fa-sort-amount-down mr-1"></i>
                          重排后: {response.retrievalDetails?.rankedResultCount || 0} 个
                        </span>
                        <span>
                          <i className="fas fa-clock mr-1"></i>
                          耗时: {response.duration}ms
                        </span>
                      </div>

                      {/* Top 结果 */}
                      {response.retrievalDetails?.topResults?.length > 0 && (
                        <div>
                          <h5 className="text-xs font-medium text-slate-400 mb-2">
                            <i className="fas fa-star mr-1.5"></i>
                            Top 检索结果
                          </h5>
                          <div className="space-y-2">
                            {response.retrievalDetails.topResults.map((result, i) => (
                              <div
                                key={`result-${i}-${result.id || i}`}
                                className="p-3 bg-slate-700/30 rounded-lg border border-slate-600/50"
                              >
                                <div className="flex items-center justify-between mb-2">
                                  <div className="flex items-center gap-2">
                                    <span className="w-5 h-5 rounded bg-cyan-600 text-white text-xs flex items-center justify-center">
                                      {i + 1}
                                    </span>
                                    <span className={`px-1.5 py-0.5 text-xs rounded ${
                                      result.matchType === 'structured' ? 'bg-purple-600' :
                                      result.matchType === 'semantic' ? 'bg-blue-600' :
                                      'bg-green-600'
                                    } text-white`}>
                                      {result.matchType}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-3 text-xs">
                                    <span className="text-slate-400">
                                      原始: {(result.score * 100).toFixed(1)}%
                                    </span>
                                    <span className="text-cyan-400 font-medium">
                                      重排: {(result.rerankedScore * 100).toFixed(1)}%
                                    </span>
                                  </div>
                                </div>
                                <p className="text-sm text-slate-300 line-clamp-3">
                                  {result.contentPreview}
                                </p>
                                {result.relevanceExplanation && (
                                  <p className="mt-2 text-xs text-slate-500 italic">
                                    {result.relevanceExplanation}
                                  </p>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Loading 状态 */}
                  {isLoading && !response && (
                    <div className="flex flex-col items-center justify-center py-12">
                      <div className="relative">
                        <div className="w-16 h-16 border-4 border-slate-700 rounded-full"></div>
                        <div className="absolute inset-0 w-16 h-16 border-4 border-cyan-500 border-t-transparent rounded-full animate-spin"></div>
                      </div>
                      <p className="mt-4 text-slate-400">正在执行自适应实体路由...</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 右侧：知识库 + 实体库面板 */}
          <div className="space-y-4">
            {/* 知识库管理卡片 */}
            <div className="bg-slate-800/90 rounded-xl border border-slate-700/50 p-4 backdrop-blur-sm">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-white flex items-center gap-2">
                  <i className="fas fa-book text-emerald-400"></i>
                  独立知识库
                </h3>
                <button
                  onClick={() => setShowKnowledgePanel(!showKnowledgePanel)}
                  className="text-xs text-slate-400 hover:text-white transition-colors"
                >
                  {showKnowledgePanel ? '收起' : '展开'}
                </button>
              </div>

              {/* 知识库状态 */}
              <div className="mb-3 p-2 bg-slate-900/50 rounded-lg">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">状态:</span>
                  <span className={knowledgeStats?.connected ? 'text-green-400' : 'text-red-400'}>
                    {knowledgeStats?.connected ? '已连接' : '未连接'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs mt-1">
                  <span className="text-slate-400">向量数:</span>
                  <span className="text-cyan-400">{knowledgeStats?.documentCount || 0}</span>
                </div>
                <div className="flex items-center justify-between text-xs mt-1">
                  <span className="text-slate-400">文件数:</span>
                  <span className="text-purple-400">{uploadedFiles.length}</span>
                </div>
              </div>

              {showKnowledgePanel && (
                <div className="space-y-3">
                  {/* 文件上传 */}
                  <div className="p-3 bg-slate-700/30 rounded-lg space-y-2">
                    <div className="text-xs text-slate-400 font-medium">上传文档</div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".txt,.md"
                      multiple
                      onChange={handleFileUpload}
                      className="hidden"
                    />
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isUploading}
                      className="w-full py-2 px-3 bg-slate-600 hover:bg-slate-500 text-white text-xs rounded flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
                    >
                      <i className="fas fa-upload"></i>
                      {isUploading ? '上传中...' : '选择文件'}
                    </button>
                    
                    <div className="text-xs text-slate-500 text-center">或直接输入文本</div>
                    
                    <input
                      type="text"
                      value={textFilename}
                      onChange={(e) => setTextFilename(e.target.value)}
                      placeholder="文件名 (如: document1)"
                      className="w-full px-2 py-1.5 bg-slate-900/80 border border-slate-600 rounded text-xs text-white placeholder-slate-500"
                    />
                    <textarea
                      value={textInput}
                      onChange={(e) => setTextInput(e.target.value)}
                      placeholder="输入文本内容..."
                      rows={3}
                      className="w-full px-2 py-1.5 bg-slate-900/80 border border-slate-600 rounded text-xs text-white placeholder-slate-500 resize-none"
                    />
                    <button
                      onClick={handleTextUpload}
                      disabled={isUploading || !textInput.trim() || !textFilename.trim()}
                      className="w-full py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded transition-colors disabled:opacity-50"
                    >
                      保存文本
                    </button>
                  </div>

                  {/* 已上传文件列表 */}
                  {uploadedFiles.length > 0 && (
                    <div className="p-3 bg-slate-700/30 rounded-lg">
                      <div className="text-xs text-slate-400 font-medium mb-2">已上传文件</div>
                      <div className="space-y-1 max-h-32 overflow-y-auto">
                        {uploadedFiles.map((file, i) => (
                          <div
                            key={`file-${i}-${file.name}`}
                            className="flex items-center justify-between text-xs bg-slate-800/50 rounded px-2 py-1"
                          >
                            <span className="text-slate-300 truncate flex-1" title={file.name}>
                              {file.name.length > 20 ? file.name.substring(0, 20) + '...' : file.name}
                            </span>
                            <button
                              onClick={() => handleDeleteFile(file.name)}
                              className="ml-2 text-red-400 hover:text-red-300"
                              title="删除"
                            >
                              <i className="fas fa-times"></i>
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 向量化操作 */}
                  <div className="flex gap-2">
                    <button
                      onClick={handleVectorize}
                      disabled={isVectorizing || uploadedFiles.length === 0}
                      className="flex-1 py-2 bg-cyan-600 hover:bg-cyan-500 text-white text-xs rounded flex items-center justify-center gap-1 transition-colors disabled:opacity-50"
                    >
                      <i className={`fas ${isVectorizing ? 'fa-spinner fa-spin' : 'fa-vector-square'}`}></i>
                      {isVectorizing ? '向量化中...' : '向量化'}
                    </button>
                    <button
                      onClick={handleClearCollection}
                      disabled={isVectorizing}
                      className="py-2 px-3 bg-red-600/80 hover:bg-red-500 text-white text-xs rounded transition-colors disabled:opacity-50"
                      title="清空知识库"
                    >
                      <i className="fas fa-trash"></i>
                    </button>
                  </div>

                  {/* 向量化进度 */}
                  {vectorizeProgress && (
                    <div className="p-2 bg-emerald-900/30 border border-emerald-600/50 rounded text-xs text-emerald-400">
                      <i className="fas fa-check mr-1"></i>
                      {vectorizeProgress}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 实体库卡片 */}
            <div className="bg-slate-800/90 rounded-xl border border-slate-700/50 p-4 backdrop-blur-sm">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-white flex items-center gap-2">
                  <i className="fas fa-database text-cyan-400"></i>
                  实体元数据库
                </h3>
                <button
                  onClick={() => setShowEntityManager(!showEntityManager)}
                  className="text-xs text-slate-400 hover:text-white transition-colors"
                >
                  {showEntityManager ? '收起' : '管理'}
                </button>
              </div>

              {/* 添加实体表单 */}
              {showEntityManager && (
                <div className="mb-4 p-3 bg-slate-700/30 rounded-lg space-y-2">
                  <input
                    type="text"
                    value={newEntity.standardName}
                    onChange={(e) => setNewEntity({ ...newEntity, standardName: e.target.value })}
                    placeholder="标准名称"
                    className="w-full px-2 py-1.5 bg-slate-900/80 border border-slate-600 rounded text-sm text-white placeholder-slate-500"
                  />
                  <select
                    value={newEntity.type}
                    onChange={(e) => setNewEntity({ ...newEntity, type: e.target.value as EntityType })}
                    className="w-full px-2 py-1.5 bg-slate-900/80 border border-slate-600 rounded text-sm text-white"
                  >
                    {Object.entries(ENTITY_TYPE_LABELS).map(([type, label]) => (
                      <option key={type} value={type}>{label}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={newEntity.aliases}
                    onChange={(e) => setNewEntity({ ...newEntity, aliases: e.target.value })}
                    placeholder="别名（逗号分隔）"
                    className="w-full px-2 py-1.5 bg-slate-900/80 border border-slate-600 rounded text-sm text-white placeholder-slate-500"
                  />
                  <button
                    onClick={handleAddEntity}
                    disabled={!newEntity.standardName.trim()}
                    className="w-full py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white text-sm rounded transition-colors disabled:opacity-50"
                  >
                    添加实体
                  </button>
                </div>
              )}

              {/* 实体列表 */}
              <div className="space-y-2 max-h-[400px] overflow-y-auto">
                {Object.entries(
                  entities.reduce((acc, e) => {
                    const typeKey = String(e.type || 'OTHER');
                    acc[typeKey] = acc[typeKey] || [];
                    acc[typeKey].push(e);
                    return acc;
                  }, {} as Record<string, EntityMetadata[]>)
                ).map(([type, typeEntities]) => (
                  <div key={`type-group-${type}`} className="space-y-1">
                    <div className="text-xs text-slate-400 font-medium">
                      {ENTITY_TYPE_LABELS[type as EntityType] || type} ({typeEntities.length})
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {typeEntities.map((entity, i) => (
                        <span
                          key={`lib-entity-${type}-${i}-${entity.standardName}`}
                          title={`别名: ${entity.aliases?.join(', ') || '无'}\n点击删除`}
                          onClick={() => handleRemoveEntity(entity.standardName)}
                          className={`px-2 py-0.5 text-xs rounded-full cursor-pointer hover:opacity-75 transition-opacity group relative ${
                            ENTITY_TYPE_COLORS[type as EntityType]?.bg || 'bg-gray-100'
                          } ${ENTITY_TYPE_COLORS[type as EntityType]?.text || 'text-gray-700'}`}
                        >
                          {entity.standardName}
                          <span className="hidden group-hover:inline ml-1 text-red-500">×</span>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
                {entities.length === 0 && (
                  <p className="text-sm text-slate-500 text-center py-4">暂无实体数据</p>
                )}
              </div>

              {/* 重置按钮 */}
              {entities.length > 0 && (
                <div className="mt-3 pt-3 border-t border-slate-700">
                  <button
                    onClick={handleResetEntities}
                    className="w-full py-1.5 bg-red-600/20 hover:bg-red-600/40 text-red-400 text-xs rounded transition-colors"
                  >
                    <i className="fas fa-undo mr-1"></i>
                    重置为默认实体库
                  </button>
                </div>
              )}
            </div>

            {/* 功能说明卡片 */}
            <div className="bg-gradient-to-br from-slate-800/90 to-purple-900/50 rounded-xl border border-slate-700/50 p-4 backdrop-blur-sm">
              <h3 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                <i className="fas fa-info-circle text-purple-400"></i>
                核心特性
              </h3>
              <div className="space-y-2 text-xs text-slate-300">
                <div className="flex items-start gap-2">
                  <span className="text-cyan-400">●</span>
                  <div>
                    <span className="font-medium">实体提取与归一化</span>
                    <p className="text-slate-500">自动识别并统一实体称呼（如"老马"→"Elon Musk"）</p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-purple-400">●</span>
                  <div>
                    <span className="font-medium">自适应路由决策</span>
                    <p className="text-slate-500">根据意图自动选择结构化/语义/混合检索</p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-green-400">●</span>
                  <div>
                    <span className="font-medium">约束松弛机制</span>
                    <p className="text-slate-500">检索失败时自动降低过滤条件</p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-yellow-400">●</span>
                  <div>
                    <span className="font-medium">混合重排序</span>
                    <p className="text-slate-500">Cross-Encoder 精细化相关性评估</p>
                  </div>
                </div>
              </div>
            </div>

            {/* 快捷链接 */}
            <div className="bg-slate-800/90 rounded-xl border border-slate-700/50 p-4 backdrop-blur-sm">
              <h3 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                <i className="fas fa-link text-blue-400"></i>
                相关功能
              </h3>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { href: '/entity-extraction', icon: '🕸️', label: 'GraphRAG' },
                  { href: '/agentic-rag', icon: '🤖', label: 'Agentic' },
                  { href: '/self-corrective-rag', icon: '🔄', label: 'Corrective' },
                  { href: '/milvus', icon: '💾', label: 'Milvus' },
                ].map(link => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="flex items-center gap-2 p-2 bg-slate-700/30 hover:bg-slate-700/50 rounded-lg transition-colors"
                  >
                    <span>{link.icon}</span>
                    <span className="text-xs text-slate-300">{link.label}</span>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

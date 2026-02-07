'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { io, Socket } from 'socket.io-client';
import { dbManager, type ConversationMessage } from '@/lib/indexeddb';
import ChatMessage from '@/components/ChatMessage';
import QueryAnalysis from '@/components/QueryAnalysis';
import QuestionSelector from '@/components/QuestionSelector';
import ParameterControls from '@/components/ParameterControls';
import FileUpload from '@/components/FileUpload';
import FileList from '@/components/FileList';
import RealtimeMonitoring from '@/components/RealtimeMonitoring';
import RetrievalDetailsPanel from '@/components/RetrievalDetailsPanel';
import SystemInfo from '@/components/SystemInfo';
import Toast from '@/components/Toast';
import IntentDistillationPanel from '@/components/IntentDistillationPanel';
import MilvusQueryVisualizer from '@/components/MilvusQueryVisualizer';
import AgenticWorkflowPanel from '@/components/AgenticWorkflowPanel';
import LangSmithTraceViewer from '@/components/LangSmithTraceViewer';
import AdaptiveEntityWorkflowPanel from '@/components/AdaptiveEntityWorkflowPanel';
import SuggestedQuestions from '@/components/SuggestedQuestions';
import ConversationExpansionWorkflow from '@/components/ConversationExpansionWorkflow';
import { ModelConfigPanel } from '@/components/ModelConfigPanel';

interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  traceId?: string;
  retrievalDetails?: any;
  queryAnalysis?: any;
}

interface FileInfo {
  name: string;
  size: number;
  modified: string;
}

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'warning' | 'info';
}

/**
 * 安全提取 API 响应中的回答内容为字符串
 * 防止 LangChain 对象被传递给 React 组件
 */
function safeAnswerString(answer: any): string {
  if (typeof answer === 'string') {
    return answer;
  }
  if (answer == null) {
    return '';
  }
  // LangChain AIMessage 对象有 content 属性
  if (typeof answer === 'object' && 'content' in answer) {
    const content = answer.content;
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content.map(item => 
        typeof item === 'string' ? item : (item?.text || '')
      ).join('');
    }
  }
  try {
    return JSON.stringify(answer);
  } catch {
    return String(answer);
  }
}

export default function HomePage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [topK, setTopK] = useState(3);
  const [threshold, setThreshold] = useState(0.0);
  const [llmModel, setLlmModel] = useState('llama3.1');
  const [embeddingModel, setEmbeddingModel] = useState('nomic-embed-text');
  const [modelConfig, setModelConfig] = useState<{
    llm: { provider: string; model: string };
    embedding: { provider: string; model: string; dimension: number };
  } | undefined>(undefined);
  const [queryAnalysis, setQueryAnalysis] = useState<any>(null);
  const [showParams, setShowParams] = useState(true);
  const [showQueryAnalysis, setShowQueryAnalysis] = useState(false);
  const [docCount, setDocCount] = useState(0);
  const [embeddingDim, setEmbeddingDim] = useState(0);
  const [systemStatus, setSystemStatus] = useState('检查中...');
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [vectorizationProgress, setVectorizationProgress] = useState(0);
  const [vectorizationStatus, setVectorizationStatus] = useState('');
  const [showVectorization, setShowVectorization] = useState(false);
  const [queryProcessingStatus, setQueryProcessingStatus] = useState('');
  const [showQueryProcessing, setShowQueryProcessing] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [radarChartData, setRadarChartData] = useState<any>(null);
  const [currentQuery, setCurrentQuery] = useState('');
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [viewingAnalysisFor, setViewingAnalysisFor] = useState<string | null>(null);
  const [retrievalDetails, setRetrievalDetails] = useState<any>(null);
  const [vectorizationDetails, setVectorizationDetails] = useState<any>(null);
  const [showIntentDistillation, setShowIntentDistillation] = useState(false);

  // Milvus 相关状态
  const [storageBackend, setStorageBackend] = useState<'memory' | 'milvus'>('memory');
  const [milvusConnected, setMilvusConnected] = useState(false);
  const [milvusStats, setMilvusStats] = useState<any>(null);

  // Agentic RAG 相关状态
  const [useAgenticRAG, setUseAgenticRAG] = useState(false);
  const [agenticWorkflow, setAgenticWorkflow] = useState<any>(null);
  const [agenticQueryAnalysis, setAgenticQueryAnalysis] = useState<any>(null);
  const [agenticRetrievalQuality, setAgenticRetrievalQuality] = useState<any>(null);
  const [agenticSelfReflection, setAgenticSelfReflection] = useState<any>(null);
  const [agenticHallucinationCheck, setAgenticHallucinationCheck] = useState<any>(null);
  const [agenticRetrievalGrade, setAgenticRetrievalGrade] = useState<any>(null);
  const [agenticDebugInfo, setAgenticDebugInfo] = useState<any>(null);
  const [showAgenticPanel, setShowAgenticPanel] = useState(false);

  // 自适应实体路由 RAG 相关状态
  const [useAdaptiveEntityRAG, setUseAdaptiveEntityRAG] = useState(false);
  const [adaptiveEntityWorkflow, setAdaptiveEntityWorkflow] = useState<any>(null);
  const [adaptiveEntityQueryAnalysis, setAdaptiveEntityQueryAnalysis] = useState<any>(null);
  const [adaptiveEntityValidation, setAdaptiveEntityValidation] = useState<any>(null);
  const [adaptiveEntityRoutingDecision, setAdaptiveEntityRoutingDecision] = useState<any>(null);
  const [adaptiveEntityRetrievalDetails, setAdaptiveEntityRetrievalDetails] = useState<any>(null);
  const [showAdaptiveEntityPanel, setShowAdaptiveEntityPanel] = useState(false);

  // 对话延伸（推荐问题）相关状态
  const [enableSuggestions, setEnableSuggestions] = useState(true);
  const [suggestedQuestions, setSuggestedQuestions] = useState<any[]>([]);
  const [suggestionAnchor, setSuggestionAnchor] = useState<any>(null);
  const [isSuggestionsLoading, setIsSuggestionsLoading] = useState(false);
  const [showSuggestionDetails, setShowSuggestionDetails] = useState(false);
  const [suggestionTimings, setSuggestionTimings] = useState<any>(null);
  const [suggestionProcessingTime, setSuggestionProcessingTime] = useState<number>(0);
  const [lastUserQuery, setLastUserQuery] = useState<string>('');
  const [lastAiResponse, setLastAiResponse] = useState<string>('');
  const [showExpansionWorkflow, setShowExpansionWorkflow] = useState(true);

  const socketRef = useRef<Socket | null>(null);

  // 初始化 WebSocket
  useEffect(() => {
    if (typeof window !== 'undefined') {
      socketRef.current = io();

      socketRef.current.on('connect', () => {
        showToast('实时监控连接成功', 'success');
      });

      socketRef.current.on('disconnect', () => {
        showToast('实时监控连接断开', 'warning');
      });

      socketRef.current.on('vectorization-progress', (progress: any) => {
        setShowVectorization(true);
        setVectorizationDetails(progress);
        if (progress.current && progress.total) {
          setVectorizationProgress((progress.current / progress.total) * 100);
        } else if (progress.progress) {
          setVectorizationProgress(progress.progress);
        }
        setVectorizationStatus(progress.status || progress.message || '处理中...');
      });

      socketRef.current.on('query-vectorization-progress', (progress: any) => {
        setShowQueryProcessing(true);
        setQueryProcessingStatus(progress.status || progress.message || '处理中...');
        if (progress.tokenization) {
          setQueryAnalysis((prev: any) => ({
            ...prev,
            tokenization: progress.tokenization
          }));
        }
        if (progress.embedding) {
          setQueryAnalysis((prev: any) => ({
            ...prev,
            embedding: progress.embedding
          }));
        }
      });

      socketRef.current.on('retrieval-details', (details: any) => {
        setRetrievalDetails(details);
      });

      return () => {
        if (socketRef.current) {
          socketRef.current.disconnect();
        }
      };
    }
  }, []);

  // 检查系统健康状态
  const checkSystemHealth = async () => {
    try {
      const response = await fetch('/api/health');
      const data = await response.json();
      if (data.success) {
        setSystemStatus('运行中');
        setDocCount(data.ragSystem?.documentCount || 0);
        setEmbeddingDim(data.ragSystem?.embeddingDimension || 0);
      } else {
        setSystemStatus('错误');
      }
      
      // 更新实际的模型配置（无论成功与否都更新，因为 API 总是返回配置）
      if (data.modelConfig) {
        setLlmModel(data.modelConfig.llm?.model || 'llama3.1');
        setEmbeddingModel(data.modelConfig.embedding?.model || 'nomic-embed-text');
        // 保存完整的 modelConfig 用于 SystemInfo 组件
        setModelConfig(data.modelConfig);
        // 如果有嵌入维度信息，也更新
        if (data.modelConfig.embedding?.dimension) {
          setEmbeddingDim(data.modelConfig.embedding.dimension);
        }
      }
    } catch (error) {
      setSystemStatus('错误');
    }
  };

  // 检查 Milvus 状态
  const checkMilvusStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/milvus?action=status');
      const data = await response.json();
      if (data.success) {
        setMilvusConnected(data.connected);
        setMilvusStats(data.stats);
      } else {
        setMilvusConnected(false);
      }
    } catch (error) {
      setMilvusConnected(false);
    }
  }, []);

  // 切换存储后端
  const handleStorageBackendChange = async (backend: 'memory' | 'milvus') => {
    if (backend === 'milvus' && !milvusConnected) {
      showToast('Milvus 未连接，请先确保 Milvus 服务正常运行', 'warning');
      return;
    }

    setStorageBackend(backend);
    showToast(`已切换到 ${backend === 'milvus' ? 'Milvus 向量数据库' : '内存存储'}`, 'success');

    if (backend === 'milvus') {
      await checkMilvusStatus();

      // 检查是否需要同步
      try {
        const syncCheckRes = await fetch('/api/milvus/sync');
        const syncCheck = await syncCheckRes.json();

        if (syncCheck.success && syncCheck.needsSync) {
          // Milvus 为空但有可同步的数据
          if (syncCheck.memory?.documentCount > 0) {
            showToast(`检测到 ${syncCheck.memory.documentCount} 个内存文档，可在可视化面板中同步到 Milvus`, 'info');
          } else if (syncCheck.uploads?.count > 0) {
            showToast(`检测到 ${syncCheck.uploads.count} 个上传文件，可在可视化面板中同步到 Milvus`, 'info');
          }
        }
      } catch (e) {
        console.error('Sync check error:', e);
      }
    }
  };

  // 加载文件列表
  const loadFilesList = async () => {
    try {
      const response = await fetch('/api/files');
      const data = await response.json();
      if (data.success) {
        setFiles(data.files || []);
      }
    } catch (error) {
      console.error('加载文件列表失败:', error);
    }
  };

  // 删除文件
  const handleDeleteFile = async (filename: string) => {
    if (!confirm(`确定要删除文件 "${filename}" 吗？`)) return;

    try {
      const response = await fetch(`/api/files/${encodeURIComponent(filename)}`, {
        method: 'DELETE'
      });
      const data = await response.json();
      if (data.success) {
        showToast('文件删除成功', 'success');
        loadFilesList();
        checkSystemHealth();
      } else {
        showToast(data.error || '删除失败', 'error');
      }
    } catch (error) {
      showToast('删除文件时发生错误', 'error');
    }
  };

  // 文件上传
  const handleFileUpload = async () => {
    if (selectedFiles.length === 0) {
      showToast('请先选择文件', 'warning');
      return;
    }

    setIsUploading(true);
    try {
      const formData = new FormData();
      selectedFiles.forEach(file => {
        formData.append('files', file);
      });

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });

      const data = await response.json();
      if (data.success) {
        showToast(`成功上传 ${data.results.length} 个文件`, 'success');
        setSelectedFiles([]);
        loadFilesList();
        checkSystemHealth();

        // 如果当前是 Milvus 后端，自动同步到 Milvus
        if (storageBackend === 'milvus' && milvusConnected) {
          showToast('正在同步到 Milvus...', 'info');
          try {
            const syncResponse = await fetch('/api/milvus/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'sync-from-uploads',
                embeddingModel,
              }),
            });
            const syncData = await syncResponse.json();
            if (syncData.success) {
              showToast(`已同步到 Milvus: ${syncData.totalChunks} 个文档块`, 'success');
              checkMilvusStatus();
            } else {
              showToast(`Milvus 同步失败: ${syncData.error}`, 'warning');
            }
          } catch (syncError) {
            showToast('Milvus 同步失败', 'warning');
          }
        }
      } else {
        showToast(data.error || '上传失败', 'error');
      }
    } catch (error) {
      showToast('上传文件时发生错误', 'error');
    } finally {
      setIsUploading(false);
    }
  };

  // 重新初始化
  const handleReinitialize = async () => {
    if (!confirm('确定要重新初始化系统吗？这将重新加载所有文档。')) return;

    try {
      const response = await fetch('/api/reinitialize', { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        showToast('系统重新初始化成功', 'success');
        checkSystemHealth();
        loadFilesList();
      } else {
        showToast(data.error || '重新初始化失败', 'error');
      }
    } catch (error) {
      showToast('重新初始化时发生错误', 'error');
    }
  };

  // 处理模型切换
  const handleModelChange = async (newLlmModel: string, newEmbeddingModel: string) => {
    const hasChanged = newLlmModel !== llmModel || newEmbeddingModel !== embeddingModel;

    if (!hasChanged) {
      showToast('模型未做任何更改', 'info');
      return;
    }

    try {
      showToast('正在切换模型...', 'info');
      setSystemStatus('重新初始化中...');

      // 更新模型状态
      setLlmModel(newLlmModel);
      setEmbeddingModel(newEmbeddingModel);

      // 调用重新初始化 API（使用新模型）
      const response = await fetch('/api/reinitialize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          llmModel: newLlmModel,
          embeddingModel: newEmbeddingModel
        })
      });

      const data = await response.json();

      if (data.success) {
        showToast(`模型切换成功: ${newLlmModel.split(':')[0]}`, 'success');
        checkSystemHealth();
        loadFilesList();
      } else {
        showToast(data.error || '模型切换失败', 'error');
        setSystemStatus('错误');
      }
    } catch (error) {
      console.error('模型切换错误:', error);
      showToast('模型切换时发生错误', 'error');
      setSystemStatus('错误');
    }
  };

  // Toast 通知
  const showToast = (message: string, type: Toast['type'] = 'info') => {
    const id = Date.now().toString();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  };

  // 高亮匹配文本
  const highlightMatchingText = (content: string, query: string) => {
    if (!query || query.length < 2) return content.substring(0, 200) + '...';
    const keywords = query.toLowerCase().split(/\s+/).filter(word => word.length > 1);
    let highlighted = content;
    keywords.forEach(keyword => {
      const regex = new RegExp(`(${keyword})`, 'gi');
      highlighted = highlighted.replace(regex, '<mark class="bg-yellow-200">$1</mark>');
    });
    return highlighted.length > 200 ? highlighted.substring(0, 200) + '...' : highlighted;
  };

  // 格式化文件大小
  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // 保存消息到 IndexedDB
  const saveMessageToDB = async (message: ConversationMessage) => {
    try {
      console.log('[IndexedDB] 保存消息:', message.id, message.type);
      await dbManager.init();

      if (!currentConversationId) {
        console.log('[IndexedDB] 创建新对话');
        const conversation = await dbManager.createNewConversation(
          message.content.substring(0, 50) + (message.content.length > 50 ? '...' : '')
        );
        setCurrentConversationId(conversation.id);
        console.log('[IndexedDB] 新对话 ID:', conversation.id);
      }

      if (currentConversationId) {
        // 确保时间戳是 Date 对象
        const messageToSave: ConversationMessage = {
          ...message,
          timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp)
        };

        await dbManager.addMessageToConversation(currentConversationId, messageToSave);
        console.log('[IndexedDB] 消息已保存到对话:', currentConversationId);
      }
    } catch (error) {
      console.error('[IndexedDB] 保存消息到数据库失败:', error);
      showToast('保存消息失败: ' + (error instanceof Error ? error.message : String(error)), 'error');
    }
  };

  // 从 IndexedDB 加载最新对话
  const loadLatestConversation = async () => {
    try {
      console.log('[IndexedDB] 开始加载最新对话...');
      await dbManager.init();

      // 先尝试获取所有对话，看看数据库里有什么
      const allConversations = await dbManager.getAllConversations();
      console.log(`[IndexedDB] 数据库中共有 ${allConversations.length} 个对话`);

      if (allConversations.length > 0) {
        allConversations.forEach((conv, index) => {
          console.log(`[IndexedDB] 对话 ${index + 1}: ID=${conv.id}, 消息数=${conv.messages?.length || 0}, 更新时间=${conv.updatedAt}`);
        });
      }

      const latestConv = await dbManager.getLatestConversation();

      if (latestConv) {
        console.log(`[IndexedDB] 找到最新对话: ${latestConv.id}`);
        console.log(`[IndexedDB] 对话消息数: ${latestConv.messages?.length || 0}`);

        if (latestConv.messages && latestConv.messages.length > 0) {
          setCurrentConversationId(latestConv.id);

          // 确保时间戳正确转换
          const restoredMessages: Message[] = latestConv.messages.map((msg, index) => {
            const timestamp = msg.timestamp instanceof Date
              ? msg.timestamp
              : new Date(msg.timestamp);

            console.log(`[IndexedDB] 消息 ${index + 1}: ${msg.type}, ID=${msg.id}, 内容长度=${msg.content?.length || 0}`);

            return {
              id: msg.id,
              type: msg.type,
              content: msg.content,
              timestamp,
              traceId: msg.traceId,
              retrievalDetails: msg.retrievalDetails || null,
              queryAnalysis: msg.queryAnalysis || null
            };
          });

          setMessages(restoredMessages);
          console.log(`[IndexedDB] 已恢复 ${restoredMessages.length} 条消息到界面`);

          // 恢复最后一条助手消息的检索详情
          const lastAssistantMessage = restoredMessages
            .filter(m => m.type === 'assistant' && m.retrievalDetails)
            .pop();
          if (lastAssistantMessage?.retrievalDetails) {
            setRetrievalDetails(lastAssistantMessage.retrievalDetails);
            console.log('[IndexedDB] 已恢复检索详情');
          }

          // 恢复最后一条用户消息的查询分析
          const lastUserMessage = restoredMessages
            .filter(m => m.type === 'user' && m.queryAnalysis)
            .pop();
          if (lastUserMessage?.queryAnalysis) {
            setQueryAnalysis(lastUserMessage.queryAnalysis);
            setShowQueryAnalysis(true);
            if (lastUserMessage.queryAnalysis.embedding?.semanticAnalysis?.vectorFeatures) {
              setRadarChartData(lastUserMessage.queryAnalysis.embedding.semanticAnalysis.vectorFeatures);
            }
            console.log('[IndexedDB] 已恢复查询分析数据');
          }

          showToast(`已恢复 ${restoredMessages.length} 条历史消息`, 'success');
        } else {
          console.warn('[IndexedDB] 对话存在但没有消息');
          setCurrentConversationId(latestConv.id);
          setMessages([]);
        }
      } else {
        console.log('[IndexedDB] 没有找到历史对话');
        setMessages([]);
        setCurrentConversationId(null);
        setQueryAnalysis(null);
        setRadarChartData(null);
        setRetrievalDetails(null);
        setShowQueryAnalysis(false);
        // 清空对话延伸引擎相关状态
        setSuggestedQuestions([]);
        setSuggestionAnchor(null);
        setSuggestionTimings(null);
        setLastUserQuery('');
        setLastAiResponse('');
      }
    } catch (error) {
      console.error('[IndexedDB] 加载历史对话失败:', error);
      console.error('[IndexedDB] 错误详情:', error instanceof Error ? error.stack : String(error));
      showToast('加载历史对话失败: ' + (error instanceof Error ? error.message : String(error)), 'error');
      // 即使失败，也清空状态
      setMessages([]);
      setCurrentConversationId(null);
      // 清空对话延伸引擎相关状态
      setSuggestedQuestions([]);
      setSuggestionAnchor(null);
      setSuggestionTimings(null);
      setLastUserQuery('');
      setLastAiResponse('');
    }
  };

  // 一键删除所有对话
  const handleDeleteAllConversations = async () => {
    if (!confirm('确定要删除所有对话记录吗？此操作不可恢复！')) return;

    try {
      await dbManager.init();
      await dbManager.deleteAllConversations();
      setMessages([]);
      setCurrentConversationId(null);
      setViewingAnalysisFor(null);
      setQueryAnalysis(null);
      setRadarChartData(null);
      setRetrievalDetails(null);
      
      // 清空对话延伸引擎相关状态
      setSuggestedQuestions([]);
      setSuggestionAnchor(null);
      setIsSuggestionsLoading(false);
      setSuggestionTimings(null);
      setSuggestionProcessingTime(0);
      setLastUserQuery('');
      setLastAiResponse('');
      
      showToast('所有对话已删除', 'success');
    } catch (error) {
      console.error('删除所有对话失败:', error);
      showToast('删除失败', 'error');
    }
  };

  // 生成模拟 Token（智能分词）
  const generateMockTokens = (text: string) => {
    const tokens: any[] = [];
    // 使用简单规则分词：中文按字符，英文按单词，数字按连续数字
    const pattern = /[\u4e00-\u9fff]|[a-zA-Z]+|[0-9]+|[.,!?:;()\-？！。，、；：（）]/g;
    let match;
    let tokenId = 1000;
    
    while ((match = pattern.exec(text)) !== null) {
      const token = match[0];
      tokens.push({
        token: token,
        tokenId: tokenId++,
        type: /[\u4e00-\u9fff]/.test(token) ? 'chinese' :
          /[a-zA-Z]/.test(token) ? 'english' :
          /[0-9]/.test(token) ? 'number' :
          /[.,!?:;()\-？！。，、；：（）]/.test(token) ? 'punctuation' : 'special'
      });
    }
    return tokens;
  };
  
  // 生成基于实体和关键词的增强 Token
  const generateEnhancedTokens = (text: string, entities?: any[], keywords?: string[]) => {
    const MAX_TOKENS = 100; // 限制最大 Token 数量
    const tokens: any[] = [];
    let tokenId = 1000;
    
    // 安全检查：限制输入长度
    const safeText = (text || '').slice(0, 500);
    if (!safeText) return tokens;
    
    // 收集实体和关键词，过滤无效值
    const specialTerms = new Set<string>();
    if (entities && Array.isArray(entities)) {
      entities.forEach(e => {
        if (e?.name && typeof e.name === 'string' && e.name.trim()) {
          specialTerms.add(e.name.trim());
        }
      });
    }
    if (keywords && Array.isArray(keywords)) {
      keywords.forEach(k => {
        if (k && typeof k === 'string' && k.trim()) {
          specialTerms.add(k.trim());
        }
      });
    }
    
    // 排序，长的优先匹配，过滤空字符串
    const sortedTerms = Array.from(specialTerms)
      .filter(t => t.length > 0)
      .sort((a, b) => b.length - a.length);
    
    let remaining = safeText;
    let iterations = 0;
    const MAX_ITERATIONS = 1000; // 防止无限循环
    
    while (remaining.length > 0 && tokens.length < MAX_TOKENS && iterations < MAX_ITERATIONS) {
      iterations++;
      let matched = false;
      
      // 尝试匹配特殊词
      for (const term of sortedTerms) {
        if (term && remaining.startsWith(term)) {
          const entity = entities?.find(e => e?.name === term);
          tokens.push({
            token: term,
            tokenId: tokenId++,
            type: entity ? 'entity' : 'keyword',
            entityType: entity?.type,
            confidence: entity?.confidence,
          });
          remaining = remaining.slice(term.length);
          matched = true;
          break;
        }
      }
      
      if (!matched) {
        const char = remaining[0];
        // 空白字符跳过
        if (/\s/.test(char)) {
          remaining = remaining.slice(1);
          continue;
        }
        
        const type = /[\u4e00-\u9fff]/.test(char) ? 'chinese' :
          /[a-zA-Z]/.test(char) ? 'english' :
          /[0-9]/.test(char) ? 'number' :
          /[.,!?:;()\-？！。，、；：（）]/.test(char) ? 'punctuation' : 'special';
        
        tokens.push({
          token: char,
          tokenId: tokenId++,
          type: type,
        });
        remaining = remaining.slice(1);
      }
    }
    
    return tokens;
  };

  // 生成推荐问题（异步调用，不阻塞主流程）
  const generateSuggestedQuestions = async (
    userQuery: string,
    aiResponse: string,
    contextChunks: any[]
  ) => {
    setIsSuggestionsLoading(true);
    setSuggestedQuestions([]);
    setSuggestionAnchor(null);
    setLastUserQuery(userQuery);
    setLastAiResponse(aiResponse);
    setSuggestionProcessingTime(0);

    try {
      const response = await fetch('/api/conversation-expansion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'expand',
          userQuery,
          aiResponse,
          contextChunks: contextChunks.map(chunk => ({
            id: chunk.id || chunk.document?.id,
            content: chunk.content || chunk.document?.pageContent || chunk.document?.content,
            metadata: chunk.metadata || chunk.document?.metadata,
            score: chunk.score,
          })),
          llmModel,
          maxSuggestions: 5,
          enableValidation: true,
        }),
      });

      const data = await response.json();
      
      if (data.success) {
        setSuggestedQuestions(data.suggestions || []);
        setSuggestionAnchor(data.anchor);
        setSuggestionTimings(data.timings);
        setSuggestionProcessingTime(data.processingTime || 0);
        console.log('[Suggestions] Generated:', data.suggestions?.length, 'questions');
      } else {
        console.error('[Suggestions] Error:', data.error);
      }
    } catch (error) {
      console.error('[Suggestions] Failed:', error);
    } finally {
      setIsSuggestionsLoading(false);
    }
  };

  // 处理推荐问题点击
  const handleSuggestionClick = (question: string) => {
    setInput(question);
  };

  // 提交问题
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessageId = Date.now().toString();
    const userMessage: Message = {
      id: userMessageId,
      type: 'user',
      content: input.trim(),
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setCurrentQuery(input.trim());
    setIsLoading(true);
    setShowQueryAnalysis(false);
    setShowQueryProcessing(true);

    await saveMessageToDB({
      id: userMessageId,
      type: 'user',
      content: input.trim(),
      timestamp: new Date()
    });

    try {
      // 清空之前的 Agentic RAG 状态
      if (useAgenticRAG) {
        setAgenticWorkflow(null);
        setAgenticQueryAnalysis(null);
        setAgenticRetrievalQuality(null);
        setAgenticSelfReflection(null);
        setAgenticHallucinationCheck(null);
        setAgenticRetrievalGrade(null);
        setAgenticDebugInfo(null);
        setShowAgenticPanel(true);
      }

      // 清空之前的自适应实体 RAG 状态
      if (useAdaptiveEntityRAG) {
        setAdaptiveEntityWorkflow(null);
        setAdaptiveEntityQueryAnalysis(null);
        setAdaptiveEntityValidation(null);
        setAdaptiveEntityRoutingDecision(null);
        setAdaptiveEntityRetrievalDetails(null);
        setShowAdaptiveEntityPanel(true);
      }

      const response = await fetch('/api/ask', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          question: input.trim(),
          topK,
          similarityThreshold: threshold,
          llmModel,
          embeddingModel,
          userId: 'demo-user',
          sessionId: 'demo-session',
          storageBackend,
          useAgenticRAG: useAgenticRAG && storageBackend === 'milvus' && !useAdaptiveEntityRAG, // 只有 Milvus 后端支持 Agentic RAG
          useAdaptiveEntityRAG: useAdaptiveEntityRAG && storageBackend === 'milvus', // 只有 Milvus 后端支持自适应实体 RAG
          maxRetries: 2,
          enableReranking: true,
        }),
      });

      const data = await response.json();

      console.log('data', data);

      // 处理自适应实体 RAG 响应
      if (data.adaptiveEntityMode) {
        setAdaptiveEntityWorkflow(data.workflow);
        setAdaptiveEntityQueryAnalysis(data.queryAnalysis);
        setAdaptiveEntityValidation(data.entityValidation);
        setAdaptiveEntityRoutingDecision(data.routingDecision);
        setAdaptiveEntityRetrievalDetails(data.retrievalDetails);
      }

      // 处理 Agentic RAG 响应
      if (data.agenticMode) {
        setAgenticWorkflow(data.workflow);
        setAgenticQueryAnalysis(data.queryAnalysis);
        setAgenticRetrievalQuality(data.retrievalDetails?.quality);
        setAgenticSelfReflection(data.retrievalDetails?.selfReflection);
        setAgenticHallucinationCheck(data.hallucinationCheck);
        setAgenticRetrievalGrade(data.retrievalGrade);
        setAgenticDebugInfo(data.debugInfo);
      }

      if (data.success) {
        let queryAnalysisData: any;
        // 重要：始终使用用户原始输入，防止 LLM 返回错误的 originalQuery
        const userOriginalInput = input.trim();
        
        // 处理自适应实体 RAG 模式的查询分析数据
        if (data.adaptiveEntityMode && data.queryAnalysis) {
          const adaptiveAnalysis = data.queryAnalysis;
          // 使用增强的 Token 生成，突出显示实体和关键词
          const enhancedTokens = generateEnhancedTokens(
            userOriginalInput, 
            adaptiveAnalysis.entities, 
            adaptiveAnalysis.keywords
          );
          queryAnalysisData = {
            tokenization: {
              tokenCount: enhancedTokens.length,
              tokens: enhancedTokens,
              processingTime: data.workflow?.steps?.find((s: any) => s.step?.includes('认知解析'))?.duration || 0,
              originalText: userOriginalInput
            },
            embedding: {
              embeddingDimension: 768,
              semanticAnalysis: {
                context: adaptiveAnalysis.intent === 'factual' ? '事实查询语境' :
                         adaptiveAnalysis.intent === 'exploratory' ? '探索性语境' :
                         adaptiveAnalysis.intent === 'comparison' ? '比较分析语境' :
                         adaptiveAnalysis.intent === 'conceptual' ? '概念理解语境' :
                         adaptiveAnalysis.intent === 'procedural' ? '操作指导语境' : '通用语境',
                semanticCategory: adaptiveAnalysis.intent || '一般',
                confidence: adaptiveAnalysis.confidence || 0.8,
                nearestConcepts: adaptiveAnalysis.keywords || [],
                vectorFeatures: {
                  techScore: adaptiveAnalysis.intent === 'factual' ? 0.7 : 0.4,
                  businessScore: 0.3,
                  dailyScore: adaptiveAnalysis.complexity === 'simple' ? 0.6 : 0.3,
                  emotionScore: 0.1,
                  vectorMagnitude: 1.2
                }
              }
            },
            // 保留原始自适应实体分析数据
            adaptiveEntityAnalysis: {
              originalQuery: adaptiveAnalysis.originalQuery,
              intent: adaptiveAnalysis.intent,
              complexity: adaptiveAnalysis.complexity,
              confidence: adaptiveAnalysis.confidence,
              entities: adaptiveAnalysis.entities,
              keywords: adaptiveAnalysis.keywords,
              logicalRelations: adaptiveAnalysis.logicalRelations
            }
          };
          setRadarChartData({
            techScore: adaptiveAnalysis.intent === 'factual' ? 0.7 : 0.4,
            businessScore: 0.3,
            dailyScore: adaptiveAnalysis.complexity === 'simple' ? 0.6 : 0.3,
            emotionScore: 0.1,
            vectorMagnitude: 1.2
          });
        }
        // 处理 Agentic RAG 模式的查询分析数据
        else if (data.agenticMode && data.queryAnalysis) {
          // 将 Agentic RAG 的查询分析转换为标准格式
          const agenticAnalysis = data.queryAnalysis;
          queryAnalysisData = {
            tokenization: {
              tokenCount: agenticAnalysis.keywords?.length || Math.floor(userOriginalInput.length / 2),
              tokens: agenticAnalysis.keywords?.map((kw: string, i: number) => ({
                token: kw,
                tokenId: 1000 + i,
                type: /[\u4e00-\u9fff]/.test(kw) ? 'chinese' : 'english'
              })) || generateMockTokens(userOriginalInput),
              processingTime: data.workflow?.steps?.find((s: any) => s.step === '查询分析与优化')?.duration || 0,
              // 始终使用用户原始输入，不信任 API 返回的 originalQuery（可能被 LLM 错误修改）
              originalText: userOriginalInput
            },
            embedding: {
              embeddingDimension: data.retrievalDetails?.searchResults?.[0]?.document?.metadata?.dimension || 768,
              semanticAnalysis: {
                context: agenticAnalysis.intent === 'factual' ? '事实查询语境' :
                         agenticAnalysis.intent === 'exploratory' ? '探索性语境' :
                         agenticAnalysis.intent === 'comparison' ? '比较分析语境' :
                         agenticAnalysis.intent === 'procedural' ? '操作指导语境' : '通用语境',
                semanticCategory: agenticAnalysis.intent || '一般',
                confidence: agenticAnalysis.confidence || 0.8,
                nearestConcepts: agenticAnalysis.keywords || [],
                vectorFeatures: {
                  techScore: agenticAnalysis.intent === 'factual' ? 0.7 : 0.4,
                  businessScore: 0.3,
                  dailyScore: agenticAnalysis.complexity === 'simple' ? 0.6 : 0.3,
                  emotionScore: 0.1,
                  vectorMagnitude: 1.2
                }
              }
            },
            // 保留原始 Agentic 分析数据
            agenticAnalysis: {
              originalQuery: agenticAnalysis.originalQuery,
              rewrittenQuery: agenticAnalysis.rewrittenQuery,
              intent: agenticAnalysis.intent,
              complexity: agenticAnalysis.complexity,
              needsRetrieval: agenticAnalysis.needsRetrieval,
              keywords: agenticAnalysis.keywords
            }
          };
          setRadarChartData({
            techScore: agenticAnalysis.intent === 'factual' ? 0.7 : 0.4,
            businessScore: 0.3,
            dailyScore: agenticAnalysis.complexity === 'simple' ? 0.6 : 0.3,
            emotionScore: 0.1,
            vectorMagnitude: 1.2
          });
        } else if (data.queryAnalysis) {
          // 普通模式的查询分析
          queryAnalysisData = data.queryAnalysis;
          if (data.queryAnalysis.embedding?.semanticAnalysis?.vectorFeatures) {
            setRadarChartData(data.queryAnalysis.embedding.semanticAnalysis.vectorFeatures);
          }
        } else {
          // 默认数据
          queryAnalysisData = {
            tokenization: {
              tokenCount: Math.floor(input.trim().length / 2),
              tokens: generateMockTokens(input.trim()),
              processingTime: 15,
              originalText: input.trim()
            },
            embedding: {
              embeddingDimension: 768,
              semanticAnalysis: {
                context: input.includes('智能') ? '人工智能语境' : '通用语境',
                semanticCategory: input.includes('智能') ? 'AI技术' : '一般',
                confidence: 0.85,
                nearestConcepts: input.includes('智能')
                  ? ['人工智能', '机器学习', '深度学习']
                  : ['文本', '信息', '内容'],
                vectorFeatures: {
                  techScore: 0.7,
                  businessScore: 0.3,
                  dailyScore: 0.2,
                  emotionScore: 0.1,
                  vectorMagnitude: 1.2
                }
              }
            }
          };
          setRadarChartData({
            techScore: 0.7,
            businessScore: 0.3,
            dailyScore: 0.2,
            emotionScore: 0.1,
            vectorMagnitude: 1.2
          });
        }

        setMessages(prev => prev.map(msg =>
          msg.id === userMessageId
            ? { ...msg, queryAnalysis: queryAnalysisData }
            : msg
        ));

        if (currentConversationId) {
          try {
            await dbManager.init();
            const conversation = await dbManager.getConversation(currentConversationId);
            if (conversation) {
              const userMsgIndex = conversation.messages.findIndex(m => m.id === userMessageId);
              if (userMsgIndex !== -1) {
                conversation.messages[userMsgIndex].queryAnalysis = queryAnalysisData;
                conversation.updatedAt = new Date();
                await dbManager.saveConversation(conversation);
              }
            }
          } catch (error) {
            console.error('更新用户消息分析数据失败:', error);
          }
        }

        // 安全提取回答内容，防止 LangChain 对象被传递给 React
        const answerContent = safeAnswerString(data.answer);
        
        const assistantMessage: Message = {
          id: (Date.now() + 1).toString(),
          type: 'assistant',
          content: answerContent,
          timestamp: new Date(),
          traceId: data.traceId,
          retrievalDetails: data.retrievalDetails
        };

        setMessages(prev => [...prev, assistantMessage]);
        setShowQueryAnalysis(true);
        setQueryAnalysis(queryAnalysisData);

        if (data.retrievalDetails) {
          setRetrievalDetails(data.retrievalDetails);
        }

        await saveMessageToDB({
          id: assistantMessage.id,
          type: 'assistant',
          content: answerContent,
          timestamp: new Date(),
          traceId: data.traceId,
          retrievalDetails: data.retrievalDetails
        });

        // 异步生成推荐问题（不阻塞主流程）
        if (enableSuggestions && data.retrievalDetails?.searchResults?.length > 0) {
          generateSuggestedQuestions(
            input.trim(),
            answerContent,
            data.retrievalDetails.searchResults
          );
        }
      } else {
        throw new Error(data.error || '请求失败');
      }
    } catch (error) {
      console.error('Error:', error);
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        type: 'assistant',
        content: `抱歉，处理您的问题时出现了错误：${error instanceof Error ? error.message : '未知错误'}`,
        timestamp: new Date()
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
      setInput('');
      setShowQueryProcessing(false);
    }
  };

  // 初始化时加载数据
  useEffect(() => {
    checkSystemHealth();
    loadFilesList();
    loadLatestConversation();
    checkMilvusStatus();
  }, [checkMilvusStatus]);

  // 雷达图配置
  const getRadarChartOption = () => {
    if (!radarChartData) return null;

    return {
      title: {
        text: '向量特征分析',
        left: 'center',
        textStyle: { fontSize: 12, color: '#374151' }
      },
      tooltip: { trigger: 'item' },
      radar: {
        indicator: [
          { name: '技术特征', max: 1 },
          { name: '商业特征', max: 1 },
          { name: '日常特征', max: 1 },
          { name: '情感倾向', max: 1, min: -1 },
          { name: '向量强度', max: Math.max(1, radarChartData.vectorMagnitude || 1) }
        ],
        radius: '60%',
        axisName: { fontSize: 10, color: '#6B7280' },
        splitLine: { lineStyle: { color: '#E5E7EB' } },
        axisLine: { lineStyle: { color: '#D1D5DB' } }
      },
      series: [{
        name: '向量特征',
        type: 'radar',
        data: [{
          value: [
            radarChartData.techScore || 0,
            radarChartData.businessScore || 0,
            radarChartData.dailyScore || 0,
            radarChartData.emotionScore || 0,
            (radarChartData.vectorMagnitude || 0) / Math.max(1, radarChartData.vectorMagnitude || 1)
          ],
          name: '当前查询',
          itemStyle: { color: '#3B82F6' },
          areaStyle: { color: 'rgba(59, 130, 246, 0.2)' }
        }]
      }]
    };
  };

  // 获取当前查看的分析数据
  const getCurrentAnalysis = () => {
    if (viewingAnalysisFor) {
      const message = messages.find(m => m.id === viewingAnalysisFor);
      return message?.queryAnalysis;
    }
    return queryAnalysis;
  };

  return (
    <div className="bg-gray-50 min-h-screen">
      {/* 导航栏 - 简洁设计 */}
      <nav className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-14">
            {/* 左侧: Logo + 存储切换 */}
            <div className="flex items-center gap-6">
              <div className="flex items-center">
                <i className="fas fa-brain text-blue-600 text-xl mr-2"></i>
                <h1 className="text-lg font-semibold text-gray-900">RAG 知识库</h1>
              </div>

              {/* 存储后端切换 - 更紧凑 */}
              <div className="flex items-center bg-gray-100 rounded-lg p-0.5">
                <button
                  onClick={() => handleStorageBackendChange('memory')}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${storageBackend === 'memory'
                    ? 'bg-white text-blue-600 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                    }`}
                >
                  内存
                </button>
                <button
                  onClick={() => handleStorageBackendChange('milvus')}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-all flex items-center gap-1 ${storageBackend === 'milvus'
                    ? 'bg-white text-purple-600 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                    }`}
                >
                  Milvus
                  <span className={`w-1.5 h-1.5 rounded-full ${milvusConnected ? 'bg-green-400' : 'bg-red-400'}`}></span>
                </button>
              </div>

              {/* RAG 模式开关 - 仅在 Milvus 模式下显示 */}
              {storageBackend === 'milvus' && (
                <div className="flex items-center gap-2">
                  {/* Agentic RAG 开关 */}
                  <button
                    onClick={() => {
                      setUseAgenticRAG(!useAgenticRAG);
                      if (!useAgenticRAG) {
                        setShowAgenticPanel(true);
                        setUseAdaptiveEntityRAG(false); // 互斥
                      }
                    }}
                    className={`px-3 py-1 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${
                      useAgenticRAG
                        ? 'bg-gradient-to-r from-purple-500 to-blue-500 text-white shadow-sm'
                        : 'bg-gray-100 text-gray-500 hover:text-gray-700'
                    }`}
                    title="启用 Agentic RAG 代理化工作流"
                  >
                    <i className="fas fa-robot"></i>
                    Agent
                    {useAgenticRAG && <i className="fas fa-check text-xs"></i>}
                  </button>

                  {/* 自适应实体路由 RAG 开关 */}
                  <button
                    onClick={() => {
                      setUseAdaptiveEntityRAG(!useAdaptiveEntityRAG);
                      if (!useAdaptiveEntityRAG) {
                        setShowAdaptiveEntityPanel(true);
                        setUseAgenticRAG(false); // 互斥
                      }
                    }}
                    className={`px-3 py-1 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${
                      useAdaptiveEntityRAG
                        ? 'bg-gradient-to-r from-cyan-500 to-blue-600 text-white shadow-sm'
                        : 'bg-gray-100 text-gray-500 hover:text-gray-700'
                    }`}
                    title="启用自适应实体路由 RAG"
                  >
                    <i className="fas fa-route"></i>
                    Entity
                    {useAdaptiveEntityRAG && <i className="fas fa-check text-xs"></i>}
                  </button>
                </div>
              )}
            </div>

            {/* 中间: 导航链接 - 图标为主 */}
            <div className="flex items-center gap-1">
              <Link href="/blog" className="p-2 text-orange-500 hover:text-orange-700 hover:bg-orange-50 rounded-lg transition-colors font-medium text-xs flex items-center gap-1" title="技术博客">
                <i className="fas fa-book-open"></i>
                <span className="hidden sm:inline">博客</span>
              </Link>
              <div className="w-px h-6 bg-gray-200 mx-1"></div>
              <Link href="/history" className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors" title="历史对话">
                <i className="fas fa-history"></i>
              </Link>
              <Link href="/observability" className="p-2 text-blue-500 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors" title="可观测性">
                <i className="fas fa-chart-line"></i>
              </Link>
              <Link href="/trace-trie" className="p-2 text-purple-500 hover:text-purple-700 hover:bg-purple-50 rounded-lg transition-colors" title="Trace-Trie">
                <i className="fas fa-sitemap"></i>
              </Link>
              <Link href="/domain-vectors" className="p-2 text-emerald-500 hover:text-emerald-700 hover:bg-emerald-50 rounded-lg transition-colors" title="领域向量">
                <i className="fas fa-crosshairs"></i>
              </Link>
              <Link href="/self-rag" className="p-2 text-indigo-500 hover:text-indigo-700 hover:bg-indigo-50 rounded-lg transition-colors" title="Self-RAG">
                <i className="fas fa-sync-alt"></i>
              </Link>
              <Link href="/agentic-rag" className="p-2 text-fuchsia-500 hover:text-fuchsia-700 hover:bg-fuchsia-50 rounded-lg transition-colors" title="Agentic RAG">
                <i className="fas fa-robot"></i>
              </Link>
              <Link href="/self-corrective-rag" className="p-2 text-teal-500 hover:text-teal-700 hover:bg-teal-50 rounded-lg transition-colors" title="Self-Corrective RAG">
                <i className="fas fa-redo-alt"></i>
              </Link>
              <Link href="/milvus" className="p-2 text-violet-500 hover:text-violet-700 hover:bg-violet-50 rounded-lg transition-colors" title="Milvus">
                <i className="fas fa-database"></i>
              </Link>
              <Link href="/entity-extraction" className="p-2 text-rose-500 hover:text-rose-700 hover:bg-rose-50 rounded-lg transition-colors" title="实体抽取">
                <i className="fas fa-project-diagram"></i>
              </Link>
              <Link href="/adaptive-entity-rag" className="p-2 text-cyan-500 hover:text-cyan-700 hover:bg-cyan-50 rounded-lg transition-colors" title="自适应实体路由 RAG">
                <i className="fas fa-route"></i>
              </Link>
              <Link href="/context-management" className="p-2 text-amber-500 hover:text-amber-700 hover:bg-amber-50 rounded-lg transition-colors" title="上下文管理">
                <i className="fas fa-layer-group"></i>
              </Link>
              <div className="w-px h-6 bg-gray-200 mx-1"></div>
              <button
                onClick={handleDeleteAllConversations}
                className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                title="清空对话"
              >
                <i className="fas fa-trash-alt"></i>
              </button>
            </div>

            {/* 右侧: 状态 */}
            <div className="flex items-center gap-2">
              <div className="flex items-center px-2 py-1 bg-gray-50 rounded-lg">
                <div className={`w-2 h-2 rounded-full mr-2 ${systemStatus === '运行中' ? 'bg-green-400 animate-pulse' : 'bg-gray-400'}`}></div>
                <span className="text-xs text-gray-600">{systemStatus}</span>
              </div>
              <button onClick={checkSystemHealth} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded" title="刷新">
                <i className="fas fa-sync-alt text-sm"></i>
              </button>
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Milvus 查询可视化 - 当选择 Milvus 后端时显示 */}
        {storageBackend === 'milvus' && !useAgenticRAG && !useAdaptiveEntityRAG && (
          <MilvusQueryVisualizer
            embeddingModel={embeddingModel}
            defaultExpanded={false}
          />
        )}

        {/* Agentic RAG 工作流面板 - 当启用 Agentic RAG 时显示 */}
        {storageBackend === 'milvus' && useAgenticRAG && showAgenticPanel && (
          <div className="mb-6 space-y-4">
            <AgenticWorkflowPanel
              workflow={agenticWorkflow}
              queryAnalysis={agenticQueryAnalysis}
              retrievalQuality={agenticRetrievalQuality}
              selfReflection={agenticSelfReflection}
              hallucinationCheck={agenticHallucinationCheck}
              isLoading={isLoading}
              className="shadow-lg"
            />
            
            {/* LangSmith 追踪可视化 */}
            {agenticWorkflow?.steps && agenticWorkflow.steps.length > 0 && (
              <LangSmithTraceViewer
                workflowSteps={agenticWorkflow.steps}
                queryAnalysis={agenticQueryAnalysis}
                retrievalGrade={agenticRetrievalGrade}
                debugInfo={agenticDebugInfo}
                totalDuration={agenticWorkflow.totalDuration}
                defaultExpanded={false}
                className="shadow-lg"
              />
            )}
          </div>
        )}

        {/* 自适应实体路由 RAG 工作流面板 - 当启用自适应实体 RAG 时显示 */}
        {storageBackend === 'milvus' && useAdaptiveEntityRAG && showAdaptiveEntityPanel && (
          <div className="mb-6">
            <AdaptiveEntityWorkflowPanel
              workflow={adaptiveEntityWorkflow}
              queryAnalysis={adaptiveEntityQueryAnalysis}
              entityValidation={adaptiveEntityValidation}
              routingDecision={adaptiveEntityRoutingDecision}
              retrievalDetails={adaptiveEntityRetrievalDetails}
              isLoading={isLoading}
              className="shadow-lg"
              defaultExpanded={false}
              onClose={() => setShowAdaptiveEntityPanel(false)}
            />
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 主聊天区域 */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-lg shadow-sm border">
              {/* 聊天头部 */}
              <div className="border-b px-6 py-4">
                <h2 className="text-lg font-medium text-gray-900">智能问答</h2>
                <p className="text-sm text-gray-500 mt-1">向知识库提问，获得基于文档的准确回答</p>
              </div>

              {/* 聊天消息区域 */}
              <div className="h-96 overflow-y-auto p-6 space-y-4">
                {messages.length === 0 ? (
                  <div className="text-center text-gray-500 text-sm">
                    <i className="fas fa-comments text-2xl mb-2"></i>
                    <p>开始提问吧！我会根据已上传的文档来回答您的问题。</p>
                  </div>
                ) : (
                  messages.map((message) => (
                    <ChatMessage
                      key={message.id}
                      message={message}
                      currentQuery={currentQuery}
                      highlightMatchingText={highlightMatchingText}
                    />
                  ))
                )}

                {isLoading && (
                  <div className="flex justify-start">
                    <div className="bg-gray-100 rounded-lg px-4 py-2">
                      <div className="flex items-center space-x-2">
                        <div className="typing-indicator"></div>
                        <span className="text-sm text-gray-600">AI 正在思考...</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* 推荐问题（猜你想问）- 只显示通过校验的最终结果 */}
                {enableSuggestions && !isLoading && !isSuggestionsLoading && 
                  suggestedQuestions.filter(q => q.validated).length > 0 && (
                  <div className="mt-4 p-4 bg-gradient-to-r from-slate-800/80 to-slate-900/80 rounded-xl border border-slate-700/50">
                    <SuggestedQuestions
                      suggestions={suggestedQuestions.filter(q => q.validated)}
                      anchor={suggestionAnchor}
                      timings={suggestionTimings}
                      isLoading={false}
                      onQuestionClick={handleSuggestionClick}
                      showDetails={false}
                    />
                  </div>
                )}
              </div>

              {/* 输入区域 */}
              <div className="border-t p-6">
                <ParameterControls
                  topK={topK}
                  threshold={threshold}
                  llmModel={llmModel}
                  embeddingModel={embeddingModel}
                  onTopKChange={setTopK}
                  onThresholdChange={setThreshold}
                  onLLMModelChange={setLlmModel}
                  onEmbeddingModelChange={setEmbeddingModel}
                  showParams={showParams}
                  onToggle={() => setShowParams(!showParams)}
                />

                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-3">
                    <div className="flex space-x-4">
                      <div className="flex-1">
                        <input
                          type="text"
                          value={input}
                          onChange={(e) => setInput(e.target.value)}
                          placeholder="请输入您的问题..."
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          disabled={isLoading}
                          required
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowIntentDistillation(!showIntentDistillation)}
                        className={`px-4 py-2 rounded-lg transition-colors ${showIntentDistillation
                          ? 'bg-purple-600 text-white'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                          }`}
                        title="意图蒸馏"
                      >
                        <i className="fas fa-brain mr-2"></i>
                        🧠
                      </button>
                      <button
                        type="button"
                        onClick={() => setEnableSuggestions(!enableSuggestions)}
                        className={`px-4 py-2 rounded-lg transition-colors ${enableSuggestions
                          ? 'bg-teal-600 text-white'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                          }`}
                        title={enableSuggestions ? '关闭推荐问题' : '开启推荐问题'}
                      >
                        💬
                      </button>
                      {enableSuggestions && (
                        <button
                          type="button"
                          onClick={() => setShowExpansionWorkflow(!showExpansionWorkflow)}
                          className={`px-4 py-2 rounded-lg transition-colors ${showExpansionWorkflow
                            ? 'bg-cyan-600 text-white'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                            }`}
                          title={showExpansionWorkflow ? '隐藏思考过程' : '显示思考过程'}
                        >
                          🔬
                        </button>
                      )}
                      <button
                        type="submit"
                        disabled={isLoading || !input.trim()}
                        className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <i className="fas fa-paper-plane mr-2"></i>
                        发送
                      </button>
                    </div>

                    {/* 意图蒸馏面板 */}
                    {showIntentDistillation && input.trim() && (
                      <div className="bg-gradient-to-br from-purple-50 to-blue-50 border-2 border-purple-200 rounded-xl p-4">
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                            <span className="text-xl">🧠</span>
                            意图蒸馏分析
                          </h3>
                          <button
                            onClick={() => setShowIntentDistillation(false)}
                            className="text-gray-400 hover:text-gray-600"
                          >
                            ✕
                          </button>
                        </div>
                        <IntentDistillationPanel
                          query={input}
                          onQuerySelect={(query) => {
                            setInput(query);
                            setShowIntentDistillation(false);
                          }}
                        />
                      </div>
                    )}
                  </div>

                  {/* 用户问题处理结果展示 */}
                  <div className="space-y-4">
                    <QuestionSelector
                      messages={messages}
                      viewingAnalysisFor={viewingAnalysisFor}
                      onSelect={setViewingAnalysisFor}
                    />

                    {/* 显示选中的问题分析 */}
                    {viewingAnalysisFor && messages.find(m => m.id === viewingAnalysisFor)?.queryAnalysis && (
                      <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
                        <h4 className="text-sm font-medium text-blue-800 mb-3">
                          <i className="fas fa-cogs mr-2"></i>
                          用户问题处理分析
                          <span className="text-xs font-normal text-blue-600 ml-2">
                            ({messages.find(m => m.id === viewingAnalysisFor)?.content.substring(0, 50)}...)
                          </span>
                        </h4>
                        <QueryAnalysis
                          analysis={messages.find(m => m.id === viewingAnalysisFor)!.queryAnalysis}
                          radarChartData={radarChartData}
                          topK={topK}
                          threshold={threshold}
                          getRadarChartOption={getRadarChartOption}
                        />
                      </div>
                    )}

                    {/* 显示当前查询的分析（如果没有选中历史问题） */}
                    {!viewingAnalysisFor && showQueryAnalysis && queryAnalysis && (
                      <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
                        <h4 className="text-sm font-medium text-blue-800 mb-3">
                          <i className="fas fa-cogs mr-2"></i>
                          用户问题处理分析
                        </h4>
                        <QueryAnalysis
                          analysis={queryAnalysis}
                          radarChartData={radarChartData}
                          topK={topK}
                          threshold={threshold}
                          getRadarChartOption={getRadarChartOption}
                        />
                      </div>
                    )}

                    {/* 猜你想问 - 思考过程可视化（每次都显示完整检索过程） */}
                    {enableSuggestions && showExpansionWorkflow && (isSuggestionsLoading || suggestionAnchor || suggestedQuestions.length > 0) && (
                      <div className="mt-4">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <h4 className="text-sm font-medium text-gray-800">
                              <span className="mr-2">💬</span>
                              对话延伸引擎
                            </h4>
                            <span className="text-xs text-gray-500">思考过程可视化</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => setShowExpansionWorkflow(!showExpansionWorkflow)}
                            className="text-xs text-gray-500 hover:text-gray-700 transition-colors"
                          >
                            {showExpansionWorkflow ? '收起' : '展开'}
                          </button>
                        </div>
                        <ConversationExpansionWorkflow
                          anchor={suggestionAnchor}
                          suggestions={suggestedQuestions}
                          timings={suggestionTimings}
                          processingTime={suggestionProcessingTime}
                          isLoading={isSuggestionsLoading}
                          userQuery={lastUserQuery}
                          aiResponse={lastAiResponse}
                        />
                      </div>
                    )}
                  </div>
                </form>
              </div>
            </div>
          </div>

          {/* 侧边栏 */}
          <div className="space-y-4">

            {/* 高级 RAG 模式快捷入口 */}
            <div className="bg-gradient-to-br from-indigo-50 via-purple-50 to-pink-50 rounded-xl border border-indigo-200 p-4">
              <h3 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
                <span className="text-lg">🚀</span>
                高级 RAG 模式
              </h3>
              <div className="grid grid-cols-2 gap-2">
                <Link
                  href="/reasoning-rag"
                  className="group flex flex-col items-center gap-1.5 p-2.5 bg-white rounded-lg border border-purple-200 hover:border-purple-400 hover:shadow-md transition-all"
                >
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white text-base group-hover:scale-110 transition-transform">
                    🧠
                  </div>
                  <span className="text-xs font-medium text-gray-700">Reasoning</span>
                  <span className="text-[9px] text-gray-500">推理增强</span>
                </Link>
                <Link
                  href="/self-corrective-rag"
                  className="group flex flex-col items-center gap-1.5 p-2.5 bg-white rounded-lg border border-teal-200 hover:border-teal-400 hover:shadow-md transition-all"
                >
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-teal-400 to-cyan-500 flex items-center justify-center text-white text-base group-hover:scale-110 transition-transform">
                    🔄
                  </div>
                  <span className="text-xs font-medium text-gray-700">Corrective</span>
                  <span className="text-[9px] text-gray-500">自省修正</span>
                </Link>
                <Link
                  href="/agentic-rag"
                  className="group flex flex-col items-center gap-1.5 p-2.5 bg-white rounded-lg border border-fuchsia-200 hover:border-fuchsia-400 hover:shadow-md transition-all"
                >
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-fuchsia-400 to-purple-500 flex items-center justify-center text-white text-base group-hover:scale-110 transition-transform">
                    🤖
                  </div>
                  <span className="text-xs font-medium text-gray-700">Agentic</span>
                  <span className="text-[9px] text-gray-500">代理工作流</span>
                </Link>
                <Link
                  href="/entity-extraction"
                  className="group flex flex-col items-center gap-1.5 p-2.5 bg-white rounded-lg border border-rose-200 hover:border-rose-400 hover:shadow-md transition-all"
                >
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-rose-500 to-orange-500 flex items-center justify-center text-white text-base group-hover:scale-110 transition-transform">
                    🕸️
                  </div>
                  <span className="text-xs font-medium text-gray-700">GraphRAG</span>
                  <span className="text-[9px] text-gray-500">实体抽取</span>
                </Link>
                <Link
                  href="/adaptive-entity-rag"
                  className="group flex flex-col items-center gap-1.5 p-2.5 bg-white rounded-lg border border-cyan-200 hover:border-cyan-400 hover:shadow-md transition-all"
                >
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-white text-base group-hover:scale-110 transition-transform">
                    🛤️
                  </div>
                  <span className="text-xs font-medium text-gray-700">Entity RAG</span>
                  <span className="text-[9px] text-gray-500">实体路由</span>
                </Link>
                <Link
                  href="/context-management"
                  className="group flex flex-col items-center gap-1.5 p-2.5 bg-white rounded-lg border border-amber-200 hover:border-amber-400 hover:shadow-md transition-all"
                >
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-white text-base group-hover:scale-110 transition-transform">
                    📚
                  </div>
                  <span className="text-xs font-medium text-gray-700">Context</span>
                  <span className="text-[9px] text-gray-500">上下文管理</span>
                </Link>
              </div>
              <p className="text-[10px] text-gray-500 mt-3 text-center">
                基于 LangGraph + Milvus 的智能检索增强生成
              </p>
            </div>

            <FileUpload
              selectedFiles={selectedFiles}
              isUploading={isUploading}
              onFileSelect={setSelectedFiles}
              onUpload={handleFileUpload}
            />

            <FileList
              files={files}
              onRefresh={loadFilesList}
              onDelete={handleDeleteFile}
              formatFileSize={formatFileSize}
            />

            <RealtimeMonitoring
              showVectorization={showVectorization}
              vectorizationDetails={vectorizationDetails}
              vectorizationProgress={vectorizationProgress}
              vectorizationStatus={vectorizationStatus}
              showQueryProcessing={showQueryProcessing}
              queryProcessingStatus={queryProcessingStatus}
              isLoading={isLoading}
              queryAnalysis={queryAnalysis}
              retrievalDetails={retrievalDetails}
            />

            {/* 检索详情面板 */}
            <RetrievalDetailsPanel
              retrievalDetails={retrievalDetails}
              queryText={currentQuery}
            />

            <SystemInfo
              docCount={storageBackend === 'milvus' ? (milvusStats?.rowCount || 0) : docCount}
              embeddingDim={storageBackend === 'milvus' ? (milvusStats?.embeddingDimension || 0) : embeddingDim}
              systemStatus={systemStatus}
              llmModel={llmModel}
              embeddingModel={embeddingModel}
              modelConfig={modelConfig}
              onReinitialize={handleReinitialize}
              onModelChange={handleModelChange}
            />

            {/* 模型配置面板 */}
            <ModelConfigPanel />
          </div>
        </div>
      </div>

      <Toast toasts={toasts} />
    </div>
  );
}
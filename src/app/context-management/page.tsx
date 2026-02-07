'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';

// ==================== 类型定义 ====================

interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  tokenCount?: number;
}

interface SessionMetadata {
  sessionId: string;
  userId?: string;
  createdAt: number;
  lastActiveAt: number;
  totalTokens: number;
  messageCount: number;
  truncatedCount: number;
  summarizedRounds: number;
}

interface WorkflowStep {
  step: string;
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'error';
  duration?: number;
  details?: Record<string, any>;
}

interface RetrievedDocument {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, any>;
}

interface ContextState {
  messages: ConversationMessage[];
  metadata: SessionMetadata;
  summary?: string;
  workflowSteps: WorkflowStep[];
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

// ==================== 主组件 ====================

export default function ContextManagementPage() {
  // 会话管理状态
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [currentState, setCurrentState] = useState<ContextState | null>(null);
  
  // 聊天状态
  const [question, setQuestion] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [rewrittenQuery, setRewrittenQuery] = useState<string | null>(null);
  const [retrievedDocs, setRetrievedDocs] = useState<RetrievedDocument[]>([]);
  const [workflowSteps, setWorkflowSteps] = useState<WorkflowStep[]>([]);
  
  // 配置状态
  const [llmModel, setLlmModel] = useState('qwen2.5:0.5b');
  const [embeddingModel, setEmbeddingModel] = useState('bge-m3:latest');
  const [windowStrategy, setWindowStrategy] = useState<'sliding_window' | 'token_limit' | 'hybrid'>('hybrid');
  const [maxRounds, setMaxRounds] = useState(10);
  const [maxTokens, setMaxTokens] = useState(4000);
  const [enableQueryRewriting, setEnableQueryRewriting] = useState(true);
  const [topK, setTopK] = useState(5);
  const [similarityThreshold, setSimilarityThreshold] = useState(0.3);
  
  // 模型列表
  const [llmModels, setLlmModels] = useState<LLMModel[]>([]);
  const [embeddingModels, setEmbeddingModels] = useState<EmbeddingModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  
  // UI状态
  const [showConfig, setShowConfig] = useState(false);
  const [showWorkflow, setShowWorkflow] = useState(true);
  const [showDocs, setShowDocs] = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());
  
  // 流式输出状态
  const [useStreaming, setUseStreaming] = useState(true);
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  // ==================== 数据加载 ====================
  
  // 加载会话列表
  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/context-management?action=sessions');
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      const data = await res.json();
      if (data.success) {
        setSessions(data.sessions || []);
      }
    } catch (error) {
      console.error('加载会话列表失败:', error);
      setSessions([]);
    }
  }, []);
  
  // 加载单个会话
  const loadSession = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`/api/context-management?action=session&sessionId=${sessionId}`);
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      const data = await res.json();
      if (data.success) {
        setCurrentState(data.session);
        setCurrentSessionId(sessionId);
      }
    } catch (error) {
      console.error('加载会话失败:', error);
    }
  }, []);
  
  // 加载模型列表
  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const res = await fetch('/api/ollama/models');
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      const data = await res.json();
      if (data.success) {
        // 合并 LLM 和推理模型作为可选的 LLM 模型
        const allLlmModels = [
          ...(data.llmModels || []),
          ...(data.reasoningModels || []),
        ];
        setLlmModels(allLlmModels);
        setEmbeddingModels(data.embeddingModels || []);
        
        // 如果当前配置的模型不在列表中，自动选择第一个
        if (allLlmModels.length > 0 && !allLlmModels.some((m: LLMModel) => m.name === llmModel)) {
          setLlmModel(allLlmModels[0].name);
        }
        if (data.embeddingModels?.length > 0 && !data.embeddingModels.some((m: EmbeddingModel) => m.name === embeddingModel)) {
          setEmbeddingModel(data.embeddingModels[0].name);
        }
      }
    } catch (error) {
      console.error('加载模型列表失败:', error);
    } finally {
      setModelsLoading(false);
    }
  }, [llmModel, embeddingModel]);
  
  // 初始化
  useEffect(() => {
    loadSessions();
    loadModels();
  }, [loadSessions, loadModels]);
  
  // 滚动到最新消息
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentState?.messages]);
  
  // ==================== 操作处理 ====================
  
  // 创建新会话
  const handleCreateSession = async () => {
    try {
      const res = await fetch('/api/context-management', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create-session' }),
      });
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      const data = await res.json();
      if (data.success && data.session) {
        await loadSessions();
        // 兼容两种格式
        const sessionId = data.session.metadata?.sessionId || data.session.sessionId;
        setCurrentSessionId(sessionId);
        setCurrentState(data.session);
        setWorkflowSteps([]);
        setRetrievedDocs([]);
        setRewrittenQuery(null);
      }
    } catch (error) {
      console.error('创建会话失败:', error);
      alert('创建会话失败，请检查后端服务是否正常');
    }
  };
  
  // 删除会话
  const handleDeleteSession = async (sessionId: string) => {
    if (!confirm('确定要删除这个会话吗？')) return;
    
    try {
      const res = await fetch(`/api/context-management?sessionId=${sessionId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      const data = await res.json();
      if (data.success) {
        await loadSessions();
        if (currentSessionId === sessionId) {
          setCurrentSessionId(null);
          setCurrentState(null);
        }
      }
    } catch (error) {
      console.error('删除会话失败:', error);
    }
  };
  
  // 发送消息
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim() || !currentSessionId || isLoading) return;
    
    const userQuestion = question.trim();
    setQuestion('');
    setIsLoading(true);
    setRewrittenQuery(null);
    setWorkflowSteps([]);
    setStreamingContent('');
    
    // 立即添加用户消息到界面
    const userMsg: ConversationMessage = {
      id: `temp-user-${Date.now()}`,
      role: 'user',
      content: userQuestion,
      timestamp: Date.now(),
    };
    
    setCurrentState(prev => prev ? {
      ...prev,
      messages: [...prev.messages, userMsg],
    } : null);
    
    // 如果使用流式输出
    if (useStreaming) {
      setIsStreaming(true);
      
      // 添加空的助手消息占位
      const assistantMsgId = `temp-assistant-${Date.now()}`;
      const assistantMsg: ConversationMessage = {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        timestamp: Date.now() + 1,
      };
      
      setCurrentState(prev => prev ? {
        ...prev,
        messages: [...prev.messages, assistantMsg],
      } : null);
      
      try {
        const res = await fetch('/api/context-management', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'stream-query',
            sessionId: currentSessionId,
            question: userQuestion,
            llmModel,
            embeddingModel,
            windowStrategy,
            maxRounds,
            maxTokens,
            enableQueryRewriting,
            topK,
            similarityThreshold,
          }),
        });
        
        if (!res.ok) {
          throw new Error(`HTTP error! status: ${res.status}`);
        }
        
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        
        if (!reader) {
          throw new Error('无法获取响应流');
        }
        
        let buffer = '';
        let fullContent = '';
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          
          // 按双换行分割 SSE 消息
          const messages = buffer.split('\n\n');
          buffer = messages.pop() || '';
          
          for (const message of messages) {
            if (!message.trim()) continue;
            
            const lines = message.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const jsonStr = line.slice(6).trim();
                
                if (jsonStr === '[DONE]') {
                  console.log('[Stream] 完成');
                  continue;
                }
                
                if (!jsonStr) continue;
                
                try {
                  const event = JSON.parse(jsonStr);
                  
                  switch (event.type) {
                    case 'workflow':
                      // 更新工作流状态
                      if (event.data?.allSteps) {
                        setWorkflowSteps(event.data.allSteps);
                      }
                      break;
                      
                    case 'token':
                      // 流式更新内容
                      fullContent = event.data.fullResponse || (fullContent + event.data.content);
                      setStreamingContent(fullContent);
                      
                      // 更新消息内容
                      setCurrentState(prev => prev ? {
                        ...prev,
                        messages: prev.messages.map(msg =>
                          msg.id === assistantMsgId
                            ? { ...msg, content: fullContent }
                            : msg
                        ),
                      } : null);
                      break;
                      
                    case 'done':
                      // 完成，更新最终状态
                      if (event.data) {
                        setRewrittenQuery(event.data.rewrittenQuery || null);
                        setRetrievedDocs(event.data.retrievedDocs || []);
                        setWorkflowSteps(event.data.workflowSteps || []);
                      }
                      break;
                      
                    case 'error':
                      console.error('[Stream] 错误:', event.data.error);
                      break;
                  }
                } catch (parseError) {
                  console.warn('[Stream] JSON 解析错误:', jsonStr.substring(0, 100));
                }
              }
            }
          }
        }
        
        reader.releaseLock();
        
        // 重新加载会话以获取最新状态
        await loadSession(currentSessionId);
        await loadSessions();
        
      } catch (error) {
        console.error('流式查询失败:', error);
        // 移除临时消息
        setCurrentState(prev => prev ? {
          ...prev,
          messages: prev.messages.filter(m => m.id !== assistantMsgId && m.id !== userMsg.id),
        } : null);
        alert('发送消息失败，请检查后端服务');
      } finally {
        setIsLoading(false);
        setIsStreaming(false);
        setStreamingContent('');
      }
      
      return;
    }
    
    // 非流式模式
    try {
      const res = await fetch('/api/context-management', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'query',
          sessionId: currentSessionId,
          question: userQuestion,
          llmModel,
          embeddingModel,
          windowStrategy,
          maxRounds,
          maxTokens,
          enableQueryRewriting,
          topK,
          similarityThreshold,
        }),
      });
      
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      
      const data = await res.json();
      
      if (data.success) {
        // 更新会话状态
        await loadSession(currentSessionId);
        
        // 刷新会话列表以更新消息计数
        await loadSessions();
        
        // 更新工作流和检索结果
        setRewrittenQuery(data.rewrittenQuery || null);
        setRetrievedDocs(data.retrievedDocs || []);
        setWorkflowSteps(data.workflow?.steps || []);
      } else {
        console.error('查询失败:', data.error);
        alert(data.error || '查询失败');
      }
    } catch (error) {
      console.error('发送消息失败:', error);
      alert('发送消息失败，请检查后端服务');
    } finally {
      setIsLoading(false);
    }
  };
  
  // 手动压缩
  const handleCompress = async () => {
    if (!currentSessionId) return;
    
    try {
      const res = await fetch('/api/context-management', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'compress',
          sessionId: currentSessionId,
        }),
      });
      
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      
      const data = await res.json();
      if (data.success) {
        await loadSession(currentSessionId);
        alert(`压缩成功！压缩了 ${data.compressedCount} 条消息`);
      } else {
        alert(data.message || '压缩失败');
      }
    } catch (error) {
      console.error('压缩失败:', error);
    }
  };
  
  // 切换步骤展开
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
  
  // ==================== 渲染函数 ====================
  
  // 格式化时间
  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };
  
  // 格式化持续时间
  const formatDuration = (ms?: number) => {
    if (!ms) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };
  
  // 渲染消息
  const renderMessage = (msg: ConversationMessage, index: number) => {
    const isUser = msg.role === 'user';
    const isSystem = msg.role === 'system';
    
    return (
      <div
        key={msg.id || index}
        className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}
      >
        <div
          className={`max-w-[80%] rounded-2xl px-4 py-3 ${
            isSystem
              ? 'bg-amber-900/30 border border-amber-700/50 text-amber-200'
              : isUser
              ? 'bg-gradient-to-br from-blue-600 to-blue-700 text-white'
              : 'bg-slate-700/50 border border-slate-600 text-slate-100'
          }`}
        >
          {isSystem && (
            <div className="flex items-center gap-2 mb-2 text-xs text-amber-400">
              <span>📝</span>
              <span>系统摘要</span>
            </div>
          )}
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{msg.content}</p>
          <div className={`text-xs mt-2 ${isUser ? 'text-blue-200' : 'text-slate-400'}`}>
            {formatTime(msg.timestamp)}
            {msg.tokenCount && <span className="ml-2">· {msg.tokenCount} tokens</span>}
          </div>
        </div>
      </div>
    );
  };
  
  // 渲染工作流步骤
  const renderWorkflowSteps = () => {
    if (workflowSteps.length === 0) {
      return (
        <div className="text-center py-6 text-slate-500">
          <span className="text-3xl mb-2 block">🔄</span>
          <p className="text-sm">等待执行工作流...</p>
        </div>
      );
    }
    
    const stepIcons: Record<string, string> = {
      '状态加载': '📂',
      '窗口截断': '✂️',
      '查询改写': '✍️',
      '向量检索': '🔍',
      '响应生成': '💬',
      '状态保存': '💾',
    };
    
    const statusColors: Record<string, string> = {
      completed: 'bg-emerald-900/30 border-emerald-700/50 text-emerald-300',
      running: 'bg-blue-900/30 border-blue-700/50 text-blue-300',
      skipped: 'bg-slate-800/50 border-slate-700/50 text-slate-400',
      error: 'bg-red-900/30 border-red-700/50 text-red-300',
      pending: 'bg-slate-800/50 border-slate-700/50 text-slate-500',
    };
    
    return (
      <div className="space-y-2">
        {workflowSteps.map((step, index) => {
          const isExpanded = expandedSteps.has(index);
          const icon = stepIcons[step.step] || '⚙️';
          const colorClass = statusColors[step.status] || statusColors.pending;
          
          return (
            <div
              key={index}
              className={`rounded-lg border ${colorClass} transition-all`}
            >
              <div
                className="flex items-center justify-between p-3 cursor-pointer hover:bg-white/5"
                onClick={() => toggleStepExpand(index)}
              >
                <div className="flex items-center gap-3">
                  <span className="text-lg">{icon}</span>
                  <div>
                    <span className="font-medium">{step.step}</span>
                    {step.status === 'skipped' && (
                      <span className="ml-2 text-xs opacity-60">(已跳过)</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs opacity-70">{formatDuration(step.duration)}</span>
                  <span className={`transform transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
                    ▼
                  </span>
                </div>
              </div>
              
              {isExpanded && step.details && (
                <div className="px-3 pb-3 pt-1 border-t border-current/20">
                  <div className="bg-black/20 rounded p-2 text-xs space-y-1">
                    {Object.entries(step.details).map(([key, value]) => (
                      <div key={key} className="flex justify-between">
                        <span className="text-slate-400">{key}:</span>
                        <span className="text-slate-200 max-w-[200px] truncate">
                          {typeof value === 'object' 
                            ? JSON.stringify(value) 
                            : String(value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };
  
  // ==================== 主渲染 ====================
  
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white">
      {/* 导航栏 */}
      <nav className="sticky top-0 z-50 bg-slate-900/80 backdrop-blur-lg border-b border-slate-700/50">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-slate-400 hover:text-white transition-colors">
              ← 返回主页
            </Link>
            <h1 className="text-xl font-bold bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent">
              上下文管理系统
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowConfig(!showConfig)}
              className={`px-3 py-1.5 rounded-lg text-sm transition-all ${
                showConfig
                  ? 'bg-cyan-600 text-white'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
            >
              ⚙️ 配置
            </button>
          </div>
        </div>
      </nav>
      
      <div className="max-w-7xl mx-auto p-4 flex gap-4 h-[calc(100vh-64px)]">
        {/* 左侧：会话列表 */}
        <div className="w-64 flex-shrink-0 flex flex-col bg-slate-800/50 rounded-2xl border border-slate-700/50 overflow-hidden">
          <div className="p-3 border-b border-slate-700/50 flex items-center justify-between">
            <h2 className="font-semibold text-sm">会话列表</h2>
            <button
              onClick={handleCreateSession}
              className="px-2 py-1 bg-cyan-600 hover:bg-cyan-500 rounded-lg text-xs transition-colors"
            >
              + 新建
            </button>
          </div>
          
          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {sessions.length === 0 ? (
              <div className="text-center py-8 text-slate-500 text-sm">
                暂无会话<br />点击"新建"开始
              </div>
            ) : (
              sessions
                .filter(session => session && session.sessionId) // 过滤无效会话
                .map((session) => (
                <div
                  key={session.sessionId}
                  onClick={() => loadSession(session.sessionId)}
                  className={`p-3 rounded-xl cursor-pointer transition-all ${
                    currentSessionId === session.sessionId
                      ? 'bg-cyan-900/40 border border-cyan-700/50'
                      : 'bg-slate-700/30 border border-transparent hover:bg-slate-700/50'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-mono text-slate-400">
                      {session.sessionId?.slice(0, 8) || 'unknown'}...
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteSession(session.sessionId);
                      }}
                      className="text-red-400 hover:text-red-300 text-xs"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <span>💬 {session.messageCount || 0}</span>
                    <span>📊 {session.totalTokens || 0}</span>
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    {formatTime(session.lastActiveAt)}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
        
        {/* 中间：聊天区域 */}
        <div className="flex-1 flex flex-col bg-slate-800/30 rounded-2xl border border-slate-700/50 overflow-hidden">
          {currentSessionId ? (
            <>
              {/* 会话信息栏 */}
              <div className="p-3 border-b border-slate-700/50 flex items-center justify-between bg-slate-800/50">
                <div className="flex items-center gap-4">
                  <span className="text-sm text-slate-400">
                    会话: <span className="font-mono text-cyan-400">{currentSessionId.slice(0, 12)}...</span>
                  </span>
                  {currentState && (
                    <>
                      <span className="text-xs text-slate-500">
                        消息: {currentState.messages.length}
                      </span>
                      <span className="text-xs text-slate-500">
                        Tokens: {currentState.metadata.totalTokens}
                      </span>
                      {currentState.metadata.truncatedCount > 0 && (
                        <span className="text-xs text-amber-500">
                          已截断: {currentState.metadata.truncatedCount}
                        </span>
                      )}
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {/* 流式输出指示器 */}
                  <button
                    onClick={() => setUseStreaming(!useStreaming)}
                    className={`px-3 py-1 rounded-lg text-xs transition-colors flex items-center gap-1.5 ${
                      useStreaming
                        ? 'bg-emerald-600/80 hover:bg-emerald-600 text-white'
                        : 'bg-slate-600/80 hover:bg-slate-600 text-slate-300'
                    }`}
                    title={useStreaming ? '流式输出已启用' : '点击启用流式输出'}
                  >
                    {useStreaming ? '⚡ 流式' : '📝 普通'}
                  </button>
                  <button
                    onClick={handleCompress}
                    className="px-3 py-1 bg-amber-600/80 hover:bg-amber-600 rounded-lg text-xs transition-colors"
                    title="压缩历史记录为摘要"
                  >
                    🗜️ 压缩
                  </button>
                </div>
              </div>
              
              {/* 查询改写提示 */}
              {rewrittenQuery && (
                <div className="px-4 py-2 bg-cyan-900/30 border-b border-cyan-700/30 flex items-center gap-2">
                  <span className="text-cyan-400">✍️</span>
                  <span className="text-sm text-cyan-300">
                    改写后查询: <span className="text-white">{rewrittenQuery}</span>
                  </span>
                </div>
              )}
              
              {/* 消息列表 */}
              <div className="flex-1 overflow-y-auto p-4">
                {currentState?.summary && (
                  <div className="mb-4 p-3 bg-amber-900/20 border border-amber-700/30 rounded-xl">
                    <div className="flex items-center gap-2 text-amber-400 text-sm mb-2">
                      <span>📜</span>
                      <span>历史摘要</span>
                    </div>
                    <p className="text-sm text-slate-300">{currentState.summary}</p>
                  </div>
                )}
                
                {currentState?.messages.map((msg, i) => renderMessage(msg, i))}
                
                {isLoading && (
                  <div className="flex justify-start mb-4">
                    <div className="bg-slate-700/50 border border-slate-600 rounded-2xl px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="animate-pulse flex gap-1">
                          <span className="w-2 h-2 bg-cyan-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
                          <span className="w-2 h-2 bg-cyan-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
                          <span className="w-2 h-2 bg-cyan-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
                        </div>
                        <span className="text-sm text-slate-400">正在处理...</span>
                      </div>
                    </div>
                  </div>
                )}
                
                <div ref={messagesEndRef} />
              </div>
              
              {/* 输入框 */}
              <form onSubmit={handleSendMessage} className="p-4 border-t border-slate-700/50 bg-slate-800/50">
                <div className="flex gap-3">
                  <input
                    type="text"
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder="输入您的问题..."
                    disabled={isLoading}
                    className="flex-1 px-4 py-3 bg-slate-900/50 border border-slate-600 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors disabled:opacity-50"
                  />
                  <button
                    type="submit"
                    disabled={isLoading || !question.trim()}
                    className="px-6 py-3 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 rounded-xl font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    发送
                  </button>
                </div>
              </form>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <span className="text-6xl mb-4 block">💬</span>
                <h3 className="text-xl font-semibold text-slate-300 mb-2">选择或创建会话</h3>
                <p className="text-slate-500 text-sm mb-4">从左侧选择一个会话，或创建新会话开始对话</p>
                <button
                  onClick={handleCreateSession}
                  className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 rounded-xl transition-colors"
                >
                  + 创建新会话
                </button>
              </div>
            </div>
          )}
        </div>
        
        {/* 右侧：工作流/检索结果/配置 */}
        <div className="w-80 flex-shrink-0 flex flex-col gap-4">
          {/* 配置面板 */}
          {showConfig && (
            <div className="bg-slate-800/50 rounded-2xl border border-slate-700/50 p-4">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <span>⚙️</span> 配置
              </h3>
              
              <div className="space-y-3">
                {/* LLM 模型 */}
                <div>
                  <label className="text-xs text-slate-400 block mb-1">LLM 模型</label>
                  {modelsLoading ? (
                    <div className="w-full px-3 py-2 bg-slate-700/50 border border-slate-600 rounded-lg text-slate-400 text-sm">
                      ⏳ 加载模型列表...
                    </div>
                  ) : llmModels.length === 0 ? (
                    <div className="w-full px-3 py-2 bg-amber-900/30 border border-amber-500/30 rounded-lg text-amber-300 text-sm">
                      ⚠️ 未检测到 LLM 模型，请检查 Ollama 服务
                    </div>
                  ) : (
                    <select
                      value={llmModel}
                      onChange={(e) => setLlmModel(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-900/80 border border-slate-600 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
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
                  <label className="text-xs text-slate-400 block mb-1">Embedding 模型</label>
                  {modelsLoading ? (
                    <div className="w-full px-3 py-2 bg-slate-700/50 border border-slate-600 rounded-lg text-slate-400 text-sm">
                      ⏳ 加载模型列表...
                    </div>
                  ) : embeddingModels.length === 0 ? (
                    <div className="w-full px-3 py-2 bg-amber-900/30 border border-amber-500/30 rounded-lg text-amber-300 text-sm">
                      ⚠️ 未检测到 Embedding 模型
                    </div>
                  ) : (
                    <select
                      value={embeddingModel}
                      onChange={(e) => setEmbeddingModel(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-900/80 border border-slate-600 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                    >
                      {embeddingModels.map((model, index) => (
                        <option key={`embedding-${model.name}-${index}`} value={model.name}>
                          {model.displayName || model.name} {model.dimension ? `(${model.dimension}D)` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                
                {/* 窗口策略 */}
                <div>
                  <label className="text-xs text-slate-400 block mb-1">窗口策略</label>
                  <select
                    value={windowStrategy}
                    onChange={(e) => setWindowStrategy(e.target.value as any)}
                    className="w-full px-3 py-2 bg-slate-900/80 border border-slate-600 rounded-lg text-sm"
                  >
                    <option value="sliding_window">滑动窗口</option>
                    <option value="token_limit">Token 限制</option>
                    <option value="hybrid">混合策略</option>
                  </select>
                </div>
                
                {/* 参数网格 */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">最大轮数</label>
                    <input
                      type="number"
                      value={maxRounds}
                      onChange={(e) => setMaxRounds(parseInt(e.target.value) || 10)}
                      min={1}
                      max={50}
                      className="w-full px-3 py-2 bg-slate-900/80 border border-slate-600 rounded-lg text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">最大 Tokens</label>
                    <input
                      type="number"
                      value={maxTokens}
                      onChange={(e) => setMaxTokens(parseInt(e.target.value) || 4000)}
                      min={500}
                      max={16000}
                      className="w-full px-3 py-2 bg-slate-900/80 border border-slate-600 rounded-lg text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Top K</label>
                    <input
                      type="number"
                      value={topK}
                      onChange={(e) => setTopK(parseInt(e.target.value) || 5)}
                      min={1}
                      max={20}
                      className="w-full px-3 py-2 bg-slate-900/80 border border-slate-600 rounded-lg text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">相似度阈值</label>
                    <input
                      type="number"
                      value={similarityThreshold}
                      onChange={(e) => setSimilarityThreshold(parseFloat(e.target.value) || 0.3)}
                      min={0}
                      max={1}
                      step={0.05}
                      className="w-full px-3 py-2 bg-slate-900/80 border border-slate-600 rounded-lg text-sm"
                    />
                  </div>
                </div>
                
                {/* 查询改写开关 */}
                <div className="flex items-center justify-between">
                  <label className="text-sm text-slate-300">启用查询改写</label>
                  <button
                    onClick={() => setEnableQueryRewriting(!enableQueryRewriting)}
                    className={`w-12 h-6 rounded-full transition-colors ${
                      enableQueryRewriting ? 'bg-cyan-600' : 'bg-slate-600'
                    }`}
                  >
                    <div
                      className={`w-5 h-5 bg-white rounded-full transition-transform ${
                        enableQueryRewriting ? 'translate-x-6' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                </div>
                
                {/* 流式输出开关 */}
                <div className="flex items-center justify-between">
                  <label className="text-sm text-slate-300">
                    流式输出
                    <span className="text-xs text-slate-500 ml-1">(打字机效果)</span>
                  </label>
                  <button
                    onClick={() => setUseStreaming(!useStreaming)}
                    className={`w-12 h-6 rounded-full transition-colors ${
                      useStreaming ? 'bg-emerald-600' : 'bg-slate-600'
                    }`}
                  >
                    <div
                      className={`w-5 h-5 bg-white rounded-full transition-transform ${
                        useStreaming ? 'translate-x-6' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                </div>
              </div>
            </div>
          )}
          
          {/* 工作流面板 */}
          <div className="flex-1 bg-slate-800/50 rounded-2xl border border-slate-700/50 overflow-hidden flex flex-col">
            <div className="p-3 border-b border-slate-700/50 flex items-center justify-between">
              <button
                onClick={() => setShowWorkflow(true)}
                className={`px-3 py-1 rounded-lg text-sm transition-colors ${
                  showWorkflow ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                🔄 工作流
              </button>
              <button
                onClick={() => setShowWorkflow(false)}
                className={`px-3 py-1 rounded-lg text-sm transition-colors ${
                  !showWorkflow ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                📄 检索结果 ({retrievedDocs.length})
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-3">
              {showWorkflow ? (
                renderWorkflowSteps()
              ) : (
                <div className="space-y-2">
                  {retrievedDocs.length === 0 ? (
                    <div className="text-center py-8 text-slate-500 text-sm">
                      暂无检索结果
                    </div>
                  ) : (
                    retrievedDocs.map((doc, i) => (
                      <div
                        key={doc.id || i}
                        className="p-3 bg-slate-700/30 border border-slate-600/50 rounded-xl"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs text-slate-400">文档 {i + 1}</span>
                          <span className="text-xs text-cyan-400 font-mono">
                            {(doc.score * 100).toFixed(1)}%
                          </span>
                        </div>
                        <p className="text-sm text-slate-300 line-clamp-4">
                          {doc.content}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

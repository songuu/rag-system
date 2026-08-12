'use client';

import React, { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import SelfCorrectiveRAGVisualizer from '@/components/SelfCorrectiveRAGVisualizer';
import SCRAGLangSmithViewer from '@/components/SCRAGLangSmithViewer';

// ==================== 类型定义 ====================

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  scragData?: SCRAGResponse;
}

interface SCRAGResponse {
  success: boolean;
  answer: string;
  query: {
    original: string;
    final: string;
    wasRewritten: boolean;
    rewriteCount: number;
  };
  rewriteHistory: Array<{
    original: string;
    rewritten: string;
    reason: string;
    keywords: string[];
    attempt: number;
  }>;
  retrieval: {
    totalDocuments: number;
    filteredDocuments: number;
    documents: Array<{
      id: string;
      content: string;
      score: number;
      gradeResult?: {
        isRelevant: boolean;
        confidence: number;
        reasoning: string;
      };
      metadata?: Record<string, any>;
    }>;
  };
  graderResult: {
    passRate: number;
    passCount: number;
    totalCount: number;
    shouldRewrite: boolean;
    reasoning: string;
    documentGrades: Array<{
      docId: string;
      isRelevant: boolean;
      confidence: number;
      reasoning: string;
    }>;
  } | null;
  generation: {
    confidence: number;
    usedDocuments: number;
    sources: string[];
  } | null;
  workflow: {
    nodeExecutions: Array<{
      node: 'retrieve' | 'grade' | 'rewrite' | 'generate';
      status: 'pending' | 'running' | 'completed' | 'skipped' | 'error';
      duration?: number;
      input?: any;
      output?: any;
      error?: string;
    }>;
    decisionPath: string[];
    totalDuration: number;
  };
  error?: string;
  meta: {
    apiDuration: number;
    timestamp: string;
  };
}

// ==================== 配置面板组件 ====================

interface ConfigPanelProps {
  config: {
    topK: number;
    similarityThreshold: number;
    maxRewriteAttempts: number;
    gradePassThreshold: number;
  };
  onChange: (config: ConfigPanelProps['config']) => void;
  isExpanded: boolean;
  onToggle: () => void;
}

const ConfigPanel: React.FC<ConfigPanelProps> = ({ config, onChange, isExpanded, onToggle }) => (
  <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
    <div 
      className="px-4 py-3 bg-gray-50 flex items-center justify-between cursor-pointer hover:bg-gray-100"
      onClick={onToggle}
    >
      <div className="flex items-center gap-2">
        <span className="text-xl">⚙️</span>
        <span className="font-medium text-gray-800">配置参数</span>
      </div>
      <svg 
        className={`w-5 h-5 text-gray-500 transform transition-transform ${isExpanded ? 'rotate-180' : ''}`}
        fill="none" 
        stroke="currentColor" 
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </div>
    
    {isExpanded && (
      <div className="p-4 space-y-4">
        {/* Top-K */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            检索数量 (Top-K): {config.topK}
          </label>
          <input
            type="range"
            min="1"
            max="20"
            value={config.topK}
            onChange={(e) => onChange({ ...config, topK: parseInt(e.target.value) })}
            className="w-full h-2 bg-indigo-100 rounded-lg appearance-none cursor-pointer"
          />
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>1</span>
            <span>20</span>
          </div>
        </div>
        
        {/* 相似度阈值 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            相似度阈值: {(config.similarityThreshold * 100).toFixed(0)}%
          </label>
          <input
            type="range"
            min="0"
            max="100"
            value={config.similarityThreshold * 100}
            onChange={(e) => onChange({ ...config, similarityThreshold: parseInt(e.target.value) / 100 })}
            className="w-full h-2 bg-blue-100 rounded-lg appearance-none cursor-pointer"
          />
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>0%</span>
            <span>100%</span>
          </div>
        </div>
        
        {/* 最大重写次数 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            最大重写次数: {config.maxRewriteAttempts}
          </label>
          <input
            type="range"
            min="0"
            max="5"
            value={config.maxRewriteAttempts}
            onChange={(e) => onChange({ ...config, maxRewriteAttempts: parseInt(e.target.value) })}
            className="w-full h-2 bg-orange-100 rounded-lg appearance-none cursor-pointer"
          />
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>0 (禁用)</span>
            <span>5</span>
          </div>
        </div>
        
        {/* 质检通过阈值 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            质检通过阈值: {(config.gradePassThreshold * 100).toFixed(0)}%
          </label>
          <input
            type="range"
            min="0"
            max="100"
            value={config.gradePassThreshold * 100}
            onChange={(e) => onChange({ ...config, gradePassThreshold: parseInt(e.target.value) / 100 })}
            className="w-full h-2 bg-purple-100 rounded-lg appearance-none cursor-pointer"
          />
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>0%</span>
            <span>100%</span>
          </div>
        </div>
      </div>
    )}
  </div>
);

// ==================== 架构说明组件 ====================

const ArchitectureInfo: React.FC = () => (
  <div className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-xl border border-indigo-200 p-6">
    <h3 className="text-lg font-bold text-indigo-800 mb-4 flex items-center gap-2">
      🏗️ Self-Corrective RAG 架构
    </h3>
    
    <div className="grid grid-cols-2 gap-4 mb-6">
      {[
        { icon: '🔍', name: 'Retrieve', desc: '检索者', detail: '从 Milvus 检索 Top-K 文档' },
        { icon: '🔬', name: 'Grader', desc: '质检员', detail: 'LLM 判断文档是否相关' },
        { icon: '✏️', name: 'Rewrite', desc: '修正者', detail: '质检失败时重写查询' },
        { icon: '💬', name: 'Generate', desc: '生成者', detail: '基于高质量文档生成回答' },
      ].map((node) => (
        <div key={node.name} className="bg-white rounded-lg p-3 border border-indigo-100">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-2xl">{node.icon}</span>
            <span className="font-bold text-gray-800">{node.name}</span>
          </div>
          <div className="text-xs text-gray-500">{node.desc}</div>
          <div className="text-sm text-gray-600 mt-1">{node.detail}</div>
        </div>
      ))}
    </div>
    
    <div className="bg-white rounded-lg p-4 border border-indigo-100">
      <div className="text-sm font-medium text-gray-700 mb-2">🔄 工作流程</div>
      <div className="flex items-center justify-center gap-2 text-sm flex-wrap">
        <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded">Retrieve</span>
        <span>→</span>
        <span className="px-2 py-1 bg-purple-100 text-purple-700 rounded">Grade</span>
        <span>→</span>
        <span className="text-gray-500">[</span>
        <span className="px-2 py-1 bg-orange-100 text-orange-700 rounded">Rewrite</span>
        <span className="text-orange-500">↩️</span>
        <span className="text-gray-500">]</span>
        <span>→</span>
        <span className="px-2 py-1 bg-green-100 text-green-700 rounded">Generate</span>
      </div>
    </div>
  </div>
);

// ==================== 主页面组件 ====================

export default function SelfCorrectiveRAGPage() {
  // 状态管理
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [currentResponse, setCurrentResponse] = useState<SCRAGResponse | null>(null);
  const [configExpanded, setConfigExpanded] = useState(false);
  const [config, setConfig] = useState({
    topK: 5,
    similarityThreshold: 0.3,
    maxRewriteAttempts: 3,
    gradePassThreshold: 0.6,
  });
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  
  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);
  
  // 发送消息
  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    
    const query = input.trim();
    if (!query || isLoading) return;
    
    // 添加用户消息
    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: query,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);
    setCurrentResponse(null);
    
    try {
      const response = await fetch('/rag-api/self-corrective-rag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          ...config,
        }),
      });
      
      const data: SCRAGResponse = await response.json();
      setCurrentResponse(data);
      
      // 添加助手消息
      const assistantMessage: Message = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: data.answer || '无法生成回答',
        timestamp: new Date(),
        scragData: data,
      };
      setMessages(prev => [...prev, assistantMessage]);
      
    } catch (error: any) {
      console.error('SC-RAG 请求失败:', error);
      
      const errorMessage: Message = {
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: `请求失败: ${error.message}`,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errorMessage]);
      
    } finally {
      setIsLoading(false);
    }
  };
  
  // 处理键盘事件
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };
  
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-indigo-50 to-purple-50">
      {/* 顶部导航 */}
      <header className="bg-white/80 backdrop-blur-lg border-b border-indigo-100 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/" className="text-gray-500 hover:text-gray-700 flex items-center gap-1">
                <i className="fas fa-arrow-left text-xs"></i>
                返回首页
              </Link>
              <div className="h-6 w-px bg-gray-300" />
              <div className="flex items-center gap-3">
                <span className="text-3xl">🔄</span>
                <div>
                  <h1 className="text-xl font-bold text-gray-800">Self-Corrective RAG</h1>
                  <p className="text-sm text-gray-500">自省式修正检索增强生成系统</p>
                </div>
              </div>
            </div>
            
            <div className="flex items-center gap-3">
              <Link
                href="/reasoning-rag"
                className="px-4 py-2 bg-purple-100 text-purple-700 rounded-lg hover:bg-purple-200 transition-colors flex items-center gap-2"
              >
                🧠 Reasoning RAG
              </Link>
              <Link
                href="/agentic-rag"
                className="px-4 py-2 bg-fuchsia-100 text-fuchsia-700 rounded-lg hover:bg-fuchsia-200 transition-colors flex items-center gap-2"
              >
                🤖 Agentic RAG
              </Link>
              <Link
                href="/self-rag"
                className="px-4 py-2 bg-indigo-100 text-indigo-700 rounded-lg hover:bg-indigo-200 transition-colors flex items-center gap-2"
              >
                🔁 Self-RAG
              </Link>
            </div>
          </div>
        </div>
      </header>
      
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 左侧：配置和架构说明 */}
          <div className="lg:col-span-1 space-y-6">
            <ConfigPanel
              config={config}
              onChange={setConfig}
              isExpanded={configExpanded}
              onToggle={() => setConfigExpanded(!configExpanded)}
            />
            
            <ArchitectureInfo />
            
            {/* 与 Agentic RAG 的区别 */}
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <h4 className="font-semibold text-gray-800 mb-3 flex items-center gap-2">
                🆚 与 Agentic RAG 的区别
              </h4>
              <ul className="space-y-2 text-sm text-gray-600">
                <li className="flex items-start gap-2">
                  <span className="text-indigo-500">•</span>
                  <span><strong>更精简</strong>: 4 个核心节点 vs 多节点复杂流程</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-indigo-500">•</span>
                  <span><strong>LLM 质检</strong>: Grader 是独立 LLM 调用，而非规则评分</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-indigo-500">•</span>
                  <span><strong>修正循环</strong>: 强调"换词重搜"的人类行为模拟</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-indigo-500">•</span>
                  <span><strong>质量闭环</strong>: 只有通过质检的文档才能进入生成</span>
                </li>
              </ul>
            </div>
          </div>
          
          {/* 右侧：对话区域 */}
          <div className="lg:col-span-2 space-y-6">
            {/* 对话历史 */}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100 bg-gray-50">
                <h2 className="font-semibold text-gray-800">💬 智能问答</h2>
                <p className="text-sm text-gray-500">基于自省式修正的高质量回答</p>
              </div>
              
              <div className="h-[400px] overflow-y-auto p-6 space-y-4">
                {messages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-gray-400">
                    <span className="text-5xl mb-4">🔄</span>
                    <p>开始提问，体验 Self-Corrective RAG</p>
                    <p className="text-sm mt-2">系统会自动质检并修正检索结果</p>
                  </div>
                ) : (
                  messages.map((message) => (
                    <div
                      key={message.id}
                      className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                          message.role === 'user'
                            ? 'bg-indigo-600 text-white'
                            : 'bg-gray-100 text-gray-800'
                        }`}
                      >
                        <p className="whitespace-pre-wrap">{message.content}</p>
                        <div className={`text-xs mt-2 ${
                          message.role === 'user' ? 'text-indigo-200' : 'text-gray-400'
                        }`}>
                          {message.timestamp.toLocaleTimeString()}
                          {message.scragData?.query?.wasRewritten && (
                            <span className="ml-2 px-2 py-0.5 bg-orange-200 text-orange-700 rounded-full">
                              重写 {message.scragData.query.rewriteCount} 次
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
                
                {isLoading && (
                  <div className="flex justify-start">
                    <div className="bg-gray-100 rounded-2xl px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 bg-indigo-500 rounded-full animate-bounce" />
                        <div className="w-2 h-2 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }} />
                        <div className="w-2 h-2 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
                        <span className="text-gray-500 ml-2">思考中...</span>
                      </div>
                    </div>
                  </div>
                )}
                
                <div ref={messagesEndRef} />
              </div>
              
              {/* 输入框 */}
              <div className="p-4 border-t border-gray-100 bg-gray-50">
                <form onSubmit={handleSubmit} className="flex gap-3">
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="输入您的问题..."
                    className="flex-1 px-4 py-3 border border-gray-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                    rows={2}
                    disabled={isLoading}
                  />
                  <button
                    type="submit"
                    disabled={isLoading || !input.trim()}
                    className={`px-6 py-3 rounded-xl font-medium transition-all ${
                      isLoading || !input.trim()
                        ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                        : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-md hover:shadow-lg'
                    }`}
                  >
                    {isLoading ? '处理中...' : '发送 🔄'}
                  </button>
                </form>
              </div>
            </div>
            
            {/* 工作流可视化 */}
            {(currentResponse || isLoading) && (
              <SelfCorrectiveRAGVisualizer
                query={currentResponse?.query}
                rewriteHistory={currentResponse?.rewriteHistory}
                retrieval={currentResponse?.retrieval}
                graderResult={currentResponse?.graderResult}
                generation={currentResponse?.generation}
                workflow={currentResponse?.workflow}
                answer={currentResponse?.answer}
                error={currentResponse?.error}
                isLoading={isLoading}
                defaultExpanded={true}
              />
            )}
            
            {/* LangSmith 追踪可视化 */}
            {(currentResponse || isLoading) && (
              <SCRAGLangSmithViewer
                nodeExecutions={currentResponse?.workflow?.nodeExecutions}
                decisionPath={currentResponse?.workflow?.decisionPath}
                graderResult={currentResponse?.graderResult}
                rewriteHistory={currentResponse?.rewriteHistory}
                totalDuration={currentResponse?.workflow?.totalDuration}
                query={currentResponse?.query}
                isLoading={isLoading}
                defaultExpanded={false}
                className="mt-4"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

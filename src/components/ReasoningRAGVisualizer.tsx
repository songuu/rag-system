'use client';

import React, { useState, useMemo } from 'react';

// ==================== 类型定义 ====================

interface ThinkingStep {
  id: string;
  timestamp: number;
  type: 'reasoning' | 'planning' | 'reflection' | 'decision';
  content: string;
  confidence?: number;
  metadata?: Record<string, any>;
}

interface BaseMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

interface RetrievedDocument {
  id: string;
  content: string;
  metadata: Record<string, any>;
  score: number;
  source: 'dense' | 'sparse' | 'hybrid';
  rerankScore?: number;
}

interface HybridRetrievalResult {
  denseResults: RetrievedDocument[];
  sparseResults: RetrievedDocument[];
  mergedResults: RetrievedDocument[];
  rerankedResults: RetrievedDocument[];
  statistics: {
    denseCount: number;
    sparseCount: number;
    mergedCount: number;
    finalCount: number;
    denseTime: number;
    sparseTime: number;
    rerankTime: number;
    totalTime: number;
  };
}

interface OrchestratorDecision {
  action: 'tool_call' | 'generate' | 'clarify';
  intent: string;
  confidence: number;
  reasoning: string;
}

interface NodeExecution {
  node: string;
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'error';
  duration?: number;
  input?: any;
  output?: any;
  error?: string;
}

interface ReasoningRAGVisualizerProps {
  query?: string;
  answer?: string;
  thinkingProcess?: ThinkingStep[];
  messages?: BaseMessage[];
  retrieval?: HybridRetrievalResult;
  orchestratorDecision?: OrchestratorDecision;
  workflow?: {
    totalDuration: number;
    iterations: number;
    decisionPath: string[];
    nodeExecutions: NodeExecution[];
  };
  config?: {
    reasoningModel?: string;
    enableBM25?: boolean;
    enableRerank?: boolean;
    topK?: number;
    rerankTopK?: number;
  };
  isLoading?: boolean;
  defaultExpanded?: boolean;
}

// ==================== 子组件 ====================

// 思维链面板
const ThinkingProcessPanel: React.FC<{ steps: ThinkingStep[] }> = ({ steps }) => {
  const [expanded, setExpanded] = useState(true);
  
  const typeConfig = {
    reasoning: { icon: '🧠', label: '推理', color: 'from-purple-500 to-indigo-500' },
    planning: { icon: '📋', label: '规划', color: 'from-blue-500 to-cyan-500' },
    reflection: { icon: '🔍', label: '反思', color: 'from-amber-500 to-orange-500' },
    decision: { icon: '⚡', label: '决策', color: 'from-emerald-500 to-teal-500' }
  };
  
  return (
    <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-xl border border-purple-500/30 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center justify-between bg-gradient-to-r from-purple-900/50 to-indigo-900/50 hover:from-purple-900/70 hover:to-indigo-900/70 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-2xl">🧠</span>
          <span className="font-semibold text-white">思维链 (Chain of Thought)</span>
          <span className="px-2 py-0.5 bg-purple-500/30 text-purple-300 text-xs rounded-full">
            {steps.length} 步
          </span>
        </div>
        <svg
          className={`w-5 h-5 text-purple-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      
      {expanded && (
        <div className="p-4 space-y-3">
          {steps.length === 0 ? (
            <div className="text-center text-gray-400 py-4">
              <p>暂无思维链数据</p>
              <p className="text-xs mt-1">推理模型会展示其思考过程</p>
            </div>
          ) : (
            <div className="relative">
              {/* 连接线 */}
              <div className="absolute left-5 top-6 bottom-6 w-0.5 bg-gradient-to-b from-purple-500 via-blue-500 to-emerald-500" />
              
              {steps.map((step, idx) => {
                const config = typeConfig[step.type] || typeConfig.reasoning;
                return (
                  <div key={step.id} className="relative pl-12 pb-4">
                    {/* 节点圆点 */}
                    <div className={`absolute left-3 w-5 h-5 rounded-full bg-gradient-to-r ${config.color} flex items-center justify-center text-xs shadow-lg`}>
                      {idx + 1}
                    </div>
                    
                    <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span>{config.icon}</span>
                          <span className="text-sm font-medium text-gray-300">{config.label}</span>
                        </div>
                        {step.confidence !== undefined && (
                          <span className="text-xs text-gray-500">
                            置信度: {(step.confidence * 100).toFixed(0)}%
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-400 whitespace-pre-wrap">{step.content}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// 混合检索面板
const HybridRetrievalPanel: React.FC<{ retrieval: HybridRetrievalResult }> = ({ retrieval }) => {
  const [expanded, setExpanded] = useState(true);
  const [activeTab, setActiveTab] = useState<'dense' | 'sparse' | 'merged' | 'reranked'>('reranked');
  
  const stats = retrieval.statistics;
  
  const getCurrentDocs = () => {
    switch (activeTab) {
      case 'dense': return retrieval.denseResults;
      case 'sparse': return retrieval.sparseResults;
      case 'merged': return retrieval.mergedResults;
      case 'reranked': return retrieval.rerankedResults;
      default: return [];
    }
  };
  
  const docs = getCurrentDocs();
  
  return (
    <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-xl border border-cyan-500/30 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center justify-between bg-gradient-to-r from-cyan-900/50 to-blue-900/50 hover:from-cyan-900/70 hover:to-blue-900/70 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-2xl">🔍</span>
          <span className="font-semibold text-white">混合检索 (Hybrid Retrieval)</span>
          <span className="px-2 py-0.5 bg-cyan-500/30 text-cyan-300 text-xs rounded-full">
            {stats.finalCount} 结果
          </span>
        </div>
        <svg
          className={`w-5 h-5 text-cyan-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      
      {expanded && (
        <div className="p-4 space-y-4">
          {/* 统计信息 */}
          <div className="grid grid-cols-4 gap-3">
            <div className="bg-blue-900/30 rounded-lg p-3 text-center border border-blue-500/20">
              <div className="text-2xl font-bold text-blue-400">{stats.denseCount}</div>
              <div className="text-xs text-blue-300">Dense (向量)</div>
              <div className="text-xs text-gray-500">{stats.denseTime}ms</div>
            </div>
            <div className="bg-green-900/30 rounded-lg p-3 text-center border border-green-500/20">
              <div className="text-2xl font-bold text-green-400">{stats.sparseCount}</div>
              <div className="text-xs text-green-300">Sparse (BM25)</div>
              <div className="text-xs text-gray-500">{stats.sparseTime}ms</div>
            </div>
            <div className="bg-amber-900/30 rounded-lg p-3 text-center border border-amber-500/20">
              <div className="text-2xl font-bold text-amber-400">{stats.mergedCount}</div>
              <div className="text-xs text-amber-300">合并结果</div>
              <div className="text-xs text-gray-500">RRF 融合</div>
            </div>
            <div className="bg-purple-900/30 rounded-lg p-3 text-center border border-purple-500/20">
              <div className="text-2xl font-bold text-purple-400">{stats.finalCount}</div>
              <div className="text-xs text-purple-300">最终结果</div>
              <div className="text-xs text-gray-500">{stats.rerankTime}ms</div>
            </div>
          </div>
          
          {/* 检索流程图 */}
          <div className="flex items-center justify-center gap-2 py-2">
            <div className="flex items-center gap-1 text-xs text-blue-400">
              <span className="w-3 h-3 rounded-full bg-blue-500" />
              Dense
            </div>
            <span className="text-gray-600">+</span>
            <div className="flex items-center gap-1 text-xs text-green-400">
              <span className="w-3 h-3 rounded-full bg-green-500" />
              Sparse
            </div>
            <span className="text-gray-600">→</span>
            <div className="flex items-center gap-1 text-xs text-amber-400">
              <span className="w-3 h-3 rounded-full bg-amber-500" />
              RRF 融合
            </div>
            <span className="text-gray-600">→</span>
            <div className="flex items-center gap-1 text-xs text-purple-400">
              <span className="w-3 h-3 rounded-full bg-purple-500" />
              Rerank
            </div>
          </div>
          
          {/* 标签页 */}
          <div className="flex gap-2 border-b border-slate-700 pb-2">
            {[
              { key: 'reranked', label: '重排结果', count: retrieval.rerankedResults.length },
              { key: 'dense', label: 'Dense', count: retrieval.denseResults.length },
              { key: 'sparse', label: 'Sparse', count: retrieval.sparseResults.length },
              { key: 'merged', label: '合并', count: retrieval.mergedResults.length }
            ].map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key as any)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  activeTab === tab.key
                    ? 'bg-cyan-500/30 text-cyan-300'
                    : 'text-gray-400 hover:text-gray-300 hover:bg-slate-700'
                }`}
              >
                {tab.label} ({tab.count})
              </button>
            ))}
          </div>
          
          {/* 文档列表 */}
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {docs.length === 0 ? (
              <div className="text-center text-gray-500 py-4">无结果</div>
            ) : (
              docs.map((doc, idx) => (
                <div key={doc.id} className="bg-slate-800/50 rounded-lg p-3 border border-slate-700">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-gradient-to-r from-cyan-500 to-blue-500 flex items-center justify-center text-xs text-white">
                        {idx + 1}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        doc.source === 'dense' ? 'bg-blue-500/30 text-blue-300' :
                        doc.source === 'sparse' ? 'bg-green-500/30 text-green-300' :
                        'bg-amber-500/30 text-amber-300'
                      }`}>
                        {doc.source}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-gray-500">Score: {doc.score.toFixed(4)}</span>
                      {doc.rerankScore !== undefined && (
                        <span className="text-purple-400">Rerank: {doc.rerankScore.toFixed(4)}</span>
                      )}
                    </div>
                  </div>
                  <p className="text-sm text-gray-400 line-clamp-3">{doc.content}</p>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// 编排器决策面板
const OrchestratorPanel: React.FC<{ decision: OrchestratorDecision }> = ({ decision }) => {
  const actionConfig = {
    tool_call: { icon: '🔧', label: '调用工具', color: 'from-blue-500 to-cyan-500' },
    generate: { icon: '✨', label: '直接生成', color: 'from-emerald-500 to-teal-500' },
    clarify: { icon: '❓', label: '需要澄清', color: 'from-amber-500 to-orange-500' }
  };
  
  const config = actionConfig[decision.action] || actionConfig.generate;
  
  return (
    <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-xl border border-amber-500/30 p-4">
      <div className="flex items-center gap-3 mb-3">
        <span className="text-2xl">🎯</span>
        <span className="font-semibold text-white">编排器决策 (Orchestrator)</span>
      </div>
      
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-slate-800/50 rounded-lg p-3">
          <div className="text-xs text-gray-500 mb-1">决策动作</div>
          <div className={`inline-flex items-center gap-2 px-2 py-1 rounded bg-gradient-to-r ${config.color} text-white text-sm`}>
            <span>{config.icon}</span>
            <span>{config.label}</span>
          </div>
        </div>
        
        <div className="bg-slate-800/50 rounded-lg p-3">
          <div className="text-xs text-gray-500 mb-1">意图类型</div>
          <div className="text-sm text-amber-400 font-medium">{decision.intent}</div>
        </div>
        
        <div className="bg-slate-800/50 rounded-lg p-3">
          <div className="text-xs text-gray-500 mb-1">置信度</div>
          <div className="flex items-center gap-2">
            <div className="flex-1 h-2 bg-slate-700 rounded-full overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-amber-500 to-orange-500"
                style={{ width: `${decision.confidence * 100}%` }}
              />
            </div>
            <span className="text-sm text-amber-400">{(decision.confidence * 100).toFixed(0)}%</span>
          </div>
        </div>
      </div>
      
      {decision.reasoning && (
        <div className="mt-3 p-3 bg-slate-800/30 rounded-lg border border-slate-700">
          <div className="text-xs text-gray-500 mb-1">推理过程</div>
          <p className="text-sm text-gray-400">{decision.reasoning}</p>
        </div>
      )}
    </div>
  );
};

// 工作流时间轴
const WorkflowTimeline: React.FC<{ 
  executions: NodeExecution[];
  decisionPath: string[];
  totalDuration: number;
}> = ({ executions, decisionPath, totalDuration }) => {
  const nodeConfig: Record<string, { icon: string; label: string; color: string }> = {
    orchestrator: { icon: '🧠', label: '编排器', color: 'bg-purple-500' },
    tool_gateway: { icon: '🔒', label: '工具网关', color: 'bg-amber-500' },
    hybrid_retrieval: { icon: '🔍', label: '混合检索', color: 'bg-cyan-500' },
    reranker: { icon: '📊', label: '重排序', color: 'bg-blue-500' },
    formatter: { icon: '📝', label: '格式化', color: 'bg-green-500' },
    generator: { icon: '✨', label: '生成器', color: 'bg-pink-500' }
  };
  
  const statusColors = {
    completed: 'text-emerald-400 bg-emerald-500/20',
    running: 'text-blue-400 bg-blue-500/20 animate-pulse',
    pending: 'text-gray-400 bg-gray-500/20',
    skipped: 'text-gray-500 bg-gray-600/20',
    error: 'text-red-400 bg-red-500/20'
  };
  
  return (
    <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-xl border border-emerald-500/30 p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span className="text-2xl">⏱️</span>
          <span className="font-semibold text-white">工作流时间轴</span>
        </div>
        <span className="px-2 py-1 bg-emerald-500/20 text-emerald-300 text-xs rounded-full">
          总耗时: {totalDuration}ms
        </span>
      </div>
      
      {/* 决策路径 */}
      {decisionPath && decisionPath.length > 0 && (
        <div className="mb-4 p-3 bg-slate-800/30 rounded-lg">
          <div className="text-xs text-gray-500 mb-2">决策路径</div>
          <div className="flex flex-wrap gap-1">
            {decisionPath.map((step, idx) => (
              <React.Fragment key={idx}>
                <span className="px-2 py-0.5 bg-slate-700 text-gray-300 text-xs rounded">
                  {step}
                </span>
                {idx < decisionPath.length - 1 && (
                  <span className="text-gray-600">→</span>
                )}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
      
      {/* 节点执行列表 */}
      <div className="space-y-2">
        {executions.map((exec, idx) => {
          const config = nodeConfig[exec.node] || { icon: '⚙️', label: exec.node, color: 'bg-gray-500' };
          const statusStyle = statusColors[exec.status] || statusColors.pending;
          const widthPercent = totalDuration > 0 && exec.duration ? (exec.duration / totalDuration) * 100 : 0;
          
          return (
            <div key={idx} className="relative">
              <div className="flex items-center gap-3 p-2 bg-slate-800/50 rounded-lg border border-slate-700">
                <div className={`w-8 h-8 rounded-lg ${config.color} flex items-center justify-center text-lg`}>
                  {config.icon}
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-300">{config.label}</span>
                    <span className={`px-2 py-0.5 rounded text-xs ${statusStyle}`}>
                      {exec.status}
                    </span>
                  </div>
                  
                  {/* 耗时条 */}
                  <div className="mt-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                    <div 
                      className={`h-full ${config.color} transition-all duration-500`}
                      style={{ width: `${Math.min(widthPercent, 100)}%` }}
                    />
                  </div>
                  
                  {exec.duration !== undefined && (
                    <div className="mt-1 text-xs text-gray-500">
                      {exec.duration}ms ({widthPercent.toFixed(1)}%)
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ==================== 主组件 ====================

export default function ReasoningRAGVisualizer({
  query,
  answer,
  thinkingProcess = [],
  messages = [],
  retrieval,
  orchestratorDecision,
  workflow,
  config,
  isLoading = false,
  defaultExpanded = true
}: ReasoningRAGVisualizerProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  
  if (!query && !isLoading) {
    return null;
  }
  
  return (
    <div className="bg-gradient-to-br from-slate-950 via-purple-950/30 to-slate-950 rounded-2xl border border-purple-500/20 shadow-2xl overflow-hidden">
      {/* 头部 */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-6 py-4 flex items-center justify-between bg-gradient-to-r from-purple-900/40 via-pink-900/30 to-indigo-900/40 hover:from-purple-900/60 hover:via-pink-900/50 hover:to-indigo-900/60 transition-all"
      >
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-500 via-pink-500 to-indigo-500 flex items-center justify-center text-2xl shadow-lg">
            🧠
          </div>
          <div className="text-left">
            <h2 className="text-lg font-bold text-white">Reasoning RAG 工作流</h2>
            <p className="text-sm text-purple-300/70">
              推理模型 + 混合检索 + 思维链
            </p>
          </div>
          
          {config?.reasoningModel && (
            <span className="px-3 py-1 bg-purple-500/30 text-purple-300 text-xs rounded-full">
              {config.reasoningModel}
            </span>
          )}
        </div>
        
        <div className="flex items-center gap-4">
          {workflow && (
            <span className="px-3 py-1 bg-emerald-500/20 text-emerald-300 text-xs rounded-full">
              {workflow.totalDuration}ms
            </span>
          )}
          
          {isLoading && (
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
              <span className="text-purple-300 text-sm">思考中...</span>
            </div>
          )}
          
          <svg
            className={`w-6 h-6 text-purple-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>
      
      {/* 内容 */}
      {isExpanded && (
        <div className="p-6 space-y-6">
          {/* 配置信息 */}
          {config && (
            <div className="flex flex-wrap gap-2">
              <span className="px-2 py-1 bg-slate-800 text-gray-400 text-xs rounded">
                BM25: {config.enableBM25 ? '✓' : '✗'}
              </span>
              <span className="px-2 py-1 bg-slate-800 text-gray-400 text-xs rounded">
                Rerank: {config.enableRerank ? '✓' : '✗'}
              </span>
              <span className="px-2 py-1 bg-slate-800 text-gray-400 text-xs rounded">
                Top-K: {config.topK} → {config.rerankTopK}
              </span>
            </div>
          )}
          
          {/* 编排器决策 */}
          {orchestratorDecision && (
            <OrchestratorPanel decision={orchestratorDecision} />
          )}
          
          {/* 思维链 */}
          <ThinkingProcessPanel steps={thinkingProcess} />
          
          {/* 混合检索 */}
          {retrieval && (
            <HybridRetrievalPanel retrieval={retrieval} />
          )}
          
          {/* 工作流时间轴 */}
          {workflow && (
            <WorkflowTimeline 
              executions={workflow.nodeExecutions}
              decisionPath={workflow.decisionPath}
              totalDuration={workflow.totalDuration}
            />
          )}
          
          {/* 最终回答预览 */}
          {answer && (
            <div className="bg-gradient-to-r from-emerald-900/30 to-teal-900/30 rounded-xl border border-emerald-500/30 p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xl">✨</span>
                <span className="font-semibold text-emerald-300">最终回答</span>
              </div>
              <p className="text-gray-300 whitespace-pre-wrap">{answer}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

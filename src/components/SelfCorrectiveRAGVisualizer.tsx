'use client';

import React, { useState } from 'react';

// ==================== 类型定义 ====================

interface DocumentGrade {
  docId: string;
  isRelevant: boolean;
  confidence: number;
  reasoning: string;
}

interface GraderResult {
  passRate: number;
  passCount: number;
  totalCount: number;
  shouldRewrite: boolean;
  reasoning: string;
  documentGrades: DocumentGrade[];
}

interface RewriteHistory {
  original: string;
  rewritten: string;
  reason: string;
  keywords: string[];
  attempt: number;
}

interface NodeExecution {
  node: 'retrieve' | 'grade' | 'rewrite' | 'generate';
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'error';
  duration?: number;
  input?: any;
  output?: any;
  error?: string;
}

interface Document {
  id: string;
  content: string;
  score: number;
  gradeResult?: {
    isRelevant: boolean;
    confidence: number;
    reasoning: string;
  };
  metadata?: Record<string, any>;
}

interface SCRAGVisualizerProps {
  // 查询信息
  query?: {
    original: string;
    final: string;
    wasRewritten: boolean;
    rewriteCount: number;
  };
  // 重写历史
  rewriteHistory?: RewriteHistory[];
  // 检索结果
  retrieval?: {
    totalDocuments: number;
    filteredDocuments: number;
    documents: Document[];
  };
  // Grader 结果
  graderResult?: GraderResult | null;
  // 生成结果
  generation?: {
    confidence: number;
    usedDocuments: number;
    sources: string[];
  } | null;
  // 工作流
  workflow?: {
    nodeExecutions: NodeExecution[];
    decisionPath: string[];
    totalDuration: number;
  };
  // 回答
  answer?: string;
  // 错误
  error?: string;
  // UI 控制
  isLoading?: boolean;
  defaultExpanded?: boolean;
  className?: string;
}

// ==================== 节点图标和颜色 ====================

const nodeConfig = {
  retrieve: {
    icon: '🔍',
    label: 'Retrieve',
    description: '检索者',
    color: 'from-blue-500 to-cyan-500',
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-200',
  },
  grade: {
    icon: '🔬',
    label: 'Grader',
    description: '质检员',
    color: 'from-purple-500 to-pink-500',
    bgColor: 'bg-purple-50',
    borderColor: 'border-purple-200',
  },
  rewrite: {
    icon: '✏️',
    label: 'Rewrite',
    description: '修正者',
    color: 'from-orange-500 to-amber-500',
    bgColor: 'bg-orange-50',
    borderColor: 'border-orange-200',
  },
  generate: {
    icon: '💬',
    label: 'Generate',
    description: '生成者',
    color: 'from-green-500 to-emerald-500',
    bgColor: 'bg-green-50',
    borderColor: 'border-green-200',
  },
};

const statusColors = {
  pending: 'bg-gray-200 text-gray-600',
  running: 'bg-blue-200 text-blue-700 animate-pulse',
  completed: 'bg-green-200 text-green-700',
  skipped: 'bg-gray-200 text-gray-500',
  error: 'bg-red-200 text-red-700',
};

// ==================== 子组件 ====================

/** 节点卡片 */
const NodeCard: React.FC<{
  node: NodeExecution;
  isActive?: boolean;
}> = ({ node, isActive }) => {
  const config = nodeConfig[node.node];
  
  return (
    <div className={`relative p-4 rounded-xl border-2 transition-all duration-300 ${
      isActive ? 'border-indigo-400 shadow-lg scale-105' : config.borderColor
    } ${config.bgColor}`}>
      {/* 状态指示器 */}
      <div className={`absolute -top-2 -right-2 px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[node.status]}`}>
        {node.status === 'completed' ? '✓' : node.status === 'running' ? '...' : node.status === 'error' ? '✗' : '○'}
      </div>
      
      {/* 节点内容 */}
      <div className="flex items-center gap-3">
        <div className={`text-3xl p-2 rounded-lg bg-gradient-to-br ${config.color} bg-opacity-20`}>
          {config.icon}
        </div>
        <div>
          <div className="font-bold text-gray-800">{config.label}</div>
          <div className="text-xs text-gray-500">{config.description}</div>
        </div>
      </div>
      
      {/* 执行时间 */}
      {node.duration !== undefined && (
        <div className="mt-2 text-xs text-gray-600">
          ⏱️ {node.duration}ms
        </div>
      )}
      
      {/* 错误信息 */}
      {node.error && (
        <div className="mt-2 text-xs text-red-600 bg-red-50 p-2 rounded">
          ❌ {node.error}
        </div>
      )}
    </div>
  );
};

/** 连接箭头 */
const Arrow: React.FC<{ isLoop?: boolean; isActive?: boolean }> = ({ isLoop, isActive }) => (
  <div className={`flex items-center justify-center ${isLoop ? 'flex-col' : ''}`}>
    {isLoop ? (
      <div className={`text-2xl ${isActive ? 'text-orange-500' : 'text-gray-300'}`}>
        ↩️
      </div>
    ) : (
      <div className={`text-2xl ${isActive ? 'text-indigo-500' : 'text-gray-300'}`}>
        →
      </div>
    )}
  </div>
);

/** Grader 详情面板 */
const GraderPanel: React.FC<{ graderResult: GraderResult }> = ({ graderResult }) => {
  const [showDetails, setShowDetails] = useState(false);
  
  return (
    <div className="bg-white rounded-xl border border-purple-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-semibold text-purple-800 flex items-center gap-2">
          🔬 质检结果
        </h4>
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="text-xs text-purple-600 hover:underline"
        >
          {showDetails ? '收起' : '展开详情'}
        </button>
      </div>
      
      {/* 通过率进度条 */}
      <div className="mb-3">
        <div className="flex justify-between text-sm mb-1">
          <span className="text-gray-600">通过率</span>
          <span className={`font-bold ${graderResult.passRate >= 0.6 ? 'text-green-600' : 'text-red-600'}`}>
            {(graderResult.passRate * 100).toFixed(1)}%
          </span>
        </div>
        <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-500 ${
              graderResult.passRate >= 0.6 ? 'bg-gradient-to-r from-green-400 to-emerald-500' : 'bg-gradient-to-r from-red-400 to-orange-500'
            }`}
            style={{ width: `${graderResult.passRate * 100}%` }}
          />
        </div>
      </div>
      
      {/* 统计信息 */}
      <div className="grid grid-cols-3 gap-2 text-center mb-3">
        <div className="bg-gray-50 rounded-lg p-2">
          <div className="text-lg font-bold text-gray-800">{graderResult.passCount}</div>
          <div className="text-xs text-gray-500">通过</div>
        </div>
        <div className="bg-gray-50 rounded-lg p-2">
          <div className="text-lg font-bold text-gray-800">{graderResult.totalCount - graderResult.passCount}</div>
          <div className="text-xs text-gray-500">未通过</div>
        </div>
        <div className="bg-gray-50 rounded-lg p-2">
          <div className={`text-lg font-bold ${graderResult.shouldRewrite ? 'text-orange-600' : 'text-green-600'}`}>
            {graderResult.shouldRewrite ? '需要' : '无需'}
          </div>
          <div className="text-xs text-gray-500">重写</div>
        </div>
      </div>
      
      {/* 评估理由 */}
      <div className="text-sm text-gray-600 bg-purple-50 rounded-lg p-2">
        💭 {graderResult.reasoning}
      </div>
      
      {/* 文档详情 */}
      {showDetails && graderResult.documentGrades.length > 0 && (
        <div className="mt-3 space-y-2">
          <div className="text-xs font-medium text-gray-500">各文档评分:</div>
          {graderResult.documentGrades.map((grade, idx) => (
            <div key={idx} className={`text-xs p-2 rounded-lg ${grade.isRelevant ? 'bg-green-50' : 'bg-red-50'}`}>
              <div className="flex items-center gap-2">
                <span className={grade.isRelevant ? 'text-green-600' : 'text-red-600'}>
                  {grade.isRelevant ? '✓' : '✗'}
                </span>
                <span className="font-medium">文档 {idx + 1}</span>
                <span className="text-gray-500">置信度: {(grade.confidence * 100).toFixed(0)}%</span>
              </div>
              <div className="mt-1 text-gray-600">{grade.reasoning}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/** 重写历史面板 */
const RewriteHistoryPanel: React.FC<{ history: RewriteHistory[] }> = ({ history }) => {
  if (history.length === 0) return null;
  
  return (
    <div className="bg-white rounded-xl border border-orange-200 p-4">
      <h4 className="font-semibold text-orange-800 flex items-center gap-2 mb-3">
        ✏️ 查询重写历史 ({history.length} 次)
      </h4>
      
      <div className="space-y-3">
        {history.map((item, idx) => (
          <div key={idx} className="bg-orange-50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="bg-orange-200 text-orange-800 text-xs font-bold px-2 py-0.5 rounded-full">
                第 {item.attempt} 次
              </span>
            </div>
            
            <div className="space-y-1 text-sm">
              <div className="flex items-start gap-2">
                <span className="text-gray-500 w-12 flex-shrink-0">原:</span>
                <span className="text-gray-600">{item.original}</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-orange-500 w-12 flex-shrink-0">新:</span>
                <span className="text-orange-700 font-medium">{item.rewritten}</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-gray-500 w-12 flex-shrink-0">因:</span>
                <span className="text-gray-600">{item.reason}</span>
              </div>
            </div>
            
            {item.keywords.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {item.keywords.map((kw, i) => (
                  <span key={i} className="bg-orange-200 text-orange-700 text-xs px-2 py-0.5 rounded">
                    {kw}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

/** 决策路径可视化 */
const DecisionPath: React.FC<{ path: string[] }> = ({ path }) => (
  <div className="bg-white rounded-xl border border-gray-200 p-4">
    <h4 className="font-semibold text-gray-800 flex items-center gap-2 mb-3">
      🗺️ 决策路径
    </h4>
    
    <div className="relative">
      {path.map((step, idx) => (
        <div key={idx} className="flex items-start gap-3 mb-2 last:mb-0">
          <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
            step.includes('RETRIEVE') ? 'bg-blue-100 text-blue-600' :
            step.includes('GRADE') ? 'bg-purple-100 text-purple-600' :
            step.includes('REWRITE') ? 'bg-orange-100 text-orange-600' :
            step.includes('GENERATE') ? 'bg-green-100 text-green-600' :
            'bg-gray-100 text-gray-600'
          }`}>
            {idx + 1}
          </div>
          <div className="flex-1 text-sm text-gray-700 pt-0.5">{step}</div>
        </div>
      ))}
    </div>
  </div>
);

// ==================== 主组件 ====================

export default function SelfCorrectiveRAGVisualizer({
  query,
  rewriteHistory = [],
  retrieval,
  graderResult,
  generation,
  workflow,
  answer,
  error,
  isLoading = false,
  defaultExpanded = true,
  className = '',
}: SCRAGVisualizerProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [activeTab, setActiveTab] = useState<'flow' | 'details' | 'result'>('flow');
  
  // 没有数据时显示占位
  if (!workflow?.nodeExecutions?.length && !isLoading) {
    return null;
  }
  
  return (
    <div className={`bg-gradient-to-br from-slate-50 to-indigo-50 rounded-2xl border border-indigo-100 overflow-hidden ${className}`}>
      {/* 头部 */}
      <div 
        className="px-6 py-4 bg-gradient-to-r from-indigo-600 to-purple-600 cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="text-3xl">🔄</div>
            <div>
              <h3 className="text-lg font-bold text-white">Self-Corrective RAG</h3>
              <p className="text-sm text-indigo-200">自省式修正检索增强生成</p>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            {/* 状态徽章 */}
            {isLoading ? (
              <span className="px-3 py-1 bg-yellow-400 text-yellow-900 rounded-full text-sm font-medium animate-pulse">
                执行中...
              </span>
            ) : error ? (
              <span className="px-3 py-1 bg-red-400 text-white rounded-full text-sm font-medium">
                错误
              </span>
            ) : workflow?.totalDuration ? (
              <span className="px-3 py-1 bg-green-400 text-green-900 rounded-full text-sm font-medium">
                完成 · {workflow.totalDuration}ms
              </span>
            ) : null}
            
            {/* 重写次数 */}
            {query?.rewriteCount !== undefined && query.rewriteCount > 0 && (
              <span className="px-3 py-1 bg-orange-400 text-orange-900 rounded-full text-sm font-medium">
                重写 {query.rewriteCount} 次
              </span>
            )}
            
            {/* 展开/收起按钮 */}
            <button className="text-white hover:bg-white/20 p-2 rounded-lg transition-colors">
              {isExpanded ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
      
      {/* 内容区域 */}
      {isExpanded && (
        <div className="p-6">
          {/* 标签页切换 */}
          <div className="flex gap-2 mb-6">
            {[
              { id: 'flow', label: '工作流', icon: '📊' },
              { id: 'details', label: '详细信息', icon: '📋' },
              { id: 'result', label: '结果', icon: '💡' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`px-4 py-2 rounded-lg font-medium transition-all ${
                  activeTab === tab.id
                    ? 'bg-indigo-600 text-white shadow-md'
                    : 'bg-white text-gray-600 hover:bg-indigo-50'
                }`}
              >
                {tab.icon} {tab.label}
              </button>
            ))}
          </div>
          
          {/* 工作流视图 */}
          {activeTab === 'flow' && (
            <div className="space-y-6">
              {/* 节点流程图 */}
              <div className="bg-white rounded-xl p-6 border border-gray-200">
                <h4 className="font-semibold text-gray-800 mb-4">🔄 4 节点质量控制闭环</h4>
                
                <div className="flex items-center justify-center gap-4 flex-wrap">
                  {/* Retrieve */}
                  <NodeCard 
                    node={workflow?.nodeExecutions?.find(n => n.node === 'retrieve') || { node: 'retrieve', status: 'pending' }}
                    isActive={workflow?.nodeExecutions?.find(n => n.node === 'retrieve')?.status === 'running'}
                  />
                  
                  <Arrow />
                  
                  {/* Grade */}
                  <NodeCard 
                    node={workflow?.nodeExecutions?.find(n => n.node === 'grade') || { node: 'grade', status: 'pending' }}
                    isActive={workflow?.nodeExecutions?.find(n => n.node === 'grade')?.status === 'running'}
                  />
                  
                  {/* 条件分支 */}
                  <div className="flex flex-col items-center gap-2">
                    <Arrow isActive={query?.wasRewritten} />
                    {query?.wasRewritten && (
                      <div className="text-xs text-orange-600 bg-orange-50 px-2 py-1 rounded">
                        质检未通过
                      </div>
                    )}
                  </div>
                  
                  {/* Rewrite (条件显示) */}
                  {rewriteHistory.length > 0 && (
                    <>
                      <NodeCard 
                        node={workflow?.nodeExecutions?.find(n => n.node === 'rewrite') || { node: 'rewrite', status: 'pending' }}
                        isActive={workflow?.nodeExecutions?.find(n => n.node === 'rewrite')?.status === 'running'}
                      />
                      <Arrow isLoop isActive />
                    </>
                  )}
                  
                  {/* Generate */}
                  {!query?.wasRewritten && <Arrow />}
                  <NodeCard 
                    node={workflow?.nodeExecutions?.find(n => n.node === 'generate') || { node: 'generate', status: 'pending' }}
                    isActive={workflow?.nodeExecutions?.find(n => n.node === 'generate')?.status === 'running'}
                  />
                </div>
              </div>
              
              {/* 决策路径 */}
              {workflow?.decisionPath && workflow.decisionPath.length > 0 && (
                <DecisionPath path={workflow.decisionPath} />
              )}
            </div>
          )}
          
          {/* 详细信息视图 */}
          {activeTab === 'details' && (
            <div className="space-y-4">
              {/* 查询信息 */}
              {query && (
                <div className="bg-white rounded-xl border border-blue-200 p-4">
                  <h4 className="font-semibold text-blue-800 flex items-center gap-2 mb-3">
                    🔍 查询信息
                  </h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex items-start gap-2">
                      <span className="text-gray-500 w-20 flex-shrink-0">原始查询:</span>
                      <span className="text-gray-800">{query.original}</span>
                    </div>
                    {query.wasRewritten && (
                      <div className="flex items-start gap-2">
                        <span className="text-orange-500 w-20 flex-shrink-0">最终查询:</span>
                        <span className="text-orange-700 font-medium">{query.final}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
              
              {/* Grader 结果 */}
              {graderResult && <GraderPanel graderResult={graderResult} />}
              
              {/* 重写历史 */}
              <RewriteHistoryPanel history={rewriteHistory} />
              
              {/* 检索结果 */}
              {retrieval && retrieval.documents.length > 0 && (
                <div className="bg-white rounded-xl border border-green-200 p-4">
                  <h4 className="font-semibold text-green-800 flex items-center gap-2 mb-3">
                    📚 检索结果 ({retrieval.filteredDocuments}/{retrieval.totalDocuments} 通过质检)
                  </h4>
                  <div className="space-y-2">
                    {retrieval.documents.slice(0, 3).map((doc, idx) => (
                      <div key={idx} className="bg-green-50 rounded-lg p-3">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            doc.gradeResult?.isRelevant ? 'bg-green-200 text-green-700' : 'bg-gray-200 text-gray-600'
                          }`}>
                            {doc.gradeResult?.isRelevant ? '✓ 相关' : '○ 待验证'}
                          </span>
                          <span className="text-xs text-gray-500">
                            相似度: {(doc.score * 100).toFixed(1)}%
                          </span>
                        </div>
                        <p className="text-sm text-gray-700 line-clamp-2">{doc.content}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          
          {/* 结果视图 */}
          {activeTab === 'result' && (
            <div className="space-y-4">
              {/* 生成统计 */}
              {generation && (
                <div className="bg-white rounded-xl border border-emerald-200 p-4">
                  <h4 className="font-semibold text-emerald-800 flex items-center gap-2 mb-3">
                    📊 生成统计
                  </h4>
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div className="bg-emerald-50 rounded-lg p-3">
                      <div className="text-2xl font-bold text-emerald-600">
                        {(generation.confidence * 100).toFixed(0)}%
                      </div>
                      <div className="text-xs text-gray-500">置信度</div>
                    </div>
                    <div className="bg-emerald-50 rounded-lg p-3">
                      <div className="text-2xl font-bold text-emerald-600">
                        {generation.usedDocuments}
                      </div>
                      <div className="text-xs text-gray-500">使用文档</div>
                    </div>
                    <div className="bg-emerald-50 rounded-lg p-3">
                      <div className="text-2xl font-bold text-emerald-600">
                        {generation.sources.length}
                      </div>
                      <div className="text-xs text-gray-500">来源</div>
                    </div>
                  </div>
                </div>
              )}
              
              {/* 回答内容 */}
              {answer && (
                <div className="bg-white rounded-xl border border-gray-200 p-4">
                  <h4 className="font-semibold text-gray-800 flex items-center gap-2 mb-3">
                    💬 生成的回答
                  </h4>
                  <div className="prose prose-sm max-w-none text-gray-700">
                    {answer}
                  </div>
                </div>
              )}
              
              {/* 错误信息 */}
              {error && (
                <div className="bg-red-50 rounded-xl border border-red-200 p-4">
                  <h4 className="font-semibold text-red-800 flex items-center gap-2 mb-2">
                    ❌ 错误
                  </h4>
                  <p className="text-sm text-red-700">{error}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

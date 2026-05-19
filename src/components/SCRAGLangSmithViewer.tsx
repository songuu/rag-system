'use client';

import React, { useState, useMemo } from 'react';
import LangSmithReactFlowGraph, { type LangSmithFlowStep } from './LangSmithReactFlowGraph';

// ==================== 类型定义 ====================

interface NodeExecution {
  node: 'retrieve' | 'grade' | 'rewrite' | 'generate';
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'error';
  duration?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
}

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

interface SCRAGLangSmithViewerProps {
  nodeExecutions?: NodeExecution[];
  decisionPath?: string[];
  graderResult?: GraderResult | null;
  rewriteHistory?: RewriteHistory[];
  totalDuration?: number;
  query?: {
    original: string;
    final: string;
    wasRewritten: boolean;
    rewriteCount: number;
  };
  isLoading?: boolean;
  defaultExpanded?: boolean;
  className?: string;
}

// 节点配置
const NODE_CONFIG = {
  retrieve: {
    name: 'Retrieve',
    icon: '🔍',
    color: 'from-blue-500 to-cyan-500',
    bgColor: 'bg-blue-500/10',
    borderColor: 'border-blue-500/30',
    description: '检索者 - 向量搜索',
  },
  grade: {
    name: 'Grader',
    icon: '🔬',
    color: 'from-purple-500 to-pink-500',
    bgColor: 'bg-purple-500/10',
    borderColor: 'border-purple-500/30',
    description: '质检员 - LLM 评估',
  },
  rewrite: {
    name: 'Rewrite',
    icon: '✏️',
    color: 'from-orange-500 to-amber-500',
    bgColor: 'bg-orange-500/10',
    borderColor: 'border-orange-500/30',
    description: '修正者 - 查询重写',
  },
  generate: {
    name: 'Generate',
    icon: '💬',
    color: 'from-green-500 to-emerald-500',
    bgColor: 'bg-green-500/10',
    borderColor: 'border-green-500/30',
    description: '生成者 - 回答生成',
  },
};

// 状态配置
const STATUS_CONFIG = {
  pending: { color: 'text-gray-400', bgColor: 'bg-gray-100', icon: '○', label: '等待' },
  running: { color: 'text-blue-500', bgColor: 'bg-blue-100', icon: '◐', label: '执行中' },
  completed: { color: 'text-green-500', bgColor: 'bg-green-100', icon: '✓', label: '完成' },
  skipped: { color: 'text-yellow-500', bgColor: 'bg-yellow-100', icon: '⊘', label: '跳过' },
  error: { color: 'text-red-500', bgColor: 'bg-red-100', icon: '✗', label: '错误' },
};

function buildSCRAGFlowSteps(
  decisionPath: string[],
  nodeExecutions: NodeExecution[]
): LangSmithFlowStep[] {
  if (decisionPath.length > 0) {
    return decisionPath.map((step, index) => {
      const nodeType = inferSCRAGNodeType(step);
      const execution = nodeExecutions.find(item => item.node === nodeType);
      return {
        id: `scrag-path-${index}-${nodeType}`,
        label: NODE_CONFIG[nodeType].name,
        description: step,
        kind: nodeType,
        status: execution?.status ?? 'completed',
        duration: execution?.duration,
        error: execution?.error,
        layer: index,
        metadata: {
          decision: step,
          rewrite: nodeType === 'rewrite' ? 'true' : undefined,
        },
      };
    });
  }

  return nodeExecutions.map((execution, index) => ({
    id: `scrag-${execution.node}-${index}`,
    label: NODE_CONFIG[execution.node].name,
    description: NODE_CONFIG[execution.node].description,
    kind: execution.node,
    status: execution.status,
    duration: execution.duration,
    error: execution.error,
    layer: index,
    metadata: {
      hasInput: execution.input ? 'true' : undefined,
      hasOutput: execution.output ? 'true' : undefined,
    },
  }));
}

function inferSCRAGNodeType(step: string): NodeExecution['node'] {
  if (step.includes('GRADE')) return 'grade';
  if (step.includes('REWRITE')) return 'rewrite';
  if (step.includes('GENERATE')) return 'generate';
  return 'retrieve';
}

// ==================== 子组件 ====================

/** 时间轴视图 */
const TimelineView: React.FC<{
  nodeExecutions: NodeExecution[];
  totalDuration?: number;
}> = ({ nodeExecutions, totalDuration }) => {
  // 按执行顺序排序
  const sortedExecutions = [...nodeExecutions];
  
  return (
    <div className="space-y-3">
      {sortedExecutions.map((exec, idx) => {
        const config = NODE_CONFIG[exec.node];
        const status = STATUS_CONFIG[exec.status];
        const percentage = totalDuration && exec.duration 
          ? (exec.duration / totalDuration * 100).toFixed(1) 
          : 0;
        
        return (
          <div key={idx} className={`rounded-lg border ${config.borderColor} ${config.bgColor} p-3`}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-xl">{config.icon}</span>
                <span className="font-medium text-gray-800">{config.name}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${status.bgColor} ${status.color}`}>
                  {status.icon} {status.label}
                </span>
              </div>
              <div className="text-sm text-gray-500">
                {exec.duration ? `${exec.duration}ms` : '-'}
                {percentage ? ` (${percentage}%)` : ''}
              </div>
            </div>
            
            {/* 进度条 */}
            {totalDuration && exec.duration && (
              <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                <div 
                  className={`h-full bg-gradient-to-r ${config.color} transition-all duration-500`}
                  style={{ width: `${Math.min(100, (exec.duration / totalDuration) * 100)}%` }}
                />
              </div>
            )}
            
            {/* 错误信息 */}
            {exec.error && (
              <div className="mt-2 text-xs text-red-600 bg-red-50 rounded p-2">
                ❌ {exec.error}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

/** 决策树视图 */
const DecisionTreeView: React.FC<{
  decisionPath: string[];
  nodeExecutions: NodeExecution[];
}> = ({ decisionPath, nodeExecutions }) => {
  const flowSteps = buildSCRAGFlowSteps(decisionPath, nodeExecutions);

  return (
    <LangSmithReactFlowGraph
      steps={flowSteps}
      emptyMessage="暂无 Self-Corrective RAG 决策路径"
    />
  );
};

/** Grader 详情视图 */
const GraderDetailView: React.FC<{
  graderResult: GraderResult;
}> = ({ graderResult }) => {
  const [showAllDocs, setShowAllDocs] = useState(false);
  const displayDocs = showAllDocs 
    ? graderResult.documentGrades 
    : graderResult.documentGrades.slice(0, 3);
  
  return (
    <div className="space-y-4">
      {/* 通过率仪表盘 */}
      <div className="bg-gradient-to-br from-purple-50 to-pink-50 rounded-xl p-4 border border-purple-200">
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-semibold text-gray-800 flex items-center gap-2">
            🔬 LLM 质检结果
          </h4>
          <span className={`text-lg font-bold ${
            graderResult.passRate >= 0.6 ? 'text-green-600' : 'text-red-600'
          }`}>
            {(graderResult.passRate * 100).toFixed(0)}%
          </span>
        </div>
        
        {/* 可视化通过率 */}
        <div className="relative h-4 bg-gray-200 rounded-full overflow-hidden mb-3">
          <div 
            className={`absolute inset-y-0 left-0 rounded-full transition-all duration-1000 ${
              graderResult.passRate >= 0.6 
                ? 'bg-gradient-to-r from-green-400 to-emerald-500' 
                : 'bg-gradient-to-r from-red-400 to-orange-500'
            }`}
            style={{ width: `${graderResult.passRate * 100}%` }}
          />
          {/* 阈值线 */}
          <div className="absolute inset-y-0 left-[60%] w-0.5 bg-gray-600" title="60% 阈值" />
        </div>
        
        {/* 统计数字 */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="bg-white rounded-lg p-2">
            <div className="text-xl font-bold text-green-600">{graderResult.passCount}</div>
            <div className="text-xs text-gray-500">通过</div>
          </div>
          <div className="bg-white rounded-lg p-2">
            <div className="text-xl font-bold text-red-600">{graderResult.totalCount - graderResult.passCount}</div>
            <div className="text-xs text-gray-500">未通过</div>
          </div>
          <div className="bg-white rounded-lg p-2">
            <div className={`text-xl font-bold ${graderResult.shouldRewrite ? 'text-orange-600' : 'text-green-600'}`}>
              {graderResult.shouldRewrite ? '是' : '否'}
            </div>
            <div className="text-xs text-gray-500">需重写</div>
          </div>
        </div>
      </div>
      
      {/* 文档评估详情 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h5 className="text-sm font-medium text-gray-700">文档评估详情</h5>
          {graderResult.documentGrades.length > 3 && (
            <button 
              onClick={() => setShowAllDocs(!showAllDocs)}
              className="text-xs text-purple-600 hover:underline"
            >
              {showAllDocs ? '收起' : `查看全部 ${graderResult.documentGrades.length} 个`}
            </button>
          )}
        </div>
        
        {displayDocs.map((doc, idx) => (
          <div 
            key={idx}
            className={`rounded-lg p-3 border ${
              doc.isRelevant 
                ? 'bg-green-50 border-green-200' 
                : 'bg-red-50 border-red-200'
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="font-medium text-sm">
                {doc.isRelevant ? '✅' : '❌'} 文档 {idx + 1}
              </span>
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                doc.isRelevant ? 'bg-green-200 text-green-700' : 'bg-red-200 text-red-700'
              }`}>
                置信度: {(doc.confidence * 100).toFixed(0)}%
              </span>
            </div>
            <p className="text-xs text-gray-600">{doc.reasoning}</p>
          </div>
        ))}
      </div>
      
      {/* 整体评估理由 */}
      <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
        <div className="text-sm text-gray-700">
          <span className="font-medium">💭 评估结论：</span>
          {graderResult.reasoning}
        </div>
      </div>
    </div>
  );
};

/** 重写历史视图 */
const RewriteHistoryView: React.FC<{
  history: RewriteHistory[];
  originalQuery: string;
  finalQuery: string;
}> = ({ history, originalQuery, finalQuery }) => {
  if (history.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        <span className="text-4xl block mb-2">✨</span>
        <p>无需重写，首次检索即通过质检</p>
      </div>
    );
  }
  
  return (
    <div className="space-y-4">
      {/* 查询演变可视化 */}
      <div className="bg-gradient-to-r from-blue-50 via-orange-50 to-green-50 rounded-xl p-4 border">
        <h5 className="text-sm font-medium text-gray-700 mb-3">📝 查询演变路径</h5>
        <div className="flex items-center gap-2 overflow-x-auto pb-2">
          <div className="flex-shrink-0 bg-blue-100 text-blue-700 px-3 py-1.5 rounded-lg text-sm">
            {originalQuery}
          </div>
          {history.map((item, idx) => (
            <React.Fragment key={idx}>
              <span className="text-orange-500 flex-shrink-0">→</span>
              <div className="flex-shrink-0 bg-orange-100 text-orange-700 px-3 py-1.5 rounded-lg text-sm">
                {item.rewritten}
              </div>
            </React.Fragment>
          ))}
          {finalQuery !== originalQuery && (
            <>
              <span className="text-green-500 flex-shrink-0">✓</span>
              <div className="flex-shrink-0 bg-green-100 text-green-700 px-3 py-1.5 rounded-lg text-sm font-medium">
                最终查询
              </div>
            </>
          )}
        </div>
      </div>
      
      {/* 重写详情 */}
      {history.map((item, idx) => (
        <div key={idx} className="bg-white rounded-lg border border-orange-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="px-2 py-0.5 bg-orange-100 text-orange-700 rounded-full text-xs font-medium">
              第 {item.attempt} 次重写
            </span>
          </div>
          
          <div className="space-y-2 text-sm">
            <div className="flex gap-2">
              <span className="text-gray-500 w-12 flex-shrink-0">原:</span>
              <span className="text-gray-700">{item.original}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-orange-500 w-12 flex-shrink-0">新:</span>
              <span className="text-orange-700 font-medium">{item.rewritten}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-gray-500 w-12 flex-shrink-0">因:</span>
              <span className="text-gray-600">{item.reason}</span>
            </div>
          </div>
          
          {item.keywords.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {item.keywords.map((kw, i) => (
                <span key={i} className="bg-orange-50 text-orange-600 text-xs px-2 py-0.5 rounded">
                  {kw}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

// ==================== 主组件 ====================

export default function SCRAGLangSmithViewer({
  nodeExecutions = [],
  decisionPath = [],
  graderResult,
  rewriteHistory = [],
  totalDuration,
  query,
  isLoading = false,
  defaultExpanded = false,
  className = '',
}: SCRAGLangSmithViewerProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [activeTab, setActiveTab] = useState<'timeline' | 'tree' | 'grader' | 'rewrite'>('timeline');
  
  // 统计信息
  const stats = useMemo(() => {
    const completed = nodeExecutions.filter(n => n.status === 'completed').length;
    const errors = nodeExecutions.filter(n => n.status === 'error').length;
    return { completed, errors, total: nodeExecutions.length };
  }, [nodeExecutions]);

  // 没有数据时不显示
  if (!nodeExecutions.length && !isLoading) {
    return null;
  }
  
  return (
    <div className={`bg-gradient-to-br from-slate-900 via-indigo-900 to-purple-900 rounded-2xl overflow-hidden ${className}`}>
      {/* 头部 */}
      <div 
        className="px-6 py-4 cursor-pointer hover:bg-white/5 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-teal-400 to-cyan-500 flex items-center justify-center">
              <span className="text-xl">📊</span>
            </div>
            <div>
              <h3 className="text-lg font-bold text-white">LangSmith 追踪可视化</h3>
              <p className="text-sm text-white/60">Self-Corrective RAG 执行追踪</p>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            {/* 状态徽章 */}
            {isLoading ? (
              <span className="px-3 py-1 bg-blue-500/30 text-blue-300 rounded-full text-sm animate-pulse">
                执行中...
              </span>
            ) : stats.errors > 0 ? (
              <span className="px-3 py-1 bg-red-500/30 text-red-300 rounded-full text-sm">
                {stats.errors} 个错误
              </span>
            ) : (
              <span className="px-3 py-1 bg-green-500/30 text-green-300 rounded-full text-sm">
                {stats.completed}/{stats.total} 完成
              </span>
            )}
            
            {/* 耗时 */}
            {totalDuration && (
              <span className="text-white/60 text-sm">
                ⏱️ {totalDuration}ms
              </span>
            )}
            
            {/* 重写次数 */}
            {query?.rewriteCount !== undefined && query.rewriteCount > 0 && (
              <span className="px-3 py-1 bg-orange-500/30 text-orange-300 rounded-full text-sm">
                🔄 重写 {query.rewriteCount} 次
              </span>
            )}
            
            {/* 展开/收起 */}
            <button className="text-white/60 hover:text-white p-2 rounded-lg hover:bg-white/10 transition-colors">
              <svg 
                className={`w-5 h-5 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                fill="none" 
                stroke="currentColor" 
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
        </div>
      </div>
      
      {/* 内容区域 */}
      {isExpanded && (
        <div className="px-6 pb-6">
          {/* 标签页 */}
          <div className="flex gap-2 mb-4 overflow-x-auto pb-2">
            {([
              { id: 'timeline', label: '时间轴', icon: '📈' },
              { id: 'tree', label: 'ReactFlow', icon: '▣' },
              { id: 'grader', label: 'Grader', icon: '🔬' },
              { id: 'rewrite', label: '重写历史', icon: '✏️' },
            ] satisfies Array<{ id: typeof activeTab; label: string; icon: string }>).map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2 rounded-lg font-medium whitespace-nowrap transition-all ${
                  activeTab === tab.id
                    ? 'bg-white text-gray-800 shadow-lg'
                    : 'bg-white/10 text-white/70 hover:bg-white/20'
                }`}
              >
                {tab.icon} {tab.label}
              </button>
            ))}
          </div>
          
          {/* 内容面板 */}
          <div className="bg-white rounded-xl p-4">
            {activeTab === 'timeline' && (
              <TimelineView 
                nodeExecutions={nodeExecutions} 
                totalDuration={totalDuration}
              />
            )}
            
            {activeTab === 'tree' && (
              <DecisionTreeView 
                decisionPath={decisionPath}
                nodeExecutions={nodeExecutions}
              />
            )}
            
            {activeTab === 'grader' && graderResult && (
              <GraderDetailView graderResult={graderResult} />
            )}
            
            {activeTab === 'grader' && !graderResult && (
              <div className="text-center py-8 text-gray-500">
                <span className="text-4xl block mb-2">📭</span>
                <p>暂无 Grader 评估数据</p>
              </div>
            )}
            
            {activeTab === 'rewrite' && (
              <RewriteHistoryView 
                history={rewriteHistory}
                originalQuery={query?.original || ''}
                finalQuery={query?.final || ''}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

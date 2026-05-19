'use client';

import React, { useState, useMemo } from 'react';
import LangSmithReactFlowGraph, { type LangSmithFlowStep } from './LangSmithReactFlowGraph';

type LangSmithViewerTab = 'timeline' | 'tree' | 'metrics' | 'debug';

interface WorkflowStep {
  id: string;
  parentId?: string;
  step?: string;
  name?: string;
  type?: string;
  status?: string;
  startTime?: number;
  endTime?: number;
  duration?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  tokens?: { input: number; output: number; total: number };
  cost?: number;
  metadata?: Record<string, unknown>;
  model?: string;
}

interface QueryAnalysis {
  intent?: string;
  complexity?: string;
  needsRetrieval?: boolean;
  keywords?: string[];
}

interface RetrievalGrade {
  score: number;
  keywordMatchScore: number;
  semanticScore: number;
  isRelevant: boolean;
  reasoning?: string;
}

// 调试信息类型
interface DebugInfo {
  milvusQueryVector?: number[];
  milvusRawScores?: number[];
  embeddingModel?: string;
  collectionDimension?: number;
}

interface LangSmithTraceViewerProps {
  workflowSteps?: WorkflowStep[];
  queryAnalysis?: QueryAnalysis;
  retrievalGrade?: RetrievalGrade;
  debugInfo?: DebugInfo;
  totalDuration?: number;
  className?: string;
  defaultExpanded?: boolean;
}

// 步骤类型图标映射
const STEP_TYPE_CONFIG: Record<string, { icon: string; color: string; bgColor: string }> = {
  '查询分析与优化': { icon: 'fa-search-plus', color: 'text-blue-400', bgColor: 'bg-blue-500/20' },
  '文档检索': { icon: 'fa-database', color: 'text-purple-400', bgColor: 'bg-purple-500/20' },
  '检索评估': { icon: 'fa-check-double', color: 'text-cyan-400', bgColor: 'bg-cyan-500/20' },
  '自省评分': { icon: 'fa-brain', color: 'text-pink-400', bgColor: 'bg-pink-500/20' },
  '检索质量评估': { icon: 'fa-chart-bar', color: 'text-orange-400', bgColor: 'bg-orange-500/20' },
  '答案生成': { icon: 'fa-magic', color: 'text-green-400', bgColor: 'bg-green-500/20' },
  '幻觉检查': { icon: 'fa-shield-alt', color: 'text-red-400', bgColor: 'bg-red-500/20' },
  '查询重写': { icon: 'fa-redo', color: 'text-yellow-400', bgColor: 'bg-yellow-500/20' },
};

// 状态颜色映射
const STATUS_CONFIG: Record<string, { color: string; icon: string; label: string }> = {
  pending: { color: 'text-gray-400', icon: 'fa-clock', label: '等待中' },
  running: { color: 'text-blue-400', icon: 'fa-spinner fa-spin', label: '执行中' },
  completed: { color: 'text-green-400', icon: 'fa-check-circle', label: '完成' },
  error: { color: 'text-red-400', icon: 'fa-times-circle', label: '错误' },
  skipped: { color: 'text-yellow-400', icon: 'fa-forward', label: '跳过' },
};

function normalizeFlowStatus(status: unknown): NonNullable<LangSmithFlowStep['status']> {
  if (status === 'running' || status === 'completed' || status === 'error' || status === 'skipped') {
    return status;
  }
  return 'pending';
}

function inferFlowKind(value: unknown): string {
  const text = String(value ?? '').toLowerCase();
  if (/retrieval|检索|database|milvus|vector/.test(text)) return 'retriever';
  if (/llm|generation|答案|生成|rewrite|重写/.test(text)) return 'llm';
  if (/grade|评估|score|评分|检查/.test(text)) return 'evaluator';
  if (/embedding|向量/.test(text)) return 'embedding';
  return 'chain';
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

export default function LangSmithTraceViewer({
  workflowSteps = [],
  queryAnalysis,
  retrievalGrade,
  debugInfo,
  totalDuration,
  className = '',
  defaultExpanded = true,
}: LangSmithTraceViewerProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<LangSmithViewerTab>('timeline');

  // 计算统计数据
  const stats = useMemo(() => {
    const completed = workflowSteps.filter(s => s.status === 'completed').length;
    const errors = workflowSteps.filter(s => s.status === 'error').length;
    const skipped = workflowSteps.filter(s => s.status === 'skipped').length;
    const totalTime = workflowSteps.reduce((sum, s) => sum + (s.duration || 0), 0);
    
    return { completed, errors, skipped, totalTime, total: workflowSteps.length };
  }, [workflowSteps]);

  const flowSteps = useMemo<LangSmithFlowStep[]>(() => {
    return workflowSteps.map((step, index) => ({
      id: step.id ?? `workflow-${index}`,
      parentId: step.parentId,
      label: step.step ?? step.name ?? `Step ${index + 1}`,
      description: step.error ?? readStringField(step.output, 'summary') ?? readStringField(step.metadata, 'description'),
      kind: inferFlowKind(step.step ?? step.name ?? step.type),
      status: normalizeFlowStatus(step.status),
      duration: typeof step.duration === 'number' ? step.duration : undefined,
      error: step.error,
      layer: index,
      metadata: {
        type: step.type,
        model: step.model,
        tokens: step.tokens?.total,
        cost: step.cost,
      },
    }));
  }, [workflowSteps]);

  // 渲染时间线视图
  const renderTimeline = () => (
    <div className="space-y-1">
      {workflowSteps.map((step, index) => {
        const stepName = step.step ?? step.name ?? `Step ${index + 1}`;
        const config = STEP_TYPE_CONFIG[stepName] || { icon: 'fa-cog', color: 'text-gray-400', bgColor: 'bg-gray-500/20' };
        const statusConfig = STATUS_CONFIG[step.status ?? 'pending'] || STATUS_CONFIG.pending;
        const isSelected = selectedStep === index;
        const progress = step.duration && stats.totalTime > 0 ? (step.duration / stats.totalTime) * 100 : 0;

        return (
          <div key={index} className="relative">
            {/* 连接线 */}
            {index < workflowSteps.length - 1 && (
              <div className="absolute left-5 top-10 w-0.5 h-6 bg-gradient-to-b from-white/20 to-transparent" />
            )}
            
            <div
              className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-all ${
                isSelected 
                  ? 'bg-white/10 ring-1 ring-white/30' 
                  : 'hover:bg-white/5'
              }`}
              onClick={() => setSelectedStep(isSelected ? null : index)}
            >
              {/* 图标 */}
              <div className={`w-10 h-10 rounded-lg ${config.bgColor} flex items-center justify-center flex-shrink-0`}>
                <i className={`fas ${config.icon} ${config.color}`}></i>
              </div>

              {/* 内容 */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-white truncate">{stepName}</span>
                  <span className={`text-xs ${statusConfig.color}`}>
                    <i className={`fas ${statusConfig.icon} mr-1`}></i>
                    {statusConfig.label}
                  </span>
                </div>
                
                {/* 进度条 */}
                {typeof step.duration === 'number' && step.duration > 0 && (
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
                      <div 
                        className={`h-full ${config.bgColor.replace('/20', '')} transition-all duration-500`}
                        style={{ width: `${Math.min(progress, 100)}%` }}
                      />
                    </div>
                    <span className="text-xs text-white/50 tabular-nums">{step.duration}ms</span>
                  </div>
                )}
              </div>

              {/* 展开图标 */}
              <i className={`fas fa-chevron-${isSelected ? 'up' : 'down'} text-white/30 text-xs`}></i>
            </div>

            {/* 展开详情 */}
            {isSelected && (
              <div className="ml-13 mt-2 p-4 bg-black/30 rounded-lg border border-white/10 space-y-3">
                {step.input !== undefined && step.input !== null && (
                  <div>
                    <div className="text-xs text-white/50 mb-1 flex items-center gap-1">
                      <i className="fas fa-sign-in-alt"></i> 输入
                    </div>
                    <pre className="text-xs text-white/70 bg-black/30 p-2 rounded overflow-auto max-h-32">
                      {JSON.stringify(step.input, null, 2)}
                    </pre>
                  </div>
                )}
                {step.output !== undefined && step.output !== null && (
                  <div>
                    <div className="text-xs text-white/50 mb-1 flex items-center gap-1">
                      <i className="fas fa-sign-out-alt"></i> 输出
                    </div>
                    <pre className="text-xs text-white/70 bg-black/30 p-2 rounded overflow-auto max-h-32">
                      {JSON.stringify(step.output, null, 2)}
                    </pre>
                  </div>
                )}
                {step.error && (
                  <div className="p-2 bg-red-500/10 rounded border border-red-500/30">
                    <div className="text-xs text-red-400 flex items-center gap-1">
                      <i className="fas fa-exclamation-triangle"></i> 错误信息
                    </div>
                    <div className="text-xs text-red-300 mt-1">{step.error}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  // 渲染树形视图
  const renderTree = () => (
    <LangSmithReactFlowGraph
      steps={flowSteps}
      emptyMessage="暂无 LangSmith workflow steps"
    />
  );

  // 渲染指标视图
  const renderMetrics = () => (
    <div className="space-y-4">
      {/* 概览卡片 */}
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-gradient-to-br from-green-500/20 to-green-600/10 rounded-xl p-3 border border-green-500/20">
          <div className="text-2xl font-bold text-green-400">{stats.completed}</div>
          <div className="text-xs text-green-300/60">完成步骤</div>
        </div>
        <div className="bg-gradient-to-br from-red-500/20 to-red-600/10 rounded-xl p-3 border border-red-500/20">
          <div className="text-2xl font-bold text-red-400">{stats.errors}</div>
          <div className="text-xs text-red-300/60">错误</div>
        </div>
        <div className="bg-gradient-to-br from-yellow-500/20 to-yellow-600/10 rounded-xl p-3 border border-yellow-500/20">
          <div className="text-2xl font-bold text-yellow-400">{stats.skipped}</div>
          <div className="text-xs text-yellow-300/60">跳过</div>
        </div>
        <div className="bg-gradient-to-br from-blue-500/20 to-blue-600/10 rounded-xl p-3 border border-blue-500/20">
          <div className="text-2xl font-bold text-blue-400">{(totalDuration || stats.totalTime) / 1000}s</div>
          <div className="text-xs text-blue-300/60">总耗时</div>
        </div>
      </div>

      {/* 检索评估分数 */}
      {retrievalGrade && (
        <div className="bg-white/5 rounded-xl p-4 border border-white/10">
          <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
            <i className="fas fa-chart-pie text-cyan-400"></i>
            检索评估分数
          </h4>
          <div className="grid grid-cols-3 gap-4">
            <div className="text-center">
              <div className="relative w-16 h-16 mx-auto">
                <svg className="w-full h-full transform -rotate-90">
                  <circle cx="32" cy="32" r="28" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="4" />
                  <circle 
                    cx="32" cy="32" r="28" fill="none" 
                    stroke={retrievalGrade.score >= 0.7 ? '#22c55e' : retrievalGrade.score >= 0.4 ? '#eab308' : '#ef4444'}
                    strokeWidth="4" 
                    strokeLinecap="round"
                    strokeDasharray={`${retrievalGrade.score * 176} 176`}
                  />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-lg font-bold text-white">{(retrievalGrade.score * 100).toFixed(0)}%</span>
                </div>
              </div>
              <div className="text-xs text-white/50 mt-2">综合评分</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-purple-400">
                {(retrievalGrade.keywordMatchScore * 100).toFixed(0)}%
              </div>
              <div className="text-xs text-white/50">关键词匹配</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-400">
                {(retrievalGrade.semanticScore * 100).toFixed(0)}%
              </div>
              <div className="text-xs text-white/50">语义相似度</div>
            </div>
          </div>
          
          {/* 评估结论 */}
          <div className={`mt-4 p-3 rounded-lg ${
            retrievalGrade.isRelevant 
              ? 'bg-green-500/10 border border-green-500/20' 
              : 'bg-red-500/10 border border-red-500/20'
          }`}>
            <div className="flex items-center gap-2">
              <i className={`fas ${retrievalGrade.isRelevant ? 'fa-check-circle text-green-400' : 'fa-times-circle text-red-400'}`}></i>
              <span className={`text-sm ${retrievalGrade.isRelevant ? 'text-green-300' : 'text-red-300'}`}>
                {retrievalGrade.reasoning}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* 查询分析 */}
      {queryAnalysis && (
        <div className="bg-white/5 rounded-xl p-4 border border-white/10">
          <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
            <i className="fas fa-search text-blue-400"></i>
            查询分析
          </h4>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-white/50">意图</span>
              <span className="text-xs px-2 py-0.5 bg-blue-500/20 text-blue-300 rounded-full">
                {queryAnalysis.intent}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-white/50">复杂度</span>
              <span className="text-xs px-2 py-0.5 bg-purple-500/20 text-purple-300 rounded-full">
                {queryAnalysis.complexity}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-white/50">需要检索</span>
              <span className={`text-xs ${queryAnalysis.needsRetrieval ? 'text-green-400' : 'text-yellow-400'}`}>
                {queryAnalysis.needsRetrieval ? '是' : '否'}
              </span>
            </div>
            {Array.isArray(queryAnalysis.keywords) && queryAnalysis.keywords.length > 0 && (
              <div>
                <span className="text-xs text-white/50 block mb-1">关键词</span>
                <div className="flex flex-wrap gap-1">
                  {queryAnalysis.keywords.slice(0, 6).map((kw: string, i: number) => (
                    <span key={i} className="text-xs px-2 py-0.5 bg-white/10 text-white/70 rounded">
                      {kw}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );

  // 渲染调试视图
  const renderDebug = () => (
    <div className="space-y-4">
      {/* Milvus 调试信息 */}
      {debugInfo && (
        <div className="bg-black/40 rounded-xl p-4 border border-white/10 font-mono">
          <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
            <i className="fas fa-bug text-orange-400"></i>
            Milvus 调试信息
          </h4>
          
          <div className="space-y-3 text-xs">
            {debugInfo.embeddingModel && (
              <div className="flex items-center justify-between py-2 border-b border-white/10">
                <span className="text-white/50">Embedding 模型</span>
                <span className="text-cyan-400">{debugInfo.embeddingModel}</span>
              </div>
            )}
            {debugInfo.collectionDimension && (
              <div className="flex items-center justify-between py-2 border-b border-white/10">
                <span className="text-white/50">集合维度</span>
                <span className="text-green-400">{debugInfo.collectionDimension}D</span>
              </div>
            )}
            {debugInfo.milvusRawScores && debugInfo.milvusRawScores.length > 0 && (
              <div className="py-2 border-b border-white/10">
                <span className="text-white/50 block mb-2">原始相似度分数</span>
                <div className="flex flex-wrap gap-2">
                  {debugInfo.milvusRawScores.map((score, i) => (
                    <span key={i} className={`px-2 py-1 rounded ${
                      score >= 0.7 ? 'bg-green-500/20 text-green-400' :
                      score >= 0.4 ? 'bg-yellow-500/20 text-yellow-400' :
                      'bg-red-500/20 text-red-400'
                    }`}>
                      Doc{i + 1}: {(score * 100).toFixed(1)}%
                    </span>
                  ))}
                </div>
              </div>
            )}
            {debugInfo.milvusQueryVector && debugInfo.milvusQueryVector.length > 0 && (
              <div className="py-2">
                <span className="text-white/50 block mb-2">查询向量预览 (前10维)</span>
                <div className="bg-black/30 p-2 rounded overflow-x-auto">
                  <code className="text-purple-400 text-[10px]">
                    [{debugInfo.milvusQueryVector.map(v => v.toFixed(4)).join(', ')}...]
                  </code>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 环境配置 */}
      <div className="bg-black/40 rounded-xl p-4 border border-white/10">
        <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
          <i className="fas fa-cog text-gray-400"></i>
          LangSmith 配置
        </h4>
        <div className="space-y-2 text-xs font-mono">
          <div className="flex items-center justify-between py-1">
            <span className="text-white/50">LANGCHAIN_TRACING_V2</span>
            <span className="text-yellow-400">{process.env.NEXT_PUBLIC_LANGCHAIN_TRACING || 'false'}</span>
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-white/50">LANGCHAIN_PROJECT</span>
            <span className="text-blue-400">{process.env.NEXT_PUBLIC_LANGCHAIN_PROJECT || 'agentic-rag'}</span>
          </div>
        </div>
        
        <div className="mt-4 p-3 bg-blue-500/10 rounded-lg border border-blue-500/20">
          <div className="text-xs text-blue-300">
            <i className="fas fa-info-circle mr-1"></i>
            启用 LangSmith 追踪后，可在 smith.langchain.com 查看完整的追踪详情
          </div>
        </div>
      </div>
    </div>
  );

  if (workflowSteps.length === 0 && !queryAnalysis && !debugInfo) {
    return null;
  }

  return (
    <div className={`bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-2xl overflow-hidden border border-white/10 ${className}`}>
      {/* 头部 */}
      <div 
        className="px-5 py-4 bg-gradient-to-r from-orange-500/20 via-red-500/20 to-pink-500/20 border-b border-white/10 cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center shadow-lg shadow-orange-500/20">
              <i className="fas fa-project-diagram text-white"></i>
            </div>
            <div>
              <h3 className="text-base font-semibold text-white flex items-center gap-2">
                LangSmith Trace Viewer
                <span className="text-xs font-normal px-2 py-0.5 bg-white/10 rounded-full text-white/60">
                  {stats.completed}/{stats.total} 步骤
                </span>
              </h3>
              <div className="text-xs text-white/50 flex items-center gap-3 mt-0.5">
                <span><i className="fas fa-clock mr-1"></i>{(totalDuration || stats.totalTime) / 1000}s</span>
                {stats.errors > 0 && <span className="text-red-400"><i className="fas fa-times-circle mr-1"></i>{stats.errors} 错误</span>}
              </div>
            </div>
          </div>
          <button className="p-2 hover:bg-white/10 rounded-lg transition-colors">
            <i className={`fas fa-chevron-${isExpanded ? 'up' : 'down'} text-white/50`}></i>
          </button>
        </div>
      </div>

      {/* 内容区域 */}
      {isExpanded && (
        <div className="p-5">
          {/* 标签页 */}
          <div className="flex gap-1 mb-4 p-1 bg-black/30 rounded-xl">
            {([
              { id: 'timeline', label: '时间线', icon: 'fa-stream' },
              { id: 'tree', label: 'ReactFlow', icon: 'fa-project-diagram' },
              { id: 'metrics', label: '指标', icon: 'fa-chart-bar' },
              { id: 'debug', label: '调试', icon: 'fa-bug' },
            ] satisfies Array<{ id: LangSmithViewerTab; label: string; icon: string }>).map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  activeTab === tab.id
                    ? 'bg-gradient-to-r from-orange-500 to-red-500 text-white shadow-lg'
                    : 'text-white/50 hover:text-white/70 hover:bg-white/5'
                }`}
              >
                <i className={`fas ${tab.icon} mr-2`}></i>
                {tab.label}
              </button>
            ))}
          </div>

          {/* 内容 */}
          <div className="min-h-[200px]">
            {activeTab === 'timeline' && renderTimeline()}
            {activeTab === 'tree' && renderTree()}
            {activeTab === 'metrics' && renderMetrics()}
            {activeTab === 'debug' && renderDebug()}
          </div>
        </div>
      )}
    </div>
  );
}

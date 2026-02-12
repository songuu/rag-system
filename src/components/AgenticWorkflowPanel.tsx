'use client';

import React, { useState, useEffect, useMemo } from 'react';

// 工作流步骤类型
interface WorkflowStep {
  step: string;
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'error';
  startTime?: number;
  endTime?: number;
  duration?: number;
  input?: any;
  output?: any;
  error?: string;
}

// 查询分析结果
interface QueryAnalysis {
  originalQuery: string;
  rewrittenQuery: string;
  intent: string;
  complexity: string;
  needsRetrieval: boolean;
  keywords: string[];
  confidence: number;
}

// 检索质量
interface RetrievalQuality {
  overallScore: number;
  relevanceScore: number;
  coverageScore: number;
  diversityScore: number;
  isAcceptable: boolean;
  suggestions: string[];
}

// 自省评分
interface SelfReflectionScore {
  documentScores: Array<{
    index: number;
    relevance: number;
    usefulness: number;
    factuality: number;
    overall: number;
    reasoning: string;
  }>;
  queryAlignmentScore: number;
  contextCompleteness: number;
  recommendation: string;
}

// 幻觉检查
interface HallucinationCheck {
  hasHallucination: boolean;
  confidence: number;
  problematicClaims: string[];
  supportedClaims: string[];
  overallFactualScore: number;
}

interface AgenticWorkflowPanelProps {
  workflow?: {
    steps: WorkflowStep[];
    totalDuration?: number;
    retryCount?: number;
  };
  queryAnalysis?: QueryAnalysis;
  retrievalQuality?: RetrievalQuality;
  selfReflection?: SelfReflectionScore;
  hallucinationCheck?: HallucinationCheck;
  isLoading?: boolean;
  className?: string;
  defaultExpanded?: boolean;
  onClose?: () => void;
}

// 步骤名称映射
const STEP_NAMES: Record<string, string> = {
  '查询分析与优化': '🔍 查询分析',
  'analyze_query': '🔍 查询分析',
  'retrieve_original': '📚 原始检索',
  'fan_out_join': '⚡ 并发汇聚',
  'grade_retrieval': '📊 Reranker 评分',
  'retrieve_after_rewrite': '🔄 重试检索',
  '文档检索': '📚 文档检索',
  '自省评分': '🤔 自省评分',
  '检索质量评估': '📊 质量评估',
  '答案生成': '✍️ 答案生成',
  'generate': '✍️ 答案生成',
  '幻觉检查': '🔬 幻觉检查',
  '查询重写': '✏️ 查询重写',
  'rewrite_query': '✏️ 查询重写',
  'semantic_cache': '💾 语义缓存',
};

// 状态颜色映射
const STATUS_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  pending: { bg: 'bg-gray-100', text: 'text-gray-500', border: 'border-gray-300' },
  running: { bg: 'bg-blue-50', text: 'text-blue-600', border: 'border-blue-400' },
  completed: { bg: 'bg-green-50', text: 'text-green-600', border: 'border-green-400' },
  skipped: { bg: 'bg-yellow-50', text: 'text-yellow-600', border: 'border-yellow-400' },
  error: { bg: 'bg-red-50', text: 'text-red-600', border: 'border-red-400' },
};

// 意图图标映射
const INTENT_ICONS: Record<string, string> = {
  factual: '📖',
  exploratory: '🔭',
  comparison: '⚖️',
  procedural: '📋',
  unknown: '❓',
};

export default function AgenticWorkflowPanel({
  workflow,
  queryAnalysis,
  retrievalQuality,
  selfReflection,
  hallucinationCheck,
  isLoading = false,
  className = '',
  defaultExpanded = false,
  onClose,
}: AgenticWorkflowPanelProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['workflow']));
  const [selectedDocIndex, setSelectedDocIndex] = useState<number | null>(null);

  const toggleSection = (section: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

  // 计算总体评分
  const overallScore = useMemo(() => {
    let score = 0;
    let count = 0;

    if (retrievalQuality?.overallScore) {
      score += retrievalQuality.overallScore;
      count++;
    }
    if (selfReflection?.queryAlignmentScore) {
      score += selfReflection.queryAlignmentScore;
      count++;
    }
    if (hallucinationCheck?.overallFactualScore) {
      score += hallucinationCheck.overallFactualScore;
      count++;
    }

    return count > 0 ? score / count : 0;
  }, [retrievalQuality, selfReflection, hallucinationCheck]);

  // 渲染进度条
  const renderProgressBar = (value: number, label: string, color: string = 'blue') => (
    <div className="mb-2">
      <div className="flex justify-between text-xs mb-1">
        <span className="text-gray-600">{label}</span>
        <span className="font-medium">{(value * 100).toFixed(0)}%</span>
      </div>
      <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
        <div
          className={`h-full bg-${color}-500 transition-all duration-500`}
          style={{ width: `${value * 100}%` }}
        />
      </div>
    </div>
  );

  // 渲染工作流步骤
  const renderWorkflowSteps = () => {
    if (!workflow?.steps?.length) {
      return (
        <div className="text-center py-8 text-gray-400">
          <i className="fas fa-project-diagram text-4xl mb-2"></i>
          <p>等待工作流执行...</p>
        </div>
      );
    }

    return (
      <div className="space-y-2">
        {workflow.steps.map((step, index) => {
          const colors = STATUS_COLORS[step.status] || STATUS_COLORS.pending;
          const stepName = STEP_NAMES[step.step] || step.step;

          return (
            <div
              key={index}
              className={`p-3 rounded-lg border ${colors.bg} ${colors.border} transition-all duration-300`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {step.status === 'running' && (
                    <i className="fas fa-spinner fa-spin text-blue-500"></i>
                  )}
                  {step.status === 'completed' && (
                    <i className="fas fa-check-circle text-green-500"></i>
                  )}
                  {step.status === 'skipped' && (
                    <i className="fas fa-forward text-yellow-500"></i>
                  )}
                  {step.status === 'error' && (
                    <i className="fas fa-exclamation-circle text-red-500"></i>
                  )}
                  {step.status === 'pending' && (
                    <i className="fas fa-circle text-gray-400"></i>
                  )}
                  <span className={`font-medium ${colors.text}`}>{stepName}</span>
                </div>
                {step.duration && (
                  <span className="text-xs text-gray-500">
                    {step.duration}ms
                  </span>
                )}
              </div>
              {step.error && (
                <p className="mt-2 text-xs text-red-600 bg-red-100 p-2 rounded">
                  {step.error}
                </p>
              )}
            </div>
          );
        })}
        
        {/* 总耗时 */}
        {workflow.totalDuration && (
          <div className="mt-4 pt-4 border-t border-gray-200 flex justify-between items-center">
            <span className="text-sm text-gray-600">总耗时</span>
            <span className="font-mono font-medium text-blue-600">
              {(workflow.totalDuration / 1000).toFixed(2)}s
            </span>
          </div>
        )}
        
        {/* 重试次数 */}
        {workflow.retryCount !== undefined && workflow.retryCount > 0 && (
          <div className="flex justify-between items-center text-sm">
            <span className="text-gray-600">重试次数</span>
            <span className="px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded-full">
              {workflow.retryCount}
            </span>
          </div>
        )}
      </div>
    );
  };

  // 渲染查询分析
  const renderQueryAnalysis = () => {
    if (!queryAnalysis) return null;

    return (
      <div className="space-y-3">
        {/* 原始查询 vs 优化查询 */}
        <div className="grid grid-cols-2 gap-3">
          <div className="p-3 bg-gray-50 rounded-lg">
            <div className="text-xs text-gray-500 mb-1">原始查询</div>
            <div className="text-sm font-medium">{queryAnalysis.originalQuery}</div>
          </div>
          <div className="p-3 bg-blue-50 rounded-lg">
            <div className="text-xs text-blue-500 mb-1">优化查询</div>
            <div className="text-sm font-medium text-blue-700">{queryAnalysis.rewrittenQuery}</div>
          </div>
        </div>

        {/* 意图和复杂度 */}
        <div className="flex gap-3">
          <div className="flex-1 p-3 bg-purple-50 rounded-lg">
            <div className="text-xs text-purple-500 mb-1">查询意图</div>
            <div className="flex items-center gap-2">
              <span className="text-xl">{INTENT_ICONS[queryAnalysis.intent] || '❓'}</span>
              <span className="font-medium text-purple-700 capitalize">{queryAnalysis.intent}</span>
            </div>
          </div>
          <div className="flex-1 p-3 bg-orange-50 rounded-lg">
            <div className="text-xs text-orange-500 mb-1">复杂度</div>
            <div className="font-medium text-orange-700 capitalize">{queryAnalysis.complexity}</div>
          </div>
          <div className="flex-1 p-3 bg-green-50 rounded-lg">
            <div className="text-xs text-green-500 mb-1">置信度</div>
            <div className="font-medium text-green-700">{(queryAnalysis.confidence * 100).toFixed(0)}%</div>
          </div>
        </div>

        {/* 关键词 */}
        {queryAnalysis.keywords?.length > 0 && (
          <div>
            <div className="text-xs text-gray-500 mb-2">提取的关键词</div>
            <div className="flex flex-wrap gap-2">
              {queryAnalysis.keywords.map((keyword, i) => (
                <span
                  key={i}
                  className="px-2 py-1 bg-gray-100 text-gray-700 text-xs rounded-full"
                >
                  {keyword}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* 是否需要检索 */}
        <div className={`p-2 rounded-lg text-center text-sm ${
          queryAnalysis.needsRetrieval ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
        }`}>
          {queryAnalysis.needsRetrieval ? '✅ 需要检索知识库' : '⏭️ 无需检索，直接回答'}
        </div>
      </div>
    );
  };

  // 渲染检索质量
  const renderRetrievalQuality = () => {
    if (!retrievalQuality) return null;

    return (
      <div className="space-y-4">
        {/* 总体评分 */}
        <div className={`p-4 rounded-lg text-center ${
          retrievalQuality.isAcceptable ? 'bg-green-50' : 'bg-yellow-50'
        }`}>
          <div className="text-3xl font-bold mb-1" style={{
            color: retrievalQuality.isAcceptable ? '#16a34a' : '#ca8a04'
          }}>
            {(retrievalQuality.overallScore * 100).toFixed(0)}
          </div>
          <div className="text-sm text-gray-600">检索质量评分</div>
          <div className={`mt-2 text-xs ${
            retrievalQuality.isAcceptable ? 'text-green-600' : 'text-yellow-600'
          }`}>
            {retrievalQuality.isAcceptable ? '✅ 质量可接受' : '⚠️ 质量待提升'}
          </div>
        </div>

        {/* 详细评分 */}
        <div className="space-y-2">
          {renderProgressBar(retrievalQuality.relevanceScore, '相关性', 'blue')}
          {renderProgressBar(retrievalQuality.coverageScore, '覆盖度', 'purple')}
          {renderProgressBar(retrievalQuality.diversityScore, '多样性', 'green')}
        </div>

        {/* 改进建议 */}
        {retrievalQuality.suggestions?.length > 0 && (
          <div className="p-3 bg-yellow-50 rounded-lg">
            <div className="text-xs text-yellow-700 font-medium mb-2">💡 改进建议</div>
            <ul className="text-xs text-yellow-800 space-y-1">
              {retrievalQuality.suggestions.map((suggestion, i) => (
                <li key={i}>• {suggestion}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  };

  // 渲染自省评分
  const renderSelfReflection = () => {
    if (!selfReflection) return null;

    return (
      <div className="space-y-4">
        {/* 总体指标 */}
        <div className="grid grid-cols-3 gap-3">
          <div className="p-3 bg-blue-50 rounded-lg text-center">
            <div className="text-2xl font-bold text-blue-600">
              {(selfReflection.queryAlignmentScore * 100).toFixed(0)}%
            </div>
            <div className="text-xs text-blue-500">查询对齐度</div>
          </div>
          <div className="p-3 bg-purple-50 rounded-lg text-center">
            <div className="text-2xl font-bold text-purple-600">
              {(selfReflection.contextCompleteness * 100).toFixed(0)}%
            </div>
            <div className="text-xs text-purple-500">上下文完整度</div>
          </div>
          <div className={`p-3 rounded-lg text-center ${
            selfReflection.recommendation === 'use' ? 'bg-green-50' :
            selfReflection.recommendation === 'expand' ? 'bg-yellow-50' :
            selfReflection.recommendation === 'rewrite' ? 'bg-orange-50' : 'bg-red-50'
          }`}>
            <div className="text-lg font-bold capitalize" style={{
              color: selfReflection.recommendation === 'use' ? '#16a34a' :
                     selfReflection.recommendation === 'expand' ? '#ca8a04' :
                     selfReflection.recommendation === 'rewrite' ? '#ea580c' : '#dc2626'
            }}>
              {selfReflection.recommendation === 'use' ? '✅ 使用' :
               selfReflection.recommendation === 'expand' ? '📈 扩展' :
               selfReflection.recommendation === 'rewrite' ? '✏️ 重写' : '⏭️ 跳过'}
            </div>
            <div className="text-xs text-gray-500">建议操作</div>
          </div>
        </div>

        {/* 文档评分列表 */}
        {selfReflection.documentScores?.length > 0 && (
          <div>
            <div className="text-xs text-gray-500 mb-2">文档自省评分</div>
            <div className="space-y-2">
              {selfReflection.documentScores.map((doc, i) => (
                <div
                  key={i}
                  className={`p-3 rounded-lg border cursor-pointer transition-all ${
                    selectedDocIndex === i ? 'border-blue-400 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
                  }`}
                  onClick={() => setSelectedDocIndex(selectedDocIndex === i ? null : i)}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium text-sm">文档 {doc.index}</span>
                    <span className={`px-2 py-0.5 rounded-full text-xs ${
                      doc.overall >= 0.7 ? 'bg-green-100 text-green-700' :
                      doc.overall >= 0.4 ? 'bg-yellow-100 text-yellow-700' :
                      'bg-red-100 text-red-700'
                    }`}>
                      {(doc.overall * 100).toFixed(0)}%
                    </span>
                  </div>
                  
                  {/* 详细评分条 */}
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <div className="text-gray-500">相关性</div>
                      <div className="h-1.5 bg-gray-200 rounded-full mt-1">
                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${doc.relevance * 100}%` }} />
                      </div>
                    </div>
                    <div>
                      <div className="text-gray-500">有用性</div>
                      <div className="h-1.5 bg-gray-200 rounded-full mt-1">
                        <div className="h-full bg-purple-500 rounded-full" style={{ width: `${doc.usefulness * 100}%` }} />
                      </div>
                    </div>
                    <div>
                      <div className="text-gray-500">事实性</div>
                      <div className="h-1.5 bg-gray-200 rounded-full mt-1">
                        <div className="h-full bg-green-500 rounded-full" style={{ width: `${doc.factuality * 100}%` }} />
                      </div>
                    </div>
                  </div>

                  {/* 展开显示理由 */}
                  {selectedDocIndex === i && doc.reasoning && (
                    <div className="mt-3 pt-3 border-t border-gray-200 text-xs text-gray-600">
                      <span className="font-medium">评分理由：</span>
                      {doc.reasoning}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  // 渲染幻觉检查
  const renderHallucinationCheck = () => {
    if (!hallucinationCheck) return null;

    return (
      <div className="space-y-4">
        {/* 总体结果 */}
        <div className={`p-4 rounded-lg text-center ${
          hallucinationCheck.hasHallucination ? 'bg-red-50' : 'bg-green-50'
        }`}>
          <div className="text-4xl mb-2">
            {hallucinationCheck.hasHallucination ? '⚠️' : '✅'}
          </div>
          <div className={`text-lg font-bold ${
            hallucinationCheck.hasHallucination ? 'text-red-600' : 'text-green-600'
          }`}>
            {hallucinationCheck.hasHallucination ? '检测到潜在幻觉' : '未检测到幻觉'}
          </div>
          <div className="text-sm text-gray-500 mt-1">
            置信度: {(hallucinationCheck.confidence * 100).toFixed(0)}%
          </div>
        </div>

        {/* 事实性评分 */}
        <div className="p-3 bg-gray-50 rounded-lg">
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm text-gray-600">事实性评分</span>
            <span className="font-bold text-lg">
              {(hallucinationCheck.overallFactualScore * 100).toFixed(0)}%
            </span>
          </div>
          <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${
                hallucinationCheck.overallFactualScore >= 0.7 ? 'bg-green-500' :
                hallucinationCheck.overallFactualScore >= 0.4 ? 'bg-yellow-500' : 'bg-red-500'
              }`}
              style={{ width: `${hallucinationCheck.overallFactualScore * 100}%` }}
            />
          </div>
        </div>

        {/* 有问题的声明 */}
        {hallucinationCheck.problematicClaims?.length > 0 && (
          <div className="p-3 bg-red-50 rounded-lg">
            <div className="text-xs text-red-700 font-medium mb-2">⚠️ 可能有问题的声明</div>
            <ul className="text-xs text-red-800 space-y-1">
              {hallucinationCheck.problematicClaims.map((claim, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-red-500">•</span>
                  <span>{claim}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 有据可查的声明 */}
        {hallucinationCheck.supportedClaims?.length > 0 && (
          <div className="p-3 bg-green-50 rounded-lg">
            <div className="text-xs text-green-700 font-medium mb-2">✅ 有据可查的声明</div>
            <ul className="text-xs text-green-800 space-y-1">
              {hallucinationCheck.supportedClaims.map((claim, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-green-500">•</span>
                  <span>{claim}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  };

  // 渲染可折叠区块
  const renderSection = (
    id: string,
    title: string,
    icon: string,
    content: React.ReactNode,
    badge?: React.ReactNode
  ) => {
    const sectionExpanded = expandedSections.has(id);

    return (
      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <button
          className="w-full px-4 py-3 flex items-center justify-between bg-gray-50 hover:bg-gray-100 transition-colors"
          onClick={() => toggleSection(id)}
        >
          <div className="flex items-center gap-2">
            <i className={`fas ${icon} text-gray-500`}></i>
            <span className="font-medium text-gray-700">{title}</span>
            {badge}
          </div>
          <i className={`fas fa-chevron-${sectionExpanded ? 'up' : 'down'} text-gray-400`}></i>
        </button>
        {sectionExpanded && (
          <div className="p-4 bg-white">
            {content}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden ${className}`}>
      {/* 头部 - 可点击折叠 */}
      <div 
        className="px-4 py-3 bg-gradient-to-r from-purple-500 to-blue-500 text-white cursor-pointer hover:from-purple-600 hover:to-blue-600 transition-all"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <i className="fas fa-robot text-xl"></i>
            <span className="font-semibold">Agentic RAG 工作流</span>
            {/* 折叠状态时显示简要信息 */}
            {!isExpanded && workflow?.steps && (
              <span className="text-xs opacity-75 ml-2">
                ({workflow.steps.filter(s => s.status === 'completed').length}/{workflow.steps.length} 步骤已完成)
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {isLoading && (
              <div className="flex items-center gap-2 text-sm">
                <i className="fas fa-spinner fa-spin"></i>
                <span>处理中...</span>
              </div>
            )}
            {!isLoading && workflow?.totalDuration && (
              <div className="text-sm opacity-90">
                总耗时: {(workflow.totalDuration / 1000).toFixed(2)}s
              </div>
            )}
            {/* 展开/折叠按钮 */}
            <button
              className="p-1 hover:bg-white/20 rounded transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                setIsExpanded(!isExpanded);
              }}
            >
              <i className={`fas fa-chevron-${isExpanded ? 'up' : 'down'}`}></i>
            </button>
            {/* 关闭按钮 */}
            {onClose && (
              <button
                className="p-1 hover:bg-white/20 rounded transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose();
                }}
              >
                <i className="fas fa-times"></i>
              </button>
            )}
          </div>
        </div>
        
        {/* 总体评分指示器 - 仅在展开时显示完整，折叠时显示简化版 */}
        {overallScore > 0 && (
          <div className="mt-3 flex items-center gap-3">
            <div className="flex-1 h-2 bg-white/20 rounded-full overflow-hidden">
              <div
                className="h-full bg-white transition-all duration-500"
                style={{ width: `${overallScore * 100}%` }}
              />
            </div>
            <span className="text-sm font-medium">
              {(overallScore * 100).toFixed(0)}%
            </span>
          </div>
        )}
      </div>

      {/* 内容区域 - 仅在展开时显示 */}
      {isExpanded && (
      <div className="p-4 space-y-3">
        {/* 工作流步骤 */}
        {renderSection(
          'workflow',
          '工作流步骤',
          'fa-project-diagram',
          renderWorkflowSteps(),
          workflow?.steps?.length ? (
            <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full">
              {workflow.steps.filter(s => s.status === 'completed').length}/{workflow.steps.length}
            </span>
          ) : null
        )}

        {/* 查询分析 */}
        {queryAnalysis && renderSection(
          'queryAnalysis',
          '查询分析',
          'fa-search-plus',
          renderQueryAnalysis(),
          <span className={`px-2 py-0.5 text-xs rounded-full ${
            queryAnalysis.needsRetrieval ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
          }`}>
            {queryAnalysis.intent}
          </span>
        )}

        {/* 检索质量 */}
        {retrievalQuality && renderSection(
          'retrievalQuality',
          '检索质量',
          'fa-chart-bar',
          renderRetrievalQuality(),
          <span className={`px-2 py-0.5 text-xs rounded-full ${
            retrievalQuality.isAcceptable ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
          }`}>
            {(retrievalQuality.overallScore * 100).toFixed(0)}%
          </span>
        )}

        {/* 自省评分 */}
        {selfReflection && renderSection(
          'selfReflection',
          '自省评分',
          'fa-brain',
          renderSelfReflection(),
          <span className={`px-2 py-0.5 text-xs rounded-full ${
            selfReflection.recommendation === 'use' ? 'bg-green-100 text-green-700' :
            selfReflection.recommendation === 'expand' ? 'bg-yellow-100 text-yellow-700' :
            'bg-orange-100 text-orange-700'
          }`}>
            {selfReflection.recommendation}
          </span>
        )}

        {/* 幻觉检查 */}
        {hallucinationCheck && renderSection(
          'hallucinationCheck',
          '幻觉检查',
          'fa-shield-alt',
          renderHallucinationCheck(),
          <span className={`px-2 py-0.5 text-xs rounded-full ${
            hallucinationCheck.hasHallucination ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
          }`}>
            {hallucinationCheck.hasHallucination ? '⚠️ 有风险' : '✅ 安全'}
          </span>
        )}
      </div>
      )}
    </div>
  );
}

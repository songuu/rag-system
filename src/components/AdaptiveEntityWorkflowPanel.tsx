'use client';

import React, { useState, useMemo } from 'react';

// ==================== 类型定义 ====================

type EntityType = 'PERSON' | 'ORGANIZATION' | 'LOCATION' | 'PRODUCT' | 'DATE' | 'EVENT' | 'CONCEPT' | 'OTHER';
type IntentType = 'factual' | 'conceptual' | 'comparison' | 'procedural' | 'exploratory';

interface WorkflowStepDetails {
  operations?: string[];
  entityCount?: number;
  intent?: string;
  validatedCount?: number;
  totalCount?: number;
  action?: string;
  actionName?: string;
  resultCount?: number;
  inputCount?: number;
  outputCount?: number;
  responseLength?: number;
  extractedEntities?: Array<{name: string; type: string; confidence: number}>;
  validatedEntities?: Array<{original: string; normalized?: string; type: string; isValid: boolean}>;
  [key: string]: any;
}

interface WorkflowStep {
  step: string;
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'error';
  startTime?: number;
  endTime?: number;
  duration?: number;
  input?: any;
  output?: any;
  error?: string;
  details?: WorkflowStepDetails;
}

interface ExtractedEntity {
  name: string;
  type: EntityType;
  value?: string;
  confidence: number;
  normalizedName?: string;
  isValid?: boolean;
  matchScore?: number;
  suggestions?: string[];
}

interface QueryAnalysis {
  originalQuery: string;
  intent: IntentType;
  complexity: string;
  confidence: number;
  entities: ExtractedEntity[];
  keywords: string[];
  logicalRelations?: any[];
}

interface EntityValidation {
  name: string;
  type: EntityType;
  normalizedName?: string;
  isValid: boolean;
  matchScore?: number;
  suggestions?: string[];
}

interface RoutingDecision {
  action: string;
  reason: string;
  constraints?: any;
  relaxedConstraints?: any;
  retryCount?: number;
}

interface RetrievalResult {
  id?: string;
  score: number;
  rerankedScore?: number;
  relevanceExplanation?: string;
  contentPreview: string;
  matchType?: string;
}

interface AdaptiveEntityWorkflowPanelProps {
  workflow?: {
    steps: WorkflowStep[];
    totalDuration?: number;
  };
  queryAnalysis?: QueryAnalysis;
  entityValidation?: EntityValidation[];
  routingDecision?: RoutingDecision;
  retrievalDetails?: {
    searchResultCount: number;
    rankedResultCount: number;
    topResults: RetrievalResult[];
  };
  isLoading?: boolean;
  className?: string;
  defaultExpanded?: boolean;
  onClose?: () => void;
}

// ==================== 常量配置 ====================

const ENTITY_TYPE_CONFIG: Record<EntityType, { icon: string; color: string; bg: string; label: string }> = {
  PERSON: { icon: 'fa-user', color: 'text-blue-400', bg: 'bg-blue-500/20', label: '人物' },
  ORGANIZATION: { icon: 'fa-building', color: 'text-purple-400', bg: 'bg-purple-500/20', label: '组织' },
  LOCATION: { icon: 'fa-map-marker-alt', color: 'text-green-400', bg: 'bg-green-500/20', label: '地点' },
  PRODUCT: { icon: 'fa-box', color: 'text-orange-400', bg: 'bg-orange-500/20', label: '产品' },
  DATE: { icon: 'fa-calendar', color: 'text-cyan-400', bg: 'bg-cyan-500/20', label: '时间' },
  EVENT: { icon: 'fa-calendar-check', color: 'text-pink-400', bg: 'bg-pink-500/20', label: '事件' },
  CONCEPT: { icon: 'fa-lightbulb', color: 'text-yellow-400', bg: 'bg-yellow-500/20', label: '概念' },
  OTHER: { icon: 'fa-tag', color: 'text-slate-400', bg: 'bg-slate-500/20', label: '其他' },
};

const INTENT_CONFIG: Record<IntentType, { icon: string; color: string; label: string }> = {
  factual: { icon: '📊', color: 'text-blue-400', label: '事实查询' },
  conceptual: { icon: '💡', color: 'text-yellow-400', label: '概念理解' },
  comparison: { icon: '⚖️', color: 'text-purple-400', label: '比较分析' },
  procedural: { icon: '📝', color: 'text-green-400', label: '操作指导' },
  exploratory: { icon: '🔍', color: 'text-cyan-400', label: '探索性' },
};

// 使用 includes 匹配的方式，因为后端步骤名称包含额外信息
const getStepConfig = (stepName: string): { name: string; icon: string; color: string } => {
  if (stepName.includes('认知解析')) return { name: '🧠 认知解析', icon: 'fa-brain', color: 'text-indigo-400' };
  if (stepName.includes('实体校验')) return { name: '✅ 实体校验', icon: 'fa-check-double', color: 'text-green-400' };
  if (stepName.includes('路由决策')) return { name: '🛤️ 路由决策', icon: 'fa-route', color: 'text-cyan-400' };
  if (stepName.includes('结构化检索')) return { name: '🔍 结构化检索', icon: 'fa-search', color: 'text-blue-400' };
  if (stepName.includes('语义检索')) return { name: '🎯 语义检索', icon: 'fa-crosshairs', color: 'text-purple-400' };
  if (stepName.includes('混合重排序') || stepName.includes('混合重排')) return { name: '📊 混合重排序', icon: 'fa-sort-amount-down', color: 'text-orange-400' };
  if (stepName.includes('生成响应') || stepName.includes('答案生成')) return { name: '✍️ 生成响应', icon: 'fa-pen-fancy', color: 'text-pink-400' };
  if (stepName.includes('松弛约束') || stepName.includes('约束放宽')) return { name: '🔓 约束放宽', icon: 'fa-unlock', color: 'text-yellow-400' };
  if (stepName.includes('执行')) return { name: `🔍 ${stepName}`, icon: 'fa-search', color: 'text-blue-400' };
  return { name: stepName, icon: 'fa-circle', color: 'text-slate-400' };
};

const STATUS_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  pending: { bg: 'bg-slate-800/50', text: 'text-slate-400', border: 'border-slate-600' },
  running: { bg: 'bg-cyan-900/30', text: 'text-cyan-400', border: 'border-cyan-500' },
  completed: { bg: 'bg-green-900/30', text: 'text-green-400', border: 'border-green-500' },
  skipped: { bg: 'bg-yellow-900/30', text: 'text-yellow-400', border: 'border-yellow-500' },
  error: { bg: 'bg-red-900/30', text: 'text-red-400', border: 'border-red-500' },
};

const ACTION_CONFIG: Record<string, { icon: string; color: string; label: string }> = {
  'structured-search': { icon: 'fa-filter', color: 'text-blue-400', label: '结构化检索' },
  'semantic-search': { icon: 'fa-brain', color: 'text-purple-400', label: '语义检索' },
  'hybrid-search': { icon: 'fa-random', color: 'text-cyan-400', label: '混合检索' },
  'relax-constraints': { icon: 'fa-unlock', color: 'text-yellow-400', label: '放宽约束' },
  'direct-answer': { icon: 'fa-comment', color: 'text-green-400', label: '直接回答' },
};

// ==================== 组件实现 ====================

export default function AdaptiveEntityWorkflowPanel({
  workflow,
  queryAnalysis,
  entityValidation,
  routingDecision,
  retrievalDetails,
  isLoading = false,
  className = '',
  defaultExpanded = false,
  onClose,
}: AdaptiveEntityWorkflowPanelProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['workflow', 'entities']));
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());

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

  // 计算实体统计
  const entityStats = useMemo<Partial<Record<EntityType, number>>>(() => {
    if (!queryAnalysis?.entities) return {};
    const stats = {} as Record<EntityType, number>;
    queryAnalysis.entities.forEach(e => {
      stats[e.type] = (stats[e.type] || 0) + 1;
    });
    return stats;
  }, [queryAnalysis?.entities]);

  // 计算总体进度
  const progress = useMemo(() => {
    if (!workflow?.steps?.length) return 0;
    const completed = workflow.steps.filter(s => s.status === 'completed').length;
    return (completed / workflow.steps.length) * 100;
  }, [workflow?.steps]);

  // 渲染工作流步骤
  const renderWorkflowSteps = () => {
    if (!workflow?.steps?.length) {
      return (
        <div className="text-center py-6 text-slate-500">
          <i className="fas fa-project-diagram text-3xl mb-2 opacity-50"></i>
          <p className="text-sm">等待工作流执行...</p>
        </div>
      );
    }

    return (
      <div className="space-y-2">
        {workflow.steps.map((step, index) => {
          const stepConfig = getStepConfig(step.step);
          const colors = STATUS_COLORS[step.status] || STATUS_COLORS.pending;
          const isStepExpanded = expandedSteps.has(index);
          const hasDetails = step.details?.operations && Array.isArray(step.details.operations);

          return (
            <div
              key={index}
              className={`rounded-lg border ${colors.bg} ${colors.border} transition-all duration-300 overflow-hidden`}
            >
              {/* 步骤头部 */}
              <div 
                className={`p-3 ${hasDetails ? 'cursor-pointer hover:bg-slate-700/30' : ''}`}
                onClick={() => hasDetails && toggleStepExpand(index)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {step.status === 'running' && (
                      <div className="w-6 h-6 flex items-center justify-center">
                        <i className="fas fa-spinner fa-spin text-cyan-400"></i>
                      </div>
                    )}
                    {step.status === 'completed' && (
                      <div className="w-6 h-6 flex items-center justify-center">
                        <i className="fas fa-check-circle text-green-400"></i>
                      </div>
                    )}
                    {step.status === 'skipped' && (
                      <div className="w-6 h-6 flex items-center justify-center">
                        <i className="fas fa-forward text-yellow-400"></i>
                      </div>
                    )}
                    {step.status === 'error' && (
                      <div className="w-6 h-6 flex items-center justify-center">
                        <i className="fas fa-exclamation-circle text-red-400"></i>
                      </div>
                    )}
                    {step.status === 'pending' && (
                      <div className="w-6 h-6 flex items-center justify-center">
                        <i className="fas fa-circle text-slate-500 text-xs"></i>
                      </div>
                    )}
                    <span className={`font-medium ${colors.text}`}>{stepConfig.name}</span>
                    {hasDetails && (
                      <i className={`fas fa-chevron-${isStepExpanded ? 'up' : 'down'} text-xs text-slate-500`}></i>
                    )}
                  </div>
                  {step.duration !== undefined && (
                    <span className="text-xs text-slate-500 font-mono">
                      {step.duration}ms
                    </span>
                  )}
                </div>
                
                {/* 简要统计信息 - 折叠状态时显示 */}
                {step.details && typeof step.details === 'object' && !isStepExpanded && (
                  <div className="mt-2 text-xs flex flex-wrap gap-2">
                    {step.details.entityCount !== undefined && (
                      <span className="bg-slate-700/50 px-2 py-0.5 rounded text-slate-300">
                        实体: {step.details.entityCount}
                      </span>
                    )}
                    {step.details.intent && (
                      <span className="bg-indigo-600/30 px-2 py-0.5 rounded text-indigo-300">
                        意图: {step.details.intent}
                      </span>
                    )}
                    {step.details.validatedCount !== undefined && step.details.totalCount !== undefined && (
                      <span className="bg-green-600/30 px-2 py-0.5 rounded text-green-300">
                        校验: {step.details.validatedCount}/{step.details.totalCount}
                      </span>
                    )}
                    {step.details.action && (
                      <span className="bg-cyan-600/30 px-2 py-0.5 rounded text-cyan-300">
                        动作: {step.details.actionName || step.details.action}
                      </span>
                    )}
                    {step.details.resultCount !== undefined && (
                      <span className="bg-blue-600/30 px-2 py-0.5 rounded text-blue-300">
                        结果: {step.details.resultCount}
                      </span>
                    )}
                    {step.details.inputCount !== undefined && step.details.outputCount !== undefined && (
                      <span className="bg-orange-600/30 px-2 py-0.5 rounded text-orange-300">
                        {step.details.inputCount} → {step.details.outputCount}
                      </span>
                    )}
                    {step.details.responseLength !== undefined && (
                      <span className="bg-pink-600/30 px-2 py-0.5 rounded text-pink-300">
                        响应: {step.details.responseLength}字
                      </span>
                    )}
                  </div>
                )}
                
                {step.error && (
                  <p className="mt-2 text-xs text-red-400 bg-red-900/30 p-2 rounded">
                    {step.error}
                  </p>
                )}
              </div>
              
              {/* 展开的详情区域 */}
              {isStepExpanded && hasDetails && (
                <div className="px-3 pb-3 border-t border-slate-700/50 pt-2 bg-slate-900/30">
                  <div className="text-xs font-medium text-slate-400 mb-2">执行详情</div>
                  <div className="space-y-1 font-mono text-xs">
                    {(step.details!.operations as string[]).map((op, opIndex) => (
                      <div 
                        key={`op-${index}-${opIndex}`}
                        className={`py-1 px-2 rounded ${
                          op.startsWith('---') ? 'bg-slate-800 text-slate-400 font-medium' :
                          op.startsWith('✓') ? 'text-green-400 bg-green-900/30' :
                          op.startsWith('✗') ? 'text-red-400 bg-red-900/30' :
                          op.startsWith('⚠️') ? 'text-amber-400 bg-amber-900/30' :
                          op.startsWith('[') ? 'text-blue-400 bg-blue-900/30' :
                          'text-slate-300'
                        }`}
                      >
                        {op}
                      </div>
                    ))}
                  </div>
                  
                  {/* 显示提取的实体 */}
                  {step.details?.extractedEntities && step.details.extractedEntities.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-slate-700/50">
                      <div className="text-xs font-medium text-slate-400 mb-2">提取的实体</div>
                      <div className="flex flex-wrap gap-2">
                        {step.details.extractedEntities.map((e, eIndex) => {
                          const typeConfig = ENTITY_TYPE_CONFIG[e.type as EntityType] || ENTITY_TYPE_CONFIG.OTHER;
                          return (
                            <span 
                              key={`entity-${index}-${eIndex}`}
                              className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs ${typeConfig.bg} ${typeConfig.color}`}
                            >
                              <i className={`fas ${typeConfig.icon} text-xs`}></i>
                              {e.name}
                              <span className="opacity-70">({typeConfig.label})</span>
                              <span className="bg-slate-900/50 px-1 rounded text-xs">
                                {(e.confidence * 100).toFixed(0)}%
                              </span>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  
                  {/* 显示校验的实体 */}
                  {step.details?.validatedEntities && step.details.validatedEntities.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-slate-700/50">
                      <div className="text-xs font-medium text-slate-400 mb-2">校验结果</div>
                      <div className="space-y-1">
                        {step.details.validatedEntities.map((e, vIndex) => (
                          <div 
                            key={`validated-${index}-${vIndex}`}
                            className={`flex items-center gap-2 px-2 py-1 rounded text-xs ${
                              e.isValid ? 'bg-green-900/30 text-green-300' : 'bg-yellow-900/30 text-yellow-300'
                            }`}
                          >
                            <i className={`fas ${e.isValid ? 'fa-check' : 'fa-question'}`}></i>
                            <span>{e.original}</span>
                            {e.normalized && e.normalized !== e.original && (
                              <>
                                <i className="fas fa-arrow-right text-slate-500"></i>
                                <span className="text-cyan-300">{e.normalized}</span>
                              </>
                            )}
                            <span className="text-slate-500">({e.type})</span>
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

        {/* 总耗时 */}
        {workflow.totalDuration && (
          <div className="mt-4 pt-4 border-t border-slate-700 flex justify-between items-center">
            <span className="text-sm text-slate-400">总耗时</span>
            <span className="font-mono font-medium text-cyan-400">
              {(workflow.totalDuration / 1000).toFixed(2)}s
            </span>
          </div>
        )}
      </div>
    );
  };

  // 渲染查询分析
  const renderQueryAnalysis = () => {
    if (!queryAnalysis) return null;

    const intentConfig = INTENT_CONFIG[queryAnalysis.intent] || INTENT_CONFIG.exploratory;

    return (
      <div className="space-y-4">
        {/* 原始查询 */}
        <div className="p-3 bg-slate-800/50 rounded-lg border border-slate-700">
          <div className="text-xs text-slate-500 mb-1">原始查询</div>
          <div className="text-white font-medium">&quot;{queryAnalysis.originalQuery}&quot;</div>
        </div>

        {/* 意图和复杂度 */}
        <div className="grid grid-cols-3 gap-3">
          <div className="p-3 bg-indigo-900/30 rounded-lg border border-indigo-500/30">
            <div className="text-xs text-indigo-400 mb-1">查询意图</div>
            <div className="flex items-center gap-2">
              <span className="text-xl">{intentConfig.icon}</span>
              <span className={`font-medium ${intentConfig.color}`}>{intentConfig.label}</span>
            </div>
          </div>
          <div className="p-3 bg-orange-900/30 rounded-lg border border-orange-500/30">
            <div className="text-xs text-orange-400 mb-1">复杂度</div>
            <div className="font-medium text-orange-300 capitalize">{queryAnalysis.complexity}</div>
          </div>
          <div className="p-3 bg-green-900/30 rounded-lg border border-green-500/30">
            <div className="text-xs text-green-400 mb-1">置信度</div>
            <div className="font-medium text-green-300">{(queryAnalysis.confidence * 100).toFixed(0)}%</div>
          </div>
        </div>

        {/* 关键词 */}
        {queryAnalysis.keywords?.length > 0 && (
          <div>
            <div className="text-xs text-slate-500 mb-2">提取的关键词</div>
            <div className="flex flex-wrap gap-2">
              {queryAnalysis.keywords.map((keyword, i) => (
                <span
                  key={i}
                  className="px-2 py-1 bg-slate-700/50 text-slate-300 text-xs rounded-full"
                >
                  {keyword}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  // 渲染实体分析
  const renderEntities = () => {
    const entities = queryAnalysis?.entities || [];
    
    if (entities.length === 0) {
      return (
        <div className="text-center py-4 text-slate-500">
          <i className="fas fa-tags text-2xl mb-2 opacity-50"></i>
          <p className="text-sm">未提取到实体</p>
        </div>
      );
    }

    return (
      <div className="space-y-3">
        {/* 实体类型统计 */}
        {Object.keys(entityStats).length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {Object.entries(entityStats).map(([type, count]) => {
              const config = ENTITY_TYPE_CONFIG[type as EntityType];
              return (
                <span
                  key={type}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs ${config.bg} ${config.color}`}
                >
                  <i className={`fas ${config.icon}`}></i>
                  {config.label}: {count}
                </span>
              );
            })}
          </div>
        )}

        {/* 实体列表 */}
        <div className="space-y-2">
          {entities.map((entity, idx) => {
            const config = ENTITY_TYPE_CONFIG[entity.type] || ENTITY_TYPE_CONFIG.OTHER;
            const validation = entityValidation?.find(e => e.name === entity.name);

            return (
              <div
                key={`entity-${idx}-${entity.name}`}
                className={`p-3 rounded-lg border ${config.bg} border-current/20`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-lg ${config.bg} flex items-center justify-center`}>
                      <i className={`fas ${config.icon} ${config.color}`}></i>
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-white">{entity.name}</span>
                        {validation?.normalizedName && validation.normalizedName !== entity.name && (
                          <>
                            <i className="fas fa-arrow-right text-xs text-slate-500"></i>
                            <span className="text-green-400">{validation.normalizedName}</span>
                          </>
                        )}
                      </div>
                      <span className={`text-xs ${config.color}`}>{config.label}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {validation !== undefined && (
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        validation.isValid 
                          ? 'bg-green-600/30 text-green-300' 
                          : 'bg-yellow-600/30 text-yellow-300'
                      }`}>
                        {validation.isValid ? '✓ 已验证' : '? 待确认'}
                      </span>
                    )}
                    <span className="text-xs text-slate-400">
                      {(entity.confidence * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>

                {/* 置信度条 */}
                <div className="mt-2 h-1 bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all ${config.bg.replace('/20', '/60')}`}
                    style={{ width: `${entity.confidence * 100}%` }}
                  ></div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // 渲染路由决策
  const renderRoutingDecision = () => {
    if (!routingDecision) return null;

    const actionConfig = ACTION_CONFIG[routingDecision.action] || {
      icon: 'fa-question',
      color: 'text-slate-400',
      label: routingDecision.action,
    };

    return (
      <div className="space-y-3">
        {/* 决策动作 */}
        <div className={`p-4 rounded-lg border ${actionConfig.color} bg-slate-800/50 border-current/30`}>
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-lg bg-current/20 flex items-center justify-center`}>
              <i className={`fas ${actionConfig.icon} ${actionConfig.color}`}></i>
            </div>
            <div>
              <div className={`font-medium ${actionConfig.color}`}>{actionConfig.label}</div>
              <div className="text-sm text-slate-400">{routingDecision.reason}</div>
            </div>
          </div>
        </div>

        {/* 约束信息 */}
        {routingDecision.constraints && (
          <div className="p-3 bg-slate-800/30 rounded-lg border border-slate-700/50">
            <div className="text-xs text-slate-500 mb-2">应用的约束</div>
            <pre className="text-xs text-slate-300 overflow-x-auto">
              {JSON.stringify(routingDecision.constraints, null, 2)}
            </pre>
          </div>
        )}

        {/* 放宽的约束 */}
        {routingDecision.relaxedConstraints && (
          <div className="p-3 bg-yellow-900/20 rounded-lg border border-yellow-500/30">
            <div className="text-xs text-yellow-400 mb-2">
              <i className="fas fa-unlock mr-1"></i>
              已放宽的约束
            </div>
            <pre className="text-xs text-yellow-300 overflow-x-auto">
              {JSON.stringify(routingDecision.relaxedConstraints, null, 2)}
            </pre>
          </div>
        )}

        {/* 重试次数 */}
        {routingDecision.retryCount !== undefined && routingDecision.retryCount > 0 && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-400">重试次数</span>
            <span className="px-2 py-0.5 bg-yellow-900/30 text-yellow-400 rounded-full">
              {routingDecision.retryCount}
            </span>
          </div>
        )}
      </div>
    );
  };

  // 渲染检索结果
  const renderRetrievalResults = () => {
    if (!retrievalDetails) return null;

    return (
      <div className="space-y-3">
        {/* 统计 */}
        <div className="grid grid-cols-2 gap-3">
          <div className="p-3 bg-blue-900/30 rounded-lg border border-blue-500/30 text-center">
            <div className="text-2xl font-bold text-blue-400">{retrievalDetails.searchResultCount}</div>
            <div className="text-xs text-blue-300">初始检索</div>
          </div>
          <div className="p-3 bg-green-900/30 rounded-lg border border-green-500/30 text-center">
            <div className="text-2xl font-bold text-green-400">{retrievalDetails.rankedResultCount}</div>
            <div className="text-xs text-green-300">重排序后</div>
          </div>
        </div>

        {/* Top 结果 */}
        {retrievalDetails.topResults?.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs text-slate-500">Top 检索结果</div>
            {retrievalDetails.topResults.map((result, idx) => (
              <div
                key={idx}
                className="p-3 bg-slate-800/50 rounded-lg border border-slate-700/50"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-white">结果 {idx + 1}</span>
                  <div className="flex items-center gap-2">
                    {result.matchType && (
                      <span className="px-2 py-0.5 bg-purple-900/30 text-purple-300 text-xs rounded">
                        {result.matchType}
                      </span>
                    )}
                    <span className={`px-2 py-0.5 text-xs rounded ${
                      (result.rerankedScore || result.score) >= 0.7
                        ? 'bg-green-900/30 text-green-300'
                        : (result.rerankedScore || result.score) >= 0.4
                        ? 'bg-yellow-900/30 text-yellow-300'
                        : 'bg-red-900/30 text-red-300'
                    }`}>
                      {((result.rerankedScore || result.score) * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>
                <p className="text-sm text-slate-400 line-clamp-2">
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
      <div className="border border-slate-700/50 rounded-lg overflow-hidden">
        <button
          className="w-full px-4 py-3 flex items-center justify-between bg-slate-800/50 hover:bg-slate-700/50 transition-colors"
          onClick={() => toggleSection(id)}
        >
          <div className="flex items-center gap-2">
            <i className={`fas ${icon} text-slate-400`}></i>
            <span className="font-medium text-white">{title}</span>
            {badge}
          </div>
          <i className={`fas fa-chevron-${sectionExpanded ? 'up' : 'down'} text-slate-500`}></i>
        </button>
        {sectionExpanded && (
          <div className="p-4 bg-slate-900/50">
            {content}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`bg-gradient-to-br from-slate-900 to-slate-800 rounded-xl shadow-xl border border-cyan-500/30 overflow-hidden ${className}`}>
      {/* 头部 */}
      <div
        className="px-5 py-4 bg-gradient-to-r from-cyan-600/30 to-blue-600/30 cursor-pointer hover:from-cyan-600/40 hover:to-blue-600/40 transition-all"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-cyan-600/30 flex items-center justify-center">
              <i className="fas fa-route text-cyan-400 text-lg"></i>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-white">实体路由 RAG 工作流</h3>
              <p className="text-xs text-slate-400">Adaptive Entity-Routing RAG</p>
            </div>
            {!isExpanded && workflow?.steps && (
              <span className="text-xs text-slate-400 ml-2">
                ({workflow.steps.filter(s => s.status === 'completed').length}/{workflow.steps.length} 步骤完成)
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {isLoading && (
              <div className="flex items-center gap-2 text-cyan-400 text-sm">
                <i className="fas fa-spinner fa-spin"></i>
                <span>处理中...</span>
              </div>
            )}
            {!isLoading && workflow?.totalDuration && (
              <div className="text-sm text-slate-400">
                耗时: <span className="text-cyan-400 font-mono">{(workflow.totalDuration / 1000).toFixed(2)}s</span>
              </div>
            )}
            <button
              className="p-1 hover:bg-white/10 rounded transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                setIsExpanded(!isExpanded);
              }}
            >
              <i className={`fas fa-chevron-${isExpanded ? 'up' : 'down'} text-slate-400`}></i>
            </button>
            {onClose && (
              <button
                className="p-1 hover:bg-white/10 rounded transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose();
                }}
              >
                <i className="fas fa-times text-slate-400"></i>
              </button>
            )}
          </div>
        </div>

        {/* 进度条 */}
        {progress > 0 && (
          <div className="mt-3 h-1.5 bg-slate-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </div>

      {/* 内容区域 */}
      {isExpanded && (
        <div className="p-4 space-y-3">
          {/* 工作流步骤 */}
          {renderSection(
            'workflow',
            '工作流步骤',
            'fa-project-diagram',
            renderWorkflowSteps(),
            workflow?.steps?.length ? (
              <span className="px-2 py-0.5 bg-cyan-900/30 text-cyan-300 text-xs rounded-full">
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
              INTENT_CONFIG[queryAnalysis.intent]?.color || 'text-slate-400'
            } bg-slate-800/50`}>
              {queryAnalysis.intent}
            </span>
          )}

          {/* 实体分析 */}
          {(queryAnalysis?.entities?.length || 0) > 0 && renderSection(
            'entities',
            '实体分析',
            'fa-tags',
            renderEntities(),
            <span className="px-2 py-0.5 bg-emerald-900/30 text-emerald-300 text-xs rounded-full">
              {queryAnalysis?.entities?.length || 0} 个实体
            </span>
          )}

          {/* 路由决策 */}
          {routingDecision && renderSection(
            'routing',
            '路由决策',
            'fa-route',
            renderRoutingDecision(),
            <span className={`px-2 py-0.5 text-xs rounded-full ${
              ACTION_CONFIG[routingDecision.action]?.color || 'text-slate-400'
            } bg-slate-800/50`}>
              {ACTION_CONFIG[routingDecision.action]?.label || routingDecision.action}
            </span>
          )}

          {/* 检索结果 */}
          {retrievalDetails && renderSection(
            'retrieval',
            '检索结果',
            'fa-database',
            renderRetrievalResults(),
            <span className="px-2 py-0.5 bg-blue-900/30 text-blue-300 text-xs rounded-full">
              {retrievalDetails.rankedResultCount} 个结果
            </span>
          )}
        </div>
      )}
    </div>
  );
}

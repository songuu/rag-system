'use client';

import { useState, useEffect } from 'react';

// ==================== 类型定义 ====================

interface ExtractedEntity {
  name: string;
  type: string;
  confidence: number;
}

interface IntentAnchor {
  entities: ExtractedEntity[];
  attributes: string[];
  intentType: string;
  stage: string;
}

interface StrategyResult {
  strategy: 'drill-down' | 'lateral-move' | 'logical-flow';
  label: string;
  icon: string;
  color: string;
  bgColor: string;
  data: any;
  questions: string[];
}

interface CandidateQuestion {
  question: string;
  strategy: string;
  strategyLabel: string;
  relevanceScore: number;
  validated: boolean;
  validationDetails?: {
    hasEvidence: boolean;
    isDuplicate: boolean;
    keywordsFound: string[];
  };
}

interface WorkflowTimings {
  anchorAnalysis: number;
  strategyRouting: number;
  questionGeneration: number;
  validation: number;
}

interface ConversationExpansionWorkflowProps {
  anchor: IntentAnchor | null;
  suggestions: CandidateQuestion[];
  timings: WorkflowTimings | null;
  processingTime?: number;
  isLoading?: boolean;
  userQuery?: string;
  aiResponse?: string;
}

// ==================== 策略配置 ====================

const STRATEGY_CONFIG: Record<string, { label: string; icon: string; color: string; bgColor: string; desc: string }> = {
  'drill-down': {
    label: '纵向深挖',
    icon: '🔍',
    color: 'text-blue-400',
    bgColor: 'bg-blue-500/10 border-blue-500/30',
    desc: '探索同一实体的其他属性',
  },
  'lateral-move': {
    label: '横向拓展',
    icon: '↔️',
    color: 'text-green-400',
    bgColor: 'bg-green-500/10 border-green-500/30',
    desc: '对比相似实体的同一属性',
  },
  'logical-flow': {
    label: '逻辑推演',
    icon: '💡',
    color: 'text-amber-400',
    bgColor: 'bg-amber-500/10 border-amber-500/30',
    desc: '推导条件、后果或建议',
  },
};

const INTENT_TYPE_LABELS: Record<string, string> = {
  'query': '信息查询',
  'compare': '对比分析',
  'how-to': '操作指导',
  'why': '原因探究',
  'what-if': '假设推演',
  'other': '其他',
};

const STAGE_LABELS: Record<string, string> = {
  'initial': '初始阶段',
  'exploring': '探索阶段',
  'deep-diving': '深入阶段',
  'concluding': '总结阶段',
};

const ENTITY_TYPE_COLORS: Record<string, string> = {
  'product': 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
  'person': 'bg-purple-500/20 text-purple-300 border-purple-500/30',
  'organization': 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  'concept': 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  'action': 'bg-green-500/20 text-green-300 border-green-500/30',
  'attribute': 'bg-pink-500/20 text-pink-300 border-pink-500/30',
  'other': 'bg-slate-500/20 text-slate-300 border-slate-500/30',
};

// ==================== 组件 ====================

export default function ConversationExpansionWorkflow({
  anchor,
  suggestions,
  timings,
  processingTime,
  isLoading = false,
  userQuery,
  aiResponse,
}: ConversationExpansionWorkflowProps) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['anchor', 'strategy', 'validation']));
  const [activeStep, setActiveStep] = useState<number>(0);

  // 动画效果：加载时逐步展示
  useEffect(() => {
    if (isLoading) {
      setActiveStep(0);
      const timer1 = setTimeout(() => setActiveStep(1), 300);
      const timer2 = setTimeout(() => setActiveStep(2), 800);
      const timer3 = setTimeout(() => setActiveStep(3), 1300);
      const timer4 = setTimeout(() => setActiveStep(4), 1800);
      return () => {
        clearTimeout(timer1);
        clearTimeout(timer2);
        clearTimeout(timer3);
        clearTimeout(timer4);
      };
    } else if (suggestions.length > 0) {
      setActiveStep(5);
    }
  }, [isLoading, suggestions.length]);

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

  // 按策略分组候选问题
  const groupedQuestions = suggestions.reduce((acc, q) => {
    const strategy = q.strategy || 'other';
    if (!acc[strategy]) {
      acc[strategy] = [];
    }
    acc[strategy].push(q);
    return acc;
  }, {} as Record<string, CandidateQuestion[]>);

  // 统计数据
  const validatedCount = suggestions.filter(s => s.validated).length;
  const totalCount = suggestions.length;

  // 渲染加载骨架
  if (isLoading && !anchor) {
    return (
      <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-xl border border-slate-700/50 p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="animate-spin w-5 h-5 border-2 border-teal-400 border-t-transparent rounded-full" />
          <h3 className="text-lg font-semibold text-white">猜你想问 - 思考过程</h3>
        </div>
        
        {/* 工作流步骤骨架 */}
        <div className="space-y-3">
          {[1, 2, 3, 4].map((step) => (
            <div
              key={step}
              className={`p-3 rounded-lg border transition-all duration-500 ${
                activeStep >= step
                  ? 'bg-slate-700/50 border-slate-600'
                  : 'bg-slate-800/50 border-slate-700/30 opacity-50'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                  activeStep >= step ? 'bg-teal-500/20 text-teal-400' : 'bg-slate-700 text-slate-500'
                }`}>
                  {activeStep > step ? '✓' : step}
                </div>
                <div className="flex-1">
                  <div className={`h-4 rounded ${activeStep >= step ? 'bg-slate-600 animate-pulse' : 'bg-slate-700/50'}`} 
                       style={{ width: `${40 + step * 15}%` }} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // 没有数据时不显示
  if (!anchor && suggestions.length === 0) {
    return null;
  }

  return (
    <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-xl border border-slate-700/50 overflow-hidden">
      {/* 头部 */}
      <div className="p-4 border-b border-slate-700/50 bg-gradient-to-r from-teal-900/30 to-cyan-900/30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">💬</span>
            <div>
              <h3 className="text-lg font-semibold text-white">猜你想问 - 思考过程</h3>
              <p className="text-xs text-slate-400">对话延伸引擎可视化</p>
            </div>
          </div>
          
          {/* 统计信息 */}
          {timings && (
            <div className="flex items-center gap-4 text-xs">
              <div className="flex items-center gap-1.5 px-2 py-1 bg-slate-700/50 rounded-lg">
                <span className="text-slate-400">总耗时</span>
                <span className="text-teal-400 font-mono">{processingTime || 0}ms</span>
              </div>
              <div className="flex items-center gap-1.5 px-2 py-1 bg-slate-700/50 rounded-lg">
                <span className="text-slate-400">生成</span>
                <span className="text-green-400 font-mono">{validatedCount}/{totalCount}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* ==================== 第一步：意图锚点分析 ==================== */}
        <div className="border border-slate-700/50 rounded-lg overflow-hidden">
          <button
            onClick={() => toggleSection('anchor')}
            className="w-full p-3 flex items-center justify-between bg-slate-800/50 hover:bg-slate-700/50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center text-blue-400 font-bold">
                1
              </div>
              <div className="text-left">
                <h4 className="text-sm font-medium text-white">意图锚点分析</h4>
                <p className="text-xs text-slate-400">理解当前对话位置</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {timings && (
                <span className="text-xs text-slate-500 font-mono">{timings.anchorAnalysis}ms</span>
              )}
              <span className={`transition-transform ${expandedSections.has('anchor') ? 'rotate-180' : ''}`}>
                ▼
              </span>
            </div>
          </button>
          
          {expandedSections.has('anchor') && anchor && (
            <div className="p-4 bg-slate-800/30 space-y-4">
              {/* 输入信息 */}
              {(userQuery || aiResponse) && (
                <div className="space-y-2">
                  <div className="text-xs text-slate-500 font-medium">输入信息</div>
                  {userQuery && (
                    <div className="p-2 bg-slate-700/30 rounded-lg">
                      <span className="text-xs text-cyan-400">用户问题: </span>
                      <span className="text-xs text-slate-300">{userQuery.slice(0, 100)}{userQuery.length > 100 ? '...' : ''}</span>
                    </div>
                  )}
                </div>
              )}

              {/* 提取的实体 */}
              <div className="space-y-2">
                <div className="text-xs text-slate-500 font-medium">提取的实体</div>
                {anchor.entities.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {anchor.entities.map((entity, i) => (
                      <div
                        key={i}
                        className={`px-3 py-1.5 rounded-lg border text-sm flex items-center gap-2 ${
                          ENTITY_TYPE_COLORS[entity.type] || ENTITY_TYPE_COLORS.other
                        }`}
                      >
                        <span className="font-medium">{entity.name}</span>
                        <span className="text-xs opacity-70">({entity.type})</span>
                        <span className="text-xs opacity-50">{(entity.confidence * 100).toFixed(0)}%</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-slate-500 italic">未提取到实体</div>
                )}
              </div>

              {/* 关注属性 */}
              <div className="space-y-2">
                <div className="text-xs text-slate-500 font-medium">关注属性</div>
                {anchor.attributes.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {anchor.attributes.map((attr, i) => (
                      <span
                        key={i}
                        className="px-3 py-1 bg-purple-500/20 text-purple-300 border border-purple-500/30 rounded-lg text-sm"
                      >
                        {attr}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-slate-500 italic">未识别到属性</div>
                )}
              </div>

              {/* 意图和阶段 */}
              <div className="grid grid-cols-2 gap-4">
                <div className="p-3 bg-slate-700/30 rounded-lg">
                  <div className="text-xs text-slate-500 mb-1">意图类型</div>
                  <div className="text-sm text-white font-medium">
                    {INTENT_TYPE_LABELS[anchor.intentType] || anchor.intentType}
                  </div>
                </div>
                <div className="p-3 bg-slate-700/30 rounded-lg">
                  <div className="text-xs text-slate-500 mb-1">对话阶段</div>
                  <div className="text-sm text-white font-medium">
                    {STAGE_LABELS[anchor.stage] || anchor.stage}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ==================== 第二步：策略路由 ==================== */}
        <div className="border border-slate-700/50 rounded-lg overflow-hidden">
          <button
            onClick={() => toggleSection('strategy')}
            className="w-full p-3 flex items-center justify-between bg-slate-800/50 hover:bg-slate-700/50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center text-amber-400 font-bold">
                2
              </div>
              <div className="text-left">
                <h4 className="text-sm font-medium text-white">延伸策略路由</h4>
                <p className="text-xs text-slate-400">三维策略并行探索</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {timings && (
                <span className="text-xs text-slate-500 font-mono">{timings.strategyRouting}ms</span>
              )}
              <span className={`transition-transform ${expandedSections.has('strategy') ? 'rotate-180' : ''}`}>
                ▼
              </span>
            </div>
          </button>
          
          {expandedSections.has('strategy') && (
            <div className="p-4 bg-slate-800/30">
              <div className="grid grid-cols-3 gap-3">
                {Object.entries(STRATEGY_CONFIG).map(([key, config]) => {
                  const questions = groupedQuestions[key] || [];
                  const hasResults = questions.length > 0;
                  
                  return (
                    <div
                      key={key}
                      className={`p-3 rounded-lg border transition-all ${
                        hasResults
                          ? config.bgColor
                          : 'bg-slate-800/50 border-slate-700/50 opacity-50'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xl">{config.icon}</span>
                        <span className={`text-sm font-medium ${hasResults ? config.color : 'text-slate-400'}`}>
                          {config.label}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mb-2">{config.desc}</p>
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-slate-500">结果:</span>
                        <span className={`text-xs font-mono ${hasResults ? 'text-white' : 'text-slate-500'}`}>
                          {questions.length} 个问题
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* ==================== 第三步：候选问题生成 ==================== */}
        <div className="border border-slate-700/50 rounded-lg overflow-hidden">
          <button
            onClick={() => toggleSection('generation')}
            className="w-full p-3 flex items-center justify-between bg-slate-800/50 hover:bg-slate-700/50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center text-green-400 font-bold">
                3
              </div>
              <div className="text-left">
                <h4 className="text-sm font-medium text-white">候选问题生成</h4>
                <p className="text-xs text-slate-400">将策略转化为自然语言问题</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {timings && (
                <span className="text-xs text-slate-500 font-mono">{timings.questionGeneration}ms</span>
              )}
              <span className="text-xs text-slate-400">共 {totalCount} 个</span>
              <span className={`transition-transform ${expandedSections.has('generation') ? 'rotate-180' : ''}`}>
                ▼
              </span>
            </div>
          </button>
          
          {expandedSections.has('generation') && suggestions.length > 0 && (
            <div className="p-4 bg-slate-800/30 space-y-3">
              {Object.entries(groupedQuestions).map(([strategy, questions]) => {
                const config = STRATEGY_CONFIG[strategy] || STRATEGY_CONFIG['logical-flow'];
                
                return (
                  <div key={strategy} className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{config.icon}</span>
                      <span className={`text-xs font-medium ${config.color}`}>{config.label}</span>
                    </div>
                    <div className="pl-7 space-y-2">
                      {questions.map((q, i) => (
                        <div
                          key={i}
                          className={`p-2 rounded-lg border ${config.bgColor} flex items-start justify-between`}
                        >
                          <span className="text-sm text-slate-200">{q.question}</span>
                          <span className="text-xs text-slate-500 ml-2 flex-shrink-0">
                            {(q.relevanceScore * 100).toFixed(0)}%
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ==================== 第四步：证据闭环校验 ==================== */}
        <div className="border border-slate-700/50 rounded-lg overflow-hidden">
          <button
            onClick={() => toggleSection('validation')}
            className="w-full p-3 flex items-center justify-between bg-slate-800/50 hover:bg-slate-700/50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-purple-500/20 flex items-center justify-center text-purple-400 font-bold">
                4
              </div>
              <div className="text-left">
                <h4 className="text-sm font-medium text-white">证据闭环校验</h4>
                <p className="text-xs text-slate-400">确保推荐问题可回答</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {timings && (
                <span className="text-xs text-slate-500 font-mono">{timings.validation}ms</span>
              )}
              <span className={`text-xs ${validatedCount > 0 ? 'text-green-400' : 'text-slate-400'}`}>
                通过 {validatedCount}/{totalCount}
              </span>
              <span className={`transition-transform ${expandedSections.has('validation') ? 'rotate-180' : ''}`}>
                ▼
              </span>
            </div>
          </button>
          
          {expandedSections.has('validation') && suggestions.length > 0 && (
            <div className="p-4 bg-slate-800/30 space-y-3">
              {/* 校验统计 */}
              <div className="grid grid-cols-3 gap-3">
                <div className="p-3 bg-green-500/10 border border-green-500/30 rounded-lg text-center">
                  <div className="text-2xl font-bold text-green-400">{validatedCount}</div>
                  <div className="text-xs text-green-300">通过校验</div>
                </div>
                <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-center">
                  <div className="text-2xl font-bold text-red-400">{totalCount - validatedCount}</div>
                  <div className="text-xs text-red-300">被过滤</div>
                </div>
                <div className="p-3 bg-slate-700/50 border border-slate-600/50 rounded-lg text-center">
                  <div className="text-2xl font-bold text-slate-300">
                    {totalCount > 0 ? ((validatedCount / totalCount) * 100).toFixed(0) : 0}%
                  </div>
                  <div className="text-xs text-slate-400">通过率</div>
                </div>
              </div>

              {/* 校验详情 */}
              <div className="space-y-2">
                <div className="text-xs text-slate-500 font-medium">校验详情</div>
                {suggestions.map((q, i) => (
                  <div
                    key={i}
                    className={`p-3 rounded-lg border ${
                      q.validated
                        ? 'bg-green-500/10 border-green-500/30'
                        : 'bg-red-500/10 border-red-500/30'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <span className="text-lg flex-shrink-0">
                        {q.validated ? '✅' : '❌'}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-200">{q.question}</p>
                        {q.validationDetails && (
                          <div className="mt-2 space-y-1.5">
                            {/* 第一行：基本校验状态 */}
                            <div className="flex items-center gap-3 text-xs">
                              <span className={q.validationDetails.hasEvidence ? 'text-green-400' : 'text-red-400'}>
                                {q.validationDetails.hasEvidence ? '✓ 有证据' : '✗ 证据不足'}
                              </span>
                              <span className={!q.validationDetails.isDuplicate ? 'text-green-400' : 'text-red-400'}>
                                {!q.validationDetails.isDuplicate ? '✓ 不重复' : '✗ 与原问题重复'}
                              </span>
                              {q.validationDetails.hallucination !== undefined && (
                                <span className={!q.validationDetails.hallucination ? 'text-green-400' : 'text-red-400'}>
                                  {!q.validationDetails.hallucination ? '✓ 无幻觉' : '✗ 检测到幻觉'}
                                </span>
                              )}
                            </div>
                            
                            {/* 第二行：覆盖率详情 */}
                            <div className="flex items-center gap-4 text-xs">
                              {q.validationDetails.entityCoverage !== undefined && (
                                <div className="flex items-center gap-1">
                                  <span className="text-slate-500">实体覆盖:</span>
                                  <span className={q.validationDetails.entityCoverage >= 0.5 ? 'text-green-400' : 'text-amber-400'}>
                                    {(q.validationDetails.entityCoverage * 100).toFixed(0)}%
                                  </span>
                                </div>
                              )}
                              {q.validationDetails.keywordCoverage !== undefined && (
                                <div className="flex items-center gap-1">
                                  <span className="text-slate-500">关键词覆盖:</span>
                                  <span className={q.validationDetails.keywordCoverage >= 0.5 ? 'text-green-400' : 'text-amber-400'}>
                                    {(q.validationDetails.keywordCoverage * 100).toFixed(0)}%
                                  </span>
                                </div>
                              )}
                            </div>
                            
                            {/* 第三行：找到的实体/关键词 */}
                            {(q.validationDetails.foundEntities?.length > 0 || q.validationDetails.keywordsFound?.length > 0) && (
                              <div className="text-xs text-slate-400">
                                {q.validationDetails.foundEntities?.length > 0 && (
                                  <span>匹配实体: {q.validationDetails.foundEntities.slice(0, 3).join(', ')}</span>
                                )}
                                {q.validationDetails.foundEntities?.length > 0 && q.validationDetails.keywordsFound?.length > 0 && (
                                  <span className="mx-1">|</span>
                                )}
                                {q.validationDetails.keywordsFound?.length > 0 && (
                                  <span>匹配词: {q.validationDetails.keywordsFound.slice(0, 3).join(', ')}</span>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ==================== 工作流时序图 ==================== */}
        {timings && (
          <div className="border border-slate-700/50 rounded-lg p-4 bg-slate-800/30">
            <div className="text-xs text-slate-500 font-medium mb-3">处理时序</div>
            <div className="relative">
              {/* 时间轴 */}
              <div className="absolute left-0 top-0 bottom-0 w-px bg-slate-600" />
              
              {/* 步骤 */}
              <div className="space-y-3 pl-6">
                {[
                  { name: '锚点分析', time: timings.anchorAnalysis, color: 'bg-blue-500' },
                  { name: '策略路由', time: timings.strategyRouting, color: 'bg-amber-500' },
                  { name: '问题生成', time: timings.questionGeneration, color: 'bg-green-500' },
                  { name: '证据校验', time: timings.validation, color: 'bg-purple-500' },
                ].map((step, i) => {
                  const totalTime = timings.anchorAnalysis + timings.strategyRouting + 
                                   timings.questionGeneration + timings.validation;
                  const percentage = totalTime > 0 ? (step.time / totalTime) * 100 : 0;
                  
                  return (
                    <div key={i} className="relative">
                      <div className={`absolute -left-6 top-1 w-3 h-3 rounded-full ${step.color}`} />
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-slate-400 w-16">{step.name}</span>
                        <div className="flex-1 h-2 bg-slate-700 rounded-full overflow-hidden">
                          <div
                            className={`h-full ${step.color} transition-all duration-500`}
                            style={{ width: `${percentage}%` }}
                          />
                        </div>
                        <span className="text-xs text-slate-500 font-mono w-16 text-right">
                          {step.time}ms
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

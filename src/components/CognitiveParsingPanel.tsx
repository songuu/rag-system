'use client';

import { useState, useMemo } from 'react';

// ==================== 类型定义 ====================

type EntityType = 'PERSON' | 'ORGANIZATION' | 'LOCATION' | 'PRODUCT' | 'DATE' | 'EVENT' | 'CONCEPT' | 'OTHER';
type IntentType = 'factual' | 'conceptual' | 'comparison' | 'procedural' | 'exploratory';
type LogicalOperator = 'AND' | 'OR' | 'NOT';

interface ExtractedEntity {
  name: string;
  type: EntityType;
  value: string;
  confidence: number;
  normalizedName?: string;
  isValid?: boolean;
  matchScore?: number;
  suggestions?: string[];
}

interface LogicalRelation {
  operator: LogicalOperator;
  entities: string[];
  description: string;
}

interface QueryAnalysis {
  originalQuery: string;
  intent: IntentType;
  complexity: string;
  confidence: number;
  entities: ExtractedEntity[];
  keywords: string[];
  logicalRelations?: LogicalRelation[];
}

interface CognitiveParsingPanelProps {
  queryAnalysis: QueryAnalysis | null;
  validatedEntities?: ExtractedEntity[];
  isLoading?: boolean;
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

const INTENT_CONFIG: Record<IntentType, { icon: string; color: string; label: string; description: string }> = {
  factual: { 
    icon: '📊', 
    color: 'text-blue-400', 
    label: '事实查询', 
    description: '需要精确答案的问题，如"XX是什么"、"XX什么时候"' 
  },
  conceptual: { 
    icon: '💡', 
    color: 'text-yellow-400', 
    label: '概念理解', 
    description: '需要解释或理解的问题，如"为什么"、"什么意思"' 
  },
  comparison: { 
    icon: '⚖️', 
    color: 'text-purple-400', 
    label: '比较分析', 
    description: '需要对比或评估的问题，如"A和B哪个好"' 
  },
  procedural: { 
    icon: '📝', 
    color: 'text-green-400', 
    label: '操作指导', 
    description: '需要步骤或方法的问题，如"怎么做"、"如何"' 
  },
  exploratory: { 
    icon: '🔍', 
    color: 'text-cyan-400', 
    label: '探索性', 
    description: '开放性问题，需要广泛信息支持' 
  },
};

const OPERATOR_CONFIG: Record<LogicalOperator, { icon: string; color: string; label: string }> = {
  AND: { icon: 'fa-link', color: 'text-green-400', label: '并且' },
  OR: { icon: 'fa-random', color: 'text-blue-400', label: '或者' },
  NOT: { icon: 'fa-ban', color: 'text-red-400', label: '排除' },
};

const COMPLEXITY_CONFIG: Record<string, { icon: string; color: string; label: string }> = {
  simple: { icon: 'fa-circle', color: 'text-green-400', label: '简单' },
  moderate: { icon: 'fa-adjust', color: 'text-yellow-400', label: '中等' },
  complex: { icon: 'fa-circle-notch', color: 'text-red-400', label: '复杂' },
};

// ==================== 组件实现 ====================

export default function CognitiveParsingPanel({ 
  queryAnalysis, 
  validatedEntities,
  isLoading 
}: CognitiveParsingPanelProps) {
  const [expandedSection, setExpandedSection] = useState<string | null>('transform');

  // 计算实体统计
  const entityStats = useMemo(() => {
    if (!queryAnalysis?.entities) return {};
    const stats: Record<EntityType, number> = {} as any;
    queryAnalysis.entities.forEach(e => {
      stats[e.type] = (stats[e.type] || 0) + 1;
    });
    return stats;
  }, [queryAnalysis?.entities]);

  // 加载状态
  if (isLoading) {
    return (
      <div className="bg-gradient-to-br from-slate-900/95 to-slate-800/95 rounded-xl border border-indigo-500/30 p-6 backdrop-blur-sm">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-indigo-600/30 flex items-center justify-center">
            <i className="fas fa-brain text-indigo-400 animate-pulse"></i>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">认知解析层</h3>
            <p className="text-xs text-slate-400">Cognitive Parsing Layer</p>
          </div>
        </div>
        <div className="flex flex-col items-center justify-center py-8">
          <div className="relative">
            <div className="w-16 h-16 border-4 border-slate-700 rounded-full"></div>
            <div className="absolute inset-0 w-16 h-16 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
          <p className="mt-4 text-sm text-slate-400">正在解析自然语言...</p>
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
            <span>实体提取</span>
            <i className="fas fa-chevron-right text-[8px]"></i>
            <span>逻辑分析</span>
            <i className="fas fa-chevron-right text-[8px]"></i>
            <span>意图分类</span>
          </div>
        </div>
      </div>
    );
  }

  // 无数据状态
  if (!queryAnalysis) {
    return (
      <div className="bg-gradient-to-br from-slate-900/95 to-slate-800/95 rounded-xl border border-slate-700/50 p-6 backdrop-blur-sm">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-slate-700/50 flex items-center justify-center">
            <i className="fas fa-brain text-slate-500"></i>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-400">认知解析层</h3>
            <p className="text-xs text-slate-500">Cognitive Parsing Layer</p>
          </div>
        </div>
        <div className="text-center py-8 text-slate-500">
          <i className="fas fa-comment-dots text-3xl mb-3 opacity-50"></i>
          <p className="text-sm">输入查询后查看认知解析结果</p>
        </div>
      </div>
    );
  }

  const intentConfig = INTENT_CONFIG[queryAnalysis.intent] || INTENT_CONFIG.exploratory;
  const complexityConfig = COMPLEXITY_CONFIG[queryAnalysis.complexity] || COMPLEXITY_CONFIG.simple;

  return (
    <div className="bg-gradient-to-br from-slate-900/95 to-slate-800/95 rounded-xl border border-indigo-500/30 backdrop-blur-sm overflow-hidden">
      {/* 头部 */}
      <div className="px-5 py-4 bg-gradient-to-r from-indigo-600/20 to-purple-600/20 border-b border-indigo-500/30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-indigo-600/30 flex items-center justify-center">
              <i className="fas fa-brain text-indigo-400"></i>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-white">认知解析层</h3>
              <p className="text-xs text-slate-400">自然语言 → 结构化数据对象</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`px-2 py-1 rounded-full text-xs ${complexityConfig.color} bg-slate-800/50`}>
              <i className={`fas ${complexityConfig.icon} mr-1`}></i>
              {complexityConfig.label}
            </span>
            <span className="px-2 py-1 rounded-full text-xs text-indigo-300 bg-indigo-600/30">
              置信度: {(queryAnalysis.confidence * 100).toFixed(0)}%
            </span>
          </div>
        </div>
      </div>

      <div className="p-5 space-y-4">
        {/* 1. 转换可视化 */}
        <div className="border border-slate-700/50 rounded-lg overflow-hidden">
          <button
            onClick={() => setExpandedSection(expandedSection === 'transform' ? null : 'transform')}
            className="w-full px-4 py-3 flex items-center justify-between bg-slate-800/50 hover:bg-slate-700/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <i className="fas fa-exchange-alt text-cyan-400"></i>
              <span className="text-sm font-medium text-white">查询转换</span>
            </div>
            <i className={`fas fa-chevron-down text-slate-400 transition-transform ${expandedSection === 'transform' ? 'rotate-180' : ''}`}></i>
          </button>
          
          {expandedSection === 'transform' && (
            <div className="p-4 bg-slate-900/50">
              {/* 原始查询 */}
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="px-2 py-0.5 text-xs bg-slate-700 text-slate-300 rounded">输入</span>
                  <span className="text-xs text-slate-500">自然语言查询</span>
                </div>
                <div className="p-3 bg-slate-800 rounded-lg border border-slate-600/50">
                  <p className="text-white font-mono text-sm">&quot;{queryAnalysis.originalQuery}&quot;</p>
                </div>
              </div>

              {/* 转换箭头 */}
              <div className="flex items-center justify-center py-2">
                <div className="flex-1 h-px bg-gradient-to-r from-transparent via-indigo-500/50 to-transparent"></div>
                <div className="mx-4 flex items-center gap-2 text-indigo-400">
                  <i className="fas fa-brain"></i>
                  <span className="text-xs">LLM 解析</span>
                  <i className="fas fa-arrow-down"></i>
                </div>
                <div className="flex-1 h-px bg-gradient-to-r from-transparent via-indigo-500/50 to-transparent"></div>
              </div>

              {/* 结构化输出 */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="px-2 py-0.5 text-xs bg-indigo-600 text-white rounded">输出</span>
                  <span className="text-xs text-slate-500">结构化数据对象</span>
                </div>
                <div className="p-3 bg-slate-800/80 rounded-lg border border-indigo-500/30 font-mono text-xs overflow-x-auto">
                  <pre className="text-slate-300">
{`{
  "intent": "${queryAnalysis.intent}",
  "complexity": "${queryAnalysis.complexity}",
  "entities": [${queryAnalysis.entities.map(e => `
    { "name": "${e.name}", "type": "${e.type}", "confidence": ${e.confidence.toFixed(2)} }`).join(',')}
  ],
  "keywords": ${JSON.stringify(queryAnalysis.keywords || [])},
  "logicalRelations": ${JSON.stringify(queryAnalysis.logicalRelations || [])}
}`}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 2. 意图分析 */}
        <div className="border border-slate-700/50 rounded-lg overflow-hidden">
          <button
            onClick={() => setExpandedSection(expandedSection === 'intent' ? null : 'intent')}
            className="w-full px-4 py-3 flex items-center justify-between bg-slate-800/50 hover:bg-slate-700/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <span className="text-xl">{intentConfig.icon}</span>
              <span className="text-sm font-medium text-white">意图分析</span>
              <span className={`px-2 py-0.5 text-xs rounded ${intentConfig.color} bg-slate-900/50`}>
                {intentConfig.label}
              </span>
            </div>
            <i className={`fas fa-chevron-down text-slate-400 transition-transform ${expandedSection === 'intent' ? 'rotate-180' : ''}`}></i>
          </button>

          {expandedSection === 'intent' && (
            <div className="p-4 bg-slate-900/50">
              {/* 意图类型网格 */}
              <div className="grid grid-cols-5 gap-2 mb-4">
                {Object.entries(INTENT_CONFIG).map(([type, config]) => (
                  <div
                    key={type}
                    className={`p-2 rounded-lg text-center transition-all ${
                      queryAnalysis.intent === type
                        ? 'bg-indigo-600/30 border-2 border-indigo-500 shadow-lg shadow-indigo-500/20'
                        : 'bg-slate-800/50 border border-slate-700/50 opacity-50'
                    }`}
                  >
                    <div className="text-2xl mb-1">{config.icon}</div>
                    <div className={`text-xs font-medium ${queryAnalysis.intent === type ? config.color : 'text-slate-500'}`}>
                      {config.label}
                    </div>
                  </div>
                ))}
              </div>

              {/* 当前意图说明 */}
              <div className={`p-3 rounded-lg border ${intentConfig.color} bg-slate-800/50 border-current/30`}>
                <div className="flex items-start gap-3">
                  <span className="text-3xl">{intentConfig.icon}</span>
                  <div>
                    <h5 className={`font-medium ${intentConfig.color}`}>{intentConfig.label}</h5>
                    <p className="text-sm text-slate-400 mt-1">{intentConfig.description}</p>
                    <div className="mt-2 flex items-center gap-4 text-xs text-slate-500">
                      <span>
                        <i className="fas fa-chart-line mr-1"></i>
                        置信度: {(queryAnalysis.confidence * 100).toFixed(0)}%
                      </span>
                      <span>
                        <i className={`fas ${complexityConfig.icon} mr-1`}></i>
                        复杂度: {complexityConfig.label}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 3. 实体提取 */}
        <div className="border border-slate-700/50 rounded-lg overflow-hidden">
          <button
            onClick={() => setExpandedSection(expandedSection === 'entities' ? null : 'entities')}
            className="w-full px-4 py-3 flex items-center justify-between bg-slate-800/50 hover:bg-slate-700/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <i className="fas fa-tags text-emerald-400"></i>
              <span className="text-sm font-medium text-white">实体提取</span>
              <span className="px-2 py-0.5 text-xs bg-emerald-600/30 text-emerald-300 rounded">
                {queryAnalysis.entities?.length || 0} 个实体
              </span>
            </div>
            <i className={`fas fa-chevron-down text-slate-400 transition-transform ${expandedSection === 'entities' ? 'rotate-180' : ''}`}></i>
          </button>

          {expandedSection === 'entities' && (
            <div className="p-4 bg-slate-900/50">
              {/* 实体类型统计 */}
              {Object.keys(entityStats).length > 0 && (
                <div className="flex flex-wrap gap-2 mb-4">
                  {Object.entries(entityStats).map(([type, count]) => {
                    const config = ENTITY_TYPE_CONFIG[type as EntityType];
                    return (
                      <span
                        key={type}
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs ${config.bg} ${config.color}`}
                      >
                        <i className={`fas ${config.icon}`}></i>
                        {config.label}: {String(count)}
                      </span>
                    );
                  })}
                </div>
              )}

              {/* 实体详情列表 */}
              <div className="space-y-2">
                {queryAnalysis.entities?.map((entity, idx) => {
                  const config = ENTITY_TYPE_CONFIG[entity.type] || ENTITY_TYPE_CONFIG.OTHER;
                  const validated = validatedEntities?.find(e => e.name === entity.name);
                  
                  return (
                    <div
                      key={`entity-${idx}-${entity.name}`}
                      className={`p-3 rounded-lg border ${config.bg} border-current/20 ${config.color}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-lg ${config.bg} flex items-center justify-center`}>
                            <i className={`fas ${config.icon} ${config.color}`}></i>
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-white">{entity.name}</span>
                              {validated?.normalizedName && validated.normalizedName !== entity.name && (
                                <>
                                  <i className="fas fa-arrow-right text-xs text-slate-500"></i>
                                  <span className="text-green-400">{validated.normalizedName}</span>
                                </>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className={`text-xs ${config.color}`}>{config.label}</span>
                              {entity.value && entity.value !== entity.name && (
                                <span className="text-xs text-slate-500">原值: {entity.value}</span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {validated !== undefined && (
                            <span className={`text-xs px-2 py-0.5 rounded ${validated.isValid ? 'bg-green-600/30 text-green-300' : 'bg-yellow-600/30 text-yellow-300'}`}>
                              {validated.isValid ? '已验证' : '待确认'}
                            </span>
                          )}
                          <div className="text-right">
                            <div className="text-xs text-slate-400">置信度</div>
                            <div className="text-sm font-medium text-white">
                              {(entity.confidence * 100).toFixed(0)}%
                            </div>
                          </div>
                        </div>
                      </div>
                      
                      {/* 置信度条 */}
                      <div className="mt-2 h-1 bg-slate-700 rounded-full overflow-hidden">
                        <div 
                          className={`h-full transition-all ${config.bg.replace('/20', '/60')}`}
                          style={{ width: `${entity.confidence * 100}%` }}
                        ></div>
                      </div>

                      {/* 建议 */}
                      {validated?.suggestions && validated.suggestions.length > 0 && (
                        <div className="mt-2 text-xs text-slate-500">
                          <i className="fas fa-lightbulb mr-1"></i>
                          建议: {validated.suggestions.join(', ')}
                        </div>
                      )}
                    </div>
                  );
                })}

                {(!queryAnalysis.entities || queryAnalysis.entities.length === 0) && (
                  <div className="text-center py-4 text-slate-500">
                    <i className="fas fa-search text-2xl mb-2 opacity-50"></i>
                    <p className="text-sm">未提取到明确实体</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 4. 逻辑关系 */}
        {queryAnalysis.logicalRelations && queryAnalysis.logicalRelations.length > 0 && (
          <div className="border border-slate-700/50 rounded-lg overflow-hidden">
            <button
              onClick={() => setExpandedSection(expandedSection === 'logic' ? null : 'logic')}
              className="w-full px-4 py-3 flex items-center justify-between bg-slate-800/50 hover:bg-slate-700/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <i className="fas fa-project-diagram text-amber-400"></i>
                <span className="text-sm font-medium text-white">逻辑关系</span>
                <span className="px-2 py-0.5 text-xs bg-amber-600/30 text-amber-300 rounded">
                  {queryAnalysis.logicalRelations.length} 个关系
                </span>
              </div>
              <i className={`fas fa-chevron-down text-slate-400 transition-transform ${expandedSection === 'logic' ? 'rotate-180' : ''}`}></i>
            </button>

            {expandedSection === 'logic' && (
              <div className="p-4 bg-slate-900/50">
                <div className="space-y-3">
                  {queryAnalysis.logicalRelations.map((relation, idx) => {
                    const opConfig = OPERATOR_CONFIG[relation.operator] || OPERATOR_CONFIG.AND;
                    return (
                      <div
                        key={`relation-${idx}`}
                        className="p-3 bg-slate-800/50 rounded-lg border border-slate-700/50"
                      >
                        <div className="flex items-center gap-2 mb-2">
                          <span className={`w-6 h-6 rounded flex items-center justify-center ${opConfig.color} bg-current/20`}>
                            <i className={`fas ${opConfig.icon} text-xs`}></i>
                          </span>
                          <span className={`text-sm font-medium ${opConfig.color}`}>{opConfig.label}</span>
                        </div>
                        <div className="flex flex-wrap gap-2 items-center">
                          {(relation.entities || []).map((entityName, eIdx) => {
                            const entity = queryAnalysis.entities?.find(e => e.name === entityName);
                            const entityConfig = entity ? ENTITY_TYPE_CONFIG[entity.type] : ENTITY_TYPE_CONFIG.OTHER;
                            return (
                              <div key={`rel-entity-${idx}-${eIdx}`} className="flex items-center gap-2">
                                {eIdx > 0 && (
                                  <span className={`text-xs ${opConfig.color}`}>{opConfig.label}</span>
                                )}
                                <span className={`px-2 py-1 rounded text-sm ${entityConfig.bg} ${entityConfig.color}`}>
                                  <i className={`fas ${entityConfig.icon} mr-1 text-xs`}></i>
                                  {entityName}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                        {relation.description && (
                          <p className="mt-2 text-xs text-slate-500">{relation.description}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 5. 关键词 */}
        {queryAnalysis.keywords && queryAnalysis.keywords.length > 0 && (
          <div className="p-3 bg-slate-800/30 rounded-lg border border-slate-700/50">
            <div className="flex items-center gap-2 mb-2">
              <i className="fas fa-key text-slate-400"></i>
              <span className="text-xs text-slate-400">提取的关键词</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {queryAnalysis.keywords.map((kw, idx) => (
                <span
                  key={`kw-${idx}-${kw}`}
                  className="px-2 py-1 bg-slate-700/50 text-slate-300 text-xs rounded hover:bg-slate-600/50 transition-colors"
                >
                  {kw}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 底部摘要 */}
      <div className="px-5 py-3 bg-slate-800/30 border-t border-slate-700/50">
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>
            <i className="fas fa-info-circle mr-1"></i>
            认知解析层将用户输入转换为系统可理解的结构化查询
          </span>
          <span className="flex items-center gap-3">
            <span><i className="fas fa-tags mr-1"></i>{queryAnalysis.entities?.length || 0} 实体</span>
            <span><i className="fas fa-key mr-1"></i>{queryAnalysis.keywords?.length || 0} 关键词</span>
          </span>
        </div>
      </div>
    </div>
  );
}

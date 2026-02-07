'use client';

import React, { useMemo } from 'react';
import dynamic from 'next/dynamic';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

interface TokenInfo {
  token: string;
  tokenId: number;
  type: 'chinese' | 'english' | 'number' | 'punctuation' | 'special' | 'entity' | 'keyword';
  entityType?: string;
  confidence?: number;
}

interface ExtractedEntity {
  name: string;
  type: string;
  value?: string;
  confidence: number;
  normalizedName?: string;
}

// 实体类型配置
const ENTITY_TYPE_CONFIG: Record<string, { icon: string; color: string; bg: string; label: string }> = {
  PERSON: { icon: '👤', color: 'text-blue-600', bg: 'bg-blue-100 border-blue-200', label: '人物' },
  ORGANIZATION: { icon: '🏢', color: 'text-purple-600', bg: 'bg-purple-100 border-purple-200', label: '组织' },
  LOCATION: { icon: '📍', color: 'text-green-600', bg: 'bg-green-100 border-green-200', label: '地点' },
  PRODUCT: { icon: '📦', color: 'text-orange-600', bg: 'bg-orange-100 border-orange-200', label: '产品' },
  DATE: { icon: '📅', color: 'text-cyan-600', bg: 'bg-cyan-100 border-cyan-200', label: '时间' },
  EVENT: { icon: '🎯', color: 'text-pink-600', bg: 'bg-pink-100 border-pink-200', label: '事件' },
  CONCEPT: { icon: '💡', color: 'text-yellow-600', bg: 'bg-yellow-100 border-yellow-200', label: '概念' },
  OTHER: { icon: '🏷️', color: 'text-slate-600', bg: 'bg-slate-100 border-slate-200', label: '其他' },
};

interface QueryAnalysisProps {
  analysis: any;
  radarChartData?: any;
  topK: number;
  threshold: number;
  getRadarChartOption: () => any;
}

// 进度条组件
function ProgressBar({ value, max = 1, color = 'blue', label, showValue = true }: {
  value: number;
  max?: number;
  color?: string;
  label: string;
  showValue?: boolean;
}) {
  const percentage = Math.min(100, (value / max) * 100);
  const colorClasses: Record<string, string> = {
    blue: 'bg-blue-500',
    green: 'bg-green-500',
    purple: 'bg-purple-500',
    orange: 'bg-orange-500',
    red: 'bg-red-500',
    cyan: 'bg-cyan-500',
    pink: 'bg-pink-500',
  };
  
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-gray-600">{label}</span>
        {showValue && <span className="font-mono text-gray-700">{(value * 100).toFixed(1)}%</span>}
      </div>
      <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
        <div 
          className={`h-full ${colorClasses[color]} transition-all duration-500 ease-out`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

// 圆形进度组件
function CircularProgress({ value, size = 60, strokeWidth = 6, color = '#3B82F6', label }: {
  value: number;
  size?: number;
  strokeWidth?: number;
  color?: string;
  label: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (value * circumference);
  
  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} className="transform -rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="#E5E7EB"
          strokeWidth={strokeWidth}
          fill="none"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-700 ease-out"
        />
      </svg>
      <div className="absolute flex flex-col items-center justify-center" style={{ width: size, height: size }}>
        <span className="text-sm font-bold" style={{ color }}>{(value * 100).toFixed(0)}%</span>
      </div>
      <span className="text-xs text-gray-500 mt-1">{label}</span>
    </div>
  );
}

// 意图标签组件
function IntentBadge({ intent, confidence, isPrimary = false }: {
  intent: string;
  confidence?: number;
  isPrimary?: boolean;
}) {
  const intentColors: Record<string, string> = {
    '查询信息': 'bg-blue-100 text-blue-700 border-blue-200',
    '操作指导': 'bg-green-100 text-green-700 border-green-200',
    '原因分析': 'bg-purple-100 text-purple-700 border-purple-200',
    '比较评估': 'bg-orange-100 text-orange-700 border-orange-200',
    '问题解决': 'bg-red-100 text-red-700 border-red-200',
    '推荐建议': 'bg-cyan-100 text-cyan-700 border-cyan-200',
  };
  
  return (
    <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs border ${intentColors[intent] || 'bg-gray-100 text-gray-700 border-gray-200'} ${isPrimary ? 'ring-2 ring-offset-1' : ''}`}>
      {isPrimary && <span className="w-1.5 h-1.5 rounded-full bg-current mr-1.5" />}
      {intent}
      {confidence !== undefined && (
        <span className="ml-1 opacity-70">{(confidence * 100).toFixed(0)}%</span>
      )}
    </span>
  );
}

export default function QueryAnalysis({ 
  analysis, 
  radarChartData, 
  topK, 
  threshold, 
  getRadarChartOption 
}: QueryAnalysisProps) {
  if (!analysis) return null;

  const vectorFeatures = analysis.embedding?.semanticAnalysis?.vectorFeatures;
  const semanticAnalysis = analysis.embedding?.semanticAnalysis;
  const quality = analysis.quality;

  // 领域雷达图配置
  const domainRadarOption = useMemo(() => {
    if (!vectorFeatures) return null;
    
    return {
      tooltip: { trigger: 'item' },
      radar: {
        indicator: [
          { name: '技术', max: 1 },
          { name: '商业', max: 1 },
          { name: '日常', max: 1 },
          { name: '情感', max: 1 },
          { name: '学术', max: 1 },
        ],
        radius: '65%',
        splitNumber: 4,
        axisName: { color: '#666', fontSize: 10 },
        splitArea: { areaStyle: { color: ['rgba(59, 130, 246, 0.05)', 'rgba(59, 130, 246, 0.1)'] } },
        splitLine: { lineStyle: { color: '#E5E7EB' } },
      },
      series: [{
        type: 'radar',
        data: [{
          value: [
            vectorFeatures.techScore || 0,
            vectorFeatures.businessScore || 0,
            vectorFeatures.dailyScore || 0,
            vectorFeatures.emotionScore || 0,
            vectorFeatures.academicScore || 0,
          ],
          name: '语义维度',
          areaStyle: { color: 'rgba(59, 130, 246, 0.3)' },
          lineStyle: { color: '#3B82F6', width: 2 },
          itemStyle: { color: '#3B82F6' },
        }]
      }]
    };
  }, [vectorFeatures]);

  // 向量统计图配置
  const vectorStatsOption = useMemo(() => {
    if (!vectorFeatures) return null;
    
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: '3%', right: '4%', bottom: '3%', top: '8%', containLabel: true },
      xAxis: { type: 'value', max: 1, axisLabel: { fontSize: 10 } },
      yAxis: {
        type: 'category',
        data: ['信息密度', '语义清晰度', '向量熵', '稀疏度'],
        axisLabel: { fontSize: 10 }
      },
      series: [{
        type: 'bar',
        data: [
          { value: vectorFeatures.informationDensity || 0, itemStyle: { color: '#3B82F6' } },
          { value: vectorFeatures.semanticClarity || 0, itemStyle: { color: '#10B981' } },
          { value: Math.min(1, (vectorFeatures.vectorEntropy || 0) / 10), itemStyle: { color: '#8B5CF6' } },
          { value: vectorFeatures.vectorSparsity || 0, itemStyle: { color: '#F59E0B' } },
        ],
        barWidth: '50%',
        label: { show: true, position: 'right', fontSize: 10, formatter: (p: any) => (p.value * 100).toFixed(0) + '%' }
      }]
    };
  }, [vectorFeatures]);

  // 类别分布饼图配置
  const categoryDistOption = useMemo(() => {
    if (!semanticAnalysis?.categoryDistribution) return null;
    
    const data = Object.entries(semanticAnalysis.categoryDistribution)
      .map(([name, value]) => ({ name, value: parseFloat((value as number * 100).toFixed(1)) }))
      .filter(item => item.value > 1)
      .sort((a, b) => b.value - a.value);
    
    const colors = ['#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EF4444', '#06B6D4', '#EC4899'];
    
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c}%' },
      series: [{
        type: 'pie',
        radius: ['40%', '70%'],
        avoidLabelOverlap: false,
        itemStyle: { borderRadius: 4, borderColor: '#fff', borderWidth: 2 },
        label: { show: false },
        emphasis: { label: { show: true, fontSize: 12, fontWeight: 'bold' } },
        labelLine: { show: false },
        data: data.map((item, i) => ({ ...item, itemStyle: { color: colors[i % colors.length] } }))
      }]
    };
  }, [semanticAnalysis?.categoryDistribution]);
  
  return (
    <div className="space-y-4">
      {/* 词元化结果 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h5 className="text-xs font-medium text-blue-700 flex items-center gap-1">
            <span className="w-5 h-5 rounded bg-blue-100 text-blue-600 flex items-center justify-center text-xs font-bold">A</span>
            词元化 (Tokenization)
          </h5>
          <span className="text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded">{analysis.tokenization?.processingTime || 0}ms</span>
        </div>
        <div className="bg-white rounded-lg p-3 border border-blue-100 shadow-sm">
          <div className="mb-3">
            <span className="text-xs text-gray-500">原始文本:</span>
            <div className="bg-gradient-to-r from-gray-50 to-blue-50 rounded px-3 py-2 text-sm font-mono mt-1 border border-gray-100">
              "{analysis.tokenization?.originalText || ''}"
            </div>
          </div>
          
          {/* Token 类型统计 */}
          {analysis.tokenization?.tokenTypes && (
            <div className="mb-3 grid grid-cols-4 gap-2">
              {[
                { label: '中文', value: analysis.tokenization.tokenTypes.chinese, color: 'red' },
                { label: '英文', value: analysis.tokenization.tokenTypes.english, color: 'blue' },
                { label: '数字', value: analysis.tokenization.tokenTypes.numbers, color: 'green' },
                { label: '标点', value: analysis.tokenization.tokenTypes.punctuation, color: 'orange' },
              ].map(item => (
                <div key={item.label} className={`text-center p-2 rounded bg-${item.color}-50 border border-${item.color}-100`}>
                  <div className={`text-lg font-bold text-${item.color}-600`}>{item.value}</div>
                  <div className="text-xs text-gray-500">{item.label}</div>
                </div>
              ))}
            </div>
          )}
          
          <div>
            <span className="text-xs text-gray-500">Token 序列 ({analysis.tokenization?.tokenCount || 0} 个词元):</span>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {analysis.tokenization?.tokens?.slice(0, 30).map((token: TokenInfo, i: number) => {
                const colors: Record<string, string> = {
                  chinese: 'bg-red-50 text-red-700 border-red-200',
                  english: 'bg-blue-50 text-blue-700 border-blue-200',
                  number: 'bg-green-50 text-green-700 border-green-200',
                  punctuation: 'bg-yellow-50 text-yellow-700 border-yellow-200',
                  special: 'bg-gray-50 text-gray-700 border-gray-200',
                  entity: 'bg-gradient-to-r from-purple-100 to-indigo-100 text-purple-800 border-purple-300 ring-1 ring-purple-300 font-semibold',
                  keyword: 'bg-gradient-to-r from-cyan-50 to-blue-50 text-cyan-700 border-cyan-300 font-medium',
                };
                
                const isEntity = token.type === 'entity';
                const isKeyword = token.type === 'keyword';
                const entityConfig = isEntity && token.entityType ? ENTITY_TYPE_CONFIG[token.entityType] || ENTITY_TYPE_CONFIG.OTHER : null;
                
                return (
                  <span
                    key={i}
                    className={`inline-flex items-center px-2 py-1 rounded text-xs border ${colors[token.type] || colors.special} hover:scale-105 transition-transform cursor-default ${isEntity ? 'shadow-sm' : ''}`}
                    title={isEntity ? `实体: ${token.entityType} (${((token.confidence || 0) * 100).toFixed(0)}%)` : 
                           isKeyword ? '关键词' : `Token ID: ${token.tokenId}`}
                  >
                    {isEntity && entityConfig && (
                      <span className="mr-1">{entityConfig.icon}</span>
                    )}
                    {isKeyword && <span className="mr-1 text-cyan-500">✦</span>}
                    {token.token}
                    {!isEntity && !isKeyword && (
                      <sub className="text-[10px] opacity-40 ml-1">{token.tokenId}</sub>
                    )}
                    {isEntity && token.confidence && (
                      <span className="ml-1 text-[10px] bg-purple-200/50 px-1 rounded">{((token.confidence) * 100).toFixed(0)}%</span>
                    )}
                  </span>
                );
              })}
              {analysis.tokenization?.tokens && analysis.tokenization.tokens.length > 30 && (
                <span className="text-xs text-gray-400 flex items-center px-2">+{analysis.tokenization.tokens.length - 30} more</span>
              )}
            </div>
            {/* Token 类型图例 */}
            <div className="flex flex-wrap gap-2 mt-3 pt-2 border-t border-gray-100">
              <span className="text-[10px] text-gray-400">图例:</span>
              <span className="inline-flex items-center gap-1 text-[10px] text-red-600"><span className="w-2 h-2 rounded bg-red-200"></span>中文</span>
              <span className="inline-flex items-center gap-1 text-[10px] text-blue-600"><span className="w-2 h-2 rounded bg-blue-200"></span>英文</span>
              <span className="inline-flex items-center gap-1 text-[10px] text-green-600"><span className="w-2 h-2 rounded bg-green-200"></span>数字</span>
              {analysis.tokenization?.tokens?.some((t: TokenInfo) => t.type === 'entity') && (
                <span className="inline-flex items-center gap-1 text-[10px] text-purple-600 font-medium"><span className="w-2 h-2 rounded bg-purple-300"></span>实体</span>
              )}
              {analysis.tokenization?.tokens?.some((t: TokenInfo) => t.type === 'keyword') && (
                <span className="inline-flex items-center gap-1 text-[10px] text-cyan-600 font-medium"><span className="w-2 h-2 rounded bg-cyan-300"></span>关键词</span>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {/* 实体抽取信息 - 仅在 Entity 模式下显示 */}
      {analysis.adaptiveEntityAnalysis?.entities && analysis.adaptiveEntityAnalysis.entities.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h5 className="text-xs font-medium text-indigo-700 flex items-center gap-1">
              <span className="w-5 h-5 rounded bg-indigo-100 text-indigo-600 flex items-center justify-center text-xs">🎯</span>
              实体抽取 (Entity Extraction)
            </h5>
            <span className="text-xs text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">
              {analysis.adaptiveEntityAnalysis.entities.length} 个实体
            </span>
          </div>
          <div className="bg-white rounded-lg p-3 border border-indigo-100 shadow-sm space-y-3">
            {/* 实体统计 */}
            <div className="flex flex-wrap gap-2">
              {(() => {
                const stats: Record<string, number> = {};
                analysis.adaptiveEntityAnalysis.entities.forEach((e: ExtractedEntity) => {
                  stats[e.type] = (stats[e.type] || 0) + 1;
                });
                return Object.entries(stats).map(([type, count]) => {
                  const config = ENTITY_TYPE_CONFIG[type] || ENTITY_TYPE_CONFIG.OTHER;
                  return (
                    <span key={type} className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs ${config.bg} ${config.color} border`}>
                      {config.icon} {config.label}: {String(count)}
                    </span>
                  );
                });
              })()}
            </div>
            
            {/* 实体列表 */}
            <div className="grid gap-2">
              {analysis.adaptiveEntityAnalysis.entities.map((entity: ExtractedEntity, idx: number) => {
                const config = ENTITY_TYPE_CONFIG[entity.type] || ENTITY_TYPE_CONFIG.OTHER;
                return (
                  <div 
                    key={idx} 
                    className={`flex items-center justify-between p-2 rounded-lg ${config.bg} border`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{config.icon}</span>
                      <div>
                        <span className={`font-medium ${config.color}`}>{entity.name}</span>
                        {entity.normalizedName && entity.normalizedName !== entity.name && (
                          <span className="text-gray-500 text-xs ml-2">
                            → {entity.normalizedName}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500">{config.label}</span>
                      <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-gradient-to-r from-indigo-400 to-purple-500 rounded-full"
                          style={{ width: `${entity.confidence * 100}%` }}
                        />
                      </div>
                      <span className="text-xs font-mono text-gray-600 w-10 text-right">
                        {(entity.confidence * 100).toFixed(0)}%
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
            
            {/* 意图和复杂度 */}
            {(analysis.adaptiveEntityAnalysis.intent || analysis.adaptiveEntityAnalysis.complexity) && (
              <div className="grid grid-cols-3 gap-2 pt-2 border-t border-indigo-100">
                <div className="bg-indigo-50/50 rounded-lg p-2 text-center">
                  <div className="text-[10px] text-indigo-500 uppercase tracking-wide">意图</div>
                  <div className="text-sm font-medium text-indigo-700 capitalize">
                    {analysis.adaptiveEntityAnalysis.intent === 'factual' ? '📊 事实查询' :
                     analysis.adaptiveEntityAnalysis.intent === 'comparison' ? '⚖️ 比较分析' :
                     analysis.adaptiveEntityAnalysis.intent === 'conceptual' ? '💡 概念理解' :
                     analysis.adaptiveEntityAnalysis.intent === 'procedural' ? '📝 操作指导' :
                     analysis.adaptiveEntityAnalysis.intent === 'exploratory' ? '🔍 探索性' :
                     analysis.adaptiveEntityAnalysis.intent || '未知'}
                  </div>
                </div>
                <div className="bg-orange-50/50 rounded-lg p-2 text-center">
                  <div className="text-[10px] text-orange-500 uppercase tracking-wide">复杂度</div>
                  <div className="text-sm font-medium text-orange-700 capitalize">
                    {analysis.adaptiveEntityAnalysis.complexity === 'simple' ? '🟢 简单' :
                     analysis.adaptiveEntityAnalysis.complexity === 'moderate' ? '🟡 中等' :
                     analysis.adaptiveEntityAnalysis.complexity === 'complex' ? '🔴 复杂' :
                     analysis.adaptiveEntityAnalysis.complexity || '未知'}
                  </div>
                </div>
                <div className="bg-green-50/50 rounded-lg p-2 text-center">
                  <div className="text-[10px] text-green-500 uppercase tracking-wide">置信度</div>
                  <div className="text-sm font-medium text-green-700">
                    {((analysis.adaptiveEntityAnalysis.confidence || 0) * 100).toFixed(0)}%
                  </div>
                </div>
              </div>
            )}
            
            {/* 关键词 */}
            {analysis.adaptiveEntityAnalysis.keywords && analysis.adaptiveEntityAnalysis.keywords.length > 0 && (
              <div className="pt-2 border-t border-indigo-100">
                <div className="text-[10px] text-gray-500 mb-1">提取的关键词:</div>
                <div className="flex flex-wrap gap-1">
                  {analysis.adaptiveEntityAnalysis.keywords.map((kw: string, i: number) => (
                    <span key={i} className="px-2 py-0.5 bg-cyan-50 text-cyan-700 text-xs rounded-full border border-cyan-200">
                      ✦ {kw}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      
      {/* 向量化与语义分析 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h5 className="text-xs font-medium text-purple-700 flex items-center gap-1">
            <span className="w-5 h-5 rounded bg-purple-100 text-purple-600 flex items-center justify-center text-xs font-bold">B</span>
            向量化与语义分析
          </h5>
          <span className="text-xs text-purple-600 bg-purple-50 px-2 py-0.5 rounded">
            {analysis.embedding?.embeddingDimension || 768} 维
          </span>
        </div>
        <div className="bg-white rounded-lg p-3 border border-purple-100 shadow-sm space-y-4">
          
          {/* 语义上下文 */}
          <div className="bg-gradient-to-r from-purple-50 via-blue-50 to-cyan-50 rounded-lg p-3 border border-purple-100">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-sm font-semibold text-purple-800">
                  {semanticAnalysis?.context || '通用语境'}
                </div>
                <div className="text-xs text-purple-600 mt-1 flex items-center gap-2">
                  <span className="bg-purple-200 px-2 py-0.5 rounded text-purple-800">
                    {semanticAnalysis?.semanticCategory || '一般'}
                  </span>
                  <span className="opacity-70">
                    置信度: {((semanticAnalysis?.confidence || 0) * 100).toFixed(1)}%
                  </span>
                </div>
              </div>
              {quality && (
                <div className="relative">
                  <CircularProgress 
                    value={quality.queryQualityScore || 0} 
                    size={50} 
                    strokeWidth={5}
                    color="#8B5CF6"
                    label="质量"
                  />
                </div>
              )}
            </div>
            
            {/* 相关概念标签 */}
            <div className="mt-3 flex flex-wrap gap-1">
              {(semanticAnalysis?.nearestConcepts || []).map((concept: string, i: number) => (
                <span key={i} className="text-xs bg-white/70 text-purple-600 px-2 py-0.5 rounded-full border border-purple-200">
                  {concept}
                </span>
              ))}
            </div>
          </div>

          {/* 意图分析 */}
          {semanticAnalysis?.intentAnalysis && (
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs font-medium text-gray-700 mb-2">🎯 意图分析</div>
              <div className="flex flex-wrap gap-2">
                <IntentBadge 
                  intent={semanticAnalysis.intentAnalysis.primaryIntent} 
                  confidence={semanticAnalysis.intentAnalysis.intentConfidence}
                  isPrimary={true}
                />
                {semanticAnalysis.intentAnalysis.possibleIntents?.slice(1, 3).map((intent: string, i: number) => (
                  <IntentBadge key={i} intent={intent} />
                ))}
              </div>
            </div>
          )}

          {/* 向量特征可视化 - 双栏布局 */}
          {vectorFeatures && (
            <div className="grid grid-cols-2 gap-3">
              {/* 领域雷达图 */}
              <div className="bg-gray-50 rounded-lg p-2">
                <div className="text-xs font-medium text-gray-700 mb-1 text-center">语义领域分布</div>
                {domainRadarOption && (
                  <ReactECharts option={domainRadarOption} style={{ height: '140px' }} />
                )}
              </div>
              
              {/* 向量统计条形图 */}
              <div className="bg-gray-50 rounded-lg p-2">
                <div className="text-xs font-medium text-gray-700 mb-1 text-center">向量质量指标</div>
                {vectorStatsOption && (
                  <ReactECharts option={vectorStatsOption} style={{ height: '140px' }} />
                )}
              </div>
            </div>
          )}

          {/* 查询质量详情 */}
          {quality && (
            <div className="bg-gradient-to-r from-green-50 to-emerald-50 rounded-lg p-3 border border-green-100">
              <div className="text-xs font-medium text-green-700 mb-2">📊 查询质量评估</div>
              <div className="grid grid-cols-3 gap-3">
                <ProgressBar value={quality.specificity || 0} color="green" label="特异性" />
                <ProgressBar value={1 - (quality.ambiguity || 0)} color="blue" label="清晰度" />
                <ProgressBar value={quality.retrievability || 0} color="purple" label="可检索性" />
              </div>
            </div>
          )}

          {/* 类别概率分布 */}
          {categoryDistOption && (
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs font-medium text-gray-700 mb-2">📈 类别概率分布</div>
              <div className="grid grid-cols-2 gap-3">
                <ReactECharts option={categoryDistOption} style={{ height: '120px' }} />
                <div className="space-y-1">
                  {semanticAnalysis?.semanticClusters?.slice(0, 4).map((cluster: any, i: number) => (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <span className="text-gray-600">{cluster.name}</span>
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                          <div 
                            className="h-full bg-blue-500 rounded-full"
                            style={{ width: `${cluster.similarity * 100}%` }}
                          />
                        </div>
                        <span className="font-mono text-gray-500 w-10 text-right">
                          {(cluster.similarity * 100).toFixed(0)}%
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* 向量数值特征 */}
          {vectorFeatures && (
            <div className="grid grid-cols-4 gap-2 text-center">
              {[
                { label: '向量模长', value: vectorFeatures.vectorMagnitude, format: (v: number) => v.toFixed(2) },
                { label: '信息熵', value: vectorFeatures.vectorEntropy, format: (v: number) => v.toFixed(2) },
                { label: '稀疏度', value: vectorFeatures.vectorSparsity, format: (v: number) => (v * 100).toFixed(0) + '%' },
                { label: '峰度', value: vectorFeatures.vectorKurtosis, format: (v: number) => v.toFixed(2) },
              ].map(item => (
                <div key={item.label} className="bg-gray-50 rounded p-2">
                  <div className="text-sm font-bold text-gray-700">{item.format(item.value || 0)}</div>
                  <div className="text-[10px] text-gray-500">{item.label}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      
      {/* 检索链路分析 */}
      {radarChartData && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h5 className="text-xs font-medium text-green-700 flex items-center gap-1">
              <span className="w-5 h-5 rounded bg-green-100 text-green-600 flex items-center justify-center text-xs font-bold">C</span>
              检索链路分析
            </h5>
          </div>
          <div className="bg-white rounded-lg p-3 border border-green-100 shadow-sm">
            {getRadarChartOption() && (
              <div className="mb-3" style={{ width: '100%', height: '180px' }}>
                <ReactECharts option={getRadarChartOption()} style={{ height: '100%', width: '100%' }} />
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-blue-50 rounded-lg p-2">
                <div className="font-medium text-blue-800 mb-1 flex items-center gap-1">
                  <span className="w-4 h-4 rounded-full bg-blue-200 text-blue-700 flex items-center justify-center text-[10px]">1</span>
                  查询理解
                </div>
                <div className="text-blue-600 space-y-0.5">
                  <div>词元: {analysis.tokenization?.tokenCount || 0}</div>
                  <div>分类: {semanticAnalysis?.semanticCategory || '一般'}</div>
                </div>
              </div>
              <div className="bg-green-50 rounded-lg p-2">
                <div className="font-medium text-green-800 mb-1 flex items-center gap-1">
                  <span className="w-4 h-4 rounded-full bg-green-200 text-green-700 flex items-center justify-center text-[10px]">2</span>
                  向量编码
                </div>
                <div className="text-green-600 space-y-0.5">
                  <div>维度: {analysis.embedding?.embeddingDimension || 768}</div>
                  <div>模长: {(radarChartData.vectorMagnitude || 0).toFixed(3)}</div>
                </div>
              </div>
              <div className="bg-purple-50 rounded-lg p-2">
                <div className="font-medium text-purple-800 mb-1 flex items-center gap-1">
                  <span className="w-4 h-4 rounded-full bg-purple-200 text-purple-700 flex items-center justify-center text-[10px]">3</span>
                  相似度计算
                </div>
                <div className="text-purple-600 space-y-0.5">
                  <div>算法: 余弦相似度</div>
                  <div>空间: {analysis.embedding?.embeddingDimension || 768}D</div>
                </div>
              </div>
              <div className="bg-orange-50 rounded-lg p-2">
                <div className="font-medium text-orange-800 mb-1 flex items-center gap-1">
                  <span className="w-4 h-4 rounded-full bg-orange-200 text-orange-700 flex items-center justify-center text-[10px]">4</span>
                  结果排序
                </div>
                <div className="text-orange-600 space-y-0.5">
                  <div>阈值: ≥ {threshold.toFixed(2)}</div>
                  <div>返回: Top-{topK}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
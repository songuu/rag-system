'use client';

import React, { useState } from 'react';

interface IntentDistillationResult {
  success: boolean;
  query: string;
  timestamp: string;
  domainAnalysis: {
    topDomain: { domain: string; name: string; similarity: number; icon: string } | null;
    allDomains: Array<{ domain: string; name: string; similarity: number; icon: string }>;
    domainCount: number;
  };
  intentAnalysis: {
    intent: string;
    intentType: string;
    confidence: number;
    keywords: string[];
    reasoning: string;
  };
  queryExpansion: {
    originalKeywords: string[];
    synonyms: Record<string, string[]>;
    relatedTerms: string[];
    expandedQueries: string[];
    reasoning: string;
    totalSynonyms: number;
    totalRelated: number;
  };
  queryRewrite: {
    original: string;
    rewritten: string[];
    improvements: Array<{ type: string; description: string }>;
  } | null;
  confidence: {
    overall: number;
    factors: Array<{ factor: string; score: number; weight: number }>;
    level: 'high' | 'medium' | 'low';
  };
  suggestions: Array<{ type: string; message: string; priority: 'high' | 'medium' | 'low' }>;
  recommendedQuery: string;
}

interface IntentDistillationPanelProps {
  query: string;
  onQuerySelect?: (query: string) => void;
}

export default function IntentDistillationPanel({ query, onQuerySelect }: IntentDistillationPanelProps) {
  const [result, setResult] = useState<IntentDistillationResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  const analyzeIntent = async () => {
    if (!query.trim()) {
      setError('请输入查询文本');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/intent-distillation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, includeRewrite: true })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || '意图分析失败');
      }

      const data = await response.json();
      if (data.success) {
        setResult(data);
        setShowDetails(true);
      } else {
        setError(data.error || '意图分析失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '意图分析失败');
    } finally {
      setIsLoading(false);
    }
  };

  // 获取置信度颜色
  const getConfidenceColor = (level: string) => {
    switch (level) {
      case 'high': return 'text-green-600 bg-green-100 border-green-300';
      case 'medium': return 'text-yellow-600 bg-yellow-100 border-yellow-300';
      case 'low': return 'text-red-600 bg-red-100 border-red-300';
      default: return 'text-gray-600 bg-gray-100 border-gray-300';
    }
  };

  // 获取优先级颜色
  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'high': return 'bg-red-500';
      case 'medium': return 'bg-yellow-500';
      case 'low': return 'bg-blue-500';
      default: return 'bg-gray-500';
    }
  };

  return (
    <div className="space-y-4">
      {/* 分析按钮 */}
      <div className="flex items-center gap-3">
        <button
          onClick={analyzeIntent}
          disabled={isLoading || !query.trim()}
          className="px-4 py-2 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 text-white rounded-lg font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {isLoading ? (
            <>
              <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              分析中...
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
              🧠 意图蒸馏
            </>
          )}
        </button>
        
        {result && (
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm transition-colors"
          >
            {showDetails ? '隐藏详情' : '显示详情'}
          </button>
        )}
      </div>

      {/* 错误信息 */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            {error}
          </div>
        </div>
      )}

      {/* 分析结果 */}
      {result && showDetails && (
        <div className="space-y-4">
          {/* 核心意图卡片 */}
          <div className="bg-gradient-to-br from-purple-50 to-blue-50 border-2 border-purple-200 rounded-xl p-5">
            <div className="flex items-start justify-between mb-3">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-2xl">{result.domainAnalysis.topDomain?.icon || '🎯'}</span>
                  <h3 className="text-lg font-bold text-gray-800">识别的意图</h3>
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${getConfidenceColor(result.confidence.level)}`}>
                    置信度: {(result.confidence.overall * 100).toFixed(1)}%
                  </span>
                </div>
                <p className="text-base text-gray-700 leading-relaxed">{result.intentAnalysis.intent}</p>
              </div>
            </div>

            {/* 意图类型和领域 */}
            <div className="grid grid-cols-2 gap-3 mt-4">
              <div className="bg-white/60 rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">意图类型</div>
                <div className="text-sm font-medium text-purple-700">{result.intentAnalysis.intentType}</div>
              </div>
              <div className="bg-white/60 rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">主要领域</div>
                <div className="text-sm font-medium text-blue-700">
                  {result.domainAnalysis.topDomain?.name || '未知'} 
                  {result.domainAnalysis.topDomain && ` (${(result.domainAnalysis.topDomain.similarity * 100).toFixed(1)}%)`}
                </div>
              </div>
            </div>
          </div>

          {/* 置信度分析 */}
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <h4 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
              📊 置信度分析
            </h4>
            <div className="space-y-2">
              {result.confidence.factors.map((factor, index) => (
                <div key={index} className="flex items-center gap-3">
                  <div className="w-32 text-xs text-gray-600">{factor.factor}</div>
                  <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all"
                      style={{ width: `${factor.score * 100}%` }}
                    />
                  </div>
                  <div className="w-12 text-xs text-gray-500 text-right">
                    {(factor.score * 100).toFixed(0)}%
                  </div>
                  <div className="w-16 text-xs text-gray-400 text-right">
                    权重 {(factor.weight * 100).toFixed(0)}%
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 关键词 */}
          {result.intentAnalysis.keywords.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <h4 className="text-sm font-semibold text-gray-800 mb-3">🔤 识别的关键词</h4>
              <div className="flex flex-wrap gap-2">
                {result.intentAnalysis.keywords.map((keyword, index) => (
                  <span
                    key={index}
                    className="px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-sm font-medium border border-blue-200"
                  >
                    {keyword}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Query Expansion - 关键词扩展 */}
          {result.queryExpansion && (
            <div className="bg-gradient-to-br from-green-50 to-teal-50 border-2 border-green-200 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h4 className="text-base font-bold text-gray-800 flex items-center gap-2">
                  <span className="text-xl">🔍</span>
                  Query Expansion - 关键词扩展
                </h4>
                <div className="flex gap-2 text-xs">
                  <span className="px-2 py-1 bg-green-100 text-green-700 rounded-full font-medium">
                    {result.queryExpansion.totalSynonyms} 个同义词
                  </span>
                  <span className="px-2 py-1 bg-teal-100 text-teal-700 rounded-full font-medium">
                    {result.queryExpansion.totalRelated} 个相关词
                  </span>
                </div>
              </div>

              {/* 原始关键词 */}
              {result.queryExpansion.originalKeywords.length > 0 && (
                <div className="mb-4">
                  <div className="text-xs font-semibold text-gray-600 mb-2 uppercase tracking-wide">
                    原始关键词
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {result.queryExpansion.originalKeywords.map((keyword, index) => (
                      <span
                        key={index}
                        className="px-3 py-1.5 bg-white text-gray-800 rounded-lg text-sm font-semibold border-2 border-green-300 shadow-sm"
                      >
                        {keyword}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* 同义词扩展 */}
              {Object.keys(result.queryExpansion.synonyms).length > 0 && (
                <div className="mb-4">
                  <div className="text-xs font-semibold text-gray-600 mb-2 uppercase tracking-wide">
                    同义词扩展
                  </div>
                  <div className="space-y-3">
                    {Object.entries(result.queryExpansion.synonyms).map(([keyword, synonyms], index) => (
                      <div key={index} className="bg-white/70 rounded-lg p-3 border border-green-200">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-sm font-bold text-green-700">{keyword}</span>
                          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                          </svg>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {synonyms.map((synonym, sIndex) => (
                            <span
                              key={sIndex}
                              className="px-2.5 py-1 bg-green-100 text-green-800 rounded-md text-xs font-medium hover:bg-green-200 transition-colors cursor-default"
                              title="点击使用此同义词"
                            >
                              {synonym}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 相关术语 */}
              {result.queryExpansion.relatedTerms.length > 0 && (
                <div className="mb-4">
                  <div className="text-xs font-semibold text-gray-600 mb-2 uppercase tracking-wide">
                    相关术语 (基于领域上下文)
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {result.queryExpansion.relatedTerms.map((term, index) => (
                      <span
                        key={index}
                        className="px-3 py-1.5 bg-teal-100 text-teal-800 rounded-lg text-sm font-medium border border-teal-300 hover:bg-teal-200 transition-colors cursor-default"
                        title="相关领域术语"
                      >
                        {term}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* 扩展查询 */}
              {result.queryExpansion.expandedQueries.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-gray-600 mb-2 uppercase tracking-wide">
                    扩展查询建议
                  </div>
                  <div className="space-y-2">
                    {result.queryExpansion.expandedQueries.map((expandedQuery, index) => (
                      <div
                        key={index}
                        className="flex items-center gap-3 p-3 bg-white/80 hover:bg-white rounded-lg transition-colors group border border-green-200"
                      >
                        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-green-500 to-teal-500 text-white flex items-center justify-center text-xs font-bold shrink-0">
                          {index + 1}
                        </div>
                        <div className="flex-1 text-sm text-gray-700 leading-relaxed">{expandedQuery}</div>
                        {onQuerySelect && (
                          <button
                            onClick={() => onQuerySelect(expandedQuery)}
                            className="opacity-0 group-hover:opacity-100 px-3 py-1.5 bg-gradient-to-r from-green-600 to-teal-600 hover:from-green-700 hover:to-teal-700 text-white text-xs rounded-md transition-all font-medium"
                          >
                            使用
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 扩展推理说明 */}
              {result.queryExpansion.reasoning && (
                <details className="mt-4">
                  <summary className="cursor-pointer text-xs text-gray-600 hover:text-gray-800 transition-colors flex items-center gap-1">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    扩展推理说明
                  </summary>
                  <div className="mt-2 p-3 bg-white/60 rounded-lg text-xs text-gray-600 leading-relaxed border border-green-200">
                    {result.queryExpansion.reasoning}
                  </div>
                </details>
              )}
            </div>
          )}

          {/* 查询改写建议 */}
          {result.queryRewrite && result.queryRewrite.rewritten.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <h4 className="text-sm font-semibold text-gray-800 mb-3">✨ 优化的查询建议</h4>
              
              {/* 改进说明 */}
              {result.queryRewrite.improvements.length > 0 && (
                <div className="mb-3 space-y-1">
                  {result.queryRewrite.improvements.map((improvement, index) => (
                    <div key={index} className="text-xs text-gray-600 flex items-center gap-2">
                      <span className="text-green-500">✓</span>
                      <span className="font-medium">{improvement.type}:</span>
                      <span>{improvement.description}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* 改写查询列表 */}
              <div className="space-y-2">
                {result.queryRewrite.rewritten.map((rewrittenQuery, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-3 p-3 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors group"
                  >
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                      index === 0 ? 'bg-purple-500 text-white' : 'bg-gray-300 text-gray-600'
                    }`}>
                      {index + 1}
                    </div>
                    <div className="flex-1 text-sm text-gray-700">{rewrittenQuery}</div>
                    {onQuerySelect && (
                      <button
                        onClick={() => onQuerySelect(rewrittenQuery)}
                        className="opacity-0 group-hover:opacity-100 px-3 py-1 bg-purple-600 hover:bg-purple-700 text-white text-xs rounded transition-all"
                      >
                        使用
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 建议 */}
          {result.suggestions.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <h4 className="text-sm font-semibold text-gray-800 mb-3">💡 优化建议</h4>
              <div className="space-y-2">
                {result.suggestions.map((suggestion, index) => (
                  <div
                    key={index}
                    className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg"
                  >
                    <div className={`w-1 h-full ${getPriorityColor(suggestion.priority)} rounded-full`} />
                    <div className="flex-1">
                      <div className="text-xs font-medium text-gray-700 mb-1">{suggestion.type}</div>
                      <div className="text-sm text-gray-600">{suggestion.message}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 领域分布 */}
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <h4 className="text-sm font-semibold text-gray-800 mb-3">🎯 领域相关度分布</h4>
            <div className="space-y-2">
              {result.domainAnalysis.allDomains.slice(0, 5).map((domain, index) => (
                <div key={domain.domain} className="flex items-center gap-3">
                  <span className="text-xl">{domain.icon}</span>
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-gray-700">{domain.name}</span>
                      <span className="text-xs text-gray-500">{(domain.similarity * 100).toFixed(2)}%</span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all ${
                          index === 0 ? 'bg-gradient-to-r from-purple-500 to-blue-500' : 'bg-gray-300'
                        }`}
                        style={{ width: `${domain.similarity * 100}%` }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 分析推理 */}
          <details className="bg-gray-50 border border-gray-200 rounded-xl">
            <summary className="cursor-pointer p-4 text-sm font-medium text-gray-700 hover:bg-gray-100 transition-colors">
              📝 详细分析推理过程
            </summary>
            <div className="p-4 pt-0 text-sm text-gray-600 leading-relaxed whitespace-pre-wrap">
              {result.intentAnalysis.reasoning}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

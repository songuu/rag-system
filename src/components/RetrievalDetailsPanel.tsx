'use client';

import React, { useState, useMemo } from 'react';
import dynamic from 'next/dynamic';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

interface SearchResult {
  document: {
    content: string;
    metadata: {
      source?: string;
      [key: string]: any;
    };
  };
  similarity: number;
  index: number;
}

interface RetrievalDetailsPanelProps {
  retrievalDetails: {
    searchResults: SearchResult[];
    queryEmbedding?: number[];
    threshold: number;
    topK: number;
    totalDocuments: number;
    searchTime: number;
  } | null;
  queryText?: string;
  onClose?: () => void;
}

// 相似度等级判断
function getSimilarityLevel(similarity: number): {
  level: string;
  color: string;
  bgColor: string;
  description: string;
} {
  if (similarity >= 0.9) return { level: '极高', color: 'text-green-700', bgColor: 'bg-green-100', description: '语义高度匹配' };
  if (similarity >= 0.8) return { level: '高', color: 'text-emerald-700', bgColor: 'bg-emerald-100', description: '语义较好匹配' };
  if (similarity >= 0.7) return { level: '中高', color: 'text-blue-700', bgColor: 'bg-blue-100', description: '语义部分匹配' };
  if (similarity >= 0.5) return { level: '中', color: 'text-yellow-700', bgColor: 'bg-yellow-100', description: '语义弱匹配' };
  if (similarity >= 0.3) return { level: '低', color: 'text-orange-700', bgColor: 'bg-orange-100', description: '语义边缘匹配' };
  return { level: '极低', color: 'text-red-700', bgColor: 'bg-red-100', description: '语义不相关' };
}

// 分析匹配原因
function analyzeMatchReason(content: string, queryText: string): {
  reasons: Array<{ type: string; description: string; importance: 'high' | 'medium' | 'low' }>;
  matchedTerms: string[];
  coverageScore: number;
} {
  const queryTerms = queryText.toLowerCase().split(/[\s,，。？！、]+/).filter(t => t.length > 1);
  const contentLower = content.toLowerCase();
  
  const matchedTerms: string[] = [];
  const reasons: Array<{ type: string; description: string; importance: 'high' | 'medium' | 'low' }> = [];
  
  // 检查关键词匹配
  queryTerms.forEach(term => {
    if (contentLower.includes(term)) {
      matchedTerms.push(term);
    }
  });
  
  if (matchedTerms.length > 0) {
    reasons.push({
      type: '关键词匹配',
      description: `包含查询关键词: ${matchedTerms.slice(0, 5).join(', ')}${matchedTerms.length > 5 ? '...' : ''}`,
      importance: matchedTerms.length > 3 ? 'high' : matchedTerms.length > 1 ? 'medium' : 'low'
    });
  }
  
  // 检查语义领域匹配
  const techKeywords = ['AI', '人工智能', '机器学习', '深度学习', '算法', '模型', '数据', '系统', '技术', '开发'];
  const businessKeywords = ['市场', '销售', '客户', '产品', '服务', '管理', '运营', '投资', '收入'];
  
  const hasTechQuery = techKeywords.some(kw => queryText.includes(kw));
  const hasTechContent = techKeywords.some(kw => content.includes(kw));
  const hasBusinessQuery = businessKeywords.some(kw => queryText.includes(kw));
  const hasBusinessContent = businessKeywords.some(kw => content.includes(kw));
  
  if (hasTechQuery && hasTechContent) {
    reasons.push({
      type: '领域匹配',
      description: '查询和文档都属于技术领域',
      importance: 'high'
    });
  }
  
  if (hasBusinessQuery && hasBusinessContent) {
    reasons.push({
      type: '领域匹配',
      description: '查询和文档都属于商业领域',
      importance: 'high'
    });
  }
  
  // 检查问答模式匹配
  const questionPatterns = ['什么', '如何', '为什么', '怎么', '哪些', '多少'];
  const hasQuestion = questionPatterns.some(p => queryText.includes(p));
  
  if (hasQuestion) {
    const hasExplanation = content.includes('是') || content.includes('因为') || content.includes('通过') || content.includes('可以');
    if (hasExplanation) {
      reasons.push({
        type: '问答匹配',
        description: '文档可能包含问题的答案解释',
        importance: 'medium'
      });
    }
  }
  
  // 检查信息密度
  const contentLength = content.length;
  if (contentLength > 200) {
    reasons.push({
      type: '信息丰富',
      description: `文档包含 ${contentLength} 字符的详细信息`,
      importance: 'low'
    });
  }
  
  // 如果没有找到明确原因，添加语义相似原因
  if (reasons.length === 0) {
    reasons.push({
      type: '语义相似',
      description: '基于向量空间的语义相似度匹配',
      importance: 'medium'
    });
  }
  
  // 计算覆盖率
  const coverageScore = queryTerms.length > 0 ? matchedTerms.length / queryTerms.length : 0;
  
  return { reasons, matchedTerms, coverageScore };
}

// 高亮匹配词
function highlightText(content: string, matchedTerms: string[]): React.ReactNode {
  if (matchedTerms.length === 0) return content;
  
  // 创建正则表达式匹配所有关键词（不区分大小写）
  const pattern = new RegExp(`(${matchedTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  const parts = content.split(pattern);
  
  return parts.map((part, i) => {
    const isMatch = matchedTerms.some(term => part.toLowerCase() === term.toLowerCase());
    return isMatch ? (
      <mark key={i} className="bg-yellow-200 text-yellow-900 px-0.5 rounded">{part}</mark>
    ) : (
      <span key={i}>{part}</span>
    );
  });
}

// 单个检索结果详情卡片
function ResultCard({ 
  result, 
  index, 
  isExpanded, 
  onToggle, 
  queryText 
}: { 
  result: SearchResult; 
  index: number; 
  isExpanded: boolean; 
  onToggle: () => void;
  queryText: string;
}) {
  const similarityLevel = getSimilarityLevel(result.similarity);
  const matchAnalysis = useMemo(() => 
    analyzeMatchReason(result.document.content, queryText),
    [result.document.content, queryText]
  );
  
  // 相似度仪表盘配置
  const gaugeOption = useMemo(() => ({
    series: [{
      type: 'gauge',
      startAngle: 180,
      endAngle: 0,
      min: 0,
      max: 1,
      radius: '100%',
      center: ['50%', '75%'],
      splitNumber: 5,
      axisLine: {
        lineStyle: {
          width: 8,
          color: [
            [0.3, '#EF4444'],
            [0.5, '#F59E0B'],
            [0.7, '#3B82F6'],
            [0.85, '#10B981'],
            [1, '#059669']
          ]
        }
      },
      pointer: {
        icon: 'path://M12.8,0.7l12,40.1H0.7L12.8,0.7z',
        length: '60%',
        width: 6,
        offsetCenter: [0, '-30%'],
        itemStyle: { color: '#333' }
      },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      detail: {
        fontSize: 16,
        fontWeight: 'bold',
        offsetCenter: [0, '10%'],
        formatter: (value: number) => (value * 100).toFixed(1) + '%',
        color: similarityLevel.color.replace('text-', '').replace('-700', '')
      },
      data: [{ value: result.similarity }]
    }]
  }), [result.similarity, similarityLevel.color]);

  return (
    <div className={`border rounded-lg overflow-hidden transition-all duration-300 ${isExpanded ? 'ring-2 ring-purple-400' : 'hover:border-purple-300'}`}>
      {/* 头部 - 始终显示 */}
      <div 
        className={`p-3 cursor-pointer transition-colors ${isExpanded ? 'bg-purple-50' : 'bg-white hover:bg-gray-50'}`}
        onClick={onToggle}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* 排名徽章 */}
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
              index === 0 ? 'bg-yellow-400 text-yellow-900' :
              index === 1 ? 'bg-gray-300 text-gray-700' :
              index === 2 ? 'bg-orange-300 text-orange-800' :
              'bg-gray-100 text-gray-600'
            }`}>
              {index + 1}
            </div>
            
            {/* 文档来源 */}
            <div>
              <div className="text-sm font-medium text-gray-800">
                {result.document.metadata?.source || `文档 ${result.index + 1}`}
              </div>
              <div className="text-xs text-gray-500 truncate max-w-xs">
                {result.document.content.slice(0, 60)}...
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            {/* 相似度标签 */}
            <div className={`px-2 py-1 rounded-full text-xs font-medium ${similarityLevel.bgColor} ${similarityLevel.color}`}>
              {(result.similarity * 100).toFixed(1)}% · {similarityLevel.level}
            </div>
            
            {/* 展开/收起图标 */}
            <svg 
              className={`w-5 h-5 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
              fill="none" 
              stroke="currentColor" 
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>
      </div>
      
      {/* 展开的详情 */}
      {isExpanded && (
        <div className="border-t bg-white">
          <div className="grid grid-cols-3 gap-4 p-4">
            {/* 左侧：相似度仪表盘 */}
            <div className="flex flex-col items-center">
              <div className="text-xs font-medium text-gray-600 mb-1">相似度</div>
              <div style={{ width: '120px', height: '80px' }}>
                <ReactECharts option={gaugeOption} style={{ height: '100%', width: '100%' }} />
              </div>
              <div className={`text-xs ${similarityLevel.color} mt-1`}>
                {similarityLevel.description}
              </div>
            </div>
            
            {/* 中间：匹配原因 */}
            <div className="col-span-2">
              <div className="text-xs font-medium text-gray-600 mb-2">匹配原因分析</div>
              <div className="space-y-2">
                {matchAnalysis.reasons.map((reason, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-xs ${
                      reason.importance === 'high' ? 'bg-green-100 text-green-700' :
                      reason.importance === 'medium' ? 'bg-blue-100 text-blue-700' :
                      'bg-gray-100 text-gray-600'
                    }`}>
                      {reason.importance === 'high' ? '★' : reason.importance === 'medium' ? '●' : '○'}
                    </span>
                    <div>
                      <span className="text-xs font-medium text-gray-700">{reason.type}:</span>
                      <span className="text-xs text-gray-600 ml-1">{reason.description}</span>
                    </div>
                  </div>
                ))}
              </div>
              
              {/* 关键词覆盖率 */}
              {matchAnalysis.matchedTerms.length > 0 && (
                <div className="mt-3 pt-3 border-t">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-gray-600">关键词覆盖率</span>
                    <span className="font-medium">{(matchAnalysis.coverageScore * 100).toFixed(0)}%</span>
                  </div>
                  <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-purple-500 rounded-full transition-all"
                      style={{ width: `${matchAnalysis.coverageScore * 100}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
          
          {/* 文档内容 */}
          <div className="px-4 pb-4">
            <div className="text-xs font-medium text-gray-600 mb-2">文档内容</div>
            <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-700 leading-relaxed max-h-48 overflow-y-auto">
              {highlightText(result.document.content, matchAnalysis.matchedTerms)}
            </div>
          </div>
          
          {/* 元数据 */}
          {Object.keys(result.document.metadata || {}).length > 0 && (
            <div className="px-4 pb-4">
              <div className="text-xs font-medium text-gray-600 mb-2">元数据</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(result.document.metadata).map(([key, value]) => {
                  // 格式化值：处理对象、数组等复杂类型
                  const formatValue = (val: any): string => {
                    if (val === null || val === undefined) return 'N/A';
                    if (typeof val === 'object') {
                      if (Array.isArray(val)) {
                        return val.map(v => formatValue(v)).join(', ');
                      }
                      // 对象类型，尝试提取常用字段
                      if ('start' in val && 'end' in val) {
                        return `${val.start}-${val.end}`;
                      }
                      if ('line' in val) {
                        return `Line ${val.line}`;
                      }
                      // 其他对象转为 JSON
                      try {
                        return JSON.stringify(val);
                      } catch {
                        return '[Object]';
                      }
                    }
                    return String(val);
                  };
                  
                  const displayValue = formatValue(value);
                  
                  return (
                    <span key={key} className="inline-flex items-center px-2 py-1 bg-gray-100 rounded text-xs max-w-xs">
                      <span className="text-gray-500">{key}:</span>
                      <span className="text-gray-700 ml-1 font-medium truncate" title={displayValue}>
                        {displayValue.length > 50 ? displayValue.slice(0, 50) + '...' : displayValue}
                      </span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}
          
          {/* 向量特征（如果有） */}
          <div className="px-4 pb-4">
            <div className="grid grid-cols-4 gap-2 text-center">
              <div className="bg-blue-50 rounded p-2">
                <div className="text-lg font-bold text-blue-600">{result.index + 1}</div>
                <div className="text-[10px] text-gray-500">向量索引</div>
              </div>
              <div className="bg-green-50 rounded p-2">
                <div className="text-lg font-bold text-green-600">{result.document.content.length}</div>
                <div className="text-[10px] text-gray-500">字符数</div>
              </div>
              <div className="bg-purple-50 rounded p-2">
                <div className="text-lg font-bold text-purple-600">{matchAnalysis.matchedTerms.length}</div>
                <div className="text-[10px] text-gray-500">匹配词数</div>
              </div>
              <div className="bg-orange-50 rounded p-2">
                <div className="text-lg font-bold text-orange-600">{matchAnalysis.reasons.length}</div>
                <div className="text-[10px] text-gray-500">匹配因素</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function RetrievalDetailsPanel({ 
  retrievalDetails, 
  queryText = '',
  onClose 
}: RetrievalDetailsPanelProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(0);
  const [showAllResults, setShowAllResults] = useState(false);
  
  // 提取数据（处理 null 情况）
  const searchResults = retrievalDetails?.searchResults || [];
  const threshold = retrievalDetails?.threshold || 0;
  const topK = retrievalDetails?.topK || 0;
  const totalDocuments = retrievalDetails?.totalDocuments || 0;
  const searchTime = retrievalDetails?.searchTime || 0;
  const displayResults = showAllResults ? searchResults : searchResults.slice(0, 5);
  
  // 相似度分布图 - 必须在所有条件返回之前调用
  const distributionOption = useMemo(() => {
    if (searchResults.length === 0) return null;
    
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: '3%', right: '4%', bottom: '3%', top: '15%', containLabel: true },
      xAxis: {
        type: 'category',
        data: searchResults.map((_, i) => `Doc ${i + 1}`),
        axisLabel: { fontSize: 10 }
      },
      yAxis: {
        type: 'value',
        max: 1,
        axisLabel: { fontSize: 10, formatter: (v: number) => (v * 100) + '%' }
      },
      series: [{
        type: 'bar',
        data: searchResults.map(r => ({
          value: r.similarity,
          itemStyle: {
            color: r.similarity >= 0.8 ? '#10B981' :
                   r.similarity >= 0.6 ? '#3B82F6' :
                   r.similarity >= 0.4 ? '#F59E0B' : '#EF4444'
          }
        })),
        barWidth: '60%',
        label: {
          show: true,
          position: 'top',
          fontSize: 9,
          formatter: (p: any) => (p.value * 100).toFixed(0) + '%'
        }
      }],
      markLine: {
        data: [{ yAxis: threshold, name: '阈值' }],
        lineStyle: { color: '#EF4444', type: 'dashed' },
        label: { formatter: '阈值' }
      }
    };
  }, [searchResults, threshold]);
  
  // 无数据时显示空状态
  if (!retrievalDetails) {
    return (
      <div className="bg-white rounded-lg shadow-sm border p-6 text-center">
        <div className="text-gray-400 mb-2">
          <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <p className="text-sm text-gray-500">暂无检索结果</p>
        <p className="text-xs text-gray-400 mt-1">提交查询后将显示检索详情</p>
      </div>
    );
  }
  
  return (
    <div className="bg-white rounded-lg shadow-sm border overflow-hidden">
      {/* 头部 */}
      <div className="border-b px-4 py-3 bg-gradient-to-r from-purple-50 to-blue-50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-purple-500 text-white flex items-center justify-center">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-800">检索详情</h3>
              <p className="text-xs text-gray-500">点击每项查看详细匹配信息</p>
            </div>
          </div>
          {onClose && (
            <button 
              onClick={onClose}
              className="p-1 hover:bg-gray-100 rounded transition-colors"
            >
              <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>
      
      {/* 统计概览 */}
      <div className="grid grid-cols-4 gap-3 p-4 bg-gray-50 border-b">
        <div className="text-center">
          <div className="text-2xl font-bold text-purple-600">{searchResults.length}</div>
          <div className="text-xs text-gray-500">匹配文档</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-blue-600">{totalDocuments}</div>
          <div className="text-xs text-gray-500">总文档数</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-green-600">{searchTime}ms</div>
          <div className="text-xs text-gray-500">检索耗时</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-orange-600">{(threshold * 100).toFixed(0)}%</div>
          <div className="text-xs text-gray-500">相似度阈值</div>
        </div>
      </div>
      
      {/* 相似度分布图 */}
      {searchResults.length > 1 && distributionOption && (
        <div className="p-4 border-b">
          <div className="text-xs font-medium text-gray-600 mb-2">相似度分布</div>
          <ReactECharts option={distributionOption} style={{ height: '120px' }} />
        </div>
      )}
      
      {/* 检索结果列表 */}
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs font-medium text-gray-600">
            检索结果 (Top-{topK})
          </div>
          {searchResults.length > 5 && (
            <button
              onClick={() => setShowAllResults(!showAllResults)}
              className="text-xs text-purple-600 hover:text-purple-800"
            >
              {showAllResults ? '收起' : `显示全部 ${searchResults.length} 条`}
            </button>
          )}
        </div>
        
        <div className="space-y-3">
          {displayResults.map((result, index) => (
            <ResultCard
              key={index}
              result={result}
              index={index}
              isExpanded={expandedIndex === index}
              onToggle={() => setExpandedIndex(expandedIndex === index ? null : index)}
              queryText={queryText}
            />
          ))}
        </div>
        
        {!showAllResults && searchResults.length > 5 && (
          <div className="mt-3 text-center">
            <button
              onClick={() => setShowAllResults(true)}
              className="text-sm text-purple-600 hover:text-purple-800 hover:underline"
            >
              查看更多 {searchResults.length - 5} 条结果 →
            </button>
          </div>
        )}
      </div>
      
      {/* 底部提示 */}
      <div className="px-4 py-3 bg-gray-50 border-t">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>相似度基于余弦距离计算，值越高表示语义越相近</span>
        </div>
      </div>
    </div>
  );
}

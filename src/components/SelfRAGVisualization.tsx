'use client';

import React, { useState, useEffect, useRef } from 'react';

// 类型定义
interface ReflectionToken {
  type: 'retrieve' | 'isrel' | 'issup' | 'isuse';
  value: string;
  score: number;
  reasoning: string;
  timestamp: number;
}

interface SelfRAGStep {
  stepId: number;
  stepName: string;
  input: any;
  output: any;
  reflection: ReflectionToken | null;
  duration: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

interface DocumentWithScore {
  content: string;
  source: string;
  similarity: number;
  isRelevant: boolean;
  relevanceScore: number;
  relevanceReasoning: string;
}

interface GenerationSegment {
  text: string;
  isSupported: boolean;
  supportScore: number;
  supportingDocs: string[];
  reasoning: string;
}

interface SelfRAGResult {
  success: boolean;
  query: string;
  finalResponse: string;
  steps: SelfRAGStep[];
  reflectionTokens: ReflectionToken[];
  documents: DocumentWithScore[];
  supportAnalysis: {
    segments: GenerationSegment[];
    overallSupport: number;
  };
  iterations: number;
  totalTime: number;
  metrics: {
    retrieveDecision: ReflectionToken;
    relevanceScores: number[];
    supportScore: number;
    usefulnessScore: number;
  };
}

interface SelfRAGVisualizationProps {
  onQuerySelect?: (query: string) => void;
}

export default function SelfRAGVisualization({ onQuerySelect }: SelfRAGVisualizationProps) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SelfRAGResult | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState<number | null>(null);
  const [showDetails, setShowDetails] = useState<string | null>(null);
  const stepsRef = useRef<HTMLDivElement>(null);

  // 示例查询
  const exampleQueries = [
    '什么是机器学习？',
    '如何优化数据库性能？',
    '1+1等于多少？',
    '人工智能有哪些应用领域？',
    '欧洲中世纪的历史特点是什么？'
  ];

  // 执行 Self-RAG
  const runSelfRAG = async () => {
    if (!query.trim()) {
      setError('请输入查询内容');
      return;
    }

    setIsProcessing(true);
    setError(null);
    setResult(null);
    setActiveStep(null);

    try {
      const response = await fetch('/rag-api/self-rag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });

      if (!response.ok) {
        throw new Error(`请求失败: ${response.statusText}`);
      }

      const data = await response.json();
      
      if (data.success) {
        setResult(data);
        // 自动滚动到步骤区域
        setTimeout(() => {
          stepsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
      } else {
        setError(data.error || 'Self-RAG 处理失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
    } finally {
      setIsProcessing(false);
    }
  };

  // 获取 Token 类型的图标和颜色
  const getTokenStyle = (type: string, value: string) => {
    const styles: Record<string, { icon: string; bgColor: string; textColor: string; borderColor: string }> = {
      'retrieve-YES': { icon: '🔍', bgColor: 'bg-blue-100', textColor: 'text-blue-700', borderColor: 'border-blue-300' },
      'retrieve-NO': { icon: '⏭️', bgColor: 'bg-gray-100', textColor: 'text-gray-600', borderColor: 'border-gray-300' },
      'isrel-RELEVANT': { icon: '✅', bgColor: 'bg-green-100', textColor: 'text-green-700', borderColor: 'border-green-300' },
      'isrel-NOT_RELEVANT': { icon: '❌', bgColor: 'bg-red-100', textColor: 'text-red-700', borderColor: 'border-red-300' },
      'issup-SUPPORTED': { icon: '📚', bgColor: 'bg-purple-100', textColor: 'text-purple-700', borderColor: 'border-purple-300' },
      'issup-NOT_SUPPORTED': { icon: '⚠️', bgColor: 'bg-yellow-100', textColor: 'text-yellow-700', borderColor: 'border-yellow-300' },
      'isuse-USEFUL': { icon: '👍', bgColor: 'bg-emerald-100', textColor: 'text-emerald-700', borderColor: 'border-emerald-300' },
      'isuse-NOT_USEFUL': { icon: '👎', bgColor: 'bg-orange-100', textColor: 'text-orange-700', borderColor: 'border-orange-300' },
    };
    return styles[`${type}-${value}`] || { icon: '❓', bgColor: 'bg-gray-100', textColor: 'text-gray-600', borderColor: 'border-gray-300' };
  };

  // 获取步骤状态样式
  const getStepStatusStyle = (status: string) => {
    switch (status) {
      case 'completed': return 'bg-green-500';
      case 'running': return 'bg-blue-500 animate-pulse';
      case 'failed': return 'bg-red-500';
      default: return 'bg-gray-300';
    }
  };

  // 格式化分数为百分比
  const formatScore = (score: number) => `${(score * 100).toFixed(1)}%`;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50">
      {/* 头部 */}
      <div className="bg-white border-b shadow-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-3">
                <span className="bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
                  🔄 Self-RAG
                </span>
                <span className="text-sm font-normal text-gray-500 bg-gray-100 px-2 py-1 rounded">
                  Self-Reflective RAG
                </span>
              </h1>
              <p className="text-sm text-gray-500 mt-1">
                自反思检索增强生成系统 - 通过 Retrieve, IsRel, IsSup, IsUse 四种反思令牌实现智能决策
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* 输入区域 */}
        <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-6 mb-8">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-xl">💬</span>
            <h2 className="text-lg font-semibold text-gray-800">输入查询</h2>
          </div>
          
          <div className="flex gap-4">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !isProcessing && runSelfRAG()}
              placeholder="输入您的问题..."
              className="flex-1 px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 outline-none transition-all text-gray-700"
              disabled={isProcessing}
            />
            <button
              onClick={runSelfRAG}
              disabled={isProcessing || !query.trim()}
              className="px-6 py-3 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white font-medium rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shadow-lg shadow-indigo-200"
            >
              {isProcessing ? (
                <>
                  <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  处理中...
                </>
              ) : (
                <>
                  <span>🚀</span>
                  运行 Self-RAG
                </>
              )}
            </button>
          </div>

          {/* 示例查询 */}
          <div className="mt-4">
            <div className="text-sm text-gray-500 mb-2">快速测试:</div>
            <div className="flex flex-wrap gap-2">
              {exampleQueries.map((q, i) => (
                <button
                  key={i}
                  onClick={() => setQuery(q)}
                  className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm rounded-lg transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 错误信息 */}
        {error && (
          <div className="bg-red-50 border-2 border-red-200 rounded-xl p-4 mb-8">
            <div className="flex items-center gap-2 text-red-700">
              <span className="text-xl">❌</span>
              <span className="font-medium">{error}</span>
            </div>
          </div>
        )}

        {/* 处理结果 */}
        {result && (
          <div ref={stepsRef} className="space-y-8">
            {/* 反思令牌概览 */}
            <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-6">
              <div className="flex items-center gap-2 mb-6">
                <span className="text-xl">🎯</span>
                <h2 className="text-lg font-semibold text-gray-800">反思令牌 (Reflection Tokens)</h2>
              </div>
              
              <div className="grid grid-cols-4 gap-4">
                {/* Retrieve Token */}
                <div className={`p-4 rounded-xl border-2 ${getTokenStyle('retrieve', result.metrics.retrieveDecision.value).borderColor} ${getTokenStyle('retrieve', result.metrics.retrieveDecision.value).bgColor}`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-2xl">{getTokenStyle('retrieve', result.metrics.retrieveDecision.value).icon}</span>
                    <span className={`text-xs font-bold px-2 py-1 rounded ${getTokenStyle('retrieve', result.metrics.retrieveDecision.value).textColor}`}>
                      {result.metrics.retrieveDecision.value}
                    </span>
                  </div>
                  <div className="text-sm font-semibold text-gray-700 mb-1">Retrieve</div>
                  <div className="text-xs text-gray-500">是否需要检索</div>
                  <div className="mt-2 text-lg font-bold text-gray-800">{formatScore(result.metrics.retrieveDecision.score)}</div>
                </div>

                {/* IsRel Token */}
                <div className={`p-4 rounded-xl border-2 ${result.metrics.relevanceScores.length > 0 ? 'border-green-300 bg-green-50' : 'border-gray-200 bg-gray-50'}`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-2xl">📋</span>
                    <span className="text-xs font-bold px-2 py-1 rounded text-green-700">
                      {result.documents.filter(d => d.isRelevant).length}/{result.documents.length}
                    </span>
                  </div>
                  <div className="text-sm font-semibold text-gray-700 mb-1">IsRel</div>
                  <div className="text-xs text-gray-500">文档相关性</div>
                  <div className="mt-2 text-lg font-bold text-gray-800">
                    {result.metrics.relevanceScores.length > 0 
                      ? formatScore(result.metrics.relevanceScores.reduce((a, b) => a + b, 0) / result.metrics.relevanceScores.length)
                      : 'N/A'}
                  </div>
                </div>

                {/* IsSup Token */}
                <div className={`p-4 rounded-xl border-2 ${result.metrics.supportScore >= 0.6 ? 'border-purple-300 bg-purple-50' : 'border-yellow-300 bg-yellow-50'}`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-2xl">{result.metrics.supportScore >= 0.6 ? '📚' : '⚠️'}</span>
                    <span className={`text-xs font-bold px-2 py-1 rounded ${result.metrics.supportScore >= 0.6 ? 'text-purple-700' : 'text-yellow-700'}`}>
                      {result.metrics.supportScore >= 0.6 ? 'SUPPORTED' : 'PARTIAL'}
                    </span>
                  </div>
                  <div className="text-sm font-semibold text-gray-700 mb-1">IsSup</div>
                  <div className="text-xs text-gray-500">回答支持度</div>
                  <div className="mt-2 text-lg font-bold text-gray-800">{formatScore(result.metrics.supportScore)}</div>
                </div>

                {/* IsUse Token */}
                <div className={`p-4 rounded-xl border-2 ${result.metrics.usefulnessScore >= 0.6 ? 'border-emerald-300 bg-emerald-50' : 'border-orange-300 bg-orange-50'}`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-2xl">{result.metrics.usefulnessScore >= 0.6 ? '👍' : '👎'}</span>
                    <span className={`text-xs font-bold px-2 py-1 rounded ${result.metrics.usefulnessScore >= 0.6 ? 'text-emerald-700' : 'text-orange-700'}`}>
                      {result.metrics.usefulnessScore >= 0.6 ? 'USEFUL' : 'NEEDS_WORK'}
                    </span>
                  </div>
                  <div className="text-sm font-semibold text-gray-700 mb-1">IsUse</div>
                  <div className="text-xs text-gray-500">回答有用性</div>
                  <div className="mt-2 text-lg font-bold text-gray-800">{formatScore(result.metrics.usefulnessScore)}</div>
                </div>
              </div>
            </div>

            {/* 处理步骤流程图 */}
            <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-6">
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-2">
                  <span className="text-xl">📊</span>
                  <h2 className="text-lg font-semibold text-gray-800">处理流程可视化</h2>
                </div>
                <div className="flex items-center gap-4 text-sm text-gray-500">
                  <span>总耗时: <span className="font-semibold text-gray-700">{(result.totalTime / 1000).toFixed(2)}s</span></span>
                  <span>迭代次数: <span className="font-semibold text-gray-700">{result.iterations}</span></span>
                </div>
              </div>

              {/* 流程图 */}
              <div className="relative">
                <div className="flex items-start justify-between overflow-x-auto pb-4">
                  {result.steps.map((step, index) => (
                    <React.Fragment key={step.stepId}>
                      {/* 步骤节点 */}
                      <div 
                        className={`flex-shrink-0 w-48 cursor-pointer transition-all ${activeStep === index ? 'scale-105' : 'hover:scale-102'}`}
                        onClick={() => setActiveStep(activeStep === index ? null : index)}
                      >
                        <div className={`relative p-4 rounded-xl border-2 transition-all ${
                          activeStep === index 
                            ? 'border-indigo-500 bg-indigo-50 shadow-lg' 
                            : 'border-gray-200 bg-white hover:border-gray-300'
                        }`}>
                          {/* 状态指示器 */}
                          <div className={`absolute -top-2 -right-2 w-4 h-4 rounded-full ${getStepStatusStyle(step.status)}`}></div>
                          
                          {/* 步骤编号 */}
                          <div className="flex items-center justify-between mb-2">
                            <span className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 text-white flex items-center justify-center text-sm font-bold">
                              {step.stepId}
                            </span>
                            <span className="text-xs text-gray-400">{step.duration}ms</span>
                          </div>
                          
                          {/* 步骤名称 */}
                          <div className="text-sm font-semibold text-gray-800 mb-1 truncate" title={step.stepName}>
                            {step.stepName}
                          </div>
                          
                          {/* 反思令牌 */}
                          {step.reflection && (
                            <div className={`mt-2 px-2 py-1 rounded text-xs font-medium ${getTokenStyle(step.reflection.type, step.reflection.value).bgColor} ${getTokenStyle(step.reflection.type, step.reflection.value).textColor}`}>
                              {getTokenStyle(step.reflection.type, step.reflection.value).icon} {step.reflection.value}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* 连接箭头 */}
                      {index < result.steps.length - 1 && (
                        <div className="flex-shrink-0 flex items-center px-2 pt-8">
                          <svg className="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                          </svg>
                        </div>
                      )}
                    </React.Fragment>
                  ))}
                </div>

                {/* 步骤详情 */}
                {activeStep !== null && result.steps[activeStep] && (
                  <div className="mt-6 p-4 bg-gray-50 rounded-xl border border-gray-200">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-semibold text-gray-800">
                        Step {result.steps[activeStep].stepId}: {result.steps[activeStep].stepName}
                      </h3>
                      <button 
                        onClick={() => setActiveStep(null)}
                        className="text-gray-400 hover:text-gray-600"
                      >
                        ✕
                      </button>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-4">
                      {/* 输入 */}
                      <div>
                        <div className="text-xs font-semibold text-gray-500 mb-2 uppercase">Input</div>
                        <pre className="p-3 bg-white rounded-lg text-xs text-gray-700 overflow-auto max-h-40 border">
                          {JSON.stringify(result.steps[activeStep].input, null, 2)}
                        </pre>
                      </div>
                      
                      {/* 输出 */}
                      <div>
                        <div className="text-xs font-semibold text-gray-500 mb-2 uppercase">Output</div>
                        <pre className="p-3 bg-white rounded-lg text-xs text-gray-700 overflow-auto max-h-40 border">
                          {JSON.stringify(result.steps[activeStep].output, null, 2)}
                        </pre>
                      </div>
                    </div>

                    {/* 反思信息 */}
                    {result.steps[activeStep].reflection && (
                      <div className="mt-4 p-3 bg-indigo-50 rounded-lg border border-indigo-200">
                        <div className="text-xs font-semibold text-indigo-600 mb-2 uppercase">Reflection Token</div>
                        <div className="text-sm text-gray-700">
                          <span className="font-medium">{result.steps[activeStep].reflection.type.toUpperCase()}</span>: {result.steps[activeStep].reflection.reasoning}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* 检索文档详情 */}
            {result.documents.length > 0 && (
              <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-6">
                <div className="flex items-center gap-2 mb-6">
                  <span className="text-xl">📄</span>
                  <h2 className="text-lg font-semibold text-gray-800">检索文档 & 相关性评估</h2>
                </div>

                <div className="space-y-4">
                  {result.documents.map((doc, index) => (
                    <div 
                      key={index}
                      className={`p-4 rounded-xl border-2 transition-all ${
                        doc.isRelevant 
                          ? 'border-green-200 bg-green-50' 
                          : 'border-red-200 bg-red-50'
                      }`}
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <span className="text-xl">{doc.isRelevant ? '✅' : '❌'}</span>
                          <div>
                            <div className="font-semibold text-gray-800">{doc.source}</div>
                            <div className="text-xs text-gray-500">
                              相似度: {formatScore(doc.similarity)} | 相关性: {formatScore(doc.relevanceScore)}
                            </div>
                          </div>
                        </div>
                        <button
                          onClick={() => setShowDetails(showDetails === `doc-${index}` ? null : `doc-${index}`)}
                          className="text-sm text-indigo-600 hover:text-indigo-800"
                        >
                          {showDetails === `doc-${index}` ? '收起' : '展开'}
                        </button>
                      </div>

                      {/* 相关性评估 */}
                      <div className="flex items-center gap-4 mb-3">
                        <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                          <div 
                            className={`h-full transition-all ${doc.isRelevant ? 'bg-green-500' : 'bg-red-400'}`}
                            style={{ width: `${doc.relevanceScore * 100}%` }}
                          />
                        </div>
                        <span className={`text-sm font-semibold ${doc.isRelevant ? 'text-green-700' : 'text-red-700'}`}>
                          {doc.isRelevant ? 'RELEVANT' : 'NOT RELEVANT'}
                        </span>
                      </div>

                      {/* 详情 */}
                      {showDetails === `doc-${index}` && (
                        <div className="mt-4 space-y-3">
                          <div className="p-3 bg-white rounded-lg border text-sm text-gray-700">
                            <div className="font-medium text-gray-800 mb-1">评估理由:</div>
                            {doc.relevanceReasoning}
                          </div>
                          <div className="p-3 bg-white rounded-lg border text-sm text-gray-600 max-h-40 overflow-auto">
                            <div className="font-medium text-gray-800 mb-1">文档内容:</div>
                            {doc.content}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 支持度分析 */}
            {result.supportAnalysis.segments.length > 0 && (
              <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-6">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-2">
                    <span className="text-xl">📊</span>
                    <h2 className="text-lg font-semibold text-gray-800">支持度分析 (IsSup)</h2>
                  </div>
                  <div className={`px-3 py-1 rounded-full text-sm font-medium ${
                    result.supportAnalysis.overallSupport >= 0.7 
                      ? 'bg-green-100 text-green-700'
                      : result.supportAnalysis.overallSupport >= 0.5 
                        ? 'bg-yellow-100 text-yellow-700'
                        : 'bg-red-100 text-red-700'
                  }`}>
                    整体支持度: {formatScore(result.supportAnalysis.overallSupport)}
                  </div>
                </div>

                <div className="space-y-3">
                  {result.supportAnalysis.segments.map((segment, index) => (
                    <div 
                      key={index}
                      className={`p-4 rounded-xl border-2 ${
                        segment.isSupported 
                          ? 'border-green-200 bg-green-50'
                          : 'border-yellow-200 bg-yellow-50'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <span className="text-xl shrink-0">{segment.isSupported ? '✓' : '?'}</span>
                        <div className="flex-1">
                          <div className="text-sm text-gray-800 mb-2">"{segment.text}"</div>
                          <div className="flex items-center gap-4 text-xs text-gray-500">
                            <span>支持度: <span className="font-semibold">{formatScore(segment.supportScore)}</span></span>
                            {segment.supportingDocs && segment.supportingDocs.length > 0 && (
                              <span>支持文档: {segment.supportingDocs.join(', ')}</span>
                            )}
                          </div>
                          {segment.reasoning && (
                            <div className="mt-2 text-xs text-gray-600 italic">{segment.reasoning}</div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 最终回答 */}
            <div className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-2xl shadow-lg border-2 border-indigo-200 p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-xl">💡</span>
                <h2 className="text-lg font-semibold text-gray-800">最终回答</h2>
              </div>
              
              <div className="bg-white rounded-xl p-5 border border-indigo-100">
                <div className="prose prose-sm max-w-none text-gray-700 leading-relaxed whitespace-pre-wrap">
                  {result.finalResponse}
                </div>
              </div>

              {/* 使用此回答 */}
              {onQuerySelect && (
                <div className="mt-4 flex justify-end">
                  <button
                    onClick={() => onQuerySelect(result.query)}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    在主系统中使用此查询 →
                  </button>
                </div>
              )}
            </div>

            {/* 完整反思令牌时间线 */}
            <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-6">
              <div className="flex items-center gap-2 mb-6">
                <span className="text-xl">⏱️</span>
                <h2 className="text-lg font-semibold text-gray-800">反思令牌时间线</h2>
              </div>

              <div className="relative">
                <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-gray-200"></div>
                
                <div className="space-y-4">
                  {result.reflectionTokens.map((token, index) => {
                    const style = getTokenStyle(token.type, token.value);
                    return (
                      <div key={index} className="relative pl-10">
                        <div className={`absolute left-2 w-5 h-5 rounded-full ${style.bgColor} border-2 ${style.borderColor} flex items-center justify-center`}>
                          <span className="text-xs">{style.icon}</span>
                        </div>
                        
                        <div className={`p-3 rounded-lg ${style.bgColor} border ${style.borderColor}`}>
                          <div className="flex items-center justify-between mb-1">
                            <span className={`text-sm font-semibold ${style.textColor}`}>
                              {token.type.toUpperCase()}: {token.value}
                            </span>
                            <span className="text-xs text-gray-400">{token.timestamp}ms</span>
                          </div>
                          <div className="text-xs text-gray-600">{token.reasoning}</div>
                          <div className="mt-1">
                            <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                              <div 
                                className={`h-full ${style.bgColor.replace('100', '500')}`}
                                style={{ width: `${token.score * 100}%` }}
                              />
                            </div>
                            <div className="text-xs text-gray-500 mt-0.5 text-right">{formatScore(token.score)}</div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 空状态 */}
        {!result && !isProcessing && !error && (
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-12 text-center">
            <div className="text-6xl mb-4">🔄</div>
            <h3 className="text-xl font-semibold text-gray-800 mb-2">Self-RAG 系统就绪</h3>
            <p className="text-gray-500 mb-6 max-w-md mx-auto">
              Self-RAG 通过四种反思令牌（Retrieve, IsRel, IsSup, IsUse）实现智能决策，
              自动判断是否需要检索、评估文档相关性、验证回答支持度和有用性。
            </p>
            
            <div className="grid grid-cols-4 gap-4 max-w-2xl mx-auto">
              <div className="p-4 bg-blue-50 rounded-xl border border-blue-200">
                <div className="text-2xl mb-2">🔍</div>
                <div className="text-sm font-semibold text-blue-700">Retrieve</div>
                <div className="text-xs text-gray-500">检索决策</div>
              </div>
              <div className="p-4 bg-green-50 rounded-xl border border-green-200">
                <div className="text-2xl mb-2">📋</div>
                <div className="text-sm font-semibold text-green-700">IsRel</div>
                <div className="text-xs text-gray-500">相关性判断</div>
              </div>
              <div className="p-4 bg-purple-50 rounded-xl border border-purple-200">
                <div className="text-2xl mb-2">📚</div>
                <div className="text-sm font-semibold text-purple-700">IsSup</div>
                <div className="text-xs text-gray-500">支持度评估</div>
              </div>
              <div className="p-4 bg-emerald-50 rounded-xl border border-emerald-200">
                <div className="text-2xl mb-2">👍</div>
                <div className="text-sm font-semibold text-emerald-700">IsUse</div>
                <div className="text-xs text-gray-500">有用性评估</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

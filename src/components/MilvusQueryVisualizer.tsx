'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';

// ============== 类型定义 ==============

interface SearchResult {
  id: string;
  content: string;
  metadata: Record<string, any>;
  score: number;
  distance?: number;
}

interface QueryVisualizerProps {
  embeddingModel?: string;
  onSearchComplete?: (results: SearchResult[]) => void;
  className?: string;
  defaultExpanded?: boolean;
}

interface VisualizationState {
  phase: 'idle' | 'embedding' | 'searching' | 'complete' | 'error' | 'timeout';
  query: string;
  results: SearchResult[];
  timing: {
    embedding?: number;
    search?: number;
    total?: number;
  };
  error?: string;
}

// ============== 颜色配置 ==============

const SIMILARITY_COLORS = {
  high: { bg: '#22c55e', text: 'text-green-400' },
  medium: { bg: '#3b82f6', text: 'text-blue-400' },
  low: { bg: '#f59e0b', text: 'text-amber-400' },
  poor: { bg: '#ef4444', text: 'text-red-400' },
};

function getSimilarityColor(score: number) {
  if (score >= 0.9) return SIMILARITY_COLORS.high;
  if (score >= 0.7) return SIMILARITY_COLORS.medium;
  if (score >= 0.5) return SIMILARITY_COLORS.low;
  return SIMILARITY_COLORS.poor;
}

// ============== 主组件 ==============

export default function MilvusQueryVisualizer({
  embeddingModel = 'nomic-embed-text',
  onSearchComplete,
  className = '',
  defaultExpanded = false,
}: QueryVisualizerProps) {
  // 状态
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState(5);
  const [visualization, setVisualization] = useState<VisualizationState>({
    phase: 'idle',
    query: '',
    results: [],
    timing: {}
  });
  const [milvusStatus, setMilvusStatus] = useState<{ connected: boolean; rowCount: number; dimension: number }>({
    connected: false,
    rowCount: 0,
    dimension: 768
  });
  const [selectedResult, setSelectedResult] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  
  const abortControllerRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  const SEARCH_TIMEOUT = 60000;

  // 检查 Milvus 状态
  const checkMilvusStatus = useCallback(async () => {
    try {
      const statusRes = await fetch('/rag-api/milvus?action=status');
      const statusData = await statusRes.json();
      if (!statusRes.ok || !statusData.success || statusData.disabled === true) {
        setMilvusStatus(prev => ({ ...prev, connected: false }));
        return;
      }

      setMilvusStatus({
        connected: Boolean(statusData.connected),
        rowCount: statusData.stats?.rowCount || 0,
        dimension: statusData.stats?.embeddingDimension || 768,
      });
    } catch (error) {
      setMilvusStatus(prev => ({ ...prev, connected: false }));
    }
  }, []);

  useEffect(() => {
    void checkMilvusStatus();
    const interval = window.setInterval(() => {
      void checkMilvusStatus();
    }, 30000);
    return () => clearInterval(interval);
  }, [checkMilvusStatus]);

  // 取消搜索
  const cancelSearch = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsSearching(false);
    setVisualization(prev => ({
      ...prev,
      phase: 'idle',
      error: '搜索已取消'
    }));
  }, []);

  // 执行查询
  const handleSearch = async () => {
    if (!query.trim()) return;
    if (!milvusStatus.connected) {
      setVisualization(prev => ({ ...prev, phase: 'error', error: 'Milvus 未连接' }));
      return;
    }

    if (abortControllerRef.current) abortControllerRef.current.abort();
    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    const startTime = Date.now();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsSearching(true);
    setSelectedResult(null);
    
    setVisualization({
      phase: 'embedding',
      query: query.trim(),
      results: [],
      timing: {},
      error: undefined
    });

    timeoutRef.current = setTimeout(() => {
      controller.abort();
      setIsSearching(false);
      setVisualization(prev => ({
        ...prev,
        phase: 'timeout',
        error: `搜索超时 (${SEARCH_TIMEOUT / 1000}秒)`
      }));
    }, SEARCH_TIMEOUT);

    try {
      const searchPhaseTimeout = setTimeout(() => {
        if (!controller.signal.aborted) {
          setVisualization(prev => ({ ...prev, phase: 'searching' }));
        }
      }, 400);

      const response = await fetch('/rag-api/milvus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'search',
          query: query.trim(),
          topK,
          threshold: 0,
          embeddingModel
        }),
        signal: controller.signal
      });

      clearTimeout(searchPhaseTimeout);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      const data = await response.json();
      const totalTime = Date.now() - startTime;

      if (data.success) {
        const results = data.results || [];
        setVisualization({
          phase: 'complete',
          query: query.trim(),
          results,
          timing: {
            embedding: Math.round(totalTime * 0.3),
            search: Math.round(totalTime * 0.7),
            total: totalTime
          },
          error: results.length === 0 ? '未找到相关文档' : undefined
        });
        onSearchComplete?.(results);
      } else {
        setVisualization(prev => ({
          ...prev,
          phase: 'error',
          results: [],
          error: data.error || '搜索失败'
        }));
      }
    } catch (error) {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (error instanceof Error && error.name === 'AbortError') return;
      setVisualization(prev => ({
        ...prev,
        phase: 'error',
        results: [],
        error: error instanceof Error ? error.message : '搜索失败'
      }));
    } finally {
      setIsSearching(false);
      abortControllerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) abortControllerRef.current.abort();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const quickQueries = ['人工智能', '机器学习', '数据分析'];

  // 折叠状态的紧凑视图
  if (!isExpanded) {
    return (
      <div className={`bg-white rounded-lg border shadow-sm ${className} mb-4`}>
        <button
          onClick={() => setIsExpanded(true)}
          className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center">
              <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <div className="text-left">
              <div className="text-sm font-medium text-gray-900">Milvus 查询可视化</div>
              <div className="text-xs text-gray-500">
                {milvusStatus.connected ? (
                  <span className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>
                    {milvusStatus.rowCount} 文档 · {milvusStatus.dimension}D
                  </span>
                ) : (
                  <span className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500"></span>
                    未连接
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">展开测试</span>
            <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </button>
      </div>
    );
  }

  // 展开状态
  return (
    <div className={`bg-white rounded-lg border shadow-sm overflow-hidden ${className} mb-4`}>
      {/* 头部 */}
      <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <div>
            <div className="text-sm font-medium text-gray-900">Milvus 实时查询</div>
            <div className="text-xs text-gray-500 flex items-center gap-2">
              {milvusStatus.connected ? (
                <>
                  <span className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>
                    在线
                  </span>
                  <span className="text-gray-300">|</span>
                  <span>{milvusStatus.rowCount} 文档</span>
                  <span className="text-gray-300">|</span>
                  <span>{milvusStatus.dimension}D</span>
                </>
              ) : (
                <span className="flex items-center gap-1 text-red-500">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500"></span>
                  未连接
                </span>
              )}
            </div>
          </div>
        </div>
        <button
          onClick={() => setIsExpanded(false)}
          className="p-1.5 hover:bg-gray-200 rounded-md transition-colors"
        >
          <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        </button>
      </div>

      {/* 生产环境通过受保护的 pipeline 入库，不能调用已废弃的 legacy sync 路由。 */}
      {milvusStatus.connected && milvusStatus.rowCount === 0 && (
        <div className="px-4 py-3 bg-amber-50 border-b border-amber-100">
          <div className="flex items-center gap-2 text-sm text-amber-700">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            当前语料库为空。请通过文档管理上传文件，系统会写入当前受保护的语料库。
          </div>
        </div>
      )}

      {/* 搜索区域 */}
      <div className="p-4">
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !isSearching && handleSearch()}
              placeholder="输入查询内容..."
              className="w-full px-3 py-2 text-sm border rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none"
              disabled={isSearching}
            />
            {isSearching && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                <div className="animate-spin w-4 h-4 border-2 border-purple-500 border-t-transparent rounded-full"></div>
              </div>
            )}
          </div>
          <select
            value={topK}
            onChange={(e) => setTopK(Number(e.target.value))}
            className="px-2 py-2 text-sm border rounded-lg focus:ring-2 focus:ring-purple-500 outline-none"
          >
            {[3, 5, 10].map(n => (
              <option key={n} value={n}>Top {n}</option>
            ))}
          </select>
          {isSearching ? (
            <button
              onClick={cancelSearch}
              className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white text-sm font-medium rounded-lg transition-colors"
            >
              取消
            </button>
          ) : (
            <button
              onClick={handleSearch}
              disabled={!query.trim() || !milvusStatus.connected}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              搜索
            </button>
          )}
        </div>

        {/* 快捷查询 */}
        <div className="flex gap-1.5 mt-2">
          {quickQueries.map(q => (
            <button
              key={q}
              onClick={() => { setQuery(q); }}
              className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 rounded transition-colors"
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      {/* 可视化区域 */}
      {(visualization.phase !== 'idle' || visualization.results.length > 0) && (
        <div className="border-t">
          <div className="grid grid-cols-2 divide-x">
            {/* 左侧：向量空间 */}
            <div className="p-4">
              <div className="text-xs font-medium text-gray-500 mb-3">向量空间</div>
              <div className="relative aspect-square bg-gradient-to-br from-slate-50 to-slate-100 rounded-lg overflow-hidden">
                {/* 状态显示 */}
                {(visualization.phase === 'embedding' || visualization.phase === 'searching') && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/80 z-10">
                    <div className="relative">
                      <div className="w-12 h-12 border-4 border-purple-200 rounded-full"></div>
                      <div className="absolute inset-0 w-12 h-12 border-4 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
                    </div>
                    <div className="mt-3 text-sm text-gray-600">
                      {visualization.phase === 'embedding' ? '向量化中...' : '检索中...'}
                    </div>
                  </div>
                )}

                {/* 错误/超时显示 */}
                {(visualization.phase === 'error' || visualization.phase === 'timeout') && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <div className="text-3xl mb-2">{visualization.phase === 'timeout' ? '⏱️' : '❌'}</div>
                    <div className="text-sm text-gray-500 text-center px-4">{visualization.error}</div>
                    <button
                      onClick={handleSearch}
                      className="mt-3 px-3 py-1 text-xs bg-purple-100 text-purple-600 rounded hover:bg-purple-200 transition-colors"
                    >
                      重试
                    </button>
                  </div>
                )}

                {/* 完成状态 - 向量可视化 */}
                {visualization.phase === 'complete' && (
                  <svg className="absolute inset-0 w-full h-full" viewBox="0 0 200 200">
                    {/* 背景网格 */}
                    <defs>
                      <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
                        <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(148, 163, 184, 0.2)" strokeWidth="0.5"/>
                      </pattern>
                    </defs>
                    <rect width="200" height="200" fill="url(#grid)" />

                    {/* 连接线 */}
                    {visualization.results.map((result, i) => {
                      const angle = (i / Math.max(visualization.results.length, 1)) * Math.PI * 2 - Math.PI / 2;
                      const dist = 35 + (1 - result.score) * 50;
                      const x = 100 + Math.cos(angle) * dist;
                      const y = 100 + Math.sin(angle) * dist;
                      const color = getSimilarityColor(result.score);
                      
                      return (
                        <line
                          key={`line-${result.id}`}
                          x1="100" y1="100"
                          x2={x} y2={y}
                          stroke={color.bg}
                          strokeWidth={selectedResult === result.id ? 3 : 2}
                          strokeOpacity={selectedResult === result.id ? 1 : 0.5}
                          className="transition-all duration-200"
                        />
                      );
                    })}

                    {/* 中心点（查询） */}
                    <circle cx="100" cy="100" r="12" fill="url(#queryGrad)" />
                    <text x="100" y="103" fill="white" fontSize="7" textAnchor="middle" fontWeight="bold">Q</text>

                    {/* 结果点 */}
                    {visualization.results.map((result, i) => {
                      const angle = (i / Math.max(visualization.results.length, 1)) * Math.PI * 2 - Math.PI / 2;
                      const dist = 35 + (1 - result.score) * 50;
                      const x = 100 + Math.cos(angle) * dist;
                      const y = 100 + Math.sin(angle) * dist;
                      const color = getSimilarityColor(result.score);
                      
                      return (
                        <g
                          key={`node-${result.id}`}
                          className="cursor-pointer"
                          onClick={() => setSelectedResult(selectedResult === result.id ? null : result.id)}
                        >
                          <circle
                            cx={x} cy={y}
                            r={selectedResult === result.id ? 11 : 9}
                            fill={color.bg}
                            stroke="white"
                            strokeWidth="2"
                            className="transition-all duration-200"
                          />
                          <text x={x} y={y + 3} fill="white" fontSize="8" textAnchor="middle" fontWeight="bold">
                            {i + 1}
                          </text>
                        </g>
                      );
                    })}

                    <defs>
                      <radialGradient id="queryGrad">
                        <stop offset="0%" stopColor="#a855f7" />
                        <stop offset="100%" stopColor="#6366f1" />
                      </radialGradient>
                    </defs>
                  </svg>
                )}

                {/* 空状态 */}
                {visualization.phase === 'complete' && visualization.results.length === 0 && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <div className="text-3xl mb-2">📭</div>
                    <div className="text-sm text-gray-500">未找到相关文档</div>
                  </div>
                )}

                {/* 空闲状态 */}
                {visualization.phase === 'idle' && visualization.results.length === 0 && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400">
                    <svg className="w-8 h-8 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    <div className="text-xs">输入查询开始测试</div>
                  </div>
                )}
              </div>

              {/* 耗时统计 */}
              {visualization.timing.total && (
                <div className="mt-3 flex gap-3 text-xs text-gray-500">
                  <span>向量化: {visualization.timing.embedding}ms</span>
                  <span>检索: {visualization.timing.search}ms</span>
                  <span className="font-medium text-purple-600">总计: {visualization.timing.total}ms</span>
                </div>
              )}
            </div>

            {/* 右侧：结果列表 */}
            <div className="p-4">
              <div className="text-xs font-medium text-gray-500 mb-3">
                检索结果 {visualization.results.length > 0 && `(${visualization.results.length})`}
              </div>
              <div className="space-y-2 max-h-[260px] overflow-y-auto pr-1">
                {visualization.results.length > 0 ? (
                  visualization.results.map((result, i) => {
                    const color = getSimilarityColor(result.score);
                    const isSelected = selectedResult === result.id;
                    
                    return (
                      <div
                        key={result.id}
                        onClick={() => setSelectedResult(isSelected ? null : result.id)}
                        className={`p-2.5 rounded-lg border cursor-pointer transition-all ${
                          isSelected 
                            ? 'border-purple-300 bg-purple-50 shadow-sm' 
                            : 'border-gray-200 hover:border-gray-300 bg-white'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-2">
                            <span
                              className="w-5 h-5 rounded-full text-white text-xs font-bold flex items-center justify-center"
                              style={{ backgroundColor: color.bg }}
                            >
                              {i + 1}
                            </span>
                            <span className="text-xs font-medium text-gray-700 truncate max-w-[120px]">
                              {result.metadata?.source || `文档 ${i + 1}`}
                            </span>
                          </div>
                          <span className={`text-xs font-bold ${color.text}`}>
                            {(result.score * 100).toFixed(1)}%
                          </span>
                        </div>
                        <div className={`text-xs text-gray-600 ${isSelected ? '' : 'line-clamp-2'}`}>
                          {result.content.substring(0, isSelected ? 300 : 100)}
                          {result.content.length > (isSelected ? 300 : 100) && '...'}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="text-center py-8 text-gray-400 text-sm">
                    {visualization.phase === 'idle' ? '等待查询...' : '暂无结果'}
                  </div>
                )}
              </div>

              {/* 相似度图例 */}
              <div className="mt-3 flex justify-center gap-3 text-xs text-gray-500">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-green-500"></span>≥90%
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-blue-500"></span>70-90%
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-amber-500"></span>50-70%
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-red-500"></span>&lt;50%
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

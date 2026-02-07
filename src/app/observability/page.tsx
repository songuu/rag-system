'use client';

import { useState, useEffect } from 'react';
import { ArrowLeft, BarChart3, Clock, CheckCircle, Coins, RefreshCw, Trash2, ThumbsUp, ThumbsDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';

interface Trace {
  id: string;
  name: string;
  startTime: string;
  endTime?: string;
  status: 'PENDING' | 'SUCCESS' | 'ERROR';
  input?: any;
  output?: any;
  observations: any[];
  scores: any[];
  userId?: string;
  sessionId?: string;
}

interface TraceStats {
  totalTraces: number;
  successRate: number;
  avgDuration: number;
  totalTokens: number;
  avgTokensPerTrace: number;
}

export default function ObservabilityPage() {
  const [traces, setTraces] = useState<Trace[]>([]);
  const [stats, setStats] = useState<TraceStats>({
    totalTraces: 0,
    successRate: 0,
    avgDuration: 0,
    totalTokens: 0,
    avgTokensPerTrace: 0
  });
  const [selectedTrace, setSelectedTrace] = useState<Trace | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const loadTraces = async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/traces');
      const data = await response.json();
      
      if (data.success) {
        setTraces(data.traces);
        setStats(data.stats);
      }
    } catch (error) {
      console.error('加载 Traces 失败:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const clearTraces = async () => {
    if (!confirm('确定要清除所有 Traces 数据吗？此操作不可撤销。')) {
      return;
    }

    try {
      const response = await fetch('/api/traces', {
        method: 'DELETE'
      });
      
      if (response.ok) {
        setTraces([]);
        setStats({
          totalTraces: 0,
          successRate: 0,
          avgDuration: 0,
          totalTokens: 0,
          avgTokensPerTrace: 0
        });
        setSelectedTrace(null);
      }
    } catch (error) {
      console.error('清除 Traces 失败:', error);
    }
  };

  const addFeedback = async (traceId: string, isPositive: boolean) => {
    try {
      await fetch(`/api/traces/${traceId}/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          score: isPositive,
          comment: isPositive ? '用户认为有用' : '用户认为无用'
        }),
      });
      
      // 重新加载数据
      loadTraces();
    } catch (error) {
      console.error('添加反馈失败:', error);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'SUCCESS':
        return 'bg-green-100 text-green-800 border-green-200';
      case 'ERROR':
        return 'bg-red-100 text-red-800 border-red-200';
      case 'PENDING':
        return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const formatDuration = (startTime: string, endTime?: string) => {
    if (!endTime) return '进行中';
    const duration = new Date(endTime).getTime() - new Date(startTime).getTime();
    return `${duration}ms`;
  };

  const getTotalTokens = (observations: any[]) => {
    return observations
      .filter(obs => obs.type === 'GENERATION')
      .reduce((sum, gen) => sum + (gen.usage?.totalTokens || 0), 0);
  };

  useEffect(() => {
    loadTraces();
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
      {/* 顶部导航 */}
      <nav className="bg-white/80 backdrop-blur-md border-b border-slate-200 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex items-center">
              <Link href="/">
                <Button variant="ghost" size="sm" className="mr-4">
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  返回主页
                </Button>
              </Link>
              <BarChart3 className="h-8 w-8 text-blue-600 mr-3" />
              <h1 className="text-xl font-bold text-slate-900">可观测性仪表盘</h1>
            </div>
            <div className="flex items-center space-x-4">
              <Button onClick={loadTraces} disabled={isLoading} size="sm">
                <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
                刷新
              </Button>
              <Button onClick={clearTraces} variant="destructive" size="sm">
                <Trash2 className="h-4 w-4 mr-2" />
                清除数据
              </Button>
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* 统计卡片 */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <Card className="bg-gradient-to-r from-purple-500 to-pink-500 text-white border-0">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-purple-100 text-sm">总 Traces</p>
                  <p className="text-2xl font-bold">{stats.totalTraces}</p>
                </div>
                <BarChart3 className="h-8 w-8 text-purple-200" />
              </div>
            </CardContent>
          </Card>

          <Card className="bg-gradient-to-r from-blue-500 to-cyan-500 text-white border-0">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-blue-100 text-sm">成功率</p>
                  <p className="text-2xl font-bold">{(stats.successRate * 100).toFixed(1)}%</p>
                </div>
                <CheckCircle className="h-8 w-8 text-blue-200" />
              </div>
            </CardContent>
          </Card>

          <Card className="bg-gradient-to-r from-green-500 to-teal-500 text-white border-0">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-green-100 text-sm">平均耗时</p>
                  <p className="text-2xl font-bold">{Math.round(stats.avgDuration)}ms</p>
                </div>
                <Clock className="h-8 w-8 text-green-200" />
              </div>
            </CardContent>
          </Card>

          <Card className="bg-gradient-to-r from-orange-500 to-red-500 text-white border-0">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-orange-100 text-sm">总 Tokens</p>
                  <p className="text-2xl font-bold">{stats.totalTokens}</p>
                </div>
                <Coins className="h-8 w-8 text-orange-200" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 主要内容区域 */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Traces 列表 */}
          <div className="lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center">
                  <BarChart3 className="h-5 w-5 mr-2" />
                  最近的 Traces
                </CardTitle>
                <CardDescription>
                  点击 Trace 查看详细信息
                </CardDescription>
              </CardHeader>
              <CardContent>
                {traces.length === 0 ? (
                  <div className="text-center text-slate-500 py-12">
                    <BarChart3 className="h-12 w-12 mx-auto mb-4 text-slate-300" />
                    <p>暂无 Traces 数据</p>
                    <p className="text-sm">开始提问以生成 Traces</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {traces
                      .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())
                      .map((trace) => (
                        <div
                          key={trace.id}
                          className={`border rounded-lg p-4 cursor-pointer transition-colors hover:bg-slate-50 ${
                            selectedTrace?.id === trace.id ? 'ring-2 ring-blue-500 bg-blue-50' : ''
                          }`}
                          onClick={() => setSelectedTrace(trace)}
                        >
                          <div className="flex items-start justify-between mb-2">
                            <div className="flex-1">
                              <div className="flex items-center space-x-2 mb-1">
                                <h3 className="font-medium text-slate-900">{trace.name}</h3>
                                <Badge className={getStatusColor(trace.status)}>
                                  {trace.status}
                                </Badge>
                              </div>
                              <p className="text-sm text-slate-600 truncate">
                                {trace.input?.question || 'No question'}
                              </p>
                            </div>
                            <div className="text-right text-sm text-slate-500">
                              <div>{new Date(trace.startTime).toLocaleTimeString()}</div>
                              <div>{formatDuration(trace.startTime, trace.endTime)}</div>
                            </div>
                          </div>
                          
                          <div className="flex items-center justify-between text-xs text-slate-500">
                            <div className="flex items-center space-x-4">
                              <span>{trace.observations.length} observations</span>
                              <span>{getTotalTokens(trace.observations)} tokens</span>
                              {trace.scores.length > 0 && (
                                <span>{trace.scores.length} scores</span>
                              )}
                            </div>
                            <div className="flex items-center space-x-2">
                              {trace.userId && (
                                <span>User: {trace.userId}</span>
                              )}
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 w-6 p-0"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  addFeedback(trace.id, true);
                                }}
                              >
                                <ThumbsUp className="h-3 w-3" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 w-6 p-0"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  addFeedback(trace.id, false);
                                }}
                              >
                                <ThumbsDown className="h-3 w-3" />
                              </Button>
                            </div>
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* 详情面板 */}
          <div className="lg:col-span-1">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center">
                  <BarChart3 className="h-5 w-5 mr-2" />
                  Trace 详情
                </CardTitle>
              </CardHeader>
              <CardContent>
                {selectedTrace ? (
                  <div className="space-y-4">
                    {/* 基本信息 */}
                    <div className="bg-slate-50 rounded-lg p-4">
                      <h4 className="font-semibold text-slate-900 mb-3">基本信息</h4>
                      <div className="space-y-2 text-sm">
                        <div>
                          <span className="text-slate-500">Trace ID:</span>
                          <div className="font-mono text-xs bg-white px-2 py-1 rounded mt-1 break-all">
                            {selectedTrace.id}
                          </div>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-500">状态:</span>
                          <Badge className={getStatusColor(selectedTrace.status)}>
                            {selectedTrace.status}
                          </Badge>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-500">耗时:</span>
                          <span>{formatDuration(selectedTrace.startTime, selectedTrace.endTime)}</span>
                        </div>
                      </div>
                    </div>

                    {/* Observations */}
                    <div className="bg-blue-50 rounded-lg p-4">
                      <h4 className="font-semibold text-slate-900 mb-3">
                        Observations ({selectedTrace.observations.length})
                      </h4>
                      <div className="space-y-2">
                        {selectedTrace.observations.map((obs, index) => (
                          <div key={index} className="bg-white rounded p-2 text-sm">
                            <div className="flex items-center justify-between">
                              <span className="font-medium">{obs.name}</span>
                              <Badge variant="outline" className="text-xs">
                                {obs.type}
                              </Badge>
                            </div>
                            {obs.usage && (
                              <div className="text-xs text-slate-500 mt-1">
                                Tokens: {obs.usage.totalTokens}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* 评分 */}
                    {selectedTrace.scores.length > 0 && (
                      <div className="bg-yellow-50 rounded-lg p-4">
                        <h4 className="font-semibold text-slate-900 mb-3">
                          评分 ({selectedTrace.scores.length})
                        </h4>
                        <div className="space-y-2">
                          {selectedTrace.scores.map((score, index) => (
                            <div key={index} className="bg-white rounded p-2 text-sm">
                              <div className="flex items-center justify-between">
                                <span className="font-medium">{score.name}</span>
                                <Badge variant="outline">{score.source}</Badge>
                              </div>
                              <div className="mt-1">
                                <span className="text-lg font-bold text-blue-600">
                                  {typeof score.value === 'boolean' 
                                    ? (score.value ? '👍' : '👎')
                                    : score.value
                                  }
                                </span>
                                {score.comment && (
                                  <p className="text-slate-600 mt-1">{score.comment}</p>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-center text-slate-500 py-12">
                    <BarChart3 className="h-12 w-12 mx-auto mb-4 text-slate-300" />
                    <p>点击 Trace 查看详情</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
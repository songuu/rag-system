'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';

interface SimulationPost {
  id: string;
  platform: string;
  round: number;
  author_name: string;
  author_type: string;
  action: string;
  content: string;
  likes: number;
  replies_count: number;
  reposts: number;
  sentiment: 'positive' | 'neutral' | 'negative';
  topics: string[];
  timestamp: string;
}

interface Step3Props {
  simulationId: string;
  onComplete: () => void;
}

export default function Step3Simulation({ simulationId, onComplete }: Step3Props) {
  const [status, setStatus] = useState<string>('created');
  const [currentRound, setCurrentRound] = useState(0);
  const [totalRounds, setTotalRounds] = useState(0);
  const [posts, setPosts] = useState<SimulationPost[]>([]);
  const [activePlatform, setActivePlatform] = useState<'all' | 'twitter' | 'reddit'>('all');
  const [sentimentDist, setSentimentDist] = useState({ positive: 0, neutral: 0, negative: 0 });
  const [hotTopics, setHotTopics] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // 自动滚动
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [posts]);

  // 启动模拟
  const startSimulation = async () => {
    setError(null);

    try {
      const response = await fetch(`/api/mirofish/simulation/${simulationId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      });

      const data = await response.json();
      if (!data.success) throw new Error(data.error);

      setStatus('running');
      connectSSE();
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动失败');
    }
  };

  // 连接 SSE
  const connectSSE = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource(`/api/mirofish/simulation/${simulationId}/stream`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case 'connected':
            setStatus(data.data.status);
            setCurrentRound(data.data.current_round || 0);
            break;

          case 'round_start':
            setCurrentRound(data.data.round);
            setTotalRounds(data.data.total_rounds);
            break;

          case 'post_created':
            if (data.data.post) {
              setPosts(prev => [...prev, data.data.post]);
            }
            break;

          case 'round_end':
            if (data.data.stats) {
              setSentimentDist(data.data.stats.sentiment_distribution);
              setHotTopics(data.data.stats.hot_topics || []);
            }
            break;

          case 'simulation_complete':
            setStatus('completed');
            es.close();
            break;

          case 'simulation_error':
            setStatus('failed');
            setError(data.data.error || '模拟运行失败');
            es.close();
            break;
        }
      } catch {
        // 忽略解析错误
      }
    };

    es.onerror = () => {
      // 重连或关闭
      es.close();
    };
  }, [simulationId]);

  // 停止模拟
  const stopSimulation = async () => {
    try {
      await fetch(`/api/mirofish/simulation/${simulationId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
      setStatus('paused');
      eventSourceRef.current?.close();
    } catch {
      // 忽略
    }
  };

  // 清理 SSE
  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  // 获取初始状态
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const response = await fetch(`/api/mirofish/simulation/${simulationId}`);
        const data = await response.json();
        if (data.success && data.simulation) {
          setStatus(data.simulation.status);
          setCurrentRound(data.simulation.current_round);
          setTotalRounds(data.simulation.config?.round_count || 0);

          if (data.simulation.status === 'running') {
            connectSSE();
          }
        }
      } catch {
        // 忽略
      }
    };
    fetchStatus();
  }, [simulationId, connectSSE]);

  // 过滤帖子
  const filteredPosts = activePlatform === 'all'
    ? posts
    : posts.filter(p => p.platform === activePlatform);

  const progressPercent = totalRounds > 0 ? (currentRound / totalRounds) * 100 : 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
      {/* 左侧控制 */}
      <div className="space-y-4">
        {/* 状态 */}
        <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
          <h3 className="text-sm font-semibold text-white mb-3">模拟状态</h3>

          <div className="mb-3">
            <span className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-sm ${
              status === 'running' ? 'bg-green-500/20 text-green-400' :
              status === 'completed' ? 'bg-blue-500/20 text-blue-400' :
              status === 'failed' ? 'bg-red-500/20 text-red-400' :
              'bg-slate-600/50 text-slate-400'
            }`}>
              <span className={`w-2 h-2 rounded-full ${
                status === 'running' ? 'bg-green-400 animate-pulse' :
                status === 'completed' ? 'bg-blue-400' :
                status === 'failed' ? 'bg-red-400' : 'bg-slate-400'
              }`} />
              {status === 'running' ? '运行中' :
               status === 'completed' ? '已完成' :
               status === 'failed' ? '失败' :
               status === 'paused' ? '已暂停' : '就绪'}
            </span>
          </div>

          {totalRounds > 0 && (
            <div className="mb-3">
              <div className="flex justify-between text-xs text-slate-400 mb-1">
                <span>第 {currentRound}/{totalRounds} 轮</span>
                <span>{Math.round(progressPercent)}%</span>
              </div>
              <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-purple-500 to-pink-500 transition-all duration-500"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}

          {/* 控制按钮 */}
          <div className="flex gap-2">
            {status === 'created' || status === 'paused' ? (
              <button
                onClick={startSimulation}
                className="flex-1 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-500 font-medium text-sm"
              >
                {status === 'paused' ? '继续' : '启动模拟'}
              </button>
            ) : status === 'running' ? (
              <button
                onClick={stopSimulation}
                className="flex-1 py-2 bg-red-600 text-white rounded-lg hover:bg-red-500 font-medium text-sm"
              >
                停止
              </button>
            ) : null}
          </div>
        </div>

        {/* 统计 */}
        <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
          <h3 className="text-sm font-semibold text-white mb-3">实时统计</h3>
          <div className="grid grid-cols-2 gap-2 text-center">
            <div className="bg-slate-700/50 rounded-lg p-2">
              <div className="text-lg font-bold text-white">{posts.length}</div>
              <div className="text-xs text-slate-400">总消息</div>
            </div>
            <div className="bg-slate-700/50 rounded-lg p-2">
              <div className="text-lg font-bold text-white">
                {new Set(posts.map(p => p.author_name)).size}
              </div>
              <div className="text-xs text-slate-400">活跃Agent</div>
            </div>
          </div>

          {/* 情感分布 */}
          {(sentimentDist.positive + sentimentDist.neutral + sentimentDist.negative) > 0 && (
            <div className="mt-3 space-y-1">
              {[
                { label: '正面', key: 'positive' as const, color: 'bg-green-500' },
                { label: '中性', key: 'neutral' as const, color: 'bg-gray-500' },
                { label: '负面', key: 'negative' as const, color: 'bg-red-500' },
              ].map(item => {
                const total = sentimentDist.positive + sentimentDist.neutral + sentimentDist.negative;
                const pct = total > 0 ? Math.round(sentimentDist[item.key] / total * 100) : 0;
                return (
                  <div key={item.key}>
                    <div className="flex justify-between text-xs text-slate-400">
                      <span>{item.label}</span>
                      <span>{pct}%</span>
                    </div>
                    <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                      <div className={`h-full ${item.color}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 热门话题 */}
        {hotTopics.length > 0 && (
          <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
            <h3 className="text-sm font-semibold text-white mb-2">热门话题</h3>
            <div className="flex flex-wrap gap-1">
              {hotTopics.map((topic, i) => (
                <span key={i} className="px-2 py-0.5 bg-purple-600/20 text-purple-300 rounded text-xs">
                  {topic}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* 完成按钮 */}
        {status === 'completed' && (
          <button
            onClick={onComplete}
            className="w-full py-3 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-lg font-medium hover:from-purple-500 hover:to-pink-500"
          >
            下一步: 生成报告 →
          </button>
        )}

        {error && (
          <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-3 text-red-400 text-sm">{error}</div>
        )}
      </div>

      {/* 消息流 */}
      <div className="lg:col-span-3">
        {/* 平台切换 */}
        <div className="flex gap-2 mb-4">
          {(['all', 'twitter', 'reddit'] as const).map(p => (
            <button
              key={p}
              onClick={() => setActivePlatform(p)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activePlatform === p
                  ? 'bg-purple-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              {p === 'all' ? '全部' : p === 'twitter' ? 'Twitter' : 'Reddit'}
              {p !== 'all' && ` (${posts.filter(post => post.platform === p).length})`}
            </button>
          ))}
        </div>

        {/* 消息列表 */}
        <div className="bg-slate-800/50 rounded-xl border border-slate-700 h-[600px] flex flex-col">
          <div className="flex-1 overflow-auto p-4 space-y-3">
            {filteredPosts.length > 0 ? (
              filteredPosts.map(msg => (
                <div
                  key={msg.id}
                  className={`p-3 rounded-lg border ${
                    msg.sentiment === 'positive'
                      ? 'bg-green-500/5 border-green-500/20'
                      : msg.sentiment === 'negative'
                      ? 'bg-red-500/5 border-red-500/20'
                      : 'bg-slate-700/30 border-slate-600/50'
                  }`}
                >
                  <div className="flex justify-between items-start mb-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-white text-sm">{msg.author_name}</span>
                      <span className="px-1.5 py-0.5 bg-slate-600 text-slate-300 rounded text-xs">{msg.author_type}</span>
                      <span className={`px-1.5 py-0.5 rounded text-xs ${
                        msg.platform === 'twitter' ? 'bg-blue-500/20 text-blue-300' : 'bg-orange-500/20 text-orange-300'
                      }`}>
                        {msg.platform}
                      </span>
                      {msg.action !== 'post' && (
                        <span className="text-xs text-slate-500">{msg.action}</span>
                      )}
                    </div>
                    <span className="text-xs text-slate-500">R{msg.round}</span>
                  </div>
                  <p className="text-sm text-slate-300">{msg.content}</p>
                  <div className="flex gap-3 mt-2 text-xs text-slate-500">
                    <span>{msg.likes} likes</span>
                    <span>{msg.replies_count} replies</span>
                    {msg.reposts > 0 && <span>{msg.reposts} reposts</span>}
                    {msg.topics.length > 0 && (
                      <span className="text-purple-400">#{msg.topics[0]}</span>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <div className="text-center py-20 text-slate-500">
                <div className="text-4xl mb-2">3</div>
                <p className="text-sm">启动模拟后消息将实时显示</p>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

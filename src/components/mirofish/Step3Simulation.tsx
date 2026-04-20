'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';

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

const SENTIMENT_CONFIG = {
  positive: { label: '正面', color: 'emerald', dotClass: 'bg-emerald-400', bgClass: 'bg-emerald-500/10 border-emerald-500/20', textClass: 'text-emerald-300', barClass: 'bg-emerald-500' },
  neutral: { label: '中性', color: 'slate', dotClass: 'bg-white/40', bgClass: 'bg-white/[0.03] border-white/[0.08]', textClass: 'text-white/50', barClass: 'bg-white/30' },
  negative: { label: '负面', color: 'rose', dotClass: 'bg-rose-400', bgClass: 'bg-rose-500/10 border-rose-500/20', textClass: 'text-rose-300', barClass: 'bg-rose-500' },
} as const;

const PLATFORM_CONFIG = {
  twitter: { label: 'Twitter', icon: '𝕏', tagClass: 'bg-blue-500/15 text-blue-300' },
  reddit: { label: 'Reddit', icon: '▲', tagClass: 'bg-orange-500/15 text-orange-300' },
} as const;

function ProgressRing({ percent, size = 120, strokeWidth = 8 }: { percent: number; size?: number; strokeWidth?: number }) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percent / 100) * circumference;

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg className="rotate-[-90deg]" width={size} height={size} role="img" aria-label="Progress ring">
        <title>Progress</title>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.05)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="url(#progressGradient)"
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-700 ease-out"
        />
        <defs>
          <linearGradient id="progressGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#a855f7" />
            <stop offset="100%" stopColor="#7c3aed" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold text-white">{Math.round(percent)}%</span>
        <span className="text-[10px] text-white/40">PROGRESS</span>
      </div>
    </div>
  );
}

function AvatarCircle({ name, sentiment }: { name: string; sentiment: SimulationPost['sentiment'] }) {
  const colors = {
    positive: 'from-emerald-500 to-teal-500',
    neutral: 'from-violet-500 to-purple-500',
    negative: 'from-rose-500 to-pink-500',
  };
  const initial = name.charAt(0).toUpperCase();
  return (
    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br ${colors[sentiment]} text-xs font-bold text-white shadow-lg`}>
      {initial}
    </div>
  );
}

export default function Step3Simulation({ simulationId, onComplete }: Step3Props) {
  const [status, setStatus] = useState<string>('created');
  const [currentRound, setCurrentRound] = useState(0);
  const [totalRounds, setTotalRounds] = useState(0);
  const [posts, setPosts] = useState<SimulationPost[]>([]);
  const [activePlatform, setActivePlatform] = useState<'all' | 'twitter' | 'reddit'>('all');
  const [activeRound, setActiveRound] = useState<number | null>(null);
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
  const filteredPosts = useMemo(() => {
    let result = posts;
    if (activePlatform !== 'all') {
      result = result.filter(p => p.platform === activePlatform);
    }
    if (activeRound !== null) {
      result = result.filter(p => p.round === activeRound);
    }
    return result;
  }, [posts, activePlatform, activeRound]);

  // 统计数据
  const stats = useMemo(() => {
    const totalLikes = posts.reduce((sum, p) => sum + p.likes, 0);
    const totalReplies = posts.reduce((sum, p) => sum + p.replies_count, 0);
    const uniqueAuthors = new Set(posts.map(p => p.author_name)).size;
    return { totalLikes, totalReplies, uniqueAuthors };
  }, [posts]);

  // 可用轮次列表
  const availableRounds = useMemo(() => {
    const rounds = new Set(posts.map(p => p.round));
    return Array.from(rounds).sort((a, b) => a - b);
  }, [posts]);

  const progressPercent = totalRounds > 0 ? (currentRound / totalRounds) * 100 : 0;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      {/* 左侧控制面板 */}
      <div className="space-y-5 lg:col-span-2">
        {/* 进度环 + 状态 */}
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-purple-400/70">SIMULATION</div>
              <div className="mt-1 text-sm font-semibold text-white">模拟运行控制</div>
            </div>
            <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-medium ${
              status === 'running' ? 'bg-emerald-500/15 text-emerald-300' :
              status === 'completed' ? 'bg-purple-500/15 text-purple-300' :
              status === 'failed' ? 'bg-rose-500/15 text-rose-300' :
              'bg-white/[0.06] text-white/40'
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full ${
                status === 'running' ? 'bg-emerald-400 animate-pulse' :
                status === 'completed' ? 'bg-purple-400' :
                status === 'failed' ? 'bg-rose-400' : 'bg-white/30'
              }`} />
              {status === 'running' ? '运行中' :
               status === 'completed' ? '已完成' :
               status === 'failed' ? '失败' :
               status === 'paused' ? '已暂停' : '就绪'}
            </span>
          </div>

          {/* 进度环 */}
          <div className="flex justify-center py-4">
            {totalRounds > 0 ? (
              <ProgressRing percent={progressPercent} />
            ) : (
              <div className="relative flex h-[120px] w-[120px] items-center justify-center">
                <div className="absolute inset-0 animate-spin rounded-full border-2 border-dashed border-purple-500/20" style={{ animationDuration: '8s' }} />
                <div className="absolute inset-3 animate-spin rounded-full border border-dashed border-violet-500/15" style={{ animationDuration: '12s', animationDirection: 'reverse' }} />
                <span className="text-3xl">🧪</span>
              </div>
            )}
          </div>

          {totalRounds > 0 && (
            <div className="mt-2 text-center">
              <span className="text-[11px] text-white/40">
                第 <span className="font-mono text-white/70">{currentRound}</span> / <span className="font-mono text-white/70">{totalRounds}</span> 轮
              </span>
            </div>
          )}

          {/* 控制按钮 */}
          <div className="mt-5 flex gap-3">
            {(status === 'created' || status === 'paused') && (
              <button
                type="button"
                onClick={startSimulation}
                className="flex-1 rounded-xl bg-gradient-to-r from-purple-600 to-violet-600 py-3 text-sm font-semibold text-white shadow-lg shadow-purple-500/20 transition-all hover:shadow-purple-500/30 hover:brightness-110 active:scale-[0.98]"
              >
                {status === 'paused' ? '继续模拟' : '启动模拟'}
              </button>
            )}
            {status === 'running' && (
              <button
                type="button"
                onClick={stopSimulation}
                className="flex-1 rounded-xl border border-rose-500/30 bg-rose-500/10 py-3 text-sm font-semibold text-rose-300 transition-all hover:bg-rose-500/20 active:scale-[0.98]"
              >
                停止模拟
              </button>
            )}
          </div>
        </div>

        {/* 实时统计面板 */}
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
          <div className="mb-4 text-[10px] font-semibold uppercase tracking-widest text-white/30">LIVE STATS</div>
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: '总帖子', value: posts.length, icon: '📝' },
              { label: '活跃Agent', value: stats.uniqueAuthors, icon: '🤖' },
              { label: '总点赞', value: stats.totalLikes, icon: '❤️' },
              { label: '总回复', value: stats.totalReplies, icon: '💬' },
            ].map(item => (
              <div
                key={item.label}
                className="group rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 transition-all hover:border-purple-500/20 hover:bg-purple-500/[0.04]"
              >
                <div className="mb-1 text-lg">{item.icon}</div>
                <div className="text-lg font-bold text-white">{item.value}</div>
                <div className="text-[10px] text-white/30">{item.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* 情绪分布 */}
        {(sentimentDist.positive + sentimentDist.neutral + sentimentDist.negative) > 0 && (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
            <div className="mb-4 text-[10px] font-semibold uppercase tracking-widest text-white/30">SENTIMENT</div>
            <div className="space-y-3">
              {(['positive', 'neutral', 'negative'] as const).map(key => {
                const total = sentimentDist.positive + sentimentDist.neutral + sentimentDist.negative;
                const pct = total > 0 ? Math.round(sentimentDist[key] / total * 100) : 0;
                const cfg = SENTIMENT_CONFIG[key];
                return (
                  <div key={key}>
                    <div className="mb-1.5 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`h-2 w-2 rounded-full ${cfg.dotClass}`} />
                        <span className="text-[11px] text-white/50">{cfg.label}</span>
                      </div>
                      <span className={`text-xs font-mono font-medium ${cfg.textClass}`}>{pct}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
                      <div
                        className={`h-full rounded-full ${cfg.barClass} transition-all duration-700`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 热门话题 */}
        {hotTopics.length > 0 && (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
            <div className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-white/30">HOT TOPICS</div>
            <div className="flex flex-wrap gap-2">
              {hotTopics.map(topic => (
                <span
                  key={topic}
                  className="rounded-lg bg-purple-500/10 px-2.5 py-1 text-[11px] font-medium text-purple-300 transition-colors hover:bg-purple-500/20"
                >
                  #{topic}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* 完成按钮 */}
        {status === 'completed' && (
          <div className="rounded-xl bg-gradient-to-r from-purple-600 to-violet-600 p-px">
            <button
              type="button"
              onClick={onComplete}
              className="w-full rounded-[11px] bg-[#0a0a1a] px-4 py-3.5 text-sm font-semibold text-white transition-all hover:bg-[#0a0a1a]/80"
            >
              下一步: 生成报告 →
            </button>
          </div>
        )}

        {/* 错误 */}
        {error && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4">
            <div className="flex items-start gap-2">
              <span className="text-rose-400">⚠</span>
              <span className="text-[12px] leading-relaxed text-rose-300">{error}</span>
            </div>
          </div>
        )}
      </div>

      {/* 右侧消息流 */}
      <div className="lg:col-span-3">
        {/* 筛选栏 */}
        <div className="mb-4 flex items-center gap-3">
          {/* 平台筛选 */}
          <div className="flex gap-1.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-1">
            {(['all', 'twitter', 'reddit'] as const).map(p => (
              <button
                type="button"
                key={p}
                onClick={() => setActivePlatform(p)}
                className={`rounded-lg px-3 py-1.5 text-[11px] font-medium transition-all ${
                  activePlatform === p
                    ? 'bg-purple-500/20 text-purple-300 shadow-sm shadow-purple-500/10'
                    : 'text-white/40 hover:text-white/60'
                }`}
              >
                {p === 'all' ? '全部' : `${PLATFORM_CONFIG[p]?.icon || ''} ${PLATFORM_CONFIG[p]?.label || p}`}
                {p !== 'all' && (
                  <span className="ml-1 font-mono text-[10px] opacity-60">
                    {posts.filter(post => post.platform === p).length}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* 轮次筛选 */}
          {availableRounds.length > 1 && (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setActiveRound(null)}
                className={`rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-all ${
                  activeRound === null
                    ? 'bg-violet-500/20 text-violet-300'
                    : 'text-white/30 hover:text-white/50'
                }`}
              >
                全轮
              </button>
              <div className="flex gap-1 overflow-x-auto">
                {availableRounds.slice(-8).map(round => (
                  <button
                    type="button"
                    key={`round-${round}`}
                    onClick={() => setActiveRound(activeRound === round ? null : round)}
                    className={`rounded-lg px-2 py-1.5 text-[10px] font-mono transition-all ${
                      activeRound === round
                        ? 'bg-violet-500/20 text-violet-300'
                        : 'text-white/20 hover:text-white/40'
                    }`}
                  >
                    R{round}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 消息列表 */}
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm">
          <div className="h-[620px] overflow-y-auto p-4">
            {filteredPosts.length > 0 ? (
              <div className="space-y-3">
                {filteredPosts.map(msg => {
                  const sentimentCfg = SENTIMENT_CONFIG[msg.sentiment];
                  const platformCfg = PLATFORM_CONFIG[msg.platform as keyof typeof PLATFORM_CONFIG];
                  return (
                    <div
                      key={msg.id}
                      className={`group rounded-xl border p-4 transition-all hover:scale-[1.01] hover:shadow-lg hover:shadow-black/20 ${sentimentCfg.bgClass}`}
                    >
                      <div className="flex items-start gap-3">
                        <AvatarCircle name={msg.author_name} sentiment={msg.sentiment} />
                        <div className="min-w-0 flex-1">
                          {/* 头部信息 */}
                          <div className="mb-1.5 flex items-center gap-2">
                            <span className="text-sm font-semibold text-white">{msg.author_name}</span>
                            <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-white/30">
                              {msg.author_type}
                            </span>
                            {platformCfg && (
                              <span className={`rounded-md px-1.5 py-0.5 text-[10px] ${platformCfg.tagClass}`}>
                                {platformCfg.icon}
                              </span>
                            )}
                            {msg.action !== 'post' && (
                              <span className="rounded-md bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-300">
                                {msg.action}
                              </span>
                            )}
                            <span className="ml-auto text-[10px] font-mono text-white/20">R{msg.round}</span>
                          </div>

                          {/* 内容 */}
                          <p className="text-[13px] leading-relaxed text-white/70">{msg.content}</p>

                          {/* 底部交互数据 */}
                          <div className="mt-3 flex items-center gap-4">
                            <span className="flex items-center gap-1 text-[11px] text-white/25 transition-colors group-hover:text-white/40">
                              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} role="img" aria-label="Likes">
                                <title>Likes</title>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
                              </svg>
                              {msg.likes}
                            </span>
                            <span className="flex items-center gap-1 text-[11px] text-white/25 transition-colors group-hover:text-white/40">
                              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} role="img" aria-label="Replies">
                                <title>Replies</title>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12c0 2.104.859 4.023 2.273 5.48.432.447.74 1.04.586 1.641a4.483 4.483 0 01-.923 1.785A5.969 5.969 0 006 21c1.282 0 2.47-.402 3.445-1.087.81.22 1.668.337 2.555.337z" />
                              </svg>
                              {msg.replies_count}
                            </span>
                            {msg.reposts > 0 && (
                              <span className="flex items-center gap-1 text-[11px] text-white/25 transition-colors group-hover:text-white/40">
                                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} role="img" aria-label="Reposts">
                                  <title>Reposts</title>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3l-3 3" />
                                </svg>
                                {msg.reposts}
                              </span>
                            )}
                            {msg.topics.length > 0 && (
                              <span className="ml-auto text-[10px] text-purple-400/60">
                                #{msg.topics[0]}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center">
                <div className="relative mb-6">
                  <div className="absolute inset-0 animate-spin rounded-full border-2 border-dashed border-purple-500/20" style={{ animationDuration: '10s', width: 100, height: 100, top: -10, left: -10 }} />
                  <div className="absolute animate-spin rounded-full border border-dashed border-violet-500/10" style={{ animationDuration: '15s', animationDirection: 'reverse', width: 120, height: 120, top: -20, left: -20 }} />
                  <span className="relative text-5xl">🌐</span>
                </div>
                <p className="text-sm text-white/30">启动模拟后消息将实时显示</p>
                <p className="mt-1 text-[11px] text-white/15">Agent 将在虚拟社交平台上互动</p>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* 底部统计条 */}
        {posts.length > 0 && (
          <div className="mt-3 flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-5 py-3">
            <div className="flex items-center gap-4">
              <span className="text-[11px] text-white/30">
                显示 <span className="font-mono text-white/50">{filteredPosts.length}</span> / {posts.length} 条
              </span>
              {activeRound !== null && (
                <button
                  type="button"
                  onClick={() => setActiveRound(null)}
                  className="text-[11px] text-purple-400 hover:text-purple-300"
                >
                  清除轮次筛选
                </button>
              )}
            </div>
            <div className="flex items-center gap-3">
              {(['positive', 'neutral', 'negative'] as const).map(key => {
                const count = posts.filter(p => p.sentiment === key).length;
                const cfg = SENTIMENT_CONFIG[key];
                return (
                  <span key={key} className="flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 rounded-full ${cfg.dotClass}`} />
                    <span className="text-[10px] font-mono text-white/30">{count}</span>
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';

// ==================== 类型定义 ====================

interface SimulationConfig {
  roundCount: number;
  postsPerRound: number;
  timeInterval: number;
  temperature: number;
  seedTopics: string[];
}

interface SimulationMessage {
  id: string;
  timestamp: string;
  author: string;
  authorType: string;
  content: string;
  likes: number;
  replies: number;
  sentiment: 'positive' | 'neutral' | 'negative';
}

interface SimulationResult {
  rounds: number;
  totalPosts: number;
  participants: number;
  hotTopics: string[];
  sentimentDistribution: {
    positive: number;
    neutral: number;
    negative: number;
  };
  timeline: SimulationMessage[];
}

export default function SimulationPage() {
  const [config, setConfig] = useState<SimulationConfig>({
    roundCount: 10,
    postsPerRound: 5,
    timeInterval: 3,
    temperature: 0.7,
    seedTopics: [],
  });

  const [seedTopicInput, setSeedTopicInput] = useState('');
  const [simulationRunning, setSimulationRunning] = useState(false);
  const [currentRound, setCurrentRound] = useState(0);
  const [messages, setMessages] = useState<SimulationMessage[]>([]);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 自动滚动到最新消息
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 添加种子话题
  const addSeedTopic = () => {
    if (!seedTopicInput.trim()) return;
    if (config.seedTopics.includes(seedTopicInput.trim())) return;

    setConfig(prev => ({
      ...prev,
      seedTopics: [...prev.seedTopics, seedTopicInput.trim()],
    }));
    setSeedTopicInput('');
  };

  // 移除种子话题
  const removeSeedTopic = (topic: string) => {
    setConfig(prev => ({
      ...prev,
      seedTopics: prev.seedTopics.filter(t => t !== topic),
    }));
  };

  // 开始模拟
  const startSimulation = async () => {
    if (config.seedTopics.length === 0) {
      setError('请至少添加一个种子话题');
      return;
    }

    setError(null);
    setSimulationRunning(true);
    setCurrentRound(0);
    setMessages([]);
    setResult(null);

    // 模拟运行
    try {
      for (let round = 1; round <= config.roundCount; round++) {
        if (!simulationRunning) break;

        setCurrentRound(round);

        // 模拟生成消息
        const roundMessages = generateMockMessages(round, config.postsPerRound);
        setMessages(prev => [...prev, ...roundMessages]);

        // 等待间隔
        await new Promise(resolve =>
          setTimeout(resolve, config.timeInterval * 1000)
        );
      }

      // 模拟完成
      setSimulationRunning(false);
      setResult({
        rounds: config.roundCount,
        totalPosts: config.roundCount * config.postsPerRound,
        participants: Math.floor(Math.random() * 10) + 5,
        hotTopics: config.seedTopics.slice(0, 3),
        sentimentDistribution: {
          positive: Math.floor(Math.random() * 30) + 20,
          neutral: Math.floor(Math.random() * 30) + 30,
          negative: Math.floor(Math.random() * 20) + 20,
        },
        timeline: messages,
      });
    } catch (err) {
      setError('模拟运行失败');
      setSimulationRunning(false);
    }
  };

  // 停止模拟
  const stopSimulation = () => {
    setSimulationRunning(false);
  };

  // 生成模拟消息（模拟）
  const generateMockMessages = (
    round: number,
    count: number
  ): SimulationMessage[] => {
    const authors = [
      { name: '科技爱好者张三', type: '普通用户' },
      { name: '数码评测师', type: '意见领袖' },
      { name: '品牌粉丝', type: '普通用户' },
      { name: '理性分析君', type: '普通用户' },
      { name: '质疑者小明', type: '普通用户' },
    ];

    const contents = [
      '这个产品真的很不错，强烈推荐！',
      '我觉得这里有些问题需要改进...',
      '等一下，让我来分析一下具体情况',
      '支持国产品牌，希望越做越好！',
      '刚看到这个新闻，感觉需要更多证据',
      '作为一名专业人士，我觉得...',
      '说得好，我也这么认为！',
      '不敢苟同，我的看法完全不同',
    ];

    const sentiments: Array<'positive' | 'neutral' | 'negative'> = [
      'positive',
      'neutral',
      'negative',
    ];

    return Array.from({ length: count }, (_, i) => {
      const author = authors[Math.floor(Math.random() * authors.length)];
      return {
        id: `msg_${round}_${i}_${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        author: author.name,
        authorType: author.type,
        content:
          contents[Math.floor(Math.random() * contents.length)] +
          ` [第${round}轮]`,
        likes: Math.floor(Math.random() * 50),
        replies: Math.floor(Math.random() * 20),
        sentiment: sentiments[Math.floor(Math.random() * sentiments.length)],
      };
    });
  };

  // 重置模拟
  const resetSimulation = () => {
    setSimulationRunning(false);
    setCurrentRound(0);
    setMessages([]);
    setResult(null);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
      {/* 顶部导航 */}
      <nav className="bg-slate-900/80 backdrop-blur-sm border-b border-slate-700/50 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-14">
            <div className="flex items-center gap-4">
              <Link href="/mirofish" className="flex items-center gap-2 text-white hover:text-purple-300 transition-colors">
                <span className="text-xl">←</span>
                <span className="text-sm">返回首页</span>
              </Link>
              <div className="h-6 w-px bg-slate-700" />
              <h1 className="text-lg font-semibold text-white flex items-center gap-2">
                <span className="text-2xl">🎮</span>
                模拟运行
              </h1>
            </div>

            {/* 功能模块导航 */}
            <div className="flex items-center gap-2">
              <Link
                href="/mirofish/process"
                className="px-3 py-1 text-sm rounded-lg transition-colors bg-slate-800 text-slate-400 hover:text-white"
              >
                🐟 完整流程
              </Link>
              <Link
                href="/mirofish/ontology"
                className="px-3 py-1 text-sm rounded-lg transition-colors bg-slate-800 text-slate-400 hover:text-white"
              >
                📋 本体
              </Link>
              <Link
                href="/mirofish/entity-extraction"
                className="px-3 py-1 text-sm rounded-lg transition-colors bg-slate-800 text-slate-400 hover:text-white"
              >
                🔍 实体抽取
              </Link>
              <Link
                href="/mirofish/graph-rag"
                className="px-3 py-1 text-sm rounded-lg transition-colors bg-slate-800 text-slate-400 hover:text-white"
              >
                🕸️ GraphRag
              </Link>
              <Link
                href="/mirofish/profile"
                className="px-3 py-1 text-sm rounded-lg transition-colors bg-slate-800 text-slate-400 hover:text-white"
              >
                👤 人设
              </Link>
              <Link
                href="/mirofish/simulation"
                className="px-3 py-1 text-sm rounded-lg transition-colors bg-purple-600 text-white"
              >
                🎮 模拟
              </Link>
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* 左侧配置面板 */}
          <div className="space-y-4">
            {/* 模拟配置 */}
            <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
              <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                ⚙️ 模拟配置
              </h3>

              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">
                    轮次数量
                  </label>
                  <input
                    type="number"
                    value={config.roundCount}
                    onChange={e =>
                      setConfig(prev => ({
                        ...prev,
                        roundCount: parseInt(e.target.value) || 10,
                      }))
                    }
                    disabled={simulationRunning}
                    min={1}
                    max={50}
                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1">
                    每轮发言数
                  </label>
                  <input
                    type="number"
                    value={config.postsPerRound}
                    onChange={e =>
                      setConfig(prev => ({
                        ...prev,
                        postsPerRound: parseInt(e.target.value) || 5,
                      }))
                    }
                    disabled={simulationRunning}
                    min={1}
                    max={20}
                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1">
                    轮次间隔 (秒)
                  </label>
                  <input
                    type="number"
                    value={config.timeInterval}
                    onChange={e =>
                      setConfig(prev => ({
                        ...prev,
                        timeInterval: parseInt(e.target.value) || 3,
                      }))
                    }
                    disabled={simulationRunning}
                    min={1}
                    max={30}
                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1">
                    随机性 (Temperature)
                  </label>
                  <input
                    type="range"
                    value={config.temperature}
                    onChange={e =>
                      setConfig(prev => ({
                        ...prev,
                        temperature: parseFloat(e.target.value),
                      }))
                    }
                    disabled={simulationRunning}
                    min={0.1}
                    max={1.5}
                    step={0.1}
                    className="w-full"
                  />
                  <div className="text-xs text-slate-500 text-right">
                    {config.temperature}
                  </div>
                </div>
              </div>
            </div>

            {/* 种子话题 */}
            <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
              <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                🔥 种子话题
              </h3>

              <div className="flex gap-2 mb-3">
                <input
                  type="text"
                  value={seedTopicInput}
                  onChange={e => setSeedTopicInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addSeedTopic()}
                  placeholder="添加话题..."
                  disabled={simulationRunning}
                  className="flex-1 px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50"
                />
                <button
                  onClick={addSeedTopic}
                  disabled={simulationRunning}
                  className="px-3 py-2 bg-slate-700 text-white rounded-lg hover:bg-slate-600 transition-colors disabled:opacity-50"
                >
                  +
                </button>
              </div>

              <div className="flex flex-wrap gap-1">
                {config.seedTopics.map(topic => (
                  <span
                    key={topic}
                    className="px-2 py-1 bg-purple-600/20 text-purple-300 rounded text-xs flex items-center gap-1"
                  >
                    {topic}
                    <button
                      onClick={() => removeSeedTopic(topic)}
                      disabled={simulationRunning}
                      className="hover:text-red-400 disabled:opacity-50"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>

            {/* 错误提示 */}
            {error && (
              <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-3 text-red-400 text-sm">
                {error}
              </div>
            )}

            {/* 控制按钮 */}
            <div className="flex gap-2">
              {!simulationRunning ? (
                <button
                  onClick={startSimulation}
                  className="flex-1 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-500 transition-colors font-medium"
                >
                  ▶️ 开始模拟
                </button>
              ) : (
                <button
                  onClick={stopSimulation}
                  className="flex-1 py-3 bg-red-600 text-white rounded-lg hover:bg-red-500 transition-colors font-medium"
                >
                  ⏹️ 停止
                </button>
              )}
              <button
                onClick={resetSimulation}
                className="px-4 py-3 bg-slate-700 text-white rounded-lg hover:bg-slate-600 transition-colors"
              >
                🔄
              </button>
            </div>
          </div>

          {/* 中间消息流 */}
          <div className="lg:col-span-2">
            <div className="bg-slate-800/50 rounded-xl border border-slate-700 h-[600px] flex flex-col">
              <div className="p-4 border-b border-slate-700">
                <div className="flex justify-between items-center">
                  <h3 className="text-sm font-semibold text-white">
                    💬 模拟消息流
                  </h3>
                  {simulationRunning && (
                    <span className="px-2 py-1 bg-green-500/20 text-green-400 rounded text-xs">
                      运行中 · 第 {currentRound}/{config.roundCount} 轮
                    </span>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-auto p-4 space-y-3">
                {messages.length > 0 ? (
                  messages.map(msg => (
                    <div
                      key={msg.id}
                      className={`p-3 rounded-lg ${
                        msg.sentiment === 'positive'
                          ? 'bg-green-500/10 border border-green-500/30'
                          : msg.sentiment === 'negative'
                          ? 'bg-red-500/10 border border-red-500/30'
                          : 'bg-slate-700/50 border border-slate-600'
                      }`}
                    >
                      <div className="flex justify-between items-start mb-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-white text-sm">
                            {msg.author}
                          </span>
                          <span className="px-1.5 py-0.5 bg-slate-600 text-slate-300 rounded text-xs">
                            {msg.authorType}
                          </span>
                        </div>
                        <span className="text-xs text-slate-500">
                          {msg.timestamp}
                        </span>
                      </div>
                      <p className="text-sm text-slate-300">{msg.content}</p>
                      <div className="flex gap-3 mt-2 text-xs text-slate-500">
                        <span>❤️ {msg.likes}</span>
                        <span>💬 {msg.replies}</span>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-12 text-slate-500">
                    <div className="text-4xl mb-2">💬</div>
                    <p className="text-sm">开始模拟后消息将实时显示</p>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>
          </div>

          {/* 右侧结果/状态 */}
          <div>
            {result ? (
              <div className="space-y-4">
                <div className="bg-gradient-to-r from-green-600/20 to-blue-600/20 rounded-xl border border-green-500/30 p-4">
                  <h3 className="text-lg font-semibold text-white mb-3">
                    ✅ 模拟完成
                  </h3>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-slate-700/50 rounded-lg p-2 text-center">
                      <div className="text-xl font-bold text-white">
                        {result.rounds}
                      </div>
                      <div className="text-xs text-slate-400">轮次</div>
                    </div>
                    <div className="bg-slate-700/50 rounded-lg p-2 text-center">
                      <div className="text-xl font-bold text-white">
                        {result.totalPosts}
                      </div>
                      <div className="text-xs text-slate-400">总发言</div>
                    </div>
                    <div className="bg-slate-700/50 rounded-lg p-2 text-center">
                      <div className="text-xl font-bold text-white">
                        {result.participants}
                      </div>
                      <div className="text-xs text-slate-400">参与人数</div>
                    </div>
                    <div className="bg-slate-700/50 rounded-lg p-2 text-center">
                      <div className="text-xl font-bold text-white">
                        {result.hotTopics.length}
                      </div>
                      <div className="text-xs text-slate-400">热门话题</div>
                    </div>
                  </div>
                </div>

                {/* 情感分布 */}
                <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
                  <h4 className="text-sm font-semibold text-white mb-3">
                    情感分布
                  </h4>
                  <div className="space-y-2">
                    {[
                      { label: '正面', key: 'positive', color: 'bg-green-500' },
                      { label: '中性', key: 'neutral', color: 'bg-gray-500' },
                      { label: '负面', key: 'negative', color: 'bg-red-500' },
                    ].map(item => {
                      const value =
                        result.sentimentDistribution[
                          item.key as keyof typeof result.sentimentDistribution
                        ];
                      const percentage = Math.round(
                        (value / result.totalPosts) * 100
                      );
                      return (
                        <div key={item.key}>
                          <div className="flex justify-between text-xs text-slate-400 mb-1">
                            <span>{item.label}</span>
                            <span>
                              {value} ({percentage}%)
                            </span>
                          </div>
                          <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                            <div
                              className={`h-full ${item.color}`}
                              style={{ width: `${percentage}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 热门话题 */}
                <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
                  <h4 className="text-sm font-semibold text-white mb-3">
                    🔥 热门话题
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {result.hotTopics.map((topic, i) => (
                      <span
                        key={i}
                        className="px-2 py-1 bg-purple-600/20 text-purple-300 rounded text-xs"
                      >
                        {topic}
                      </span>
                    ))}
                  </div>
                </div>

                <Link
                  href="/mirofish/simulation"
                  className="block w-full py-3 text-center bg-purple-600 text-white rounded-lg hover:bg-purple-500 transition-colors font-medium"
                >
                  🔁 重新模拟
                </Link>
              </div>
            ) : (
              <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-8 text-center">
                <div className="text-6xl mb-4">🎮</div>
                <h3 className="text-xl font-bold text-white mb-2">
                  模拟运行
                </h3>
                <p className="text-slate-400 text-sm max-w-xs mx-auto">
                  配置模拟参数和种子话题，启动模拟后将在此实时显示消息流和结果分析。
                </p>

                {/* 进度条 */}
                {simulationRunning && (
                  <div className="mt-6">
                    <div className="flex justify-between text-xs text-slate-400 mb-1">
                      <span>模拟进度</span>
                      <span>
                        {Math.round((currentRound / config.roundCount) * 100)}%
                      </span>
                    </div>
                    <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-purple-500 to-pink-500 transition-all"
                        style={{
                          width: `${(currentRound / config.roundCount) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

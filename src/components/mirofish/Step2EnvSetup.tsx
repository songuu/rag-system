'use client';

import React, { useState } from 'react';

interface GraphNode {
  uuid: string;
  name: string;
  labels: string[];
  summary: string;
}

interface EntityProfile {
  entity_id: string;
  entity_name: string;
  entity_type: string;
  full_name: string;
  age?: number;
  gender?: string;
  occupation?: string;
  personality_traits: string[];
  speaking_style: string;
  social_media_style: string;
  typical_posts: string[];
  viewpoints: Record<string, string>;
  background: string;
}

interface SimulationConfigInput {
  platforms: string[];
  round_count: number;
  posts_per_round: number;
  agents_per_round: number;
  temperature: number;
  seed_topics: string[];
  time_interval: number;
}

interface Step2Props {
  projectId: string;
  simulationRequirement: string;
  graphNodes: GraphNode[];
  profiles: EntityProfile[];
  onProfilesGenerated: (profiles: EntityProfile[]) => void;
  onSimulationCreated: (simulationId: string, config: SimulationConfigInput) => void;
  onComplete: () => void;
}

export default function Step2EnvSetup({
  projectId,
  simulationRequirement,
  graphNodes,
  profiles,
  onProfilesGenerated,
  onSimulationCreated,
  onComplete,
}: Step2Props) {
  const [selectedEntities, setSelectedEntities] = useState<string[]>([]);
  const [profileLoading, setProfileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [topicInput, setTopicInput] = useState('');

  const [config, setConfig] = useState<SimulationConfigInput>({
    platforms: ['twitter', 'reddit'],
    round_count: 10,
    posts_per_round: 5,
    agents_per_round: 5,
    temperature: 0.8,
    seed_topics: [],
    time_interval: 2,
  });

  // 全选/取消全选
  const toggleAll = () => {
    if (selectedEntities.length === graphNodes.length) {
      setSelectedEntities([]);
    } else {
      setSelectedEntities(graphNodes.map(n => n.uuid));
    }
  };

  // 生成人设
  const generateProfiles = async () => {
    if (selectedEntities.length === 0) {
      setError('请至少选择一个实体');
      return;
    }

    setProfileLoading(true);
    setError(null);

    try {
      const entities = selectedEntities.map(id => {
        const node = graphNodes.find(n => n.uuid === id);
        return {
          id,
          name: node?.name || '',
          type: node?.labels[0] || 'Person',
          description: node?.summary || '',
        };
      });

      const response = await fetch('/api/mirofish/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entities,
          simulationContext: simulationRequirement,
        }),
      });

      const data = await response.json();
      if (!data.success) throw new Error(data.error || '人设生成失败');

      onProfilesGenerated(data.profiles || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '人设生成失败');
    } finally {
      setProfileLoading(false);
    }
  };

  // 添加话题
  const addTopic = () => {
    if (!topicInput.trim() || config.seed_topics.includes(topicInput.trim())) return;
    setConfig(prev => ({
      ...prev,
      seed_topics: [...prev.seed_topics, topicInput.trim()],
    }));
    setTopicInput('');
  };

  // 创建模拟
  const createSimulation = async () => {
    if (profiles.length === 0) {
      setError('请先生成Agent人设');
      return;
    }
    if (config.seed_topics.length === 0) {
      setError('请至少添加一个种子话题');
      return;
    }

    setError(null);

    try {
      const response = await fetch('/api/mirofish/simulation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            ...config,
            project_id: projectId,
            agents_per_round: Math.min(config.agents_per_round, profiles.length),
          },
          profiles,
        }),
      });

      const data = await response.json();
      if (!data.success) throw new Error(data.error || '创建模拟失败');

      onSimulationCreated(data.simulation.simulation_id, config);
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建模拟失败');
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* 左侧配置 */}
      <div className="space-y-4">
        {/* 实体选择 */}
        <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
          <div className="flex justify-between items-center mb-3">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-purple-600 flex items-center justify-center text-xs font-bold">1</span>
              选择Agent实体
            </h3>
            <button
              onClick={toggleAll}
              className="text-xs text-purple-400 hover:text-purple-300"
            >
              {selectedEntities.length === graphNodes.length ? '取消全选' : '全选'}
            </button>
          </div>

          <div className="max-h-48 overflow-auto space-y-1">
            {graphNodes.map(node => (
              <label
                key={node.uuid}
                className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors ${
                  selectedEntities.includes(node.uuid)
                    ? 'bg-purple-600/20 border border-purple-500/50'
                    : 'bg-slate-700/50 hover:bg-slate-700'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedEntities.includes(node.uuid)}
                  onChange={() => {
                    setSelectedEntities(prev =>
                      prev.includes(node.uuid)
                        ? prev.filter(id => id !== node.uuid)
                        : [...prev, node.uuid]
                    );
                  }}
                  className="rounded border-slate-500 text-purple-500"
                />
                <span className="text-sm text-white truncate">{node.name}</span>
                <span className="text-xs text-slate-400">({node.labels[0]})</span>
              </label>
            ))}
          </div>

          {profiles.length === 0 && (
            <button
              onClick={generateProfiles}
              disabled={profileLoading || selectedEntities.length === 0}
              className={`w-full mt-3 py-2 rounded-lg font-medium transition-colors ${
                profileLoading || selectedEntities.length === 0
                  ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                  : 'bg-purple-600 text-white hover:bg-purple-500'
              }`}
            >
              {profileLoading ? '生成中...' : `生成人设 (${selectedEntities.length})`}
            </button>
          )}

          {profiles.length > 0 && (
            <div className="mt-3 p-2 bg-green-500/10 border border-green-500/30 rounded-lg text-xs text-green-400">
              已生成 {profiles.length} 个Agent人设
            </div>
          )}
        </div>

        {/* 模拟配置 */}
        {profiles.length > 0 && (
          <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
            <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-purple-600 flex items-center justify-center text-xs font-bold">2</span>
              模拟配置
            </h3>

            <div className="space-y-3">
              {/* 平台选择 */}
              <div>
                <label className="block text-xs text-slate-400 mb-1">模拟平台</label>
                <div className="flex gap-2">
                  {(['twitter', 'reddit'] as const).map(p => (
                    <button
                      key={p}
                      onClick={() => {
                        setConfig(prev => ({
                          ...prev,
                          platforms: prev.platforms.includes(p)
                            ? prev.platforms.filter(x => x !== p)
                            : [...prev.platforms, p],
                        }));
                      }}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                        config.platforms.includes(p)
                          ? 'bg-purple-600 text-white'
                          : 'bg-slate-700 text-slate-400 hover:text-white'
                      }`}
                    >
                      {p === 'twitter' ? 'Twitter' : 'Reddit'}
                    </button>
                  ))}
                </div>
              </div>

              {/* 数值配置 */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">轮次</label>
                  <input
                    type="number"
                    value={config.round_count}
                    onChange={e => setConfig(prev => ({ ...prev, round_count: parseInt(e.target.value) || 10 }))}
                    min={1} max={50}
                    className="w-full px-2 py-1.5 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">每轮Agent数</label>
                  <input
                    type="number"
                    value={config.agents_per_round}
                    onChange={e => setConfig(prev => ({ ...prev, agents_per_round: parseInt(e.target.value) || 5 }))}
                    min={1} max={profiles.length}
                    className="w-full px-2 py-1.5 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                </div>
              </div>

              {/* 种子话题 */}
              <div>
                <label className="block text-xs text-slate-400 mb-1">种子话题</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={topicInput}
                    onChange={e => setTopicInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addTopic()}
                    placeholder="添加话题..."
                    className="flex-1 px-2 py-1.5 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                  <button onClick={addTopic} className="px-3 py-1.5 bg-slate-700 text-white rounded-lg hover:bg-slate-600 text-sm">+</button>
                </div>
                <div className="flex flex-wrap gap-1 mt-2">
                  {config.seed_topics.map(topic => (
                    <span key={topic} className="px-2 py-0.5 bg-purple-600/20 text-purple-300 rounded text-xs flex items-center gap-1">
                      {topic}
                      <button onClick={() => setConfig(prev => ({ ...prev, seed_topics: prev.seed_topics.filter(t => t !== topic) }))} className="hover:text-red-400">x</button>
                    </span>
                  ))}
                </div>
              </div>

              {/* Temperature */}
              <div>
                <label className="block text-xs text-slate-400 mb-1">随机性 ({config.temperature})</label>
                <input
                  type="range"
                  value={config.temperature}
                  onChange={e => setConfig(prev => ({ ...prev, temperature: parseFloat(e.target.value) }))}
                  min={0.1} max={1.5} step={0.1}
                  className="w-full"
                />
              </div>

              <button
                onClick={createSimulation}
                className="w-full py-3 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-lg font-medium hover:from-purple-500 hover:to-pink-500 transition-all"
              >
                创建模拟并进入下一步 →
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-3 text-red-400 text-sm">
            {error}
          </div>
        )}
      </div>

      {/* 右侧人设展示 */}
      <div className="lg:col-span-2">
        {profiles.length > 0 ? (
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-white">Agent 人设 ({profiles.length})</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {profiles.map((profile, i) => (
                <div key={i} className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <h4 className="font-semibold text-white">{profile.full_name}</h4>
                      <div className="text-xs text-slate-400">
                        {profile.occupation} {profile.age && `\u00b7 ${profile.age}\u5C81`} {profile.gender && `\u00b7 ${profile.gender}`}
                      </div>
                    </div>
                    <span className="px-2 py-0.5 bg-blue-500/20 text-blue-300 rounded text-xs">{profile.entity_type}</span>
                  </div>

                  {profile.personality_traits.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {profile.personality_traits.map((trait, j) => (
                        <span key={j} className="px-1.5 py-0.5 bg-purple-500/20 text-purple-300 rounded text-xs">{trait}</span>
                      ))}
                    </div>
                  )}

                  {profile.speaking_style && (
                    <p className="text-xs text-slate-400 mb-2">{profile.speaking_style}</p>
                  )}

                  {profile.typical_posts.length > 0 && (
                    <div className="text-xs text-slate-300 bg-slate-700/50 rounded p-2 italic">
                      &ldquo;{profile.typical_posts[0]}&rdquo;
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-12 text-center">
            <div className="text-6xl mb-4">2</div>
            <h3 className="text-xl font-bold text-white mb-2">环境设置</h3>
            <p className="text-slate-400 max-w-md mx-auto">
              选择图谱中的实体，为其生成AI角色人设。每个Agent都有独特的性格、观点和说话风格。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

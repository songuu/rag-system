'use client';

import React, { useState } from 'react';
import type { ModelOverride } from '@/lib/mirofish/types';

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
  modelOverride?: ModelOverride | null;
  onProfilesGenerated: (profiles: EntityProfile[]) => void;
  onSimulationCreated: (simulationId: string, config: SimulationConfigInput) => void;
  onComplete: () => void;
}

const PERSONALITY_COLORS: Record<string, string> = {
  default: 'bg-violet-500/15 text-violet-300',
};

function getTraitColor(_trait: string): string {
  return PERSONALITY_COLORS.default;
}

export default function Step2EnvSetup({
  projectId,
  simulationRequirement,
  graphNodes,
  profiles,
  modelOverride,
  onProfilesGenerated,
  onSimulationCreated,
  onComplete,
}: Step2Props) {
  const [selectedEntities, setSelectedEntities] = useState<string[]>([]);
  const [profileLoading, setProfileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [topicInput, setTopicInput] = useState('');
  const [expandedProfile, setExpandedProfile] = useState<string | null>(null);

  const [config, setConfig] = useState<SimulationConfigInput>({
    platforms: ['twitter', 'reddit'],
    round_count: 10,
    posts_per_round: 5,
    agents_per_round: 5,
    temperature: 0.8,
    seed_topics: [],
    time_interval: 2,
  });

  const toggleAll = () => {
    if (selectedEntities.length === graphNodes.length) {
      setSelectedEntities([]);
    } else {
      setSelectedEntities(graphNodes.map(n => n.uuid));
    }
  };

  const generateProfiles = async () => {
    if (selectedEntities.length === 0) { setError('请至少选择一个实体'); return; }
    setProfileLoading(true);
    setError(null);
    try {
      const entities = selectedEntities.map(id => {
        const node = graphNodes.find(n => n.uuid === id);
        return { id, name: node?.name || '', type: node?.labels[0] || 'Person', description: node?.summary || '' };
      });
      const response = await fetch('/api/mirofish/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entities, simulationContext: simulationRequirement, modelOverride: modelOverride || undefined }),
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

  const addTopic = () => {
    if (!topicInput.trim() || config.seed_topics.includes(topicInput.trim())) return;
    setConfig(prev => ({ ...prev, seed_topics: [...prev.seed_topics, topicInput.trim()] }));
    setTopicInput('');
  };

  const createSimulation = async () => {
    if (profiles.length === 0) { setError('请先生成Agent人设'); return; }
    if (config.seed_topics.length === 0) { setError('请至少添加一个种子话题'); return; }
    setError(null);
    try {
      const response = await fetch('/api/mirofish/simulation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: { ...config, project_id: projectId, agents_per_round: Math.min(config.agents_per_round, profiles.length) },
          profiles,
          modelOverride: modelOverride || undefined,
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

  const phase: 'select' | 'config' | 'ready' = profiles.length === 0 ? 'select' : 'config';

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      {/* 左侧控制 */}
      <div className="space-y-5 lg:col-span-2">
        {/* 流程指示 */}
        <div className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-5 py-3">
          {(['select', 'config'] as const).map((p, i) => {
            const isDone = (p === 'select' && profiles.length > 0);
            const isCur = phase === p;
            const labels = ['选择实体 & 生成人设', '配置模拟参数'];
            return (
              <React.Fragment key={p}>
                {i > 0 && <div className={`h-px flex-1 ${isDone ? 'bg-purple-500/50' : 'bg-white/10'}`} />}
                <div className="flex items-center gap-2">
                  <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                    isDone ? 'bg-emerald-500 text-white' : isCur ? 'bg-purple-500/20 text-purple-300 ring-2 ring-purple-500/40' : 'bg-white/5 text-white/30'
                  }`}>
                    {isDone ? '✓' : i + 1}
                  </div>
                  <span className={`text-xs font-medium ${isDone ? 'text-emerald-300' : isCur ? 'text-white' : 'text-white/30'}`}>
                    {labels[i]}
                  </span>
                </div>
              </React.Fragment>
            );
          })}
        </div>

        {/* 实体选择 */}
        <div className={`rounded-2xl border p-5 transition-all ${
          phase === 'select'
            ? 'border-purple-500/30 bg-purple-500/[0.04] shadow-lg shadow-purple-500/5'
            : 'border-emerald-500/20 bg-emerald-500/[0.02]'
        }`}>
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`flex h-9 w-9 items-center justify-center rounded-xl text-sm font-bold ${
                profiles.length > 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-purple-500/20 text-purple-400'
              }`}>
                {profiles.length > 0 ? '✓' : '1'}
              </div>
              <div>
                <div className="text-sm font-semibold text-white">选择 Agent 实体</div>
                <div className="text-[11px] text-white/40">{graphNodes.length} 个实体可用</div>
              </div>
            </div>
            <button type="button" onClick={toggleAll} className="text-[11px] text-purple-400 hover:text-purple-300">
              {selectedEntities.length === graphNodes.length ? '取消全选' : '全选'}
            </button>
          </div>

          <div className="mb-3 max-h-52 space-y-1.5 overflow-y-auto pr-1">
            {graphNodes.map(node => {
              const checked = selectedEntities.includes(node.uuid);
              return (
                <label
                  key={node.uuid}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl p-3 transition-all ${
                    checked
                      ? 'border border-purple-500/30 bg-purple-500/10'
                      : 'border border-transparent bg-white/[0.02] hover:bg-white/[0.04]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => setSelectedEntities(prev =>
                      prev.includes(node.uuid) ? prev.filter(id => id !== node.uuid) : [...prev, node.uuid]
                    )}
                    className="rounded border-white/20 bg-transparent text-purple-500 focus:ring-purple-500/30"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-white">{node.name}</div>
                    <div className="truncate text-[10px] text-white/30">{node.summary?.slice(0, 50)}</div>
                  </div>
                  <span className="shrink-0 rounded-lg bg-blue-500/10 px-2 py-0.5 text-[10px] text-blue-300">
                    {node.labels[0]}
                  </span>
                </label>
              );
            })}
          </div>

          {profiles.length === 0 ? (
            <button
              type="button"
              onClick={generateProfiles}
              disabled={profileLoading || selectedEntities.length === 0}
              className="group relative w-full overflow-hidden rounded-xl bg-gradient-to-r from-purple-600 to-violet-600 py-3 text-sm font-semibold text-white shadow-lg shadow-purple-500/20 disabled:opacity-40 disabled:shadow-none"
            >
              {profileLoading && <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-white/10 to-transparent" />}
              <span className="relative">{profileLoading ? '正在生成 Agent 人设...' : `⚙️ 生成人设 (${selectedEntities.length})`}</span>
            </button>
          ) : (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-emerald-400">
              <span>✅</span> 已生成 {profiles.length} 个 Agent 人设
            </div>
          )}
        </div>

        {/* 模拟配置 */}
        {profiles.length > 0 && (
          <div className="rounded-2xl border border-purple-500/30 bg-purple-500/[0.04] p-5 shadow-lg shadow-purple-500/5">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-purple-500/20 text-sm font-bold text-purple-400">2</div>
              <div>
                <div className="text-sm font-semibold text-white">模拟配置</div>
                <div className="text-[11px] text-white/40">设定模拟参数与种子话题</div>
              </div>
            </div>

            <div className="space-y-4">
              {/* 平台 */}
              <div>
                <div className="mb-1.5 text-[11px] font-medium text-white/50">模拟平台</div>
                <div className="flex gap-2">
                  {(['twitter', 'reddit'] as const).map(p => (
                    <button
                      type="button"
                      key={p}
                      onClick={() => setConfig(prev => ({
                        ...prev,
                        platforms: prev.platforms.includes(p)
                          ? prev.platforms.filter(x => x !== p)
                          : [...prev.platforms, p],
                      }))}
                      className={`flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium transition-all ${
                        config.platforms.includes(p)
                          ? 'bg-purple-500/20 text-purple-300 ring-1 ring-purple-500/30'
                          : 'bg-white/[0.03] text-white/40 hover:bg-white/[0.06]'
                      }`}
                    >
                      {p === 'twitter' ? '🐦 Twitter' : '🔴 Reddit'}
                    </button>
                  ))}
                </div>
              </div>

              {/* 数值 */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="mb-1.5 text-[11px] font-medium text-white/50">轮次数</div>
                  <input
                    type="number"
                    value={config.round_count}
                    onChange={e => setConfig(prev => ({ ...prev, round_count: parseInt(e.target.value) || 10 }))}
                    min={1} max={50}
                    className="w-full rounded-xl border border-white/[0.08] bg-black/30 px-3 py-2 text-sm text-white focus:border-purple-500/40 focus:outline-none"
                  />
                </div>
                <div>
                  <div className="mb-1.5 text-[11px] font-medium text-white/50">每轮 Agent 数</div>
                  <input
                    type="number"
                    value={config.agents_per_round}
                    onChange={e => setConfig(prev => ({ ...prev, agents_per_round: parseInt(e.target.value) || 5 }))}
                    min={1} max={profiles.length}
                    className="w-full rounded-xl border border-white/[0.08] bg-black/30 px-3 py-2 text-sm text-white focus:border-purple-500/40 focus:outline-none"
                  />
                </div>
              </div>

              {/* 种子话题 */}
              <div>
                <div className="mb-1.5 text-[11px] font-medium text-white/50">种子话题</div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={topicInput}
                    onChange={e => setTopicInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addTopic()}
                    placeholder="输入话题,按 Enter 添加..."
                    className="flex-1 rounded-xl border border-white/[0.08] bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/20 focus:border-purple-500/40 focus:outline-none"
                  />
                  <button type="button" onClick={addTopic} className="rounded-xl bg-white/[0.06] px-3 py-2 text-sm text-white/60 hover:bg-white/[0.1]">+</button>
                </div>
                {config.seed_topics.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {config.seed_topics.map(topic => (
                      <span key={topic} className="flex items-center gap-1.5 rounded-lg bg-purple-500/15 px-2.5 py-1 text-[11px] font-medium text-purple-300">
                        {topic}
                        <button type="button" onClick={() => setConfig(prev => ({ ...prev, seed_topics: prev.seed_topics.filter(t => t !== topic) }))} className="text-purple-400/50 hover:text-rose-400">×</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Temperature */}
              <div>
                <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-white/50">
                  <span>随机性</span>
                  <span className="text-purple-300">{config.temperature}</span>
                </div>
                <input
                  type="range"
                  value={config.temperature}
                  onChange={e => setConfig(prev => ({ ...prev, temperature: parseFloat(e.target.value) }))}
                  min={0.1} max={1.5} step={0.1}
                  className="w-full accent-purple-500"
                />
              </div>

              <button
                type="button"
                onClick={createSimulation}
                className="group w-full rounded-2xl bg-gradient-to-r from-purple-600 via-violet-600 to-fuchsia-600 p-px shadow-lg shadow-purple-500/20"
              >
                <div className="flex items-center justify-center gap-2 rounded-[15px] bg-[#060612] px-6 py-3.5 transition-colors group-hover:bg-[#0a0a1a]">
                  <span className="text-sm font-semibold text-white">🚀 创建模拟并进入下一步</span>
                  <span className="text-purple-400 transition-transform group-hover:translate-x-1">→</span>
                </div>
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-3 rounded-xl border border-rose-500/20 bg-rose-500/[0.06] p-4">
            <span className="text-rose-400">⚠</span>
            <div className="text-sm text-rose-300">{error}</div>
          </div>
        )}
      </div>

      {/* 右侧人设展示 */}
      <div className="lg:col-span-3">
        {profiles.length > 0 ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-lg font-semibold text-white">Agent 人设</div>
                <div className="text-xs text-white/30">{profiles.length} 个角色就绪</div>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {profiles.map(profile => {
                const isExpanded = expandedProfile === profile.entity_id;
                return (
                  <button
                    type="button"
                    key={profile.entity_id}
                    onClick={() => setExpandedProfile(isExpanded ? null : profile.entity_id)}
                    className={`rounded-2xl border p-5 text-left transition-all ${
                      isExpanded
                        ? 'border-purple-500/30 bg-purple-500/[0.04] shadow-lg shadow-purple-500/5'
                        : 'border-white/[0.06] bg-white/[0.02] hover:border-white/[0.1] hover:bg-white/[0.03]'
                    }`}
                  >
                    <div className="mb-3 flex items-start justify-between">
                      <div>
                        <div className="text-sm font-semibold text-white">{profile.full_name}</div>
                        <div className="mt-0.5 text-[11px] text-white/40">
                          {profile.occupation}{profile.age ? ` · ${profile.age}岁` : ''}{profile.gender ? ` · ${profile.gender}` : ''}
                        </div>
                      </div>
                      <span className="shrink-0 rounded-lg bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-300">
                        {profile.entity_type}
                      </span>
                    </div>

                    {profile.personality_traits.length > 0 && (
                      <div className="mb-3 flex flex-wrap gap-1.5">
                        {profile.personality_traits.slice(0, isExpanded ? undefined : 3).map(trait => (
                          <span key={trait} className={`rounded-lg px-2 py-0.5 text-[10px] font-medium ${getTraitColor(trait)}`}>
                            {trait}
                          </span>
                        ))}
                        {!isExpanded && profile.personality_traits.length > 3 && (
                          <span className="text-[10px] text-white/20">+{profile.personality_traits.length - 3}</span>
                        )}
                      </div>
                    )}

                    {profile.typical_posts.length > 0 && (
                      <div className="rounded-xl bg-black/20 p-3 text-xs italic leading-relaxed text-white/50">
                        &ldquo;{profile.typical_posts[0]}&rdquo;
                      </div>
                    )}

                    {isExpanded && (
                      <div className="mt-3 space-y-2 border-t border-white/[0.06] pt-3">
                        {profile.speaking_style && (
                          <div>
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-white/25">说话风格</div>
                            <div className="text-xs text-white/50">{profile.speaking_style}</div>
                          </div>
                        )}
                        {profile.background && (
                          <div>
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-white/25">背景</div>
                            <div className="text-xs text-white/50">{profile.background}</div>
                          </div>
                        )}
                        {Object.keys(profile.viewpoints).length > 0 && (
                          <div>
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-white/25">观点</div>
                            {Object.entries(profile.viewpoints).map(([topic, view]) => (
                              <div key={topic} className="mt-1 text-xs text-white/40">
                                <span className="text-purple-300">{topic}:</span> {view}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex min-h-[400px] items-center justify-center rounded-2xl border border-dashed border-white/[0.08] bg-white/[0.01]">
            <div className="max-w-sm text-center">
              <div className="relative mx-auto mb-6 flex h-24 w-24 items-center justify-center">
                <div className="absolute inset-0 animate-spin rounded-full border border-dashed border-purple-500/20" style={{ animationDuration: '20s' }} />
                <span className="text-4xl">⚙️</span>
              </div>
              <h3 className="mb-2 text-xl font-bold text-white">环境设置</h3>
              <p className="text-sm leading-relaxed text-white/40">
                选择图谱中的实体,为其生成 AI 角色人设。每个 Agent 都有独特的性格、观点和说话风格。
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

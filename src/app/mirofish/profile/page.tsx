'use client';

import React, { useState } from 'react';
import Link from 'next/link';

// ==================== 类型定义 ====================

interface EntityProfile {
  entity_id: string;
  entity_name: string;
  entity_type: string;
  full_name: string;
  age?: number;
  gender?: string;
  occupation?: string;
  position?: string;
  personality_traits: string[];
  speaking_style: string;
  social_media_style: string;
  typical_posts: string[];
  viewpoints: Record<string, string>;
  background: string;
}

interface Entity {
  id: string;
  name: string;
  type: string;
  description?: string;
}

export default function ProfilePage() {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [entityInput, setEntityInput] = useState('');
  const [entityType, setEntityType] = useState('Person');
  const [simulationContext, setSimulationContext] = useState('');
  const [selectedEntities, setSelectedEntities] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<EntityProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 添加实体
  const addEntity = () => {
    if (!entityInput.trim()) return;

    const newEntity: Entity = {
      id: `entity_${Date.now()}`,
      name: entityInput.trim(),
      type: entityType,
      description: '',
    };

    setEntities(prev => [...prev, newEntity]);
    setEntityInput('');
    setSelectedEntities(prev => [...prev, newEntity.id]);
  };

  // 删除实体
  const removeEntity = (id: string) => {
    setEntities(prev => prev.filter(e => e.id !== id));
    setSelectedEntities(prev => prev.filter(eid => eid !== id));
  };

  // 切换选择
  const toggleSelect = (id: string) => {
    setSelectedEntities(prev =>
      prev.includes(id)
        ? prev.filter(eid => eid !== id)
        : [...prev, id]
    );
  };

  // 全选
  const selectAll = () => {
    setSelectedEntities(entities.map(e => e.id));
  };

  // 取消全选
  const deselectAll = () => {
    setSelectedEntities([]);
  };

  // 生成人设
  const generateProfiles = async () => {
    if (selectedEntities.length === 0) {
      setError('请至少选择一个实体');
      return;
    }

    if (!simulationContext.trim()) {
      setError('请输入模拟上下文');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const selectedEntitiesData = selectedEntities.map(id => {
        const entity = entities.find(e => e.id === id)!;
        return {
          id,
          name: entity.name,
          type: entity.type,
          description: entity.description || '',
        };
      });

      const response = await fetch('/api/mirofish/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entities: selectedEntitiesData,
          simulationContext: simulationContext,
        }),
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || '人设生成失败');
      }

      setProfiles(data.profiles || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '人设生成失败');
    } finally {
      setLoading(false);
    }
  };

  // 下载人设为 JSON
  const downloadProfiles = () => {
    if (profiles.length === 0) return;

    const blob = new Blob([JSON.stringify(profiles, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'profiles.json';
    a.click();
    URL.revokeObjectURL(url);
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
                <span className="text-2xl">👤</span>
                人设生成
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
                className="px-3 py-1 text-sm rounded-lg transition-colors bg-purple-600 text-white"
              >
                👤 人设
              </Link>
              <Link
                href="/mirofish/simulation"
                className="px-3 py-1 text-sm rounded-lg transition-colors bg-slate-800 text-slate-400 hover:text-white"
              >
                🎮 模拟
              </Link>
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 左侧配置面板 */}
          <div className="space-y-4">
            {/* 添加实体 */}
            <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
              <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                ➕ 添加实体
              </h3>

              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">实体名称</label>
                  <input
                    type="text"
                    value={entityInput}
                    onChange={e => setEntityInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addEntity()}
                    placeholder="输入实体名称，如：张三、科技博主A..."
                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1">实体类型</label>
                  <select
                    value={entityType}
                    onChange={e => setEntityType(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                  >
                    <option value="Person">人物</option>
                    <option value="Organization">组织/机构</option>
                    <option value="Brand">品牌</option>
                    <option value="Product">产品</option>
                    <option value="Media">媒体</option>
                    <option value="Influencer">意见领袖</option>
                    <option value="User">普通用户</option>
                  </select>
                </div>

                <button
                  onClick={addEntity}
                  className="w-full py-2 bg-slate-700 text-white rounded-lg hover:bg-slate-600 transition-colors text-sm"
                >
                  + 添加
                </button>
              </div>
            </div>

            {/* 模拟上下文 */}
            <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
              <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                🎯 模拟上下文
              </h3>
              <textarea
                value={simulationContext}
                onChange={e => setSimulationContext(e.target.value)}
                placeholder="描述模拟场景，如：模拟一个关于手机发热的舆论争议..."
                className="w-full h-24 px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
              />
            </div>

            {/* 错误提示 */}
            {error && (
              <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-3 text-red-400 text-sm">
                {error}
              </div>
            )}

            {/* 生成按钮 */}
            <button
              onClick={generateProfiles}
              disabled={loading || selectedEntities.length === 0}
              className={`w-full py-3 rounded-lg font-medium transition-colors ${
                loading || selectedEntities.length === 0
                  ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                  : 'bg-purple-600 text-white hover:bg-purple-500'
              }`}
            >
              {loading ? '生成中...' : `👤 生成 ${selectedEntities.length} 个人设`}
            </button>
          </div>

          {/* 中间实体列表 */}
          <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
            <div className="flex justify-between items-center mb-3">
              <h3 className="text-sm font-semibold text-white">
                📋 实体列表 ({entities.length})
              </h3>
              <div className="flex gap-2">
                <button
                  onClick={selectAll}
                  className="px-2 py-1 text-xs bg-slate-700 text-slate-300 rounded hover:bg-slate-600 transition-colors"
                >
                  全选
                </button>
                <button
                  onClick={deselectAll}
                  className="px-2 py-1 text-xs bg-slate-700 text-slate-300 rounded hover:bg-slate-600 transition-colors"
                >
                  取消
                </button>
              </div>
            </div>

            {entities.length > 0 ? (
              <div className="space-y-2 max-h-[500px] overflow-auto">
                {entities.map(entity => (
                  <div
                    key={entity.id}
                    className={`p-3 rounded-lg border transition-colors cursor-pointer ${
                      selectedEntities.includes(entity.id)
                        ? 'bg-purple-600/20 border-purple-500/50'
                        : 'bg-slate-700/50 border-slate-600 hover:border-slate-500'
                    }`}
                    onClick={() => toggleSelect(entity.id)}
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <div className="font-medium text-white">{entity.name}</div>
                        <div className="text-xs text-slate-400 mt-1">{entity.type}</div>
                      </div>
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          removeEntity(entity.id);
                        }}
                        className="text-slate-500 hover:text-red-400 transition-colors"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-12 text-slate-500">
                <div className="text-4xl mb-2">👤</div>
                <p className="text-sm">请先添加实体</p>
              </div>
            )}
          </div>

          {/* 右侧人设展示 */}
          <div>
            {profiles.length > 0 ? (
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-lg font-semibold text-white">
                    🎭 生成的人设 ({profiles.length})
                  </h3>
                  <button
                    onClick={downloadProfiles}
                    className="px-3 py-1 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors"
                  >
                    💾 下载
                  </button>
                </div>

                {profiles.map((profile, i) => (
                  <div
                    key={i}
                    className="bg-slate-800/50 rounded-xl border border-slate-700 p-4"
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h4 className="text-lg font-semibold text-white">
                          {profile.full_name}
                        </h4>
                        <div className="text-sm text-slate-400">
                          {profile.occupation} {profile.position && `· ${profile.position}`}
                          {profile.age && ` · ${profile.age}岁`}
                          {profile.gender && ` · ${profile.gender}`}
                        </div>
                      </div>
                      <span className="px-2 py-1 bg-blue-500/20 text-blue-300 rounded text-xs">
                        {profile.entity_type}
                      </span>
                    </div>

                    {profile.personality_traits.length > 0 && (
                      <div className="mb-3">
                        <div className="text-xs text-slate-400 mb-1">性格特点</div>
                        <div className="flex flex-wrap gap-1">
                          {profile.personality_traits.map((trait, j) => (
                            <span
                              key={j}
                              className="px-2 py-0.5 bg-purple-500/20 text-purple-300 rounded text-xs"
                            >
                              {trait}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {profile.speaking_style && (
                      <div className="mb-3">
                        <div className="text-xs text-slate-400 mb-1">说话风格</div>
                        <p className="text-sm text-slate-300">{profile.speaking_style}</p>
                      </div>
                    )}

                    {profile.typical_posts.length > 0 && (
                      <div className="mb-3">
                        <div className="text-xs text-slate-400 mb-1">典型发言</div>
                        <div className="space-y-1">
                          {profile.typical_posts.slice(0, 2).map((post, j) => (
                            <div
                              key={j}
                              className="text-sm text-slate-300 bg-slate-700/50 rounded p-2"
                            >
                              "{post}"
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {Object.keys(profile.viewpoints).length > 0 && (
                      <div>
                        <div className="text-xs text-slate-400 mb-1">观点倾向</div>
                        <div className="space-y-1">
                          {Object.entries(profile.viewpoints).map(([topic, view], j) => (
                            <div key={j} className="text-sm">
                              <span className="text-blue-300">{topic}:</span>{' '}
                              <span className="text-slate-300">{view}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-12 text-center">
                <div className="text-6xl mb-4">🎭</div>
                <h3 className="text-xl font-bold text-white mb-2">
                  人设生成器
                </h3>
                <p className="text-slate-400 max-w-md mx-auto">
                  添加实体并设置模拟上下文，AI 将为每个实体生成详细的模拟人设，
                  包括性格特点、说话风格、观点倾向等。
                </p>
                <div className="mt-6 flex justify-center gap-4 flex-wrap">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-purple-400">10+</div>
                    <div className="text-xs text-slate-500">属性维度</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

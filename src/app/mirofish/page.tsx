'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface Project {
  id: string;
  name: string;
  description: string;
  status: string;
  current_step: number;
  simulation_requirement: string;
  created_at: string;
  updated_at: string;
}

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  created: { label: '已创建', color: 'bg-slate-500/20 text-slate-400' },
  graph_built: { label: '图谱已建', color: 'bg-blue-500/20 text-blue-400' },
  env_setup: { label: '环境就绪', color: 'bg-cyan-500/20 text-cyan-400' },
  simulating: { label: '模拟中', color: 'bg-green-500/20 text-green-400' },
  report_generated: { label: '报告完成', color: 'bg-purple-500/20 text-purple-400' },
  completed: { label: '全部完成', color: 'bg-emerald-500/20 text-emerald-400' },
};

const STEP_LABELS = ['图谱构建', '环境设置', '模拟运行', '报告生成', '深度交互'];

export default function MiroFishPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  // 创建项目弹窗
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [createRequirement, setCreateRequirement] = useState('');
  const [creating, setCreating] = useState(false);

  // 加载项目列表
  useEffect(() => {
    const fetchProjects = async () => {
      try {
        const response = await fetch('/api/mirofish/project');
        const data = await response.json();
        if (data.success) {
          setProjects(data.projects || []);
        }
      } catch {
        // 忽略
      } finally {
        setLoading(false);
      }
    };
    fetchProjects();
  }, []);

  // 创建项目
  const handleCreate = async () => {
    if (!createName.trim() || !createRequirement.trim()) return;

    setCreating(true);
    try {
      const response = await fetch('/api/mirofish/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: createName,
          description: createDesc,
          simulation_requirement: createRequirement,
        }),
      });

      const data = await response.json();
      if (data.success && data.project) {
        router.push(`/mirofish/console/${data.project.id}`);
      }
    } catch {
      // 忽略
    } finally {
      setCreating(false);
    }
  };

  // 删除项目
  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/mirofish/project/${id}`, { method: 'DELETE' });
      setProjects(prev => prev.filter(p => p.id !== id));
    } catch {
      // 忽略
    }
  };

  return (
    <div className="min-h-screen bg-slate-900">
      {/* 顶部导航栏 */}
      <nav style={{
        height: '60px',
        background: '#000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px',
        position: 'sticky',
        top: 0,
        zIndex: 100,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
          <Link href="/" style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 800,
            fontSize: '16px',
            letterSpacing: '1px',
            cursor: 'pointer',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            textDecoration: 'none',
          }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-label="MiroFish Logo">
              <circle cx="12" cy="8" r="4" fill="#7C3AED"/>
              <path d="M4 20C4 16 7.5 13 12 13C16.5 13 20 16 20 20" stroke="#7C3AED" strokeWidth="2" strokeLinecap="round"/>
              <circle cx="8" cy="18" r="2" fill="#7C3AED"/>
              <circle cx="16" cy="18" r="2" fill="#7C3AED"/>
            </svg>
            <span style={{ background: 'linear-gradient(135deg, #7C3AED 0%, #A855F7 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>MIROFISH</span>
          </Link>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Link
              href="/mirofish/process"
              style={{
                padding: '6px 14px',
                borderRadius: '6px',
                fontSize: '13px',
                fontWeight: 500,
                background: 'rgba(255,255,255,0.1)',
                color: '#fff',
                textDecoration: 'none',
              }}
            >
              完整流程(旧)
            </Link>
            <Link
              href="/mirofish/ontology"
              style={{
                padding: '6px 14px',
                borderRadius: '6px',
                fontSize: '13px',
                fontWeight: 500,
                background: 'rgba(255,255,255,0.1)',
                color: '#fff',
                textDecoration: 'none',
              }}
            >
              本体
            </Link>
            <Link
              href="/mirofish/entity-extraction"
              style={{
                padding: '6px 14px',
                borderRadius: '6px',
                fontSize: '13px',
                fontWeight: 500,
                background: 'rgba(255,255,255,0.1)',
                color: '#fff',
                textDecoration: 'none',
              }}
            >
              实体抽取
            </Link>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '36px',
            height: '36px',
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '14px',
            color: '#fff',
            fontWeight: 600,
          }}>
            U
          </div>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* 头部 */}
        <div className="flex justify-between items-start mb-8">
          <div>
            <h1 className="text-3xl font-bold text-white mb-2">MiroFish Console</h1>
            <p className="text-slate-400">
              AI群体智能预测引擎 - 构建高保真数字世界，模拟社会舆论
            </p>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-500 font-medium transition-colors flex items-center gap-2"
          >
            <span className="text-lg">+</span>
            新建项目
          </button>
        </div>

        {/* 项目列表 */}
        {loading ? (
          <div className="text-center py-20">
            <div className="animate-spin w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full mx-auto" />
          </div>
        ) : projects.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map(project => {
              const statusInfo = STATUS_MAP[project.status] || STATUS_MAP.created;
              return (
                <Link
                  key={project.id}
                  href={`/mirofish/console/${project.id}`}
                  className="bg-slate-800/50 rounded-xl border border-slate-700 p-5 hover:border-purple-500/50 transition-all group"
                >
                  <div className="flex justify-between items-start mb-3">
                    <h3 className="font-semibold text-white group-hover:text-purple-300 transition-colors">
                      {project.name}
                    </h3>
                    <span className={`px-2 py-0.5 rounded text-xs ${statusInfo.color}`}>
                      {statusInfo.label}
                    </span>
                  </div>

                  {project.description && (
                    <p className="text-sm text-slate-400 mb-3 line-clamp-2">
                      {project.description}
                    </p>
                  )}

                  <p className="text-xs text-slate-500 mb-3 line-clamp-1">
                    {project.simulation_requirement}
                  </p>

                  {/* 步骤进度 */}
                  <div className="flex gap-1 mb-3">
                    {STEP_LABELS.map((label, i) => (
                      <div
                        key={i}
                        className={`flex-1 h-1.5 rounded-full ${
                          i < project.current_step
                            ? 'bg-purple-500'
                            : i === project.current_step
                            ? 'bg-purple-500/50'
                            : 'bg-slate-700'
                        }`}
                        title={label}
                      />
                    ))}
                  </div>

                  <div className="flex justify-between items-center">
                    <span className="text-xs text-slate-500">
                      {STEP_LABELS[project.current_step] || '未开始'}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500">
                        {new Date(project.updated_at).toLocaleDateString()}
                      </span>
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleDelete(project.id);
                        }}
                        className="text-xs text-slate-600 hover:text-red-400 transition-colors"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="bg-slate-800/30 rounded-xl border border-slate-700/50 p-16 text-center">
            <div className="text-6xl mb-4">🐟</div>
            <h3 className="text-2xl font-bold text-white mb-3">欢迎使用 MiroFish</h3>
            <p className="text-slate-400 mb-6 max-w-lg mx-auto">
              MiroFish 是一个AI驱动的群体智能预测引擎。输入种子信息（新闻、政策、金融信号），
              系统将构建知识图谱、生成AI角色、模拟社交互动，并生成预测分析报告。
            </p>
            <div className="flex justify-center gap-4 mb-8">
              {[
                { step: '1', label: '图谱构建', desc: '上传文档提取实体关系' },
                { step: '2', label: '环境设置', desc: '生成AI Agent人设' },
                { step: '3', label: '模拟运行', desc: '双平台社交模拟' },
                { step: '4', label: '报告生成', desc: 'AI分析舆情趋势' },
                { step: '5', label: '深度交互', desc: '对话采访上帝视角' },
              ].map((item) => (
                <div key={item.step} className="text-center">
                  <div className="w-12 h-12 rounded-full bg-purple-600/20 flex items-center justify-center text-purple-400 font-bold text-lg mx-auto mb-2">
                    {item.step}
                  </div>
                  <div className="text-sm text-white font-medium">{item.label}</div>
                  <div className="text-xs text-slate-500 mt-1">{item.desc}</div>
                </div>
              ))}
            </div>
            <button
              onClick={() => setShowCreate(true)}
              className="px-8 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-500 font-medium text-lg"
            >
              创建第一个项目
            </button>
          </div>
        )}
      </div>

      {/* 创建项目弹窗 */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-xl border border-slate-700 w-full max-w-lg p-6">
            <h2 className="text-xl font-bold text-white mb-4">新建项目</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">项目名称 *</label>
                <input
                  type="text"
                  value={createName}
                  onChange={e => setCreateName(e.target.value)}
                  placeholder="例如：新能源汽车舆论模拟"
                  className="w-full px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>

              <div>
                <label className="block text-sm text-slate-400 mb-1">模拟需求描述 *</label>
                <textarea
                  value={createRequirement}
                  onChange={e => setCreateRequirement(e.target.value)}
                  placeholder="例如：模拟关于某品牌电动车自燃事件的社交媒体舆论走向..."
                  className="w-full h-24 px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
                />
              </div>

              <div>
                <label className="block text-sm text-slate-400 mb-1">项目描述（可选）</label>
                <textarea
                  value={createDesc}
                  onChange={e => setCreateDesc(e.target.value)}
                  placeholder="项目背景和目标..."
                  className="w-full h-16 px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
                />
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowCreate(false)}
                className="flex-1 py-2 bg-slate-700 text-white rounded-lg hover:bg-slate-600 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !createName.trim() || !createRequirement.trim()}
                className="flex-1 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
              >
                {creating ? '创建中...' : '创建项目'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import KnowledgeGraphViewer from '@/components/KnowledgeGraphViewer';

// ==================== 类型定义 ====================

interface Ontology {
  entity_types: Array<{
    name: string;
    description: string;
    attributes: Array<{ name: string; type: string; description: string }>;
    examples: string[];
  }>;
  edge_types: Array<{
    name: string;
    description: string;
    source_targets: Array<{ source: string; target: string }>;
    attributes: unknown[];
  }>;
  analysis_summary: string;
}

interface GraphData {
  graph_id: string;
  nodes: Array<{
    uuid: string;
    name: string;
    labels: string[];
    summary: string;
    attributes: Record<string, unknown>;
  }>;
  edges: Array<{
    uuid: string;
    name: string;
    fact: string;
    source_node_name: string;
    target_node_name: string;
  }>;
  node_count: number;
  edge_count: number;
}

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

interface TaskStatus {
  status: string;
  progress: number;
  message: string;
  graphId?: string;
  error?: string;
}

// ==================== 主组件 ====================

export default function MiroFishPage() {
  // 工作流状态
  const [workflowStep, setWorkflowStep] = useState<
    'ontology' | 'graph' | 'profile' | 'simulation'
  >('ontology');

  // 本体配置
  const [simulationRequirement, setSimulationRequirement] = useState('');
  const [texts, setTexts] = useState<string[]>([]);
  const [customText, setCustomText] = useState('');
  const [ontology, setOntology] = useState<Ontology | null>(null);
  const [ontologyLoading, setOntologyLoading] = useState(false);
  const [ontologyError, setOntologyError] = useState<string | null>(null);

  // 图谱构建
  const [graphText, setGraphText] = useState('');
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphTaskId, setGraphTaskId] = useState<string | null>(null);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);

  // 人设生成
  const [selectedEntities, setSelectedEntities] = useState<string[]>([]);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profiles, setProfiles] = useState<EntityProfile[]>([]);
  const [profileError, setProfileError] = useState<string | null>(null);

  // 进度
  const [progress, setProgress] = useState<TaskStatus | null>(null);

  // ==================== 本体生成 ====================

  const generateOntology = async () => {
    if (!simulationRequirement.trim()) {
      setOntologyError('请输入模拟需求');
      return;
    }

    if (texts.length === 0 && !customText.trim()) {
      setOntologyError('请提供分析文本或输入文本内容');
      return;
    }

    setOntologyLoading(true);
    setOntologyError(null);

    try {
      const inputTexts = customText.trim()
        ? [...texts, customText]
        : texts;

      const response = await fetch('/api/mirofish/ontology', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          texts: inputTexts,
          simulationRequirement: simulationRequirement,
        }),
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || '本体生成失败');
      }

      setOntology(data.ontology);
      setWorkflowStep('graph');
    } catch (error) {
      setOntologyError(error instanceof Error ? error.message : '本体生成失败');
    } finally {
      setOntologyLoading(false);
    }
  };

  // ==================== 图谱构建 ====================

  const buildGraph = async () => {
    if (!graphText.trim()) {
      setGraphError('请输入要构建图谱的文本');
      return;
    }

    if (!ontology) {
      setGraphError('请先生成本体');
      return;
    }

    setGraphLoading(true);
    setGraphError(null);
    setProgress({ status: 'pending', progress: 0, message: '正在创建任务...' });

    try {
      const response = await fetch('/api/mirofish/graph', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: graphText,
          ontology: ontology,
          graphName: 'MiroFish Graph',
        }),
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || '图谱构建失败');
      }

      setGraphTaskId(data.taskId);
    } catch (error) {
      setGraphError(error instanceof Error ? error.message : '图谱构建失败');
      setGraphLoading(false);
    }
  };

  // 轮询图谱状态
  useEffect(() => {
    if (!graphTaskId || !graphLoading) return;

    const pollStatus = async () => {
      try {
        const response = await fetch(
          `/api/mirofish/graph?action=status&taskId=${graphTaskId}`
        );
        const data = await response.json();

        if (data.success) {
          setProgress({
            status: data.status,
            progress: data.progress || 0,
            message: data.message || '',
            graphId: data.graphId,
            error: data.error,
          });

          if (data.status === 'completed' && data.graphId) {
            // 获取图谱数据
            const graphResponse = await fetch(
              `/api/mirofish/graph?action=data&graphId=${data.graphId}`
            );
            const graphResult = await graphResponse.json();

            if (graphResult.success) {
              setGraphData(graphResult.graph);
            }

            setGraphLoading(false);
          } else if (data.status === 'failed') {
            setGraphError(data.error || '图谱构建失败');
            setGraphLoading(false);
          }
        }
      } catch (error) {
        console.error('获取状态失败:', error);
      }
    };

    const interval = setInterval(pollStatus, 2000);
    return () => clearInterval(interval);
  }, [graphTaskId, graphLoading]);

  // ==================== 人设生成 ====================

  const generateProfiles = async () => {
    if (!graphData || selectedEntities.length === 0) {
      setProfileError('请先构建图谱并选择实体');
      return;
    }

    setProfileLoading(true);
    setProfileError(null);

    try {
      // 准备实体数据
      const entities = selectedEntities.map(id => {
        const node = graphData!.nodes.find(n => n.uuid === id);
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

      if (!data.success) {
        throw new Error(data.error || '人设生成失败');
      }

      setProfiles(data.profiles || []);
      setWorkflowStep('profile');
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : '人设生成失败');
    } finally {
      setProfileLoading(false);
    }
  };

  // ==================== 渲染 ====================

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
      {/* 顶部导航 */}
      <nav className="bg-slate-900/80 backdrop-blur-sm border-b border-slate-700/50 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-14">
            <div className="flex items-center gap-4">
              <Link href="/" className="flex items-center gap-2 text-white hover:text-purple-300 transition-colors">
                <span className="text-xl">←</span>
                <span className="text-sm">返回首页</span>
              </Link>
              <div className="h-6 w-px bg-slate-700" />
              <h1 className="text-lg font-semibold text-white flex items-center gap-2">
                <span className="text-2xl">🐟</span>
                MiroFish 群体模拟
              </h1>
            </div>

            {/* 功能模块导航 */}
            <div className="flex items-center gap-2">
              <Link
                href="/mirofish/process"
                className="px-3 py-1 text-sm rounded-lg transition-colors bg-purple-600 text-white"
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
                className="px-3 py-1 text-sm rounded-lg transition-colors bg-slate-800 text-slate-400 hover:text-white"
              >
                🎮 模拟
              </Link>
            </div>

            {/* 工作流步骤 */}
            <div className="flex items-center gap-2">
              {[
                { key: 'ontology', label: '1. 本体', icon: '📋' },
                { key: 'graph', label: '2. 图谱', icon: '🕸️' },
                { key: 'profile', label: '3. 人设', icon: '👤' },
                { key: 'simulation', label: '4. 模拟', icon: '🎮' },
              ].map(step => (
                <button
                  key={step.key}
                  onClick={() => setWorkflowStep(step.key as typeof workflowStep)}
                  className={`px-3 py-1 text-sm rounded-lg transition-colors ${
                    workflowStep === step.key
                      ? 'bg-purple-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  {step.icon} {step.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 左侧控制面板 */}
          <div className="lg:col-span-1 space-y-4">
            {/* 本体配置 */}
            {workflowStep === 'ontology' && (
              <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
                <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                  📋 本体配置
                </h3>

                <div className="space-y-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      模拟需求描述
                    </label>
                    <textarea
                      value={simulationRequirement}
                      onChange={e => setSimulationRequirement(e.target.value)}
                      placeholder="例如：模拟一个关于某品牌产品争议的社交媒体舆论场..."
                      className="w-full h-24 px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      分析文本（可选，支持多段）
                    </label>
                    <textarea
                      value={customText}
                      onChange={e => setCustomText(e.target.value)}
                      placeholder="输入要分析的文本内容，用于提取实体类型..."
                      className="w-full h-32 px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
                    />
                  </div>

                  {ontologyError && (
                    <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-2 text-red-400 text-sm">
                      {ontologyError}
                    </div>
                  )}

                  <button
                    onClick={generateOntology}
                    disabled={ontologyLoading}
                    className={`w-full py-2 rounded-lg font-medium transition-colors ${
                      ontologyLoading
                        ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                        : 'bg-purple-600 text-white hover:bg-purple-500'
                    }`}
                  >
                    {ontologyLoading ? '生成中...' : '🚀 生成本体'}
                  </button>
                </div>
              </div>
            )}

            {/* 图谱构建 */}
            {workflowStep === 'graph' && (
              <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
                <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                  🕸️ 图谱构建
                </h3>

                {ontology && (
                  <div className="mb-4 p-3 bg-slate-700/50 rounded-lg">
                    <div className="text-xs text-slate-400 mb-2">已生成实体类型</div>
                    <div className="flex flex-wrap gap-1">
                      {ontology.entity_types.slice(0, 6).map((type, i) => (
                        <span
                          key={i}
                          className="px-2 py-0.5 bg-blue-500/20 text-blue-300 rounded text-xs"
                        >
                          {type.name}
                        </span>
                      ))}
                      {ontology.entity_types.length > 6 && (
                        <span className="text-xs text-slate-500">
                          +{ontology.entity_types.length - 6}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                <div className="space-y-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      图谱文本内容
                    </label>
                    <textarea
                      value={graphText}
                      onChange={e => setGraphText(e.target.value)}
                      placeholder="输入要构建图谱的完整文本..."
                      className="w-full h-32 px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
                    />
                  </div>

                  {graphError && (
                    <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-2 text-red-400 text-sm">
                      {graphError}
                    </div>
                  )}

                  <button
                    onClick={buildGraph}
                    disabled={graphLoading || !ontology}
                    className={`w-full py-2 rounded-lg font-medium transition-colors ${
                      graphLoading || !ontology
                        ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                        : 'bg-purple-600 text-white hover:bg-purple-500'
                    }`}
                  >
                    {graphLoading ? '构建中...' : '🕸️ 构建图谱'}
                  </button>
                </div>

                {/* 进度条 */}
                {progress && graphLoading && (
                  <div className="mt-4">
                    <div className="flex justify-between text-xs text-slate-400 mb-1">
                      <span>{progress.message}</span>
                      <span>{Math.round(progress.progress)}%</span>
                    </div>
                    <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-purple-500 to-pink-500 transition-all"
                        style={{ width: `${progress.progress}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 人设生成 */}
            {workflowStep === 'profile' && graphData && (
              <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
                <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                  👤 人设生成
                </h3>

                <div className="space-y-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-2">
                      选择要生成人设的实体
                    </label>
                    <div className="max-h-48 overflow-auto space-y-1">
                      {graphData.nodes.map(node => (
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
                          <span className="text-sm text-white truncate">
                            {node.name}
                          </span>
                          <span className="text-xs text-slate-400">
                            ({node.labels[0]})
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {profileError && (
                    <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-2 text-red-400 text-sm">
                      {profileError}
                    </div>
                  )}

                  <button
                    onClick={generateProfiles}
                    disabled={profileLoading || selectedEntities.length === 0}
                    className={`w-full py-2 rounded-lg font-medium transition-colors ${
                      profileLoading || selectedEntities.length === 0
                        ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                        : 'bg-purple-600 text-white hover:bg-purple-500'
                    }`}
                  >
                    {profileLoading ? '生成中...' : '👤 生成人设'}
                  </button>
                </div>
              </div>
            )}

            {/* 统计信息 */}
            {graphData && (
              <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
                <h3 className="text-sm font-semibold text-white mb-3">📊 图谱统计</h3>
                <div className="grid grid-cols-2 gap-2 text-center">
                  <div className="bg-slate-700/50 rounded-lg p-2">
                    <div className="text-xl font-bold text-blue-400">
                      {graphData.node_count}
                    </div>
                    <div className="text-xs text-slate-400">实体</div>
                  </div>
                  <div className="bg-slate-700/50 rounded-lg p-2">
                    <div className="text-xl font-bold text-purple-400">
                      {graphData.edge_count}
                    </div>
                    <div className="text-xs text-slate-400">关系</div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 右侧内容区域 */}
          <div className="lg:col-span-2">
            {/* 本体预览 */}
            {workflowStep === 'ontology' && ontology && (
              <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
                <h3 className="text-lg font-semibold text-white mb-4">📋 本体定义</h3>

                <div className="mb-4">
                  <h4 className="text-sm font-medium text-blue-400 mb-2">
                    实体类型 ({ontology.entity_types.length})
                  </h4>
                  <div className="grid grid-cols-2 gap-2">
                    {ontology.entity_types.map((type, i) => (
                      <div
                        key={i}
                        className="bg-slate-700/50 rounded-lg p-3"
                      >
                        <div className="font-medium text-white">{type.name}</div>
                        <div className="text-xs text-slate-400 mt-1">
                          {type.description}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <h4 className="text-sm font-medium text-purple-400 mb-2">
                    关系类型 ({ontology.edge_types.length})
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {ontology.edge_types.map((edge, i) => (
                      <div
                        key={i}
                        className="bg-slate-700/50 rounded-lg px-3 py-2"
                      >
                        <span className="text-purple-300">{edge.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* 图谱可视化 */}
            {workflowStep === 'graph' && graphData && (
              <KnowledgeGraphViewer
                graph={{
                  entities: graphData.nodes.map(n => ({
                    id: n.uuid,
                    name: n.name,
                    type: (n.labels[0]?.toUpperCase() || 'OTHER') as 'PERSON' | 'ORGANIZATION' | 'LOCATION' | 'EVENT' | 'CONCEPT' | 'PRODUCT' | 'DATE' | 'OTHER',
                    description: n.summary,
                    aliases: [],
                    mentions: 1,
                    sourceChunks: [],
                  })),
                  relations: graphData.edges.map(e => ({
                    id: e.uuid,
                    source: e.source_node_name,
                    target: e.target_node_name,
                    type: e.name,
                    description: e.fact,
                    weight: 1,
                    sourceChunks: [],
                  })),
                  communities: [],
                  metadata: {
                    documentId: graphData.graph_id,
                    createdAt: new Date().toISOString(),
                    entityCount: graphData.node_count,
                    relationCount: graphData.edge_count,
                    communityCount: 0,
                  },
                }}
              />
            )}

            {/* 人设展示 */}
            {workflowStep === 'profile' && profiles.length > 0 && (
              <div className="space-y-4">
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
                        <p className="text-sm text-slate-300">
                          {profile.speaking_style}
                        </p>
                      </div>
                    )}

                    {profile.typical_posts.length > 0 && (
                      <div className="mb-3">
                        <div className="text-xs text-slate-400 mb-1">典型发言</div>
                        <div className="space-y-1">
                          {profile.typical_posts.slice(0, 3).map((post, j) => (
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
                          {Object.entries(profile.viewpoints).map(
                            ([topic, view], j) => (
                              <div
                                key={j}
                                className="text-sm"
                              >
                                <span className="text-blue-300">{topic}:</span>{' '}
                                <span className="text-slate-300">{view}</span>
                              </div>
                            )
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* 空状态 */}
            {!ontology && workflowStep === 'ontology' && (
              <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-12 text-center">
                <div className="text-6xl mb-4">🐟</div>
                <h3 className="text-2xl font-bold text-white mb-2">
                  MiroFish 群体模拟
                </h3>
                <p className="text-slate-400 mb-6 max-w-md mx-auto">
                  输入模拟需求和文本内容，生成本体定义、构建知识图谱、生成实体人设，
                  打造个性化的社交媒体舆论模拟系统。
                </p>
                <div className="flex justify-center gap-3 flex-wrap">
                  {[
                    { icon: '📋', label: '本体生成' },
                    { icon: '🕸️', label: '图谱构建' },
                    { icon: '👤', label: '人设生成' },
                    { icon: '🎮', label: '模拟运行' },
                  ].map((step, i) => (
                    <div
                      key={i}
                      className="px-4 py-2 bg-slate-700 rounded-lg text-sm text-slate-300"
                    >
                      <span className="mr-2">{step.icon}</span>
                      {step.label}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 图谱空状态 */}
            {!graphData && workflowStep === 'graph' && (
              <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-12 text-center">
                <div className="text-6xl mb-4">🕸️</div>
                <h3 className="text-xl font-bold text-white mb-2">
                  知识图谱
                </h3>
                <p className="text-slate-400">
                  构建图谱后将在此显示可视化效果
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 功能说明 */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-slate-800/30 rounded-xl border border-slate-700/50 p-6">
          <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            📖 MiroFish 工作流程
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {[
              {
                icon: '📋',
                title: '1. 本体生成',
                desc: '分析文本内容，生成适合社会舆论模拟的实体和关系类型定义。',
              },
              {
                icon: '🕸️',
                title: '2. 图谱构建',
                desc: '基于文本构建知识图谱，提取实体和关系。',
              },
              {
                icon: '👤',
                title: '3. 人设生成',
                desc: '为关键实体生成模拟人设，包括性格、观点、发言风格等。',
              },
              {
                icon: '🎮',
                title: '4. 模拟运行',
                desc: '基于人设和图谱进行社交媒体舆论模拟。',
              },
            ].map((step, i) => (
              <div key={i} className="bg-slate-800/50 rounded-lg p-4">
                <div className="text-3xl mb-2">{step.icon}</div>
                <h4 className="font-medium text-white mb-1">{step.title}</h4>
                <p className="text-sm text-slate-400">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

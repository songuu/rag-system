'use client';

import React, { useState, useEffect, useCallback } from 'react';
import KnowledgeGraphViewer from '@/components/KnowledgeGraphViewer';

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

interface Step1Props {
  projectId: string;
  simulationRequirement: string;
  ontology: Ontology | null;
  graphData: GraphData | null;
  onOntologyGenerated: (ontology: Ontology) => void;
  onGraphBuilt: (graphData: GraphData) => void;
  onComplete: () => void;
}

export default function Step1GraphBuild({
  projectId,
  simulationRequirement,
  ontology,
  graphData,
  onOntologyGenerated,
  onGraphBuilt,
  onComplete,
}: Step1Props) {
  const [texts, setTexts] = useState('');
  const [graphText, setGraphText] = useState('');
  const [ontologyLoading, setOntologyLoading] = useState(false);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphTaskId, setGraphTaskId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ status: string; progress: number; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 生成本体
  const generateOntology = async () => {
    if (!texts.trim()) {
      setError('请输入分析文本');
      return;
    }

    setOntologyLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/mirofish/ontology', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          texts: [texts],
          simulationRequirement,
        }),
      });

      const data = await response.json();
      if (!data.success) throw new Error(data.error || '本体生成失败');

      onOntologyGenerated(data.ontology);
    } catch (err) {
      setError(err instanceof Error ? err.message : '本体生成失败');
    } finally {
      setOntologyLoading(false);
    }
  };

  // 构建图谱
  const buildGraph = async () => {
    const textToUse = graphText.trim() || texts.trim();
    if (!textToUse) {
      setError('请输入文本内容');
      return;
    }
    if (!ontology) {
      setError('请先生成本体');
      return;
    }

    setGraphLoading(true);
    setError(null);
    setProgress({ status: 'pending', progress: 0, message: '正在创建任务...' });

    try {
      const response = await fetch('/api/mirofish/graph', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: textToUse,
          ontology,
          graphName: `Project ${projectId} Graph`,
        }),
      });

      const data = await response.json();
      if (!data.success) throw new Error(data.error || '图谱构建失败');

      setGraphTaskId(data.taskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '图谱构建失败');
      setGraphLoading(false);
    }
  };

  // 轮询图谱状态
  useEffect(() => {
    if (!graphTaskId || !graphLoading) return;

    const pollStatus = async () => {
      try {
        const response = await fetch(`/api/mirofish/graph?action=status&taskId=${graphTaskId}`);
        const data = await response.json();

        if (data.success) {
          setProgress({
            status: data.status,
            progress: data.progress || 0,
            message: data.message || '',
          });

          if (data.status === 'completed' && data.graphId) {
            const graphResponse = await fetch(`/api/mirofish/graph?action=data&graphId=${data.graphId}`);
            const graphResult = await graphResponse.json();

            if (graphResult.success) {
              onGraphBuilt(graphResult.graph);
            }
            setGraphLoading(false);
          } else if (data.status === 'failed') {
            setError(data.error || '图谱构建失败');
            setGraphLoading(false);
          }
        }
      } catch {
        // 忽略轮询错误
      }
    };

    const interval = setInterval(pollStatus, 2000);
    return () => clearInterval(interval);
  }, [graphTaskId, graphLoading, onGraphBuilt]);

  const phase = !ontology ? 'ontology' : !graphData ? 'graph' : 'done';

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* 左侧控制面板 */}
      <div className="space-y-4">
        {/* 本体配置 */}
        <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
          <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-purple-600 flex items-center justify-center text-xs font-bold">1</span>
            本体生成
          </h3>

          <div className="space-y-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">模拟需求</label>
              <div className="px-3 py-2 bg-slate-700/50 rounded-lg text-slate-300 text-sm">
                {simulationRequirement || '未设置'}
              </div>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">分析文本</label>
              <textarea
                value={texts}
                onChange={e => setTexts(e.target.value)}
                placeholder="输入要分析的文本内容..."
                disabled={!!ontology}
                className="w-full h-32 px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none disabled:opacity-50"
              />
            </div>

            {!ontology && (
              <button
                onClick={generateOntology}
                disabled={ontologyLoading}
                className={`w-full py-2 rounded-lg font-medium transition-colors ${
                  ontologyLoading
                    ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                    : 'bg-purple-600 text-white hover:bg-purple-500'
                }`}
              >
                {ontologyLoading ? '生成中...' : '生成本体'}
              </button>
            )}

            {ontology && (
              <div className="p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
                <div className="text-xs text-green-400 mb-1">本体已生成</div>
                <div className="flex flex-wrap gap-1">
                  {ontology.entity_types.slice(0, 5).map((t, i) => (
                    <span key={i} className="px-2 py-0.5 bg-blue-500/20 text-blue-300 rounded text-xs">
                      {t.name}
                    </span>
                  ))}
                  {ontology.entity_types.length > 5 && (
                    <span className="text-xs text-slate-500">+{ontology.entity_types.length - 5}</span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 图谱构建 */}
        {ontology && (
          <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
            <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-purple-600 flex items-center justify-center text-xs font-bold">2</span>
              图谱构建
            </h3>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">图谱文本（留空则使用本体文本）</label>
                <textarea
                  value={graphText}
                  onChange={e => setGraphText(e.target.value)}
                  placeholder="输入要构建图谱的文本（可选）..."
                  disabled={!!graphData}
                  className="w-full h-24 px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none disabled:opacity-50"
                />
              </div>

              {!graphData && (
                <button
                  onClick={buildGraph}
                  disabled={graphLoading}
                  className={`w-full py-2 rounded-lg font-medium transition-colors ${
                    graphLoading
                      ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                      : 'bg-purple-600 text-white hover:bg-purple-500'
                  }`}
                >
                  {graphLoading ? '构建中...' : '构建图谱'}
                </button>
              )}

              {/* 进度条 */}
              {progress && graphLoading && (
                <div>
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
          </div>
        )}

        {/* 统计 + 下一步 */}
        {graphData && (
          <>
            <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-4">
              <h3 className="text-sm font-semibold text-white mb-3">图谱统计</h3>
              <div className="grid grid-cols-2 gap-2 text-center">
                <div className="bg-slate-700/50 rounded-lg p-2">
                  <div className="text-xl font-bold text-blue-400">{graphData.node_count}</div>
                  <div className="text-xs text-slate-400">实体</div>
                </div>
                <div className="bg-slate-700/50 rounded-lg p-2">
                  <div className="text-xl font-bold text-purple-400">{graphData.edge_count}</div>
                  <div className="text-xs text-slate-400">关系</div>
                </div>
              </div>
            </div>

            <button
              onClick={onComplete}
              className="w-full py-3 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-lg font-medium hover:from-purple-500 hover:to-pink-500 transition-all"
            >
              下一步: 环境设置 →
            </button>
          </>
        )}

        {error && (
          <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-3 text-red-400 text-sm">
            {error}
          </div>
        )}
      </div>

      {/* 右侧预览 */}
      <div className="lg:col-span-2">
        {graphData ? (
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
        ) : ontology ? (
          <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-6">
            <h3 className="text-lg font-semibold text-white mb-4">本体定义</h3>
            <div className="mb-4">
              <div className="text-sm text-slate-400 mb-2">实体类型 ({ontology.entity_types.length})</div>
              <div className="grid grid-cols-2 gap-2">
                {ontology.entity_types.map((type, i) => (
                  <div key={i} className="bg-slate-700/50 rounded-lg p-3">
                    <div className="font-medium text-white text-sm">{type.name}</div>
                    <div className="text-xs text-slate-400 mt-1">{type.description}</div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="text-sm text-slate-400 mb-2">关系类型 ({ontology.edge_types.length})</div>
              <div className="flex flex-wrap gap-2">
                {ontology.edge_types.map((edge, i) => (
                  <span key={i} className="px-3 py-1 bg-purple-500/20 text-purple-300 rounded-lg text-sm">
                    {edge.name}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-12 text-center">
            <div className="text-6xl mb-4">1</div>
            <h3 className="text-xl font-bold text-white mb-2">图谱构建</h3>
            <p className="text-slate-400 max-w-md mx-auto">
              上传文档或输入文本，系统将自动提取实体和关系，构建知识图谱。
              这是整个模拟流程的基础。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

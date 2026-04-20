'use client';

import React, { useState, useEffect, useRef } from 'react';
import KnowledgeGraphViewer from '@/components/KnowledgeGraphViewer';
import type { ModelOverride } from '@/lib/mirofish/types';

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
  modelOverride?: ModelOverride | null;
  onOntologyGenerated: (ontology: Ontology) => void;
  onGraphBuilt: (graphData: GraphData) => void;
  onComplete: () => void;
}

interface UploadedPdf {
  filename: string;
  pages: number;
  size: number;
}

export default function Step1GraphBuild({
  projectId,
  simulationRequirement,
  ontology,
  graphData,
  modelOverride,
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
  const [uploading, setUploading] = useState(false);
  const [uploadedPdf, setUploadedPdf] = useState<UploadedPdf | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePdfUpload = async (file: File) => {
    if (file.type !== 'application/pdf') {
      setError('仅支持 PDF 文件');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('文件大小不能超过 10MB');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch('/api/mirofish/upload', { method: 'POST', body: formData });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || '上传失败');
      setTexts(data.text);
      setUploadedPdf({ filename: data.filename, pages: data.pages, size: data.size });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'PDF 上传失败');
    } finally {
      setUploading(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handlePdfUpload(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDrop = (e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handlePdfUpload(file);
  };

  const generateOntology = async () => {
    if (!texts.trim()) { setError('请输入分析文本'); return; }
    setOntologyLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/mirofish/ontology', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          texts: [texts],
          simulationRequirement,
          modelOverride: modelOverride || undefined,
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

  const buildGraph = async () => {
    const textToUse = graphText.trim() || texts.trim();
    if (!textToUse) { setError('请输入文本内容'); return; }
    if (!ontology) { setError('请先生成本体'); return; }
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
          modelOverride: modelOverride || undefined,
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

  useEffect(() => {
    if (!graphTaskId || !graphLoading) return;
    const pollStatus = async () => {
      try {
        const response = await fetch(`/api/mirofish/graph?action=status&taskId=${graphTaskId}`);
        const data = await response.json();
        if (data.success) {
          setProgress({ status: data.status, progress: data.progress || 0, message: data.message || '' });
          if (data.status === 'completed' && data.graphId) {
            const graphResponse = await fetch(`/api/mirofish/graph?action=data&graphId=${data.graphId}`);
            const graphResult = await graphResponse.json();
            if (graphResult.success) onGraphBuilt(graphResult.graph);
            setGraphLoading(false);
          } else if (data.status === 'failed') {
            setError(data.error || '图谱构建失败');
            setGraphLoading(false);
          }
        }
      } catch { /* ignore */ }
    };
    const interval = setInterval(pollStatus, 2000);
    return () => clearInterval(interval);
  }, [graphTaskId, graphLoading, onGraphBuilt]);

  const phase: 'ontology' | 'graph' | 'done' = !ontology ? 'ontology' : !graphData ? 'graph' : 'done';

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      {/* 左侧控制面板 */}
      <div className="space-y-5 lg:col-span-2">
        {/* 流水线进度可视化 */}
        <div className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-5 py-3">
          {(['ontology', 'graph', 'done'] as const).map((p, i) => {
            const isDone = phase === 'done' || (phase === 'graph' && p === 'ontology');
            const isCur = phase === p;
            const labels = ['本体生成', '图谱构建', '完成'];
            return (
              <React.Fragment key={p}>
                {i > 0 && <div className={`h-px flex-1 ${isDone ? 'bg-purple-500/50' : 'bg-white/10'}`} />}
                <div className="flex items-center gap-2">
                  <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                    isDone ? 'bg-purple-500 text-white' : isCur ? 'bg-purple-500/20 text-purple-300 ring-2 ring-purple-500/40' : 'bg-white/5 text-white/30'
                  }`}>
                    {isDone ? '✓' : i + 1}
                  </div>
                  <span className={`text-xs font-medium ${isDone ? 'text-purple-300' : isCur ? 'text-white' : 'text-white/30'}`}>
                    {labels[i]}
                  </span>
                </div>
              </React.Fragment>
            );
          })}
        </div>

        {/* 需求概览 */}
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-purple-400/70">模拟需求</div>
          <div className="text-sm leading-relaxed text-white/70">{simulationRequirement || '未设置'}</div>
        </div>

        {/* 步骤 1: 本体生成 */}
        <div className={`rounded-2xl border p-5 transition-all duration-300 ${
          phase === 'ontology'
            ? 'border-purple-500/30 bg-purple-500/[0.04] shadow-lg shadow-purple-500/5'
            : ontology
              ? 'border-emerald-500/20 bg-emerald-500/[0.02]'
              : 'border-white/[0.06] bg-white/[0.02]'
        }`}>
          <div className="mb-4 flex items-center gap-3">
            <div className={`flex h-9 w-9 items-center justify-center rounded-xl text-sm font-bold ${
              ontology ? 'bg-emerald-500/20 text-emerald-400' : 'bg-purple-500/20 text-purple-400'
            }`}>
              {ontology ? '✓' : '1'}
            </div>
            <div>
              <div className="text-sm font-semibold text-white">本体生成</div>
              <div className="text-[11px] text-white/40">上传 PDF 或输入文本,提取实体 & 关系模式</div>
            </div>
          </div>

          {/* PDF 上传区 */}
          {!ontology && (
            <div className="mb-3">
              <input ref={fileInputRef} type="file" accept="application/pdf" onChange={handleFileSelect} className="hidden" />
              <button
                type="button"
                onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`w-full rounded-xl border-2 border-dashed p-5 text-center transition-all ${
                  isDragging
                    ? 'border-purple-500 bg-purple-500/10 scale-[1.01]'
                    : uploadedPdf
                      ? 'border-emerald-500/40 bg-emerald-500/5'
                      : 'border-white/10 bg-white/[0.02] hover:border-purple-500/40 hover:bg-purple-500/[0.03]'
                }`}
              >
                {uploading ? (
                  <div className="flex items-center justify-center gap-2 text-sm text-white/50">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-purple-500/30 border-t-purple-500" />
                    解析 PDF 中...
                  </div>
                ) : uploadedPdf ? (
                  <div className="flex items-center justify-center gap-2 text-sm text-emerald-400">
                    <span>📄</span>
                    <span>{uploadedPdf.filename}</span>
                    <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px]">{uploadedPdf.pages} 页</span>
                  </div>
                ) : (
                  <div>
                    <div className="mb-1 text-2xl">📁</div>
                    <div className="text-sm text-white/60">点击或拖放 PDF 文件</div>
                    <div className="mt-1 text-[10px] text-white/25">仅支持 PDF, ≤10MB</div>
                  </div>
                )}
              </button>
            </div>
          )}

          {/* 文本输入 */}
          <textarea
            value={texts}
            onChange={e => setTexts(e.target.value)}
            placeholder="直接输入或通过上方 PDF 上传填充..."
            disabled={!!ontology}
            rows={4}
            className="mb-3 w-full resize-none rounded-xl border border-white/[0.08] bg-black/30 px-4 py-3 text-sm text-white placeholder:text-white/20 focus:border-purple-500/40 focus:outline-none focus:ring-1 focus:ring-purple-500/20 disabled:opacity-40"
          />

          {!ontology ? (
            <button
              type="button"
              onClick={generateOntology}
              disabled={ontologyLoading || !texts.trim()}
              className="group relative w-full overflow-hidden rounded-xl bg-gradient-to-r from-purple-600 to-violet-600 py-3 text-sm font-semibold text-white shadow-lg shadow-purple-500/20 transition-all hover:shadow-purple-500/30 disabled:opacity-40 disabled:shadow-none"
            >
              {ontologyLoading && (
                <div className="absolute inset-0 bg-gradient-to-r from-purple-600/0 via-white/10 to-purple-600/0 animate-pulse" />
              )}
              <span className="relative">{ontologyLoading ? '正在分析实体与关系...' : '🧬 生成本体'}</span>
            </button>
          ) : (
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-emerald-400">
                <span>✅</span> 本体已生成
              </div>
              <div className="flex flex-wrap gap-1.5">
                {ontology.entity_types.map(t => (
                  <span key={t.name} className="rounded-lg bg-blue-500/15 px-2.5 py-1 text-[11px] font-medium text-blue-300">
                    {t.name}
                  </span>
                ))}
              </div>
              {ontology.edge_types.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {ontology.edge_types.map(e => (
                    <span key={e.name} className="rounded-lg bg-purple-500/15 px-2.5 py-1 text-[11px] font-medium text-purple-300">
                      {e.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 步骤 2: 图谱构建 */}
        {ontology && (
          <div className={`rounded-2xl border p-5 transition-all duration-300 ${
            phase === 'graph'
              ? 'border-purple-500/30 bg-purple-500/[0.04] shadow-lg shadow-purple-500/5'
              : graphData
                ? 'border-emerald-500/20 bg-emerald-500/[0.02]'
                : 'border-white/[0.06] bg-white/[0.02] opacity-60'
          }`}>
            <div className="mb-4 flex items-center gap-3">
              <div className={`flex h-9 w-9 items-center justify-center rounded-xl text-sm font-bold ${
                graphData ? 'bg-emerald-500/20 text-emerald-400' : 'bg-purple-500/20 text-purple-400'
              }`}>
                {graphData ? '✓' : '2'}
              </div>
              <div>
                <div className="text-sm font-semibold text-white">图谱构建</div>
                <div className="text-[11px] text-white/40">基于本体抽取实体与关系,构建知识图谱</div>
              </div>
            </div>

            <textarea
              value={graphText}
              onChange={e => setGraphText(e.target.value)}
              placeholder="输入要构建图谱的文本(可选,留空则使用本体文本)..."
              disabled={!!graphData}
              rows={3}
              className="mb-3 w-full resize-none rounded-xl border border-white/[0.08] bg-black/30 px-4 py-3 text-sm text-white placeholder:text-white/20 focus:border-purple-500/40 focus:outline-none focus:ring-1 focus:ring-purple-500/20 disabled:opacity-40"
            />

            {!graphData ? (
              <button
                type="button"
                onClick={buildGraph}
                disabled={graphLoading}
                className="group relative w-full overflow-hidden rounded-xl bg-gradient-to-r from-purple-600 to-violet-600 py-3 text-sm font-semibold text-white shadow-lg shadow-purple-500/20 transition-all hover:shadow-purple-500/30 disabled:opacity-40 disabled:shadow-none"
              >
                {graphLoading && (
                  <div className="absolute inset-0 bg-gradient-to-r from-purple-600/0 via-white/10 to-purple-600/0 animate-pulse" />
                )}
                <span className="relative">{graphLoading ? '构建中...' : '🔗 构建图谱'}</span>
              </button>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-blue-500/10 p-4 text-center">
                  <div className="text-2xl font-bold text-blue-400">{graphData.node_count}</div>
                  <div className="text-[11px] text-blue-300/60">实体节点</div>
                </div>
                <div className="rounded-xl bg-purple-500/10 p-4 text-center">
                  <div className="text-2xl font-bold text-purple-400">{graphData.edge_count}</div>
                  <div className="text-[11px] text-purple-300/60">关系边</div>
                </div>
              </div>
            )}

            {progress && graphLoading && (
              <div className="mt-3">
                <div className="mb-1.5 flex justify-between text-[11px] text-white/40">
                  <span>{progress.message}</span>
                  <span>{Math.round(progress.progress)}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-purple-500 to-pink-500 transition-all duration-500"
                    style={{ width: `${progress.progress}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* 下一步 */}
        {graphData && (
          <button
            type="button"
            onClick={onComplete}
            className="group w-full rounded-2xl bg-gradient-to-r from-purple-600 via-violet-600 to-fuchsia-600 p-px shadow-lg shadow-purple-500/20 transition-all hover:shadow-purple-500/30"
          >
            <div className="flex items-center justify-center gap-2 rounded-[15px] bg-[#060612] px-6 py-3.5 transition-colors group-hover:bg-[#0a0a1a]">
              <span className="text-sm font-semibold text-white">下一步: 环境设置</span>
              <span className="text-purple-400 transition-transform group-hover:translate-x-1">→</span>
            </div>
          </button>
        )}

        {/* 错误提示 */}
        {error && (
          <div className="flex items-start gap-3 rounded-xl border border-rose-500/20 bg-rose-500/[0.06] p-4">
            <span className="text-rose-400">⚠</span>
            <div>
              <div className="text-sm text-rose-300">{error}</div>
              <button
                type="button"
                onClick={() => setError(null)}
                className="mt-1 text-[11px] text-rose-400/60 hover:text-rose-300"
              >
                关闭
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 右侧大预览区 */}
      <div className="lg:col-span-3">
        {graphData ? (
          <div className="overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.02]">
            <div className="border-b border-white/[0.06] px-5 py-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-white">知识图谱</div>
                <div className="flex gap-3 text-[11px] text-white/30">
                  <span>{graphData.node_count} 节点</span>
                  <span>{graphData.edge_count} 关系</span>
                </div>
              </div>
            </div>
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
          </div>
        ) : ontology ? (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
            <div className="mb-6 flex items-center gap-3">
              <span className="text-2xl">🧬</span>
              <div>
                <div className="text-lg font-semibold text-white">本体定义</div>
                <div className="text-xs text-white/40">{ontology.analysis_summary?.slice(0, 100) || '基于输入文本生成的本体结构'}</div>
              </div>
            </div>
            <div className="mb-5">
              <div className="mb-3 text-xs font-semibold uppercase tracking-widest text-blue-400/60">
                实体类型 ({ontology.entity_types.length})
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {ontology.entity_types.map(type => (
                  <div key={type.name} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 transition-colors hover:border-blue-500/20 hover:bg-blue-500/[0.03]">
                    <div className="mb-1 text-sm font-semibold text-white">{type.name}</div>
                    <div className="mb-2 text-xs leading-relaxed text-white/40">{type.description}</div>
                    {type.attributes.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {type.attributes.slice(0, 4).map((a, j) => (
                          <span key={j} className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-white/30">{a.name}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-3 text-xs font-semibold uppercase tracking-widest text-purple-400/60">
                关系类型 ({ontology.edge_types.length})
              </div>
              <div className="flex flex-wrap gap-2">
                {ontology.edge_types.map((edge, i) => (
                  <div key={i} className="rounded-xl border border-white/[0.06] bg-purple-500/5 px-3 py-2 transition-colors hover:border-purple-500/20">
                    <div className="text-xs font-medium text-purple-300">{edge.name}</div>
                    <div className="mt-0.5 text-[10px] text-white/25">{edge.description?.slice(0, 40)}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          /* 空状态 - 视觉引导 */
          <div className="flex min-h-[400px] items-center justify-center rounded-2xl border border-dashed border-white/[0.08] bg-white/[0.01]">
            <div className="max-w-sm text-center">
              <div className="relative mx-auto mb-6 flex h-24 w-24 items-center justify-center">
                {/* 装饰环 */}
                <div className="absolute inset-0 animate-spin rounded-full border border-dashed border-purple-500/20" style={{ animationDuration: '20s' }} />
                <div className="absolute inset-2 animate-spin rounded-full border border-dotted border-violet-500/15" style={{ animationDuration: '15s', animationDirection: 'reverse' }} />
                <span className="text-4xl">🧬</span>
              </div>
              <h3 className="mb-2 text-xl font-bold text-white">图谱构建</h3>
              <p className="text-sm leading-relaxed text-white/40">
                上传文档或输入文本,系统将自动提取实体和关系,构建知识图谱。这是整个模拟流程的基础。
              </p>
              <div className="mt-6 flex items-center justify-center gap-4 text-[11px] text-white/20">
                <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-purple-500/40" />支持 PDF</span>
                <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-blue-500/40" />自动抽取</span>
                <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500/40" />可视化图谱</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

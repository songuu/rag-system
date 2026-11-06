'use client';

import React, { useState, useEffect, useRef } from 'react';
import KnowledgeGraphViewer from '@/components/KnowledgeGraphViewer';
import type { ModelOverride, ProjectGraphIdentity, Ontology, GraphData } from '@/lib/mirofish/types';
import { useMiroFishLocale } from './MiroFishLocaleProvider';
import { toMiroFishViewerGraph } from '@/lib/mirofish/graph-view';
import { MIROFISH_SEED_MAX_TOTAL_BYTES, MIROFISH_SEED_MAX_FILES, MIROFISH_SEED_EXTENSIONS, type MiroFishSeedFileInfo } from '@/lib/mirofish/seed-file-contract';

interface Step1Props {
  projectId: string;
  simulationRequirement: string;
  initialTexts?: string[];
  initialSeedFiles?: MiroFishSeedFileInfo[];
  onSeedFilesPersist?: (files: MiroFishSeedFileInfo[]) => void | Promise<void>;
  ontology: Ontology | null;
  graphData: GraphData | null;
  modelOverride?: ModelOverride | null;
  initialTaskId?: string | null;
  onTaskStarted?: (taskId: string | null) => void | Promise<void>;
  onTextsPersist: (texts: string[]) => void | Promise<void>;
  onOntologyGenerated: (ontology: Ontology) => void | Promise<void>;
  onGraphBuilt: (graphData: GraphData, identity?: ProjectGraphIdentity) => void | Promise<void>;
  onComplete: () => void | Promise<void>;
}

export default function Step1GraphBuild({
  projectId,
  simulationRequirement,
  initialTexts,
  initialSeedFiles,
  onSeedFilesPersist,
  ontology,
  graphData,
  modelOverride,
  initialTaskId,
  onTaskStarted,
  onTextsPersist,
  onOntologyGenerated,
  onGraphBuilt,
  onComplete,
}: Step1Props) {
  const { locale, t } = useMiroFishLocale();
  const [texts, setTexts] = useState(() => initialTexts?.join('\n\n') ?? '');
  const textsRef = useRef(texts);
  useEffect(() => { textsRef.current = texts; }, [texts]);
  const [graphText, setGraphText] = useState('');
  const [ontologyLoading, setOntologyLoading] = useState(false);
  const [graphLoading, setGraphLoading] = useState(Boolean(initialTaskId) && !graphData);
  const [recoveringGraph, setRecoveringGraph] = useState(!initialTaskId && Boolean(ontology) && !graphData);
  const [graphTaskId, setGraphTaskId] = useState<string | null>(initialTaskId ?? null);
  const [recoveredGraph, setRecoveredGraph] = useState<{ graphId: string; documentVersion?: string; trustLevel?: string; graphGeneration?: string } | null>(null);
  const recoveryAttempted = useRef(false);
  const interruptedTask = useRef(false);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ status: string; progress: number; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<MiroFishSeedFileInfo[]>(initialSeedFiles ?? []);
  const [seedSavePending, setSeedSavePending] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSeedUpload = async (files: File[]) => {
    if (uploading || files.length === 0) return;
    if (files.some(file => !MIROFISH_SEED_EXTENSIONS.includes(file.name.split('.').at(-1)?.toLowerCase() as typeof MIROFISH_SEED_EXTENSIONS[number]))) {
      setError(t('支持 PDF、Markdown 和 TXT 文件', 'Choose PDF, Markdown or TXT files')); return;
    }
    if (files.length + uploadedFiles.length > MIROFISH_SEED_MAX_FILES) {
      setError(t('每个项目最多上传 10 个文件', 'Upload up to 10 files per project')); return;
    }
    if ([...files, ...uploadedFiles].reduce((sum, file) => sum + file.size, 0) > MIROFISH_SEED_MAX_TOTAL_BYTES) {
      setError(t('上传文件总量不能超过 50MB', 'Combined uploads must be 50 MB or smaller')); return;
    }
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      files.forEach(file => formData.append('files', file));
      const response = await fetch('/rag-api/mirofish/upload', { method: 'POST', headers: { 'Accept-Language': locale }, body: formData });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || t("上传失败"));
      const extracted = Array.isArray(data.texts) ? data.texts.join('\n\n') : data.text;
      if (typeof extracted !== 'string' || !extracted.trim()) throw new Error(t('文件中没有可读取的文本', 'No readable text was found in these files'));
      const nextTexts = [textsRef.current, extracted].filter(value => value.trim()).join('\n\n');
      const nextFiles = [...uploadedFiles, ...(Array.isArray(data.files) ? data.files : [{ filename: data.filename, pages: data.pages, size: data.size }])];
      textsRef.current = nextTexts;
      setTexts(nextTexts);
      setUploadedFiles(nextFiles);
      setSeedSavePending(true);
      await onTextsPersist([nextTexts]);
      await onSeedFilesPersist?.(nextFiles);
      setSeedSavePending(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('文件上传失败', 'File upload failed'));
    } finally {
      setUploading(false);
    }
  };

  const retrySeedSave = async () => {
    if (uploading) return;
    setUploading(true); setError(null);
    try {
      await onTextsPersist([textsRef.current]);
      await onSeedFilesPersist?.(uploadedFiles);
      setSeedSavePending(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('保存种子文件失败', 'Unable to save seed files'));
    } finally { setUploading(false); }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    void handleSeedUpload(files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDrop = (e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    setIsDragging(false);
    void handleSeedUpload(Array.from(e.dataTransfer.files));
  };

  const generateOntology = async () => {
    if (!texts.trim()) { setError(t("请输入分析文本")); return; }
    setOntologyLoading(true);
    setError(null);
    try {
      await onTextsPersist([texts]);
      if (seedSavePending) { await onSeedFilesPersist?.(uploadedFiles); setSeedSavePending(false); }
      const response = await fetch('/rag-api/mirofish/ontology', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept-Language': locale },
        body: JSON.stringify({
          texts: [texts],
          simulationRequirement,
          modelOverride: modelOverride || undefined,
        }),
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || t("本体生成失败"));
      await onOntologyGenerated(data.ontology);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("本体生成失败"));
    } finally {
      setOntologyLoading(false);
    }
  };

  const buildGraph = async () => {
    const textToUse = graphText.trim() || texts.trim();
    if (!textToUse) { setError(t("请输入文本内容")); return; }
    if (!ontology) { setError(t("请先生成本体")); return; }
    setGraphLoading(true);
    setError(null);
    setRecoveryNotice(null);
    setProgress({ status: 'pending', progress: 0, message: t("正在创建任务...") });
    try {
      const response = await fetch('/rag-api/mirofish/graph', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept-Language': locale },
        body: JSON.stringify({
          text: textToUse,
            projectId,
          ontology,
          graphName: `Project ${projectId} Graph`,
          modelOverride: modelOverride || undefined,
        }),
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || t("图谱构建失败"));
      setGraphTaskId(data.taskId);
      await onTaskStarted?.(data.taskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("图谱构建失败"));
      setGraphLoading(false);
    }
  };

  useEffect(() => {
    if (!ontology || graphData || graphTaskId || recoveryAttempted.current) return;
    recoveryAttempted.current = true;
    setRecoveringGraph(true);
    const controller = new AbortController();
    let cancelled = false;
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
    // Older projects did not persist task IDs. Recover only artifacts carrying
    // this exact project name, from the server's already-authorized catalog.
    void (async () => {
      try {
        const response = await fetch('/rag-api/mirofish/graph?action=list', { signal: controller.signal });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || t("读取已有图谱失败"));
        const artifact = result.graphs?.filter((item: { graphName?: string }) => item.graphName === `Project ${projectId} Graph`)
          .sort((a: { createdAt: string }, b: { createdAt: string }) => b.createdAt.localeCompare(a.createdAt))[0];
        if (!cancelled && artifact) {
          setRecoveredGraph(artifact);
          setRecoveryNotice(null);
          setError(null);
          setGraphLoading(true);
        } else if (!cancelled && interruptedTask.current) {
          setRecoveryNotice(t('上次图谱构建任务已中断，未找到已保存图谱。文本和本体已保留，请重新构建。',
            'The previous graph build was interrupted and no saved graph was found. Your text and ontology are preserved. Please build again.'));
        }
      } catch (cause) {
        if (!cancelled) setError(timedOut
          ? t('检查已有图谱超时，请重试。', 'Checking saved graphs timed out. Please try again.')
          : cause instanceof Error ? cause.message : t("读取已有图谱失败"));
      } finally {
        clearTimeout(deadline);
        if (!cancelled) setRecoveringGraph(false);
      }
    })();
    return () => { cancelled = true; clearTimeout(deadline); controller.abort(); recoveryAttempted.current = false; };
  }, [ontology, graphData, graphTaskId, projectId, t]);

  useEffect(() => {
    if ((!graphTaskId && !recoveredGraph) || !graphLoading) return;
    const controller = new AbortController();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pollStatus = async () => {
      let timedOut = false;
      const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
      try {
        let data;
        if (recoveredGraph) data = { ...recoveredGraph, status: 'completed', progress: 100, message: t("正在读取已完成图谱...") };
        else {
          const response = await fetch(`/rag-api/mirofish/graph?action=status&taskId=${encodeURIComponent(graphTaskId!)}`, { signal: controller.signal });
          data = await response.json();
          if (!cancelled && response.status === 404 && data.code === 'MIROFISH_GRAPH_NOT_FOUND') {
            // TaskManager is process-local; its absence after a restart does
            // not imply that the durable graph was lost. Clear the stale
            // reference before trying the authorized artifact catalog.
            await onTaskStarted?.(null);
            if (cancelled) return;
            interruptedTask.current = true;
            recoveryAttempted.current = false;
            setError(null);
            setProgress(null);
            setGraphLoading(false);
            setRecoveringGraph(true);
            setGraphTaskId(null);
            return;
          }
          if (!response.ok || !data.success) throw new Error(data.error || t("读取图谱任务失败"));
        }
        if (cancelled) return;
        setProgress({ status: data.status, progress: data.progress || 0, message: data.message || '' });
        if (data.status === 'failed') throw new Error(data.error || t("图谱构建失败"));
        if (data.status === 'completed') {
          if (!data.graphId) throw new Error(t("图谱任务缺少构建结果，请重新构建"));
          const params = new URLSearchParams({ action: 'data', graphId: data.graphId });
          for (const field of ['documentVersion', 'trustLevel', 'graphGeneration'] as const) {
            if (data[field]) params.set(field, data[field]);
          }
          const response = await fetch(`/rag-api/mirofish/graph?${params}`, { signal: controller.signal });
          const result = await response.json();
          if (!response.ok || !result.success || !result.graph) throw new Error(result.error || t("图谱已构建，但读取结果失败，请重试"));
          if (result.graph.graph_id !== data.graphId) throw new Error(t("图谱结果与构建任务不一致，请重试"));
          if (cancelled) return;
          await onGraphBuilt(result.graph, {
            documentId: data.graphId, documentVersion: result.documentVersion || data.documentVersion,
            trustLevel: result.trustLevel || data.trustLevel,
            ...(result.graphGeneration || data.graphGeneration ? { graphGeneration: result.graphGeneration || data.graphGeneration } : {}),
          });
          if (!cancelled) { setGraphLoading(false); setError(null); }
          return;
        }
        // Schedule only after the previous poll settles; slow readback cannot
        // create overlapping requests or save the same project repeatedly.
        timer = setTimeout(pollStatus, 2000);
      } catch (cause) {
        if (!cancelled) {
          setError(timedOut
            ? t('读取图谱任务或结果超时，请重新读取。', 'Reading the graph task or result timed out. Please retry.')
            : cause instanceof Error ? cause.message : t("读取图谱结果失败"));
          setGraphLoading(false);
        }
      } finally {
        clearTimeout(deadline);
      }
    };
    void pollStatus();
    return () => { cancelled = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [graphTaskId, recoveredGraph, graphLoading, onGraphBuilt, onTaskStarted, t]);

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
            const labels = [t("本体生成"), t("图谱构建"), t("完成")];
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
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-purple-400/70">{t("模拟需求")}</div>
          <div className="text-sm leading-relaxed text-white/70">{simulationRequirement || t("未设置")}</div>
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
              <div className="text-sm font-semibold text-white">{t("本体生成")}</div>
              <div className="text-[11px] text-white/40">{t("上传 PDF 或输入文本,提取实体 & 关系模式")}</div>
            </div>
          </div>

          {/* PDF 上传区 */}
          {!ontology && (
            <div className="mb-3">
              <input ref={fileInputRef} type="file" multiple accept=".pdf,.md,.markdown,.txt" onChange={handleFileSelect} className="hidden" />
              <button
                type="button"
                onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`w-full rounded-xl border-2 border-dashed p-5 text-center transition-all ${
                  isDragging
                    ? 'border-purple-500 bg-purple-500/10 scale-[1.01]'
                    : uploadedFiles.length > 0
                      ? 'border-emerald-500/40 bg-emerald-500/5'
                      : 'border-white/10 bg-white/[0.02] hover:border-purple-500/40 hover:bg-purple-500/[0.03]'
                }`}
              >
                {uploading ? (
                  <div className="flex items-center justify-center gap-2 text-sm text-white/50">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-purple-500/30 border-t-purple-500" />
                    {t('正在解析文件...', 'Parsing files...')}
                  </div>
                ) : uploadedFiles.length > 0 ? (
                  <div className="flex items-center justify-center gap-2 text-sm text-emerald-400">
                    <span>📄</span>
                    <span>{t('继续添加文件', 'Add more files')} ({uploadedFiles.length}/{MIROFISH_SEED_MAX_FILES})</span>
                  </div>
                ) : (
                  <div>
                    <div className="mb-1 text-2xl">📁</div>
                    <div className="text-sm text-white/60">{t('点击或拖放 PDF / Markdown / TXT 文件', 'Choose or drop PDF / Markdown / TXT files')}</div>
                    <div className="mt-1 text-[10px] text-white/25">{t('最多 10 个文件，合计 50MB', 'Up to 10 files, 50 MB combined')}</div>
                  </div>
                )}
              </button>
              {uploadedFiles.length > 0 && <ul className="mt-2 space-y-1 text-xs text-white/60" aria-label={t('种子文件', 'Seed files')}>
                {uploadedFiles.map((file, index) => <li key={`${file.filename}-${index}`} className="flex justify-between gap-2 rounded bg-white/5 px-3 py-2">
                  <span className="truncate">{file.filename}</span><span>{file.pages ? `${file.pages} ${t('页', 'pages')}` : `${Math.ceil(file.size / 1024)} KB`}</span>
                </li>)}
              </ul>}
              {seedSavePending && <button type="button" disabled={uploading} onClick={() => { void retrySeedSave(); }} className="mt-3 text-xs text-amber-300 disabled:opacity-40">{t('重试保存种子文件', 'Retry saving seed files')}</button>}
            </div>
          )}

          {/* 文本输入 */}
          <textarea
            value={texts}
            onChange={e => setTexts(e.target.value)}
            placeholder={t("直接输入或通过上方 PDF 上传填充...")}
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
              <span className="relative">{ontologyLoading ? t("正在分析实体与关系...") : t("🧬 生成本体")}</span>
            </button>
          ) : (
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-emerald-400">
                <span>✅</span>{t("本体已生成")}</div>
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
                <div className="text-sm font-semibold text-white">{t("图谱构建")}</div>
                <div className="text-[11px] text-white/40">{t("基于本体抽取实体与关系,构建知识图谱")}</div>
              </div>
            </div>

            <textarea
              value={graphText}
              onChange={e => setGraphText(e.target.value)}
              placeholder={t("输入要构建图谱的文本(可选,留空则使用本体文本)...")}
              disabled={!!graphData}
              rows={3}
              className="mb-3 w-full resize-none rounded-xl border border-white/[0.08] bg-black/30 px-4 py-3 text-sm text-white placeholder:text-white/20 focus:border-purple-500/40 focus:outline-none focus:ring-1 focus:ring-purple-500/20 disabled:opacity-40"
            />

            {recoveryNotice && !graphData && <p role="status" className="mb-3 text-xs leading-relaxed text-amber-200/80">{recoveryNotice}</p>}

            {!graphData ? (
              <button
                type="button"
                onClick={() => {
                  if ((graphTaskId || recoveredGraph) && progress?.status !== 'failed') {
                    setError(null);
                    setGraphLoading(true);
                  } else { void buildGraph(); }
                }}
                disabled={graphLoading || recoveringGraph}
                className="group relative w-full overflow-hidden rounded-xl bg-gradient-to-r from-purple-600 to-violet-600 py-3 text-sm font-semibold text-white shadow-lg shadow-purple-500/20 transition-all hover:shadow-purple-500/30 disabled:opacity-40 disabled:shadow-none"
              >
                {graphLoading && (
                  <div className="absolute inset-0 bg-gradient-to-r from-purple-600/0 via-white/10 to-purple-600/0 animate-pulse" />
                )}
                <span className="relative">{recoveringGraph ? t("正在检查已有图谱...") : graphLoading ? t("构建中...") : (graphTaskId || recoveredGraph) && progress?.status !== 'failed' ? t("重新读取图谱") : t("🔗 构建图谱")}</span>
              </button>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-blue-500/10 p-4 text-center">
                  <div className="text-2xl font-bold text-blue-400">{graphData.node_count}</div>
                  <div className="text-[11px] text-blue-300/60">{t("实体节点")}</div>
                </div>
                <div className="rounded-xl bg-purple-500/10 p-4 text-center">
                  <div className="text-2xl font-bold text-purple-400">{graphData.edge_count}</div>
                  <div className="text-[11px] text-purple-300/60">{t("关系边")}</div>
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
            disabled={advancing}
            onClick={async () => {
              setAdvancing(true);
              try { await onComplete(); }
              catch (cause) { setError(cause instanceof Error ? cause.message : t("进入下一步失败")); }
              finally { setAdvancing(false); }
            }}
            className="group w-full rounded-2xl bg-gradient-to-r from-purple-600 via-violet-600 to-fuchsia-600 p-px shadow-lg shadow-purple-500/20 transition-all hover:shadow-purple-500/30"
          >
            <div className="flex items-center justify-center gap-2 rounded-[15px] bg-[#060612] px-6 py-3.5 transition-colors group-hover:bg-[#0a0a1a]">
              <span className="text-sm font-semibold text-white">{t("下一步: 环境设置")}</span>
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
              >{t("关闭")}</button>
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
                <div className="text-sm font-semibold text-white">{t("知识图谱")}</div>
                <div className="flex gap-3 text-[11px] text-white/30">
                  <span>{graphData.node_count}{t("节点")}</span>
                  <span>{graphData.edge_count}{t("关系")}</span>
                </div>
              </div>
            </div>
            <KnowledgeGraphViewer
              graph={toMiroFishViewerGraph(graphData)}
            />
          </div>
        ) : ontology ? (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
            <div className="mb-6 flex items-center gap-3">
              <span className="text-2xl">🧬</span>
              <div>
                <div className="text-lg font-semibold text-white">{t("本体定义")}</div>
                <div className="text-xs text-white/40">{ontology.analysis_summary?.slice(0, 100) || t("基于输入文本生成的本体结构")}</div>
              </div>
            </div>
            <div className="mb-5">
              <div className="mb-3 text-xs font-semibold uppercase tracking-widest text-blue-400/60">{t("实体类型 (")}{ontology.entity_types.length})
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
              <div className="mb-3 text-xs font-semibold uppercase tracking-widest text-purple-400/60">{t("关系类型 (")}{ontology.edge_types.length})
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
              <h3 className="mb-2 text-xl font-bold text-white">{t("图谱构建")}</h3>
              <p className="text-sm leading-relaxed text-white/40">{t("上传文档或输入文本,系统将自动提取实体和关系,构建知识图谱。这是整个模拟流程的基础。")}</p>
              <div className="mt-6 flex items-center justify-center gap-4 text-[11px] text-white/20">
                <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-purple-500/40" />{t("支持 PDF")}</span>
                <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-blue-500/40" />{t("自动抽取")}</span>
                <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500/40" />{t("可视化图谱")}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

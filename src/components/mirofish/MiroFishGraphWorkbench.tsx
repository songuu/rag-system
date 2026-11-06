'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import KnowledgeGraphViewer from '@/components/KnowledgeGraphViewer';
import { toMiroFishViewerGraph, type MiroFishGraphViewInput } from '@/lib/mirofish/graph-view';
import type { ProjectGraphIdentity } from '@/lib/mirofish/types';
import { useMiroFishLocale } from './MiroFishLocaleProvider';

export default function MiroFishGraphWorkbench({ graph, identity, simulationRunning = false, simulationId, children }: {
  graph: MiroFishGraphViewInput | null; identity?: ProjectGraphIdentity | null; simulationRunning?: boolean; simulationId?: string | null; children: React.ReactNode;
}) {
  const { locale, t } = useMiroFishLocale();
  const [mode, setMode] = useState<'graph' | 'split' | 'workbench'>(graph ? 'split' : 'workbench');
  const params = identity ? new URLSearchParams({ action: 'data', graphId: identity.documentId,
    documentVersion: identity.documentVersion, trustLevel: identity.trustLevel,
    ...(identity.graphGeneration ? { graphGeneration: identity.graphGeneration } : {}) }).toString() : '';
  const requestKey = JSON.stringify([params, simulationId]);
  const [readback, setReadback] = useState<{ key: string; graph: MiroFishGraphViewInput | null } | null>(null);
  const visibleGraph = readback?.key === params ? readback.graph : graph;
  const viewerGraph = useMemo(() => visibleGraph ? toMiroFishViewerGraph(visibleGraph) : null, [visibleGraph]);
  const [pending, setPending] = useState<string | null>(null);
  const refreshing = pending === requestKey;
  const [lastRead, setLastRead] = useState('');
  const [error, setError] = useState('');
  const [memoryError, setMemoryError] = useState('');
  const [memoryReadback, setMemoryReadback] = useState<{ id: string; memory: Record<string, { observations: string[] }>; projection?: { enabled: boolean; status: string; projectedEventSequence: number; committedEventSequence: number; errorCode?: string } } | null>(null);
  const memory = memoryReadback?.id === simulationId ? memoryReadback : null;
  const activeRequest = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if ((!params && !simulationId) || activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setPending(requestKey);
    const read = async (url: string) => {
      const response = await fetch(url, { signal: controller.signal, headers: { 'Accept-Language': locale } });
      return { ok: response.ok, status: response.status, body: await response.json() };
    };
    try {
      // Independent, scoped evidence spaces: a failed graph read must not hide simulation observations.
      const [source, isolated] = await Promise.allSettled([
        params ? read('/rag-api/mirofish/graph?' + params) : Promise.resolve(null),
        simulationId ? read('/rag-api/mirofish/simulation/' + encodeURIComponent(simulationId) + '?action=memory') : Promise.resolve(null),
      ]);
      if (controller.signal.aborted) return;
      if (source.status === 'rejected') setError(t('图谱刷新失败', 'Graph refresh failed'));
      else if (source.value) {
        const result = source.value.body;
        if (!source.value.ok || !result.success || !result.graph || result.graph.graph_id !== identity?.documentId) {
          if ([403, 404, 409].includes(source.value.status)) setReadback({ key: params, graph: null });
          setError(result.error || t('图谱刷新失败', 'Graph refresh failed'));
        } else { setReadback({ key: params, graph: result.graph }); setError(''); }
      }
      if (isolated.status === 'rejected') setMemoryError(t('模拟观察读取失败', 'Unable to read simulation observations'));
      else if (isolated.value) {
        const result = isolated.value.body;
        if (!isolated.value.ok || !result.success || result.evidenceScope !== 'simulation') {
          setMemoryReadback(null); setMemoryError(result.error || t('模拟观察读取失败', 'Unable to read simulation observations'));
        } else {
          setMemoryReadback({ id: simulationId!, memory: result.memory || {}, projection: result.projection }); setMemoryError('');
        }
      }
      setLastRead(new Date().toLocaleTimeString(locale === 'en' ? 'en-US' : 'zh-CN'));
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      if (!controller.signal.aborted) setPending(null);
    }
  }, [identity?.documentId, locale, params, requestKey, simulationId, t]);
  useEffect(() => () => { activeRequest.current?.abort(); activeRequest.current = null; }, [requestKey]);
  useEffect(() => { if (simulationId) void refresh(); }, [refresh, simulationId]);
  useEffect(() => {
    if (!simulationRunning || (!params && !simulationId)) return;
    const timer = setInterval(() => { void refresh(); }, 30_000);
    return () => clearInterval(timer);
  }, [params, refresh, simulationId, simulationRunning]);
  return <section className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-slate-900/50 p-3">
      <div className="flex gap-2" aria-label={t('工作台布局', 'Workbench layout')}>
        {(['graph', 'split', 'workbench'] as const).map(value => <button key={value} type="button" aria-pressed={mode === value}
          onClick={() => setMode(value)} className={`rounded-lg px-3 py-2 text-xs ${mode === value ? 'bg-purple-600 text-white' : 'text-slate-400 hover:bg-white/5'}`}>
          {value === 'graph' ? t('图谱', 'Graph') : value === 'split' ? t('分屏', 'Split') : t('工作区', 'Workbench')}
        </button>)}
      </div>
      <div className="flex items-center gap-3 text-xs text-slate-400">
        {lastRead && <span>{t('最近读取', 'Last read')}: {lastRead}</span>}
        <button type="button" disabled={(!params && !simulationId) || refreshing} onClick={() => { void refresh(); }} className="rounded-lg border border-white/15 px-3 py-2 disabled:opacity-40">
          {refreshing ? t('刷新中...', 'Refreshing...') : t('刷新图谱', 'Refresh graph')}
        </button>
      </div>
    </div>
    {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
    <div className={mode === 'split' ? 'grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]' : 'min-w-0'}>
      <div hidden={mode === 'workbench'} className="min-w-0">
        {viewerGraph ? <KnowledgeGraphViewer graph={viewerGraph} /> : <div className="rounded-xl border border-dashed border-white/15 p-10 text-center text-sm text-slate-400">{t('图谱完成后将在这里显示', 'The graph will appear here after building')}</div>}
        {simulationId && <div className="mt-4 space-y-3 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4">
          <h3 className="text-sm font-semibold text-cyan-200">{t('本次模拟观察', 'Observations from this simulation')}</h3>
          <p className="text-xs text-slate-400">{t('以下内容仅属于本次模拟，不会修改原始知识图谱', 'These observations belong to this simulation and do not change the source knowledge graph')}</p>
          {memoryError && <p role="alert" className="text-xs text-rose-300">{memoryError}</p>}
          {memory?.projection?.enabled && <p className="text-xs text-cyan-300">{t('同步状态', 'Sync status')}: {memory.projection.status} · {memory.projection.projectedEventSequence}/{memory.projection.committedEventSequence} {memory.projection.errorCode}</p>}
          {memory ? <ul className="max-h-64 space-y-2 overflow-auto text-xs text-slate-300">{Object.entries(memory.memory).flatMap(([agentId, state]) => state.observations.slice(-3).map((observation, index) => <li key={agentId + '-' + index} className="rounded bg-black/20 p-2"><strong>{visibleGraph?.nodes.find(node => node.uuid === agentId)?.name || agentId}</strong><p className="mt-1 whitespace-pre-wrap">{observation}</p></li>)).slice(-30)}</ul> : <p className="text-xs text-slate-500">{t('尚无可展示的模拟观察', 'No simulation observations to display yet')}</p>}
        </div>}
      </div>
      <div hidden={mode === 'graph'} className="min-w-0">{children}</div>
    </div>
  </section>;
}

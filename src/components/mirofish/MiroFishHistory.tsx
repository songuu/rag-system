'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { MiroFishSeedFileInfo } from '@/lib/mirofish/seed-file-contract';
import { useMiroFishLocale } from './MiroFishLocaleProvider';

export interface MiroFishHistoryProject { id: string; name: string; simulation_requirement: string; seed_files?: MiroFishSeedFileInfo[] }
interface HistoryRun { simulation_id: string; project_id: string; status: string; current_round: number; config?: { round_count?: number };
  total_posts?: number; created_at: string; updated_at?: string; report_id?: string; report_ids?: string[];
  simulation_requirement?: string; seed_files?: MiroFishSeedFileInfo[] }

export default function MiroFishHistory({ projects }: { projects: MiroFishHistoryProject[] }) {
  const { locale, t } = useMiroFishLocale();
  const [runs, setRuns] = useState<HistoryRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const projectMap = useMemo(() => new Map(projects.map(project => [project.id, project])), [projects]);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/rag-api/mirofish/simulation', { signal: controller.signal, headers: { 'Accept-Language': locale } });
        const result = await response.json();
        if (!response.ok || !result.success || !Array.isArray(result.simulations)) throw new Error(result.error || t('读取运行历史失败', 'Unable to load simulation history'));
        if (!controller.signal.aborted) { setRuns(result.simulations); setError(''); }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('读取运行历史失败', 'Unable to load simulation history'));
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [locale, reload, t]);
  const visible = runs.filter(run => {
    const project = projectMap.get(run.project_id);
    return (status === 'all' || run.status === status) && `${project?.name ?? ''} ${run.simulation_requirement ?? project?.simulation_requirement ?? ''} ${run.simulation_id}`.toLocaleLowerCase().includes(search.toLocaleLowerCase());
  }).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const statusLabel = (value: string) => ({ created: t('已创建', 'Created'), preparing: t('准备中', 'Preparing'), ready: t('已就绪', 'Ready'), running: t('运行中', 'Running'), paused: t('已暂停', 'Paused'), stopping: t('正在停止', 'Stopping'), stopped: t('已停止', 'Stopped'), finalizing: t('正在保存最终状态', 'Saving final state'), completed: t('已完成', 'Completed'), failed: t('失败', 'Failed') }[value] ?? value);
  return <section className="mt-10 space-y-4" aria-label={t('运行历史', 'Run history')}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-xl font-semibold text-white">{t('运行历史', 'Run history')}</h2><p className="mt-1 text-xs text-slate-400">{t('每次模拟分别保留，可重新打开同一项目的不同运行', 'Every simulation is preserved, including multiple runs of the same project')}</p></div>
      <button type="button" onClick={() => { setLoading(true); setReload(value => value + 1); }} className="rounded-lg border border-slate-600 px-3 py-2 text-xs text-slate-300">{t('刷新', 'Refresh')}</button>
    </div>
    <div className="flex flex-wrap gap-3">
      <input value={search} onChange={event => setSearch(event.target.value)} aria-label={t('搜索运行历史', 'Search run history')} placeholder={t('按项目、需求或运行 ID 搜索', 'Search projects, requirements or run IDs')} className="min-w-56 flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white" />
      <select value={status} onChange={event => setStatus(event.target.value)} aria-label={t('运行状态', 'Run status')} className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white">
        <option value="all">{t('全部状态', 'All statuses')}</option>{[...new Set(runs.map(run => run.status))].map(value => <option key={value} value={value}>{statusLabel(value)}</option>)}
      </select>
    </div>
    {error && <p role="alert" className="rounded-lg bg-rose-500/10 p-3 text-sm text-rose-300">{error}</p>}
    {loading ? <p className="py-6 text-sm text-slate-400">{t('正在读取运行历史...', 'Loading run history...')}</p> : visible.length === 0 ? <p className="rounded-xl border border-dashed border-slate-700 p-8 text-center text-sm text-slate-400">{t('暂无匹配的运行记录', 'No matching simulations')}</p> : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {visible.map(run => {
        const project = projectMap.get(run.project_id);
        const seedFiles = run.seed_files ?? project?.seed_files;
        const reportId = run.report_id || run.report_ids?.at(-1);
        const url = (step: number) => `/mirofish/console/${encodeURIComponent(run.project_id)}?${new URLSearchParams({ simulationId: run.simulation_id, step: String(step), ...(reportId ? { reportId } : {}) })}`;
        return <article key={run.simulation_id} data-run-id={run.simulation_id} className="space-y-3 rounded-xl border border-slate-700 bg-slate-800/40 p-5">
          <div className="flex items-center justify-between gap-2"><h3 className="truncate font-semibold text-white">{project?.name || run.project_id}</h3><span className="shrink-0 rounded bg-purple-500/15 px-2 py-1 text-xs text-purple-300">{statusLabel(run.status)}</span></div>
          <p className="break-all font-mono text-[11px] text-slate-500">{run.simulation_id}</p>
          <p className="line-clamp-3 text-xs leading-relaxed text-slate-300">{run.simulation_requirement ?? project?.simulation_requirement}</p>
          {seedFiles?.length ? <ul className="space-y-1 text-xs text-slate-400">{seedFiles.map((file, index) => <li key={`${file.filename}-${index}`} className="truncate">📄 {file.filename}</li>)}</ul> : null}
          <div className="flex justify-between text-xs text-slate-400"><span>{t('轮数', 'Rounds')}: {run.current_round || 0}/{run.config?.round_count || 0}</span><span>{t('帖子', 'Posts')}: {run.total_posts || 0}</span></div>
          <time className="block text-xs text-slate-500" dateTime={run.created_at}>{new Date(run.created_at).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN')}</time>
          <div className="flex flex-wrap gap-3 border-t border-white/5 pt-3 text-xs text-purple-300">
            <Link href={url(2)}>{t('图谱与运行', 'Graph and run')}</Link>
            {reportId ? <Link href={url(3)}>{t('分析报告', 'Report')}</Link> : <span className="text-slate-600">{t('报告未生成', 'No report yet')}</span>}
          </div>
        </article>;
      })}
    </div>}
  </section>;
}

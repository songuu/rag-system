'use client';
import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { ModelOverride } from '@/lib/mirofish/types';
import type { ReportRuntimeRecord } from '@/lib/mirofish/report-contracts';
import { useMiroFishLocale } from '@/components/mirofish/MiroFishLocaleProvider';

interface Step4Props {
  simulationId: string; projectId: string; reportId: string | null; modelOverride?: ModelOverride | null;
  onReportGenerated: (reportId: string) => void | Promise<void>; onComplete: () => void | Promise<void>;
}
function responseError(data: { error?: unknown }, fallback: string): Error {
  return new Error(typeof data.error === 'string' ? data.error : fallback);
}
export default function Step4Report({ simulationId, projectId, reportId, modelOverride, onReportGenerated, onComplete }: Step4Props) {
  const { locale, t } = useMiroFishLocale();
  const [report, setReport] = useState<ReportRuntimeRecord | null>(null);
  const [activeId, setActiveId] = useState(reportId);
  const [pendingSave, setPendingSave] = useState<string | null>(null);
  const [reading, setReading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [discoveryRefresh, setDiscoveryRefresh] = useState(0);
  const [tab, setTab] = useState<'report' | 'tools' | 'console'>('report');
  const callbacks = useRef({ onReportGenerated, onComplete });
  const currentSimulation = useRef(simulationId);
  useEffect(() => { callbacks.current = { onReportGenerated, onComplete }; currentSimulation.current = simulationId; }, [onReportGenerated, onComplete, simulationId]);
  const actionController = useRef<AbortController | null>(null);
  useEffect(() => () => actionController.current?.abort(), [simulationId]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function recover() {
      await Promise.resolve();
      if (cancelled) return;
      if (reportId) { setActiveId(reportId); setReading(false); return; }
      setReading(true); setVerified(false); setReport(null); setError(null); setActiveId(null); setPendingSave(null);
      try {
        const query = new URLSearchParams({ action: 'by-simulation', simulation_id: simulationId, project_id: projectId });
        const response = await fetch('/rag-api/mirofish/report?' + query, { signal: controller.signal, headers: { 'Accept-Language': locale } });
        const data = await response.json();
        if (!response.ok || !data.success) throw responseError(data, t('读取报告失败', 'Unable to load report'));
        if (cancelled || !data.report) return;
        const found = data.report as ReportRuntimeRecord;
        setReport(found); setActiveId(found.report_id);
        setPendingSave(found.report_id);
        await callbacks.current.onReportGenerated(found.report_id);
        // Saving can update reportId and replace this effect before its promise
        // settles. Clear the save barrier for the same simulation nonetheless.
        if (currentSimulation.current === simulationId) setPendingSave(value => value === found.report_id ? null : value);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : t('读取报告失败', 'Unable to load report'));
      } finally { if (!cancelled) setReading(false); }
    }
    void recover();
    return () => { cancelled = true; controller.abort(); };
  }, [simulationId, projectId, reportId, locale, t, discoveryRefresh]);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function poll() {
      try {
        const response = await fetch('/rag-api/mirofish/report/' + encodeURIComponent(activeId!), { signal: controller.signal, headers: { 'Accept-Language': locale } });
        const data = await response.json();
        if (!response.ok || !data.success || !data.report) throw responseError(data, t('读取报告失败', 'Unable to load report'));
        if (cancelled) return;
        setReport(data.report); setVerified(true); setReading(false);
        if (data.report.status === 'generating') timer = setTimeout(() => void poll(), 2000);
      } catch (reason) {
        if (!cancelled) { setVerified(false); setReading(false); setError(reason instanceof Error ? reason.message : t('读取报告失败', 'Unable to load report')); }
      }
    }
    void poll();
    return () => { cancelled = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [activeId, refresh, locale, t]);

  async function generate(mode: 'new' | 'resume' | 'force' = 'new') {
    if (busy || reading) return;
    const boundSimulation = simulationId;
    const controller = new AbortController(); actionController.current?.abort(); actionController.current = controller;
    setBusy(true); setError(null); setVerified(false);
    try {
      const response = await fetch('/rag-api/mirofish/report', { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'Accept-Language': locale },
        body: JSON.stringify({ simulation_id: simulationId, project_id: projectId, modelOverride: modelOverride ?? undefined,
          ...(mode === 'resume' ? { resume_report_id: activeId } : {}), force_regenerate: mode === 'force' }) });
      const data = await response.json();
      if (!response.ok || !data.success) throw responseError(data, t('生成报告失败', 'Unable to generate report'));
      if (currentSimulation.current !== boundSimulation || controller.signal.aborted) return;
      setPendingSave(data.report_id); setActiveId(data.report_id);
      await callbacks.current.onReportGenerated(data.report_id);
      if (currentSimulation.current === boundSimulation && !controller.signal.aborted) { setPendingSave(null); setRefresh(value => value + 1); }
    } catch (reason) {
      if (currentSimulation.current === boundSimulation && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : t('生成报告失败', 'Unable to generate report'));
    } finally { if (currentSimulation.current === boundSimulation) setBusy(false); }
  }
  async function saveAgain() {
    if (!pendingSave || busy) return;
    setBusy(true); setError(null);
    try { await callbacks.current.onReportGenerated(pendingSave); setPendingSave(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('保存报告失败', 'Unable to save report')); }
    finally { setBusy(false); }
  }
  async function complete() {
    setBusy(true); setError(null);
    try { await callbacks.current.onComplete(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('保存步骤失败', 'Unable to save progress')); }
    finally { setBusy(false); }
  }
  const generating = report?.status === 'generating';
  const done = report?.status === 'completed' && report.simulation_id === simulationId && (!reportId || report.report_id === reportId) && verified && !pendingSave;
  const stages = { pending: t('等待生成', 'Queued'), planning: t('规划目录', 'Planning outline'), generating: t('逐章研究', 'Researching chapters'),
    assembling: t('组装报告', 'Assembling report'), completed: t('报告完成', 'Report complete'), failed: t('生成失败', 'Generation failed') };
  const button = 'rounded-lg border border-purple-500/30 bg-purple-600/20 px-4 py-2 text-xs text-purple-200 disabled:opacity-40';
  return <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
    <aside className="space-y-4">
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <h2 className="font-semibold">{t('报告研究工作台', 'Report research')}</h2>
        <p className="mt-2 text-xs leading-6 text-white/50">{t('动态规划目录，结合图谱检索和真实参与者采访，逐章生成带证据的报告。', 'Plan an outline, research graph evidence and interview participants, then assemble the report.')}</p>
        <p role="status" className="mt-4 text-sm text-purple-300">{reading ? t('正在恢复报告…', 'Restoring report…') : report ? stages[report.stage] ?? report.status : t('准备生成报告', 'Ready to generate')}</p>
        {report ? <><progress aria-label={t('报告进度', 'Report progress')} className="mt-3 w-full accent-purple-500" value={report.progress ?? 0} max="100" />
          <div className="mt-2 text-xs text-white/50">{report.sections.length}/{report.outline?.sections.length ?? '?'} {t('章已保存', 'chapters saved')} · {report.progress ?? 0}%</div></> : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {!activeId ? <button className={button} disabled={busy || reading} onClick={() => void generate()}>{t('生成分析报告', 'Generate report')}</button> : null}
          {report?.status === 'failed' ? <><button className={button} disabled={busy} onClick={() => void generate('resume')}>{t('恢复生成', 'Resume generation')}</button>
            <button className={button} disabled={busy} onClick={() => void generate('force')}>{t('重新生成', 'Regenerate')}</button></> : null}
          {pendingSave ? <button className={button} disabled={busy} onClick={() => void saveAgain()}>{t('重试保存报告', 'Retry saving report')}</button> : null}
          {done ? <><a className={button} href={'/rag-api/mirofish/report/' + activeId + '?action=download'}>{t('下载 Markdown', 'Download Markdown')}</a>
            <button className={button} disabled={busy} onClick={() => void complete()}>{t('下一步：深度交互', 'Next: interaction')}</button></> : null}
        </div>
        {generating ? <p className="mt-3 text-xs text-white/40">{t('章节与日志会持续保存，刷新后可继续查看。', 'Chapters and logs are saved as the report progresses.')}</p> : null}
      </div>
      {error ? <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-xs text-red-300">{error}
        <button className="ml-3 underline" onClick={() => { setError(null); if (activeId) setRefresh(value => value + 1); else setDiscoveryRefresh(value => value + 1); }}>{t('重新读取', 'Reload')}</button></div> : null}
      {report?.outline ? <nav aria-label={t('报告目录', 'Report outline')} className="rounded-xl border border-white/10 p-4"><h3 className="mb-3 text-xs text-white/50">{t('报告目录', 'Report outline')}</h3>
        {report.outline.sections.map((section, index) => <a key={index} href={'#report-section-' + index} className="mb-3 block text-xs leading-5 text-white/70">
          {index < report.sections.length ? '✓ ' : index === report.current_section ? '◉ ' : '○ '}{section.title}</a>)}</nav> : null}
    </aside>
    <main className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="mb-5 flex gap-4 border-b border-white/10 pb-3">
        {(['report', 'tools', 'console'] as const).map(value => <button key={value} aria-pressed={tab === value} className={tab === value ? 'text-sm text-purple-300' : 'text-sm text-white/40'} onClick={() => setTab(value)}>
          {value === 'report' ? t('报告', 'Report') : value === 'tools' ? t('工具证据', 'Tool evidence') : t('运行日志', 'Run log')}</button>)}
      </div>
      {!report ? <p className="py-16 text-center text-sm text-white/40">{t('报告将在这里逐章出现。', 'Report chapters will appear here.')}</p> : tab === 'report' ? <>
        <h1 className="text-xl font-semibold">{report.title}</h1><p className="my-4 text-sm leading-7 text-white/60">{report.summary}</p>
        {report.sections.map(section => <section key={section.index} id={'report-section-' + section.index} className="mb-7 scroll-mt-24 border-t border-white/10 pt-5">
          <h2 className="mb-3 text-base font-semibold text-purple-200">{section.title}</h2><div className="prose prose-sm prose-invert max-w-none text-white/75"><ReactMarkdown>{section.content}</ReactMarkdown></div></section>)}
      </> : tab === 'tools' ? <div className="space-y-3">{report.events.filter(event => event.action === 'tool_call' || event.action === 'tool_result').map(event =>
        <details key={event.sequence} className="rounded-lg border border-white/10 p-3"><summary className="cursor-pointer text-xs text-purple-200">{event.sequence}. {event.details?.tool_name} · {event.message}</summary>
          <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-[11px] text-white/60">{JSON.stringify(event.details, null, 2)}</pre></details>)}</div>
        : <ol className="space-y-2 font-mono text-[11px] text-white/60">{report.events.map(event => <li key={event.sequence}>{event.timestamp.slice(11, 19)} {event.message}</li>)}</ol>}
    </main>
  </div>;
}

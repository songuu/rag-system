'use client';
import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useMiroFishLocale } from '@/components/mirofish/MiroFishLocaleProvider';
import type { ModelOverride } from '@/lib/mirofish/types';
import type { ReportRuntimeRecord, ReportSource } from '@/lib/mirofish/report-contracts';
interface AgentProfile { entity_id: string; entity_name: string; entity_type: string; full_name: string; occupation?: string; background?: string; personality_traits?: string[] }
interface ChatMessage { role: 'user' | 'assistant'; content: string; timestamp?: string; sources?: ReportSource[]; tool_calls?: Array<{ name: string }> }
interface InterviewAnswer { agent_id: string; agent_name: string; question: string; answer: string; sentiment: string; confidence: number; platform_answers?: Record<string, string>; sources?: ReportSource[] }
interface Props { simulationId: string; reportId: string; agents: AgentProfile[]; modelOverride?: ModelOverride | null }
function failure(data: { error?: unknown }, fallback: string): Error { return new Error(typeof data.error === 'string' ? data.error : fallback); }
export default function Step5Interaction({ simulationId, reportId, agents, modelOverride }: Props) {
  const { locale, t } = useMiroFishLocale();
  const [profiles, setProfiles] = useState<AgentProfile[]>(agents);
  const [report, setReport] = useState<ReportRuntimeRecord | null>(null);
  const [target, setTarget] = useState('report');
  const [conversations, setConversations] = useState<Record<string, ChatMessage[]>>({});
  const [input, setInput] = useState('');
  const [historyLoading, setHistoryLoading] = useState(true);
  const [chatBusy, setChatBusy] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [question, setQuestion] = useState('');
  const [custom, setCustom] = useState(false);
  const [questions, setQuestions] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<InterviewAnswer[]>([]);
  const [mode, setMode] = useState<'chat' | 'questionnaire'>('chat');
  const [refresh, setRefresh] = useState(0);
  const [metadataRefresh, setMetadataRefresh] = useState(0);
  const bound = useRef({ simulationId, reportId });
  useEffect(() => { bound.current = { simulationId, reportId }; }, [simulationId, reportId]);
  const action = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    async function load() {
      await Promise.resolve();
      if (cancelled) return;
      setReport(null); setProfiles(agents); setConversations({}); setAnswers([]); setSelected([]); setError(null);
      try {
        const [profileResponse, reportResponse] = await Promise.all([
          fetch('/rag-api/mirofish/interaction/interview?' + new URLSearchParams({ simulation_id: simulationId }), { signal: controller.signal, headers: { 'Accept-Language': locale } }),
          fetch('/rag-api/mirofish/report/' + encodeURIComponent(reportId), { signal: controller.signal, headers: { 'Accept-Language': locale } }),
        ]);
        const [profileData, reportData] = await Promise.all([profileResponse.json(), reportResponse.json()]);
        if (!profileResponse.ok || !profileData.success) throw failure(profileData, t('读取参与者失败', 'Unable to load participants'));
        if (!reportResponse.ok || !reportData.success) throw failure(reportData, t('读取报告失败', 'Unable to load report'));
        if (!cancelled) { setProfiles(profileData.profiles); setReport(reportData.report); }
      } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : t('读取失败', 'Unable to load data')); }
    }
    void load();
    return () => { cancelled = true; controller.abort(); action.current?.abort(); };
    // The API supplies canonical profiles; prop changes are a fallback only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulationId, reportId, locale, t, metadataRefresh]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function loadHistory() {
      await Promise.resolve();
      if (cancelled) return;
      setHistoryLoading(true); setError(null);
      try {
        const url = target === 'report'
          ? '/rag-api/mirofish/interaction/chat?' + new URLSearchParams({ report_id: reportId })
          : '/rag-api/mirofish/interaction/interview?' + new URLSearchParams({ action: 'history', simulation_id: simulationId, agent_id: target });
        const response = await fetch(url, { signal: controller.signal, headers: { 'Accept-Language': locale } });
        const data = await response.json();
        if (!response.ok || !data.success) throw failure(data, t('读取对话失败', 'Unable to load conversation'));
        if (!cancelled) setConversations(previous => ({ ...previous, [target]: data.messages ?? [] }));
      } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : t('读取对话失败', 'Unable to load conversation')); }
      finally { if (!cancelled) setHistoryLoading(false); }
    }
    void loadHistory();
    return () => { cancelled = true; controller.abort(); };
  }, [target, simulationId, reportId, locale, t, refresh]);

  async function send() {
    if (!input.trim() || chatBusy || historyLoading) return;
    const text = input.trim(); const object = target; const sim = simulationId; const reportKey = reportId;
    const controller = new AbortController(); action.current?.abort(); action.current = controller;
    setChatBusy(true); setError(null);
    try {
      const endpoint = object === 'report' ? 'chat' : 'interview';
      const response = await fetch('/rag-api/mirofish/interaction/' + endpoint, { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'Accept-Language': locale },
        body: JSON.stringify({ report_id: reportKey, simulation_id: sim, ...(object !== 'report' ? { agent_id: object } : {}), question: text, modelOverride: modelOverride ?? undefined }) });
      const data = await response.json();
      if (!response.ok || !data.success) throw failure(data, t('对话失败', 'Unable to send message'));
      if (bound.current.simulationId !== sim || bound.current.reportId !== reportKey || controller.signal.aborted) return;
      const answer = object === 'report' ? data : data.response;
      setConversations(previous => ({ ...previous, [object]: [...(previous[object] ?? []),
        { role: 'user', content: text }, { role: 'assistant', content: answer.answer, sources: answer.sources, tool_calls: answer.tool_calls }] }));
      setInput('');
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t('对话失败', 'Unable to send message')); }
    finally { setChatBusy(false); }
  }
  async function interview() {
    if (batchBusy || !selected.length || (!custom && !question.trim())) return;
    const sim = simulationId;
    const controller = new AbortController(); action.current?.abort(); action.current = controller;
    setBatchBusy(true); setError(null);
    try {
      const response = await fetch('/rag-api/mirofish/interaction/interview', { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'Accept-Language': locale },
        body: JSON.stringify({ simulation_id: sim, modelOverride: modelOverride ?? undefined,
          ...(custom ? { interviews: selected.map(id => ({ agent_id: id, prompt: questions[id]?.trim() || question })) } : { agent_ids: selected, question }) }) });
      const data = await response.json();
      if (!response.ok || !data.success) throw failure(data, t('采访失败', 'Unable to complete interview'));
      if (bound.current.simulationId === sim && !controller.signal.aborted) {
        setAnswers(data.responses);
        // Re-read the selected actor's canonical conversation after batch interviews.
        setRefresh(value => value + 1);
      }
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t('采访失败', 'Unable to complete interview')); }
    finally { setBatchBusy(false); }
  }
  const activeProfile = profiles.find(profile => profile.entity_id === target);
  const messages = conversations[target] ?? [];
  const button = 'rounded-lg border border-purple-500/30 bg-purple-600/20 px-4 py-2 text-xs text-purple-200 disabled:opacity-40';
  return <div className="grid gap-5 lg:grid-cols-[250px_minmax(0,1fr)]">
    <aside className="space-y-4">
      <div className="rounded-xl border border-white/10 p-4">
        <h2 className="mb-3 text-sm font-semibold">{t('会话对象', 'Conversation')}</h2>
        <button disabled={chatBusy || batchBusy} onClick={() => { setTarget('report'); setMode('chat'); }} className={'mb-3 block w-full rounded-lg p-2 text-left text-sm ' + (target === 'report' ? 'bg-purple-600/20 text-purple-200' : 'text-white/60')}>ReportAgent</button>
        <label className="text-xs text-white/40" htmlFor="interview-agent">{t('模拟参与者', 'Simulation participant')}</label>
        <select id="interview-agent" aria-label={t('选择 Agent', 'Select agent')} className="mt-2 w-full rounded-lg border border-white/10 bg-slate-950 p-2 text-sm" value={target === 'report' ? '' : target}
          disabled={chatBusy || batchBusy} onChange={event => { if (event.target.value) { setTarget(event.target.value); setMode('chat'); } }}>
          <option value="">{t('选择 Agent', 'Select agent')}</option>{profiles.map(profile => <option key={profile.entity_id} value={profile.entity_id}>{profile.entity_name}</option>)}
        </select>
        <button className={button + ' mt-4 w-full'} onClick={() => setMode('questionnaire')}>{t('批量采访问卷', 'Interview questionnaire')}</button>
      </div>
      {activeProfile ? <div className="rounded-xl border border-white/10 p-4 text-xs leading-6 text-white/60"><h3 className="font-semibold text-white">{activeProfile.entity_name}</h3>
        <p>{activeProfile.entity_type} · {activeProfile.occupation}</p><p className="mt-2">{activeProfile.background}</p><p>{activeProfile.personality_traits?.join(' · ')}</p></div> : null}
      {report ? <details className="rounded-xl border border-white/10 p-4" open><summary className="cursor-pointer text-sm font-semibold">{t('报告侧栏', 'Report reference')}</summary>
        <h3 className="my-3 text-sm text-purple-200">{report.title}</h3><p className="mb-3 text-xs leading-6 text-white/50">{report.summary}</p>
        {report.sections.map(section => <details key={section.index} className="mb-3 text-xs"><summary className="cursor-pointer text-white/70">{section.title}</summary>
          <div className="mt-2 max-h-72 overflow-auto text-white/50"><ReactMarkdown>{section.content}</ReactMarkdown></div></details>)}</details> : null}
    </aside>
    <main className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      {error ? <div role="alert" className="mb-4 rounded-lg border border-red-500/30 p-3 text-xs text-red-300">{error}<button className="ml-3 underline" onClick={() => { setRefresh(value => value + 1); setMetadataRefresh(value => value + 1); }}>{t('重新读取', 'Reload')}</button></div> : null}
      {mode === 'chat' ? <>
        <h2 className="border-b border-white/10 pb-4 text-sm font-semibold">{activeProfile?.entity_name ?? 'ReportAgent'} · {t('独立会话', 'Conversation history')}</h2>
        <div aria-live="polite" className="max-h-[600px] min-h-80 space-y-5 overflow-y-auto py-5">
          {historyLoading ? <p className="text-xs text-white/40">{t('正在恢复会话…', 'Restoring conversation…')}</p> : !messages.length ? <p className="py-20 text-center text-sm text-white/40">{t('基于报告或该参与者的真实模拟记忆提问。', 'Ask about the report or this participant’s recorded simulation experience.')}</p> : null}
          {messages.map((message, index) => <article key={index} className={'rounded-xl p-4 ' + (message.role === 'user' ? 'ml-10 bg-purple-500/10' : 'mr-5 border border-white/10')}>
            <p className="mb-2 text-[11px] text-white/40">{message.role === 'user' ? t('我', 'You') : activeProfile?.entity_name ?? 'ReportAgent'}</p>
            <div className="prose prose-sm prose-invert max-w-none break-words text-sm text-white/80"><ReactMarkdown>{message.content}</ReactMarkdown></div>
            {message.tool_calls?.length ? <p className="mt-3 text-[11px] text-purple-300">{t('检索工具', 'Tools')}: {message.tool_calls.map(tool => tool.name).join(' · ')}</p> : null}
            {message.sources?.length ? <details className="mt-3 text-[11px] text-white/50"><summary className="cursor-pointer">{t('查看来源', 'View sources')} ({message.sources.length})</summary>
              {message.sources.map(source => <p key={source.kind + ':' + source.id} className="mt-1 break-all">{source.kind}: {source.label} · {source.id}</p>)}</details> : null}
          </article>)}
          {chatBusy ? <p role="status" className="text-xs text-purple-300">{t('正在查阅证据并回答…', 'Reviewing evidence…')}</p> : null}
        </div>
        <form onSubmit={event => { event.preventDefault(); void send(); }} className="flex gap-3 border-t border-white/10 pt-4">
          <textarea aria-label={t('对话问题', 'Message')} maxLength={2000} rows={2} className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 p-3 text-sm" value={input} onChange={event => setInput(event.target.value)} />
          <button className={button} disabled={chatBusy || historyLoading || !input.trim()}>{t('发送', 'Send')}</button>
        </form>
      </> : <>
        <h2 className="mb-4 text-base font-semibold">{t('真实参与者采访问卷', 'Participant interview questionnaire')}</h2>
        <p className="mb-4 text-xs text-white/50">{t('选择最多 10 位参与者，共用问题或为每人设置问题。回答将保留在对应会话中。', 'Select up to 10 participants and use a shared question or individual prompts. Answers are retained in each conversation.')}</p>
        <div className="mb-4 flex flex-wrap gap-2">{profiles.map(profile => <label key={profile.entity_id} className="rounded-lg border border-white/10 p-2 text-xs">
          <input type="checkbox" checked={selected.includes(profile.entity_id)} disabled={batchBusy || !selected.includes(profile.entity_id) && selected.length >= 10}
            onChange={event => setSelected(previous => event.target.checked ? [...previous, profile.entity_id] : previous.filter(id => id !== profile.entity_id))} /> {profile.entity_name}</label>)}</div>
        <button className={button + ' mb-4'} disabled={batchBusy} onClick={() => setSelected(profiles.slice(0, 10).map(profile => profile.entity_id))}>{t('选择前 10 位', 'Select first 10')}</button>
        <label className="mb-3 block text-xs"><input type="checkbox" checked={custom} onChange={event => setCustom(event.target.checked)} /> {t('为每人设置问题', 'Individual questions')}</label>
        <textarea aria-label={t('共享采访问题', 'Shared interview question')} placeholder={t('采访问题', 'Interview question')} maxLength={2000} rows={3} className="mb-4 w-full rounded-lg border border-white/10 bg-white/5 p-3 text-sm" value={question} onChange={event => setQuestion(event.target.value)} />
        {custom ? selected.map(id => <label key={id} className="mb-3 block text-xs text-white/60">{profiles.find(profile => profile.entity_id === id)?.entity_name}
          <textarea aria-label={'Question ' + id} maxLength={2000} rows={2} className="mt-2 w-full rounded-lg border border-white/10 bg-white/5 p-3 text-sm" value={questions[id] ?? ''} placeholder={t('留空使用共享问题', 'Leave blank to use shared question')} onChange={event => setQuestions(previous => ({ ...previous, [id]: event.target.value }))} /></label>) : null}
        <button className={button} disabled={batchBusy || chatBusy || !selected.length || (custom ? selected.some(id => !(questions[id] || question).trim()) : !question.trim())} onClick={() => void interview()}>
          {batchBusy ? t('采访中…', 'Interviewing…') : t('开始采访', 'Start interviews')} ({selected.length})</button>
        <div className="mt-5 space-y-4">{answers.map((answer, index) => <article key={answer.agent_id + ':' + index} className="rounded-xl border border-white/10 p-4">
          <h3 className="text-sm font-semibold text-purple-200">{answer.agent_name}</h3><p className="my-2 text-xs text-white/40">{answer.question}</p>
          <div className="prose prose-sm prose-invert max-w-none text-white/75"><ReactMarkdown>{answer.answer}</ReactMarkdown></div>
          {Object.entries(answer.platform_answers ?? {}).map(([platform, value]) => <details key={platform} className="mt-3 text-xs text-white/60"><summary className="cursor-pointer">{platform}</summary><p className="mt-2 whitespace-pre-wrap">{value}</p></details>)}
          <p className="mt-3 text-xs text-white/40">{answer.sentiment} · {t('信心', 'Confidence')} {Math.round(answer.confidence * 100)}%</p>
        </article>)}</div>
      </>}
    </main>
  </div>;
}

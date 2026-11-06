'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import type { ModelOverride,EntityProfile,PlatformType } from '@/lib/mirofish/types';
import type { NativeSimulationPolicy } from '@/lib/mirofish/simulation-policy';
import { normalizeSimulationPolicy } from '@/lib/mirofish/simulation-policy';
import { useMiroFishLocale } from './MiroFishLocaleProvider';
import { adoptPreparationTask } from '@/lib/mirofish/preparation-client';
import { bindPreparedProfilesToGraph, bindPreparedProfileConfig } from '@/lib/mirofish/profile-bindings';

interface GraphNode {
  uuid: string;
  name: string;
  labels: string[];
  summary: string;
}

export interface SimulationConfigInput {
  policy?:Partial<NativeSimulationPolicy>;
  platforms: PlatformType[];
  round_count: number;
  posts_per_round: number;
  agents_per_round: number;
  temperature: number;
  seed_topics: string[];
  time_interval: number;
}

interface Step2Props {
  initialConfig?:SimulationConfigInput;
  initialSelectedEntityIds?:string[];
  initialPrepareTaskId?:string|null;
  initialPrepareId?:string;
  onPrepareTaskStarted?:(id:string)=>Promise<void>|void;
  onPrepared?:(result:{prepare_id:string;profiles:EntityProfile[];config:SimulationConfigInput;prepared_at:string;prepare_fingerprint:string})=>Promise<void>|void;
  onDraftChange?:(draft:{selectedEntityIds:string[];config:SimulationConfigInput})=>void;
  projectId: string;
  simulationRequirement: string;
  graphNodes: GraphNode[];
  profiles: EntityProfile[];
  modelOverride?: ModelOverride | null;
  onProfilesGenerated: (profiles: EntityProfile[]) => void;
  onSimulationCreated: (simulationId: string, config: SimulationConfigInput) => Promise<void>|void;
  onComplete: () => Promise<void>|void;
}

const PERSONALITY_COLORS: Record<string, string> = {
  default: 'bg-violet-500/15 text-violet-300',
};

function getTraitColor(trait: string): string {
  return PERSONALITY_COLORS[trait] ?? PERSONALITY_COLORS.default;
}

export default function Step2EnvSetup({
  projectId,
  graphNodes,
  profiles: savedProfiles,
  modelOverride,
  onProfilesGenerated,
  onSimulationCreated,
  initialConfig,initialSelectedEntityIds,initialPrepareTaskId,initialPrepareId,onPrepareTaskStarted,onPrepared,onDraftChange,
}: Step2Props) {
  const {locale,t}=useMiroFishLocale();
  const profiles = useMemo(() => bindPreparedProfilesToGraph(savedProfiles, graphNodes), [savedProfiles, graphNodes]);
  const dirty=useRef(false);
  const [selectedEntities, updateSelectedEntities] = useState<string[]>(()=>{
    const aliases = new Map(savedProfiles.map((profile,index)=>[profile.entity_id,profiles[index].entity_id]));
    return (initialSelectedEntityIds??profiles.map(profile=>profile.entity_id)).map(id=>aliases.get(id)??id).filter(id=>graphNodes.some(node=>node.uuid===id));
  });
  const setSelectedEntities=(value:React.SetStateAction<string[]>)=>{dirty.current=true;updateSelectedEntities(value);};
  const [taskId,setTaskId]=useState<string|null>(initialPrepareTaskId??null);
  const [prepareId,setPrepareId]=useState(initialPrepareId);
  const [preparation,setPreparation]=useState<{stage:string;current:number;total:number}|null>(null);
  const [profileLoading, setProfileLoading] = useState(Boolean(initialPrepareTaskId));
  const [simulationLoading, setSimulationLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [topicInput, setTopicInput] = useState('');
  const [expandedProfile, setExpandedProfile] = useState<string | null>(null);
  const [eventAgent,setEventAgent]=useState('');const [eventRound,setEventRound]=useState(0);const [eventText,setEventText]=useState('');

  const [configDraft, updateConfig] = useState<SimulationConfigInput>(()=>initialConfig??{
    platforms: ['twitter', 'reddit'],
    round_count: 10,
    posts_per_round: 5,
    agents_per_round: 5,
    temperature: 0.8,
    seed_topics: [],
    time_interval: 2,
  });
  const config = useMemo(() => bindPreparedProfileConfig(configDraft, savedProfiles, profiles), [configDraft, savedProfiles, profiles]);
  const setConfig=(value:React.SetStateAction<SimulationConfigInput>)=>{dirty.current=true;updateConfig(value);};
  const policy=normalizeSimulationPolicy(config.policy);
  const patchPolicy=(patch:Partial<NativeSimulationPolicy>)=>setConfig(previous=>({...previous,policy:{...normalizeSimulationPolicy(previous.policy),...patch}}));
  const selectionMatches=new Set(profiles.map(profile=>profile.entity_id)).size===profiles.length&&profiles.length===selectedEntities.length&&profiles.every(profile=>selectedEntities.includes(profile.entity_id));
  const createBlockedReason = profileLoading ? t('环境仍在准备，请等待完成。','The environment is still preparing. Please wait.')
    : !selectionMatches ? t('所选实体与已有人设不一致，请重新准备人设。','The selected entities do not match the saved personas. Prepare personas again.')
      : !config.platforms.length ? t('请至少选择一个模拟平台。','Select at least one simulation platform.') : null;
  useEffect(()=>{if(dirty.current)onDraftChange?.({selectedEntityIds:selectedEntities,config});},[selectedEntities,config,onDraftChange]);
  useEffect(()=>{
    if(!taskId)return;let cancelled=false;let timer:ReturnType<typeof setTimeout>|undefined;const controller=new AbortController();
    const poll=async()=>{try{
      const response=await fetch(`/rag-api/mirofish/simulation/prepare?taskId=${encodeURIComponent(taskId)}`,{signal:controller.signal,headers:{'Accept-Language':locale}});const data=await response.json();
      if(!response.ok||!data.success)throw new Error(t('读取准备进度失败','Unable to read preparation progress'));
      if(cancelled)return;const job=data.job;setPreparation({stage:job.stage,current:job.current,total:job.total});
      if(job.status==='failed')throw new Error(t('环境准备失败，进度记录已保存；请重新准备','Preparation failed. Its progress record was saved; prepare again to retry.'));
      if(job.status==='completed'&&job.result){setPrepareId(job.result.prepare_id);onProfilesGenerated(job.result.profiles);setConfig(job.result.config);setProfileLoading(false);setTaskId(null);try{await onPrepared?.(job.result);}catch{if(!cancelled)setError(t('准备结果已在服务端保存，页面同步失败；可刷新恢复。','Preparation is saved on the server. Refresh to recover after a view synchronization failure.'));}return;}
      timer=setTimeout(poll,1500);
    }catch(cause){if(!cancelled){setError(cause instanceof Error?cause.message:t('准备失败','Preparation failed'));setProfileLoading(false);}}};
    void poll();return()=>{cancelled=true;controller.abort();if(timer)clearTimeout(timer);};
  },[taskId,locale,onPrepared,onProfilesGenerated,t]);

  const toggleAll = () => {
    if (selectedEntities.length === graphNodes.length) {
      setSelectedEntities([]);
    } else {
      setSelectedEntities(graphNodes.map(n => n.uuid));
    }
  };

  const generateProfiles = async () => {
    if (selectedEntities.length === 0||selectedEntities.length>50) { setError(t('请选择 1–50 个实体','Select between 1 and 50 entities')); return; }
    setProfileLoading(true);
    setError(null);
    try {
      const response = await fetch('/rag-api/mirofish/simulation/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json','Accept-Language':locale },
        body: JSON.stringify({ project_id:projectId,selectedEntityIds:selectedEntities,config,async:true,autoConfig:true,language:locale,forceRegenerate:true, modelOverride: modelOverride || undefined }),
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || t('人设生成失败','Persona generation failed'));
      await adoptPreparationTask(data.taskId,{onTask:setTaskId,persist:onPrepareTaskStarted,onPersistenceError:()=>setError(t('任务已启动并保存在服务端，页面同步失败；进度仍会继续更新。','The task is saved and running. Progress continues despite a view synchronization failure.'))});
    } catch (err) {
      setError(err instanceof Error ? err.message : t('人设生成失败','Persona generation failed'));
      setProfileLoading(false);
    }
  };

  const addTopic = () => {
    if (!topicInput.trim() || config.seed_topics.includes(topicInput.trim())) return;
    setConfig(prev => ({ ...prev, seed_topics: [...prev.seed_topics, topicInput.trim()] }));
    setTopicInput('');
  };

  const createSimulation = async () => {
    if (!profiles.length||!selectionMatches) { setError(t('请为当前所选实体重新准备人设','Prepare personas for the current selection')); return; }
    setSimulationLoading(true);
    setError(null);
    try {
      const response = await fetch('/rag-api/mirofish/simulation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json','Accept-Language':locale },
        body: JSON.stringify({
          project_id: projectId,
          prepare_id: prepareId,config:{...config,project_id:projectId},profiles,
          modelOverride: modelOverride || undefined,
        }),
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || t('创建模拟失败','Unable to create simulation'));
      await onSimulationCreated(data.simulation.simulation_id, config);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('创建模拟失败','Unable to create simulation'));
    } finally {
      setSimulationLoading(false);
    }
  };

  const phase: 'select' | 'config' | 'ready' = profiles.length === 0 ? 'select' : 'config';

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      {/* 左侧控制 */}
      <div className="space-y-5 lg:col-span-2">
        <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-3 text-xs text-purple-200">{t('本地模拟引擎：基于角色、信息流和运行记忆生成模拟行为，不连接真实社交账号。','Local simulation engine: generates behavior from personas, feeds and runtime memory. It does not use real social accounts.')}</div>
        {preparation&&profileLoading&&<div role="status" className="rounded-xl border border-white/10 p-3 text-sm text-white/70">{preparation.stage==='profiles'?t('正在生成人设','Generating personas'):preparation.stage==='config'?t('正在分析需求并配置环境','Planning the environment'):t('正在保存准备结果','Saving preparation')} · {preparation.current}/{preparation.total}</div>}
        {/* 流程指示 */}
        <div className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-5 py-3">
          {(['select', 'config'] as const).map((p, i) => {
            const isDone = (p === 'select' && profiles.length > 0);
            const isCur = phase === p;
            const labels = [t('选择实体 & 生成人设','Select entities and personas'), t('配置模拟参数','Configure simulation')];
            return (
              <React.Fragment key={p}>
                {i > 0 && <div className={`h-px flex-1 ${isDone ? 'bg-purple-500/50' : 'bg-white/10'}`} />}
                <div className="flex items-center gap-2">
                  <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                    isDone ? 'bg-emerald-500 text-white' : isCur ? 'bg-purple-500/20 text-purple-300 ring-2 ring-purple-500/40' : 'bg-white/5 text-white/30'
                  }`}>
                    {isDone ? '✓' : i + 1}
                  </div>
                  <span className={`text-xs font-medium ${isDone ? 'text-emerald-300' : isCur ? 'text-white' : 'text-white/30'}`}>
                    {labels[i]}
                  </span>
                </div>
              </React.Fragment>
            );
          })}
        </div>

        {/* 实体选择 */}
        <div className={`rounded-2xl border p-5 transition-all ${
          phase === 'select'
            ? 'border-purple-500/30 bg-purple-500/[0.04] shadow-lg shadow-purple-500/5'
            : 'border-emerald-500/20 bg-emerald-500/[0.02]'
        }`}>
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`flex h-9 w-9 items-center justify-center rounded-xl text-sm font-bold ${
                profiles.length > 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-purple-500/20 text-purple-400'
              }`}>
                {profiles.length > 0 ? '✓' : '1'}
              </div>
              <div>
                <div className="text-sm font-semibold text-white">{t('选择 Agent 实体','Select agent entities')}</div>
                <div className="text-[11px] text-white/40">{graphNodes.length} {t('个实体可用','entities available')}</div>
              </div>
            </div>
            <button type="button" onClick={toggleAll} disabled={profileLoading} className="text-[11px] text-purple-400 hover:text-purple-300 disabled:opacity-40">
              {selectedEntities.length === graphNodes.length ? t('取消全选','Deselect all') : t('全选','Select all')}
            </button>
          </div>

          <div className="mb-3 max-h-52 space-y-1.5 overflow-y-auto pr-1">
            {graphNodes.map(node => {
              const checked = selectedEntities.includes(node.uuid);
              return (
                <label
                  key={node.uuid}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl p-3 transition-all ${
                    checked
                      ? 'border border-purple-500/30 bg-purple-500/10'
                      : 'border border-transparent bg-white/[0.02] hover:bg-white/[0.04]'
                  }`}
                >
                  <input
                    type="checkbox"
                    disabled={profileLoading}
                    checked={checked}
                    onChange={() => setSelectedEntities(prev =>
                      prev.includes(node.uuid) ? prev.filter(id => id !== node.uuid) : [...prev, node.uuid]
                    )}
                    className="rounded border-white/20 bg-transparent text-purple-500 focus:ring-purple-500/30"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-white">{node.name}</div>
                    <div className="truncate text-[10px] text-white/30">{node.summary?.slice(0, 50)}</div>
                  </div>
                  <span className="shrink-0 rounded-lg bg-blue-500/10 px-2 py-0.5 text-[10px] text-blue-300">
                    {node.labels[0]}
                  </span>
                </label>
              );
            })}
          </div>

          {(
            <button
              type="button"
              onClick={generateProfiles}
              disabled={profileLoading || selectedEntities.length === 0}
              className="group relative w-full overflow-hidden rounded-xl bg-gradient-to-r from-purple-600 to-violet-600 py-3 text-sm font-semibold text-white shadow-lg shadow-purple-500/20 disabled:opacity-40 disabled:shadow-none"
            >
              {profileLoading && <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-white/10 to-transparent" />}
              <span className="relative">{profileLoading ? t('正在准备环境…','Preparing environment…') : `${profiles.length?t('重新准备','Prepare again'):t('生成人设并配置环境','Prepare personas and environment')} (${selectedEntities.length})`}</span>
            </button>
          )}
          {profiles.length>0&&(
            <div className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-emerald-400">
              <span>✅</span> {profiles.length} {t('个 Agent 人设已生成','agent personas prepared')}
            </div>
          )}
        </div>

        {/* 模拟配置 */}
        {profiles.length > 0 && (
          <div className="rounded-2xl border border-purple-500/30 bg-purple-500/[0.04] p-5 shadow-lg shadow-purple-500/5">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-purple-500/20 text-sm font-bold text-purple-400">2</div>
              <div>
                <div className="text-sm font-semibold text-white">{t('模拟配置','Simulation configuration')}</div>
                <div className="text-[11px] text-white/40">{t('设定模拟参数与种子话题','Set parameters and seed topics')}</div>
              </div>
            </div>

            <fieldset disabled={profileLoading} className="space-y-4 disabled:opacity-60">
              {/* 平台 */}
              <div>
                <div className="mb-1.5 text-[11px] font-medium text-white/50">{t('模拟平台','Platforms')}</div>
                <div className="flex gap-2">
                  {(['twitter', 'reddit'] as const).map(p => (
                    <button
                      type="button"
                      key={p}
                      onClick={() => setConfig(prev => ({
                        ...prev,
                        platforms: prev.platforms.includes(p)
                          ? prev.platforms.filter(x => x !== p)
                          : [...prev.platforms, p],
                      }))}
                      className={`flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium transition-all ${
                        config.platforms.includes(p)
                          ? 'bg-purple-500/20 text-purple-300 ring-1 ring-purple-500/30'
                          : 'bg-white/[0.03] text-white/40 hover:bg-white/[0.06]'
                      }`}
                    >
                      {p === 'twitter' ? '🐦 Twitter' : '🔴 Reddit'}
                    </button>
                  ))}
                </div>
              </div>

              {/* 数值 */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="mb-1.5 text-[11px] font-medium text-white/50">{t('轮次数','Rounds')}</div>
                  <input
                    type="number"
                    value={config.round_count}
                    onChange={e => setConfig(prev => ({ ...prev, round_count: parseInt(e.target.value) || 10 }))}
                    min={1} max={30}
                    className="w-full rounded-xl border border-white/[0.08] bg-black/30 px-3 py-2 text-sm text-white focus:border-purple-500/40 focus:outline-none"
                  />
                </div>
                <div>
                  <div className="mb-1.5 text-[11px] font-medium text-white/50">{t('每轮 Agent 数','Agents per round')}</div>
                  <input
                    type="number"
                    value={config.agents_per_round}
                    onChange={e => setConfig(prev => ({ ...prev, agents_per_round: parseInt(e.target.value) || 5 }))}
                    min={1} max={profiles.length}
                    className="w-full rounded-xl border border-white/[0.08] bg-black/30 px-3 py-2 text-sm text-white focus:border-purple-500/40 focus:outline-none"
                  />
                </div>
              </div>

              {/* 种子话题 */}
              <div>
                <div className="mb-1.5 text-[11px] font-medium text-white/50">{t('种子话题','Seed topics')}</div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={topicInput}
                    onChange={e => setTopicInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addTopic()}
                    placeholder={t('输入话题,按 Enter 添加...','Enter a topic and press Enter…')}
                    className="flex-1 rounded-xl border border-white/[0.08] bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/20 focus:border-purple-500/40 focus:outline-none"
                  />
                  <button type="button" onClick={addTopic} className="rounded-xl bg-white/[0.06] px-3 py-2 text-sm text-white/60 hover:bg-white/[0.1]">+</button>
                </div>
                {config.seed_topics.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {config.seed_topics.map(topic => (
                      <span key={topic} className="flex items-center gap-1.5 rounded-lg bg-purple-500/15 px-2.5 py-1 text-[11px] font-medium text-purple-300">
                        {topic}
                        <button type="button" onClick={() => setConfig(prev => ({ ...prev, seed_topics: prev.seed_topics.filter(t => t !== topic) }))} className="text-purple-400/50 hover:text-rose-400">×</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Temperature */}
              <div>
                <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-white/50">
                  <span>{t('随机性','Temperature')}</span>
                  <span className="text-purple-300">{config.temperature}</span>
                </div>
                <input
                  type="range"
                  value={config.temperature}
                  onChange={e => setConfig(prev => ({ ...prev, temperature: parseFloat(e.target.value) }))}
                  min={0.1} max={1.5} step={0.1}
                  className="w-full accent-purple-500"
                />
              </div>

              <details className="rounded-xl border border-white/10 p-3 text-xs text-white/60">
                <summary className="cursor-pointer font-medium text-purple-200">{t('时间、推荐与运行记忆','Time, recommendations and memory')}</summary>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <label>{t('开始小时','Starting hour')}<input type="number" min={0} max={23} value={policy.start_hour} onChange={event=>patchPolicy({start_hour:Number(event.target.value)})} className="mt-1 w-full rounded-lg bg-black/30 p-2"/></label>
                  <label>{t('每轮模拟分钟','Simulated minutes per round')}<input type="number" min={1} max={1440} value={policy.minutes_per_round} onChange={event=>patchPolicy({minutes_per_round:Number(event.target.value)})} className="mt-1 w-full rounded-lg bg-black/30 p-2"/></label>
                </div>
                <label className="mt-3 flex gap-2"><input type="checkbox" checked={policy.memory_enabled} onChange={event=>patchPolicy({memory_enabled:event.target.checked})}/>{t('使用角色运行记忆','Use agent runtime memory')}</label>
                <label className="mt-2 flex gap-2"><input type="checkbox" checked={policy.graph_memory_enabled} onChange={event=>patchPolicy({graph_memory_enabled:event.target.checked})}/>{t('将模拟行为写入隔离图记忆','Project actions into isolated graph memory')}</label>
                {(['twitter','reddit'] as const).filter(platform=>config.platforms.includes(platform)).map(platform=><div key={platform} className="mt-3 space-y-2"><h4>{platform} · {t('推荐权重','Feed weights')}</h4>{(['recency','popularity','relevance','echo_chamber'] as const).map(key=><label key={key} className="flex items-center justify-between gap-2"><span>{({recency:t('时效','Recency'),popularity:t('热度','Popularity'),relevance:t('相关性','Relevance'),echo_chamber:t('关注偏好','Follow preference')})[key]}</span><input aria-label={`${platform} ${key}`} type="range" min={0} max={1} step={.05} value={policy.platform[platform][key]} onChange={event=>patchPolicy({platform:{...policy.platform,[platform]:{...policy.platform[platform],[key]:Number(event.target.value)}}})}/></label>)}</div>)}
                <p className="mt-3 text-white/40">{t('以上时间、活跃度、推荐权重及种子事件由本地引擎实际消费。','The local engine uses these schedules, activity settings, feed weights and seed events.')}</p>
              </details>
              <details className="rounded-xl border border-white/10 p-3 text-xs text-white/60"><summary className="cursor-pointer font-medium text-purple-200">{t('角色活跃度与时间','Agent activity and schedule')}</summary><div className="mt-3 max-h-64 space-y-3 overflow-y-auto">{profiles.map(profile=>{const activity=policy.agents[profile.entity_id]??{active_hours:profile.behavioral_anchors?.active_hours??Array.from({length:24},(_,hour)=>hour),activity_level:1,influence_weight:profile.behavioral_anchors?.influence_weight??1,posts_per_hour:1,comments_per_hour:1};return <div key={profile.entity_id} className="rounded-lg bg-white/[0.03] p-2"><strong>{profile.entity_name}</strong><label className="mt-2 flex items-center justify-between">{t('活跃概率','Activity probability')}<input aria-label={`${profile.entity_name} activity`} type="number" min={0} max={1} step={.1} value={activity.activity_level} onChange={event=>patchPolicy({agents:{...policy.agents,[profile.entity_id]:{...activity,activity_level:Number(event.target.value)}}})} className="w-16 rounded bg-black/30 p-1"/></label><label className="mt-2 block">{t('活跃小时（逗号分隔）','Active hours (comma-separated)')}<input value={activity.active_hours.join(',')} onChange={event=>patchPolicy({agents:{...policy.agents,[profile.entity_id]:{...activity,active_hours:event.target.value.split(',').filter(Boolean).map(Number).filter(hour=>Number.isInteger(hour)&&hour>=0&&hour<24)}}})} className="mt-1 w-full rounded bg-black/30 p-2"/></label></div>;})}</div></details>
              <details className="rounded-xl border border-white/10 p-3 text-xs text-white/60"><summary className="cursor-pointer font-medium text-purple-200">{t('注入种子事件','Inject seed events')}</summary><div className="mt-3 space-y-2"><select aria-label={t('事件发言角色','Event author')} value={eventAgent} onChange={event=>setEventAgent(event.target.value)} className="w-full rounded bg-[#141323] p-2"><option value="">{t('选择发言角色','Select an author')}</option>{profiles.map(profile=><option key={profile.entity_id} value={profile.entity_id}>{profile.entity_name}</option>)}</select><label className="flex items-center gap-2">{t('触发轮次（0 为开场）','Round (0 for opening)')}<input type="number" min={0} max={config.round_count} value={eventRound} onChange={event=>setEventRound(Number(event.target.value))} className="w-16 rounded bg-black/30 p-2"/></label><textarea aria-label={t('种子事件内容','Seed event content')} value={eventText} maxLength={5000} onChange={event=>setEventText(event.target.value)} className="w-full rounded bg-black/30 p-2"/><button type="button" disabled={!eventAgent||!eventText.trim()||policy.events.length>=50} onClick={()=>{patchPolicy({events:[...policy.events,{id:`manual_${Date.now()}`,round:eventRound,agent_id:eventAgent,content:eventText.trim(),topics:config.seed_topics}]});setEventText('');}} className="rounded bg-purple-500/20 px-3 py-2 disabled:opacity-30">{t('添加事件','Add event')}</button>{policy.events.map(event=><div key={event.id} className="flex justify-between gap-2 rounded bg-white/[0.03] p-2"><span>R{event.round} · {event.content.slice(0,80)}</span><button type="button" aria-label={t('删除事件','Remove event')} onClick={()=>patchPolicy({events:policy.events.filter(item=>item.id!==event.id)})}>×</button></div>)}</div></details>
              {policy.generation_reasoning&&<p className="text-xs leading-relaxed text-white/40">{t('配置依据：','Configuration rationale: ')}{policy.generation_reasoning}</p>}

              {createBlockedReason && <p id="simulation-create-hint" role="status" className="text-xs leading-relaxed text-amber-200">{createBlockedReason}</p>}
              <button
                type="button"
                onClick={createSimulation}
                disabled={simulationLoading||Boolean(createBlockedReason)}
                aria-describedby={createBlockedReason ? 'simulation-create-hint' : undefined}
                className="group w-full rounded-2xl bg-gradient-to-r from-purple-600 via-violet-600 to-fuchsia-600 p-px shadow-lg shadow-purple-500/20 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
              >
                <div className="flex items-center justify-center gap-2 rounded-[15px] bg-[#060612] px-6 py-3.5 transition-colors group-hover:bg-[#0a0a1a]">
                  <span className="text-sm font-semibold text-white">
                    {simulationLoading ? t('正在创建模拟…','Creating simulation…') : t('🚀 创建模拟并进入下一步','🚀 Create simulation and continue')}
                  </span>
                  <span className="text-purple-400 transition-transform group-hover:translate-x-1">→</span>
                </div>
              </button>
            </fieldset>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-3 rounded-xl border border-rose-500/20 bg-rose-500/[0.06] p-4">
            <span className="text-rose-400">⚠</span>
            <div className="text-sm text-rose-300">{error}</div>
          </div>
        )}
      </div>

      {/* 右侧人设展示 */}
      <div className="lg:col-span-3">
        {profiles.length > 0 ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-lg font-semibold text-white">{t('Agent 人设','Agent personas')}</div>
                <div className="text-xs text-white/30">{profiles.length} {t('个角色就绪','agents ready')}</div>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {profiles.map(profile => {
                const isExpanded = expandedProfile === profile.entity_id;
                return (
                  <button
                    type="button"
                    key={profile.entity_id}
                    onClick={() => setExpandedProfile(isExpanded ? null : profile.entity_id)}
                    className={`rounded-2xl border p-5 text-left transition-all ${
                      isExpanded
                        ? 'border-purple-500/30 bg-purple-500/[0.04] shadow-lg shadow-purple-500/5'
                        : 'border-white/[0.06] bg-white/[0.02] hover:border-white/[0.1] hover:bg-white/[0.03]'
                    }`}
                  >
                    <div className="mb-3 flex items-start justify-between">
                      <div>
                        <div className="text-sm font-semibold text-white">{profile.full_name}</div>
                        <div className="mt-0.5 text-[11px] text-white/40">
                          {profile.occupation}{profile.age ? ` · ${profile.age}${t('岁',' years')}` : ''}{profile.gender ? ` · ${profile.gender}` : ''}
                        </div>
                      </div>
                      <span className="shrink-0 rounded-lg bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-300">
                        {profile.entity_type}
                      </span>
                    </div>

                    {profile.personality_traits.length > 0 && (
                      <div className="mb-3 flex flex-wrap gap-1.5">
                        {profile.personality_traits.slice(0, isExpanded ? undefined : 3).map(trait => (
                          <span key={trait} className={`rounded-lg px-2 py-0.5 text-[10px] font-medium ${getTraitColor(trait)}`}>
                            {trait}
                          </span>
                        ))}
                        {!isExpanded && profile.personality_traits.length > 3 && (
                          <span className="text-[10px] text-white/20">+{profile.personality_traits.length - 3}</span>
                        )}
                      </div>
                    )}

                    {profile.typical_posts.length > 0 && (
                      <div className="rounded-xl bg-black/20 p-3 text-xs italic leading-relaxed text-white/50">
                        &ldquo;{profile.typical_posts[0]}&rdquo;
                      </div>
                    )}

                    {isExpanded && (
                      <div className="mt-3 space-y-2 border-t border-white/[0.06] pt-3">
                        {profile.speaking_style && (
                          <div>
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-white/25">{t('说话风格','Speaking style')}</div>
                            <div className="text-xs text-white/50">{profile.speaking_style}</div>
                          </div>
                        )}
                        {profile.background && (
                          <div>
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-white/25">{t('背景','Background')}</div>
                            <div className="text-xs text-white/50">{profile.background}</div>
                          </div>
                        )}
                        {Object.keys(profile.viewpoints).length > 0 && (
                          <div>
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-white/25">{t('观点','Viewpoints')}</div>
                            {Object.entries(profile.viewpoints).map(([topic, view]) => (
                              <div key={topic} className="mt-1 text-xs text-white/40">
                                <span className="text-purple-300">{topic}:</span> {view}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex min-h-[400px] items-center justify-center rounded-2xl border border-dashed border-white/[0.08] bg-white/[0.01]">
            <div className="max-w-sm text-center">
              <div className="relative mx-auto mb-6 flex h-24 w-24 items-center justify-center">
                <div className="absolute inset-0 animate-spin rounded-full border border-dashed border-purple-500/20" style={{ animationDuration: '20s' }} />
                <span className="text-4xl">⚙️</span>
              </div>
              <h3 className="mb-2 text-xl font-bold text-white">{t('环境设置','Environment setup')}</h3>
              <p className="text-sm leading-relaxed text-white/40">
                {t('选择图谱中的实体，为其生成 AI 角色人设。每个 Agent 都有独特的性格、观点和说话风格。','Select graph entities to generate AI personas with distinct personalities, viewpoints and speaking styles.')}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

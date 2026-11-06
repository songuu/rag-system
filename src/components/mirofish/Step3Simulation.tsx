'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativeSimulationSnapshot, SimulationActionEvent } from '@/lib/mirofish/simulation-policy';
import type { SimulationPost,SimulationStatus } from '@/lib/mirofish/types';
import { useMiroFishLocale } from './MiroFishLocaleProvider';

interface Step3Props { simulationId:string; onComplete:()=>Promise<void>|void;onStatusChange?:(status:SimulationStatus)=>void }
const card='rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5';
const button='rounded-xl border border-purple-500/30 bg-purple-500/15 px-4 py-2 text-sm text-purple-200 disabled:opacity-40';
const isActive=(status:string)=>['running','stopping','finalizing'].includes(status);

export default function Step3Simulation({simulationId,onComplete,onStatusChange}:Step3Props){
 const {locale,t}=useMiroFishLocale();
 const [snapshot,setSnapshot]=useState<NativeSimulationSnapshot|null>(null);
 const [error,setError]=useState<string|null>(null);
 const [busy,setBusy]=useState(false);
 const [revision,setRevision]=useState(0);
 const [platform,setPlatform]=useState('all');
 const [round,setRound]=useState<number|null>(null);
 const [tab,setTab]=useState<'posts'|'actions'|'memory'>('posts');
 const [agent,setAgent]=useState('all');
 const [connection,setConnection]=useState<'connecting'|'live'|'reconnecting'>('connecting');
 const mounted=useRef(true);
 const status=snapshot?.info.status??'loading';
 useEffect(()=>{if(status!=='loading')onStatusChange?.(status);},[status,onStatusChange]);
 const applySnapshot=useCallback((next:NativeSimulationSnapshot)=>setSnapshot(next),[]);

 // The committed snapshot is authoritative. Polling repairs reconnect gaps and interaction counters.
 useEffect(()=>{
  mounted.current=true;let cancelled=false;let timer:ReturnType<typeof setTimeout>|undefined;const abort=new AbortController();
  const load=async()=>{try{
   const response=await fetch(`/rag-api/mirofish/simulation/${encodeURIComponent(simulationId)}?action=snapshot`,{signal:abort.signal,headers:{'Accept-Language':locale}});
   const data=await response.json();if(!response.ok||!data.success||!data.snapshot)throw new Error(data.error||t('读取模拟失败','Unable to load simulation'));
   if(cancelled)return;applySnapshot(data.snapshot);
   if(isActive(data.snapshot.info.status))timer=setTimeout(load,2000);
  }catch(cause){if(!cancelled)setError(cause instanceof Error?cause.message:t('读取模拟失败','Unable to load simulation'));}};
  void load();return()=>{cancelled=true;mounted.current=false;abort.abort();if(timer)clearTimeout(timer);};
 },[simulationId,locale,t,revision,applySnapshot]);

 useEffect(()=>{
  if(!isActive(status))return;
  const events=new EventSource(`/rag-api/mirofish/simulation/${encodeURIComponent(simulationId)}/stream`);
  events.onopen=()=>setConnection('live');
  events.onerror=()=>setConnection('reconnecting');
  events.onmessage=event=>{try{
   const message=JSON.parse(event.data);setConnection('live');
   if(message.type==='connected'&&message.data.snapshot)applySnapshot(message.data.snapshot);
   if(message.type==='post_created'&&message.data.post)setSnapshot(previous=>previous?{...previous,posts:previous.posts.some(post=>post.id===message.data.post.id)?previous.posts:[...previous.posts,message.data.post]}:previous);
   if(message.type==='action_executed'&&message.data.action)setSnapshot(previous=>previous?{...previous,actions:previous.actions.some(action=>action.id===message.data.action.id)?previous.actions:[...previous.actions,message.data.action]}:previous);
   if(['simulation_complete','simulation_error','state_changed'].includes(message.type)){if(message.type==='simulation_error')setError(t('模拟运行失败，请检查模型或重试','Simulation failed. Check the model or retry.'));setRevision(value=>value+1);}
  }catch{setConnection('reconnecting');}};
  return()=>events.close();
 },[simulationId,status,applySnapshot,t]);

 const control=async(action:'start'|'resume'|'restart'|'pause'|'stop')=>{
  setBusy(true);setError(null);
  try{
   const response=await fetch(`/rag-api/mirofish/simulation/${encodeURIComponent(simulationId)}`,{method:'POST',headers:{'Content-Type':'application/json','Accept-Language':locale},body:JSON.stringify({action})});
   const data=await response.json();if(!response.ok||!data.success)throw new Error(data.error||t('操作失败','Operation failed'));
   if(data.simulation)setSnapshot(previous=>previous?{...previous,info:data.simulation}:previous);
   setRevision(value=>value+1);
  }catch(cause){setError(cause instanceof Error?cause.message:t('操作失败','Operation failed'));}
  finally{if(mounted.current)setBusy(false);}
 };
 const posts=useMemo(()=>(snapshot?.posts??[]).filter(post=>(platform==='all'||post.platform===platform)&&(round===null||post.round===round)&&(agent==='all'||post.author_id===agent)),[snapshot?.posts,platform,round,agent]);
 const actions=useMemo(()=>(snapshot?.actions??[]).filter(event=>(platform==='all'||event.platform===platform)&&(round===null||event.round===round)&&(agent==='all'||event.agentId===agent)),[snapshot?.actions,platform,round,agent]);
 const profiles=snapshot?.info.agent_profiles??[];
 const rounds=Array.from(new Set([...(snapshot?.posts??[]).map(post=>post.round),...(snapshot?.actions??[]).map(event=>event.round)])).sort((a,b)=>a-b);
 const total=snapshot?.info.config.round_count??0;
 const current=snapshot?.info.current_round??0;
 const progress=total?Math.min(100,current/total*100):0;
 const canReport=['completed','stopped'].includes(status)&&['idle','complete'].includes(snapshot?.projection.status??'pending');
 const labels:Record<string,string>={loading:t('读取中','Loading'),ready:t('就绪','Ready'),running:t('运行中','Running'),paused:t('已暂停','Paused'),stopping:t('正在停止并收尾','Stopping and draining'),stopped:t('已停止','Stopped'),finalizing:t('正在提交运行记忆','Committing runtime memory'),completed:t('已完成','Completed'),failed:t('运行失败','Failed')};
 const exportUrl=(format:string)=>`/rag-api/mirofish/simulation/${encodeURIComponent(simulationId)}?action=export&format=${format}`;

 return <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
  <div className="space-y-5 lg:col-span-2">
   <div className={card}>
    <div className="flex items-start justify-between gap-3"><div><p className="text-xs uppercase tracking-widest text-purple-400">{t('本地模拟引擎','Local simulation engine')}</p><h2 className="mt-2 font-semibold text-white">{t('模拟运行控制','Simulation controls')}</h2></div><span role="status" className="rounded-full bg-purple-500/15 px-3 py-1 text-xs text-purple-200">{labels[status]??status}</span></div>
    <p className="mt-4 text-sm text-white/50">{t('已提交轮次','Committed rounds')} {current}/{total}</p>
    <progress className="mt-2 h-2 w-full accent-purple-500" value={progress} max={100}>{progress}%</progress>
    <div className="mt-4 grid grid-cols-3 gap-2 text-center">{[[t('帖子','Posts'),snapshot?.info.total_posts??0],[t('评论','Comments'),snapshot?.info.total_comments??0],[t('动作','Actions'),snapshot?.actions.length??0]].map(([label,value])=><div key={label} className="rounded-xl bg-white/[0.03] p-3"><strong className="block font-mono text-lg text-white">{value}</strong><span className="text-xs text-white/40">{label}</span></div>)}</div>
    <div className="mt-5 flex flex-wrap gap-2">
     {status==='ready'&&<button type="button" disabled={busy} onClick={()=>void control('start')} className={button}>{t('开始模拟','Start simulation')}</button>}
     {['paused','failed'].includes(status)&&<button type="button" disabled={busy} onClick={()=>void control('resume')} className={button}>{t('从已提交轮次继续','Resume committed progress')}</button>}
     {status==='running'&&<button type="button" disabled={busy} onClick={()=>void control('pause')} className={button}>{t('暂停','Pause')}</button>}
     {['running','paused','failed'].includes(status)&&<button type="button" disabled={busy} onClick={()=>void control('stop')} className={button}>{t('停止并保留结果','Stop and keep results')}</button>}
     {['completed','stopped','failed'].includes(status)&&<button type="button" disabled={busy} onClick={()=>void control('restart')} className={button}>{t('重新运行','Restart')}</button>}
    </div>
    {snapshot?.recoverable&&<p className="mt-3 text-xs text-amber-200">{t('服务重启后已恢复为暂停状态，可从最后提交轮次继续。','Recovered after a service restart. Resume from the last committed round.')}</p>}
    {isActive(status)&&<p className="mt-3 text-xs text-white/40">{connection==='live'?t('实时连接正常','Live connection active'):t('正在恢复实时连接，快照同步仍在继续','Reconnecting live updates; snapshot synchronization continues')}</p>}
   </div>
   <div className={card}><h3 className="text-sm font-semibold text-white">{t('运行记忆','Runtime memory')}</h3><p className="mt-2 text-xs text-white/50">{t('记忆游标','Memory cursor')}: {snapshot?.projection.projectedEventSequence??0}/{snapshot?.projection.committedEventSequence??0}</p><p className="mt-2 text-xs text-white/40">{snapshot?.projection.enabled?t('隔离图记忆已启用；完成前等待全部事件写入。','Isolated graph memory is enabled. Completion waits for all events.'):t('本次使用角色运行记忆，未开启图记忆投影。','This run uses agent runtime memory without graph projection.')}</p>{snapshot?.projection.status==='failed'&&<p role="alert" className="mt-3 text-xs text-rose-300">{t('图记忆写入失败；请继续运行以重试，完成前不能生成报告。','Graph memory failed. Resume to retry before generating a report.')}</p>}</div>
   <div className={card}><h3 className="text-sm font-semibold text-white">{t('导出记录','Export records')}</h3><div className="mt-3 flex flex-wrap gap-2">{[['snapshot',t('完整快照 JSON','Snapshot JSON')],['actions-csv',t('行为 CSV','Action CSV')],['config',t('环境配置 JSON','Configuration JSON')],['twitter-csv',t('Twitter 人设 CSV','Twitter profiles CSV')],['reddit-json',t('Reddit 人设 JSON','Reddit profiles JSON')]].map(([format,label])=><a key={format} href={exportUrl(format)} className="rounded-lg bg-white/[0.05] px-3 py-2 text-xs text-white/60 hover:text-purple-200">{label}</a>)}</div></div>
   {canReport&&<button type="button" disabled={busy} onClick={async()=>{setBusy(true);setError(null);try{await onComplete();}catch(cause){setError(cause instanceof Error?cause.message:t('进入报告失败','Unable to open report'));}finally{if(mounted.current)setBusy(false);}}} className="w-full rounded-xl bg-purple-600 px-4 py-3 font-semibold text-white disabled:opacity-40">{t('下一步：生成报告 →','Next: generate report →')}</button>}
   {error&&<div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">{error}</div>}
  </div>
  <div className="space-y-4 lg:col-span-3">
   <div className="grid grid-cols-2 gap-3">{(snapshot?.info.config.platforms??[]).map(value=>{const events=(snapshot?.actions??[]).filter(event=>event.platform===value);return <div key={value} className="rounded-xl border border-white/10 bg-white/[0.02] p-3"><h3 className="text-sm font-semibold text-white">{value==='twitter'?'Twitter':'Reddit'}</h3><p className="mt-2 text-xs text-white/50">{t('共享提交轮次','Shared committed rounds')}: {current}/{total}</p><p className="mt-1 text-xs text-white/40">{t('成功行为','Successful actions')}: {events.filter(event=>event.success).length}/{events.length} · {t('帖子','Posts')}: {(snapshot?.posts??[]).filter(post=>post.platform===value).length}</p></div>;})}</div>
   <div className="flex flex-wrap gap-2">{(['posts','actions','memory'] as const).map(value=><button type="button" key={value} onClick={()=>setTab(value)} className={button+' '+(tab===value?'ring-1 ring-purple-400':'opacity-60')}>{value==='posts'?t('帖子流','Posts'):value==='actions'?t('行为记录','Actions'):t('角色记忆','Agent memory')}</button>)}</div>
   <div className="flex flex-wrap gap-2">
    <select aria-label={t('平台筛选','Platform filter')} value={platform} onChange={event=>setPlatform(event.target.value)} className="rounded-lg bg-[#141323] p-2 text-xs text-white"><option value="all">{t('全部平台','All platforms')}</option><option value="twitter">Twitter</option><option value="reddit">Reddit</option></select>
    <select aria-label={t('轮次筛选','Round filter')} value={round??'all'} onChange={event=>setRound(event.target.value==='all'?null:Number(event.target.value))} className="rounded-lg bg-[#141323] p-2 text-xs text-white"><option value="all">{t('全部轮次','All rounds')}</option>{rounds.map(value=><option key={value} value={value}>R{value}</option>)}</select>
    <select aria-label={t('角色筛选','Agent filter')} value={agent} onChange={event=>setAgent(event.target.value)} className="max-w-52 rounded-lg bg-[#141323] p-2 text-xs text-white"><option value="all">{t('全部角色','All agents')}</option>{profiles.map(profile=><option key={profile.entity_id} value={profile.entity_id}>{profile.entity_name}</option>)}</select>
   </div>
   <div className={card+' max-h-[720px] space-y-3 overflow-y-auto'}>
    {tab==='posts'&&(posts.length?posts.map(post=><PostCard key={post.id} post={post}/>):<p className="py-16 text-center text-sm text-white/40">{t('暂无帖子；角色可能选择搜索、互动或不发言。','No posts yet. Agents may search, interact, or remain silent.')}</p>)}
    {tab==='actions'&&(actions.length?actions.map(event=><ActionCard key={event.id} event={event} name={profiles.find(profile=>profile.entity_id===event.agentId)?.entity_name??event.agentId}/>):<p className="py-16 text-center text-sm text-white/40">{t('暂无符合筛选条件的行为','No matching actions')}</p>)}
    {tab==='memory'&&profiles.filter(profile=>agent==='all'||profile.entity_id===agent).map(profile=><div key={profile.entity_id} className="rounded-xl border border-white/10 p-4"><h3 className="text-sm font-semibold text-white">{profile.entity_name}</h3><ul className="mt-2 space-y-2 text-xs text-white/50">{(snapshot?.memory[profile.entity_id]?.observations??[]).map((value,index)=><li key={index} className="whitespace-pre-wrap">{value}</li>)}</ul>{!snapshot?.memory[profile.entity_id]?.observations.length&&<p className="mt-2 text-xs text-white/30">{t('尚无运行记忆','No runtime memory yet')}</p>}</div>)}
   </div>
  </div>
 </div>;
}
function PostCard({post}:{post:SimulationPost}){return <article className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4"><div className="flex gap-2 text-xs"><strong className="text-white">{post.author_name}</strong><span className="text-purple-300">{post.platform} · {post.action}</span><span className="ml-auto text-white/30">R{post.round}</span></div><p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-white/75">{post.content}</p><div className="mt-3 text-xs text-white/35">♥ {post.likes} · ↩ {post.replies_count} · ↻ {post.reposts} {post.topics.map(topic=>`#${topic}`).join(' ')}</div></article>;}
function ActionCard({event,name}:{event:SimulationActionEvent;name:string}){return <article className="rounded-xl border border-white/[0.08] p-4"><div className="flex gap-2 text-xs"><strong className="text-white">{name}</strong><span className="text-purple-300">{event.platform} · {event.action}</span><span className={'ml-auto '+(event.success?'text-emerald-300':'text-rose-300')}>{event.success?'✓':'⚠'} R{event.round} · #{event.sequence}</span></div><p className="mt-2 whitespace-pre-wrap text-xs text-white/60">{event.observation||event.content||event.errorCode||event.action}</p></article>;}


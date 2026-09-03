'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Braces, Check, ChevronRight, Clock3, Copy, FileClock, LoaderCircle, Plus, Save, Settings2, Sparkles, X } from 'lucide-react';
import styles from './PromptOptimizerStudio.module.css';

type Mode = 'general' | 'structured' | 'image';
type Profile = { profileId: string; name: string; provider: string; model: string; isDefault: boolean };
type Template = { id: string; name: string; description: string; mode: Mode };
type Version = { versionNumber: number; kind: string; prompt: string; instruction: string; analysis: { summary?: string; improvements?: string[] }; variables: Record<string, string>; modelProfileId: string | null; templateId: string; createdAt: string };
type Workspace = { workspace_id: string; title: string; original_prompt: string; mode: Mode; variables: Record<string, string>; selected_model_profile_id: string | null; current_version: number; updated_at: string };

const API_ROOT = '/rag-api/prompt-optimizer';
const MODE_LABELS: Record<Mode, string> = { general: '通用增强', structured: '结构任务', image: '图像创作' };

export default function PromptOptimizerStudio() {
  const [prompt, setPrompt] = useState('');
  const [instruction, setInstruction] = useState('');
  const [mode, setMode] = useState<Mode>('general');
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [activeVersion, setActiveVersion] = useState<Version | null>(null);
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [profileDraft, setProfileDraft] = useState({ name: '我的优化模型', provider: 'openai', model: 'gpt-4.1-mini', baseUrl: '', isDefault: true, temperature: 0.3, topP: 1, maxTokens: 1800, timeoutSeconds: 60 });
  const workspaceRequestSequence = useRef(0);

  const variableNames = useMemo(() => Array.from(prompt.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]{0,63})\}\}/g), match => match[1]).filter((value, index, all) => all.indexOf(value) === index), [prompt]);
  const template = templates.find(item => item.mode === mode);

  useEffect(() => { void refreshCatalogs(); }, []);
  useEffect(() => {
    if (!modelOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setModelOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [modelOpen]);

  function updatePrompt(nextPrompt: string) {
    setPrompt(nextPrompt);
    const names = Array.from(nextPrompt.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]{0,63})\}\}/g), match => match[1]);
    setVariables(current => Object.fromEntries(names.filter((name, index) => names.indexOf(name) === index).map(name => [name, current[name] ?? ''])));
  }

  async function refreshCatalogs() {
    try {
      const [profileData, templateData, workspaceData] = await Promise.all([
        api<Profile[]>('/models'), api<Template[]>('/templates'), api<Workspace[]>('/workspaces'),
      ]);
      setProfiles(profileData); setTemplates(templateData); setWorkspaces(workspaceData);
      setSelectedProfileId(current => current || profileData.find(item => item.isDefault)?.profileId || profileData[0]?.profileId || '');
    } catch (caught) { setError(messageOf(caught)); }
  }

  async function optimize(iterate = false) {
    if (!prompt.trim()) return setError('先写下需要优化的提示词。');
    if (!selectedProfileId) { setModelOpen(true); return setError('先添加一个独立的优化模型。'); }
    setBusy(true); setError('');
    try {
      const sourcePrompt = iterate && activeVersion ? activeVersion.prompt : prompt;
      const data = await api<{ workspaceId: string; version: Version }>('/optimize', {
        method: 'POST', body: JSON.stringify({ prompt: sourcePrompt, instruction, mode, variables, modelProfileId: selectedProfileId,
          templateId: template?.id ?? `${mode}-v1`, workspaceId: workspace?.workspace_id ?? null,
          parentVersion: iterate ? activeVersion?.versionNumber ?? null : null,
          expectedCurrentVersion: workspace?.current_version ?? null }),
      });
      await openWorkspace(data.workspaceId);
      await refreshCatalogs();
    } catch (caught) { setError(messageOf(caught)); } finally { setBusy(false); }
  }

  async function openWorkspace(workspaceId: string) {
    const requestSequence = ++workspaceRequestSequence.current;
    setBusy(true); setError('');
    try {
      const data = await api<{ workspace: Workspace; versions: Version[] }>(`/workspaces/${encodeURIComponent(workspaceId)}`);
      if (requestSequence !== workspaceRequestSequence.current) return;
      setWorkspace(data.workspace); setPrompt(data.workspace.original_prompt);
      const latest = data.versions[0] ?? null;
      setVariables(latest?.variables || data.workspace.variables || {}); setVersions(data.versions); setActiveVersion(latest);
      setInstruction(latest?.instruction || '');
      setMode(modeForVersion(latest, data.workspace.mode));
      setSelectedProfileId(latest?.modelProfileId || data.workspace.selected_model_profile_id || selectedProfileId);
    } catch (caught) { if (requestSequence === workspaceRequestSequence.current) setError(messageOf(caught)); }
    finally { if (requestSequence === workspaceRequestSequence.current) setBusy(false); }
  }

  async function saveManual() {
    if (busy || !workspace || !activeVersion) return;
    setBusy(true); setError('');
    try {
      await api(`/workspaces/${encodeURIComponent(workspace.workspace_id)}/versions`, { method: 'POST', body: JSON.stringify({
        prompt: activeVersion.prompt, instruction, mode, variables, modelProfileId: selectedProfileId,
        templateId: activeVersion.templateId || template?.id || `${mode}-v1`, parentVersion: activeVersion.versionNumber,
        expectedCurrentVersion: workspace.current_version,
      }) });
      await openWorkspace(workspace.workspace_id);
    } catch (caught) { setError(messageOf(caught)); } finally { setBusy(false); }
  }

  async function saveProfile() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const saved = await api<Profile>('/models', { method: 'POST', body: JSON.stringify({
        name: profileDraft.name, provider: profileDraft.provider, model: profileDraft.model,
        baseUrl: profileDraft.baseUrl || null, isDefault: profileDraft.isDefault,
        settings: { temperature: profileDraft.temperature, topP: profileDraft.topP,
          maxTokens: profileDraft.maxTokens, timeoutMs: profileDraft.timeoutSeconds * 1000 },
      }) });
      await refreshCatalogs(); setSelectedProfileId(saved.profileId); setModelOpen(false);
    } catch (caught) { setError(messageOf(caught)); } finally { setBusy(false); }
  }

  function startFresh() { workspaceRequestSequence.current += 1; setBusy(false); setWorkspace(null); setVersions([]); setActiveVersion(null); setPrompt(''); setInstruction(''); setVariables({}); setError(''); }
  function selectVersion(version: Version) { setActiveVersion(version); setInstruction(version.instruction || ''); setVariables(version.variables || {}); setMode(modeForVersion(version, mode)); if (version.modelProfileId) setSelectedProfileId(version.modelProfileId); }
  async function copyResult() { if (!activeVersion) return; try { await navigator.clipboard.writeText(activeVersion.prompt); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setError('复制失败，请手动选择提示词文本。'); } }

  return <div className={styles.shell}>
    <header className={styles.header}>
      <div className={styles.brand}><Link href="/" className={styles.back} aria-label="返回首页"><ArrowLeft size={18} /></Link><div className={styles.mark}>P°</div><div><strong>提示词优化台</strong><span>Prompt Atelier / v1</span></div></div>
      <div className={styles.headerActions}>
        <label className={styles.modelSelect}><span>优化模型</span><select value={selectedProfileId} onChange={event => setSelectedProfileId(event.target.value)}><option value="">未配置</option>{profiles.map(item => <option key={item.profileId} value={item.profileId}>{item.name} · {item.model}</option>)}</select></label>
        <button className={styles.iconButton} onClick={() => setModelOpen(true)} aria-label="模型设置"><Settings2 size={17} />模型设置</button>
        <button className={styles.primarySmall} disabled={busy} onClick={startFresh}><Plus size={17} />新建</button>
      </div>
    </header>

    <section className={styles.intro}><div><span className={styles.eyebrow}>MAKE THE ASK SHARPER</span><h1>把模糊想法，打磨成<br/><em>可执行的提示词。</em></h1></div><p>独立模型配置 · PostgreSQL 版本留痕 · 变量化复用<br/>每次优化都成为一个可回看的版本，而不是覆盖。</p></section>

    <div className={styles.workspace}>
      <aside className={styles.history}>
        <div className={styles.panelTitle}><span><FileClock size={16}/>优化项目</span><b>{workspaces.length}</b></div>
        <div className={styles.historyList}>{workspaces.length === 0 ? <div className={styles.emptySmall}>还没有历史项目<br/>完成第一次优化后会出现在这里。</div> : workspaces.map(item => <button disabled={busy} key={item.workspace_id} className={workspace?.workspace_id === item.workspace_id ? styles.historyActive : styles.historyItem} onClick={() => void openWorkspace(item.workspace_id)}><span>{item.title}</span><small>v{item.current_version} · {MODE_LABELS[item.mode]}</small><ChevronRight size={15}/></button>)}</div>
      </aside>

      <section className={styles.editor}>
        <div className={styles.editorHead}><div><span className={styles.step}>01</span><div><h2>原始提示词</h2><p>保留变量请使用 <code>{'{{variable}}'}</code></p></div></div><span className={styles.counter}>{prompt.length.toLocaleString()} / 20,000</span></div>
        <div className={styles.modes}>{(['general','structured','image'] as Mode[]).map(item => <button key={item} className={mode === item ? styles.modeActive : styles.mode} onClick={() => setMode(item)}>{MODE_LABELS[item]}</button>)}</div>
        <textarea className={styles.promptInput} value={prompt} maxLength={20000} onChange={event => updatePrompt(event.target.value)} placeholder={'例如：为 {{product}} 写一段新品发布文案，语气专业但有温度……'} />
        <label className={styles.instruction}><span>本轮优化要求 <i>可选</i></span><input value={instruction} maxLength={2000} onChange={event => setInstruction(event.target.value)} placeholder="如：保持中文、增加验收标准、减少营销腔" /></label>
        {variableNames.length > 0 && <div className={styles.variables}><div className={styles.variableTitle}><Braces size={16}/>变量试填 <span>{variableNames.length}</span></div>{variableNames.map(name => <label key={name}><code>{`{{${name}}}`}</code><input value={variables[name] ?? ''} onChange={event => setVariables(current => ({ ...current, [name]: event.target.value }))} placeholder={`输入 ${name} 的测试值`} /></label>)}</div>}
        <div className={styles.optimizeBar}><div><Sparkles size={18}/><span>{template?.name ?? MODE_LABELS[mode]}</span><small>{template?.description}</small></div><button disabled={busy} onClick={() => void optimize(Boolean(workspace))}>{busy ? <LoaderCircle className={styles.spin} size={18}/> : <Sparkles size={18}/>} {workspace ? '基于当前版本迭代' : '开始优化'}</button></div>
        {error && <div className={modelOpen ? styles.modalError : styles.error} role="alert">{error}<button onClick={() => setError('')} aria-label="关闭错误提示"><X size={14}/></button></div>}
      </section>

      <section className={styles.result}>
        <div className={styles.resultHead}><div><span className={styles.stepDark}>02</span><div><h2>优化版本</h2><p>{activeVersion ? `已选 v${activeVersion.versionNumber}` : '等待第一次优化'}</p></div></div>{activeVersion && <div className={styles.resultActions}><button disabled={busy} onClick={() => void copyResult()}>{copied ? <Check size={15}/> : <Copy size={15}/>}{copied ? '已复制' : '复制'}</button><button disabled={busy} onClick={() => void saveManual()}><Save size={15}/>存为新版本</button></div>}</div>
        {!activeVersion ? <div className={styles.emptyResult}><div>✦</div><h3>好提示词不是一次写成的。</h3><p>左侧输入目标、选择模式与模型，优化结果会在这里以不可变版本保存。</p></div> : <><div className={styles.paper}><div className={styles.paperMeta}><span>VERSION {String(activeVersion.versionNumber).padStart(2,'0')}</span><span>{activeVersion.kind.toUpperCase()}</span></div><textarea value={activeVersion.prompt} onChange={event => setActiveVersion(current => current ? { ...current, prompt: event.target.value } : current)} /><div className={styles.analysis}><strong>为什么这样改</strong><p>{activeVersion.analysis?.summary || '该模型返回了优化正文，可继续迭代或手动调整后存为新版本。'}</p>{activeVersion.analysis?.improvements?.map(item => <span key={item}>↗ {item}</span>)}</div></div><div className={styles.compare}><span>原文</span><p>{workspace?.original_prompt}</p></div></>}
        {versions.length > 0 && <div className={styles.timeline}><div className={styles.panelTitle}><span><Clock3 size={16}/>版本时间线</span><b>{versions.length}</b></div><div>{versions.map(item => <button disabled={busy} key={item.versionNumber} className={activeVersion?.versionNumber === item.versionNumber ? styles.versionActive : styles.version} onClick={() => selectVersion(item)}><span>v{item.versionNumber}</span><small>{item.kind} · {formatTime(item.createdAt)}</small></button>)}</div></div>}
      </section>
    </div>

    {modelOpen && <div className={styles.modalBackdrop} onMouseDown={() => setModelOpen(false)}><div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="prompt-model-title" onMouseDown={event => event.stopPropagation()}><button className={styles.modalClose} aria-label="关闭模型设置" onClick={() => setModelOpen(false)}><X/></button><span className={styles.eyebrow}>ISOLATED MODEL PROFILE</span><h2 id="prompt-model-title">添加优化模型</h2><p>模型档案与系统 RAG 模型完全独立。API Key 只从服务端环境变量读取，不会保存到数据库。</p><div className={styles.formGrid}><label>名称<input autoFocus value={profileDraft.name} onChange={event => setProfileDraft({...profileDraft,name:event.target.value})}/></label><label>提供商<select value={profileDraft.provider} onChange={event => setProfileDraft({...profileDraft,provider:event.target.value})}><option value="openai">OpenAI</option><option value="openrouter">OpenRouter</option><option value="compatible">OpenAI 兼容</option>{process.env.NODE_ENV !== 'production' && <option value="ollama">Ollama（仅本地）</option>}</select></label><label>模型名称<input value={profileDraft.model} onChange={event => setProfileDraft({...profileDraft,model:event.target.value})}/></label>{['compatible','ollama'].includes(profileDraft.provider) && <label>Base URL<input value={profileDraft.baseUrl} onChange={event => setProfileDraft({...profileDraft,baseUrl:event.target.value})} placeholder={profileDraft.provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'https://models.example.com/v1'}/></label>}<label>Temperature<input type="number" min="0" max="2" step="0.1" value={profileDraft.temperature} onChange={event => setProfileDraft({...profileDraft,temperature:Number(event.target.value)})}/></label><label>Top P<input type="number" min="0" max="1" step="0.05" value={profileDraft.topP} onChange={event => setProfileDraft({...profileDraft,topP:Number(event.target.value)})}/></label><label>Max tokens<input type="number" min="256" max="16384" step="256" value={profileDraft.maxTokens} onChange={event => setProfileDraft({...profileDraft,maxTokens:Number(event.target.value)})}/></label><label>超时（秒）<input type="number" min="5" max="120" step="5" value={profileDraft.timeoutSeconds} onChange={event => setProfileDraft({...profileDraft,timeoutSeconds:Number(event.target.value)})}/></label></div><label className={styles.checkbox}><input type="checkbox" checked={profileDraft.isDefault} onChange={event => setProfileDraft({...profileDraft,isDefault:event.target.checked})}/>设为默认优化模型</label><button className={styles.modalSubmit} disabled={busy} onClick={() => void saveProfile()}>{busy ? <LoaderCircle className={styles.spin}/> : <Settings2/>}保存模型档案</button></div></div>}
  </div>;
}

async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const payload = await response.json();
  if (!response.ok || payload.success === false) throw new Error(payload.error?.message || payload.error || '请求失败');
  return payload.data as T;
}
function messageOf(value: unknown) { return value instanceof Error ? value.message : '操作失败，请稍后重试。'; }
function modeForVersion(version: Version | null, fallback: Mode): Mode { const candidate = version?.templateId.split('-')[0]; return candidate === 'general' || candidate === 'structured' || candidate === 'image' ? candidate : fallback; }
function formatTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '刚刚' : date.toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }); }

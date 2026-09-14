'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';

type Health = {
  status: 'ready' | 'not_ready' | 'disabled';
  backend: 'neo4j' | 'file';
  neo4j?: { connected: boolean; database: string; uri: string };
  managementEnabled: boolean;
  timestamp: string;
};

type ArtifactIdentity = {
  tenantId: string;
  corpusId: string;
  documentId: string;
  documentVersion: string;
  trustLevel: 'trusted' | 'reviewed' | 'external' | 'quarantined';
};

type Snapshot = {
  identity: ArtifactIdentity;
  artifactDigest: string;
  graphName?: string;
  createdAt: string;
  expiresAt?: string;
  nodeCount: number;
  edgeCount: number;
};

type ActivePointer = {
  identity: ArtifactIdentity | null;
  revision: number;
  updatedAt: string;
};

type Entity = {
  id: string;
  name: string;
  labels: string[];
  summary: string;
  aliases: string[];
  passageIds: string[];
};

type EntityResult = { entity: Entity; score?: number };
type PathResult = {
  entityIds: string[];
  claimIds: string[];
  passageIds: string[];
  score: number;
};

type ClaimSource = {
  claim: {
    id: string;
    predicate: string;
    fact: string;
    sourceEntityName: string;
    targetEntityName: string;
    confidence: number;
  };
  passages: Array<{
    id: string;
    content: string;
    contentTruncated: boolean;
    source?: string;
    page?: number;
    sectionPath?: string[];
    documentId: string;
    documentVersion: string;
    trustLevel: string;
  }>;
  contentTruncated: boolean;
  truncated: boolean;
};

type CommunityResult = {
  community: {
    id: string;
    name: string;
    summary: string;
    keywords: string[];
    entityIds: string[];
    claimIds: string[];
    level: number;
    parentId?: string;
  };
  score?: number;
};

type SnapshotPayload = {
  snapshots: Snapshot[];
  active: ActivePointer;
  backend: 'neo4j' | 'file';
};

type BuildSource = {
  documentId: string;
  documentVersion: string;
  sourceName: string;
  contentType: string;
  chunkCount: number;
  updatedAt: string;
};

type BuildSourcePayload = {
  sources: BuildSource[];
};

type BuildJob = {
  id: string;
  graphVersion: string;
  status: 'queued' | 'running' | 'staged' | 'validated' | 'published' | 'failed' | 'cancelled';
  progress: number;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
};

type Envelope<T> = {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  graphVersion?: string;
};

const API_ROOT = '/rag-api/knowledge-graph';

const SNAPSHOT_DATE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const TRUST_LEVEL_LABELS: Record<ArtifactIdentity['trustLevel'], string> = {
  trusted: '可信',
  reviewed: '已复核',
  external: '外部',
  quarantined: '隔离',
};

export default function KnowledgeGraphConsole() {
  const [scopeInput, setScopeInput] = useState('');
  const [corpusId, setCorpusId] = useState('');
  const [health, setHealth] = useState<Health | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [active, setActive] = useState<ActivePointer | null>(null);
  const [buildSources, setBuildSources] = useState<BuildSource[]>([]);
  const [selectedBuildSourceKey, setSelectedBuildSourceKey] = useState('');
  const [buildJob, setBuildJob] = useState<BuildJob | null>(null);
  const [query, setQuery] = useState('');
  const [entities, setEntities] = useState<EntityResult[]>([]);
  const [entitySearchAttempted, setEntitySearchAttempted] = useState(false);
  const [selectedEntityId, setSelectedEntityId] = useState('');
  const [neighbors, setNeighbors] = useState<PathResult[]>([]);
  const [sourceEntityId, setSourceEntityId] = useState('');
  const [targetEntityId, setTargetEntityId] = useState('');
  const [paths, setPaths] = useState<PathResult[]>([]);
  const [pathSearchAttempted, setPathSearchAttempted] = useState(false);
  const [claimSource, setClaimSource] = useState<ClaimSource | null>(null);
  const [communityQuery, setCommunityQuery] = useState('');
  const [communities, setCommunities] = useState<CommunityResult[]>([]);
  const [maxHops, setMaxHops] = useState<1 | 2>(1);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const loadOverview = useCallback(async (signal?: AbortSignal) => {
    setBusy('overview');
    setError('');
    try {
      const headers = scopeHeaders(corpusId);
      const [healthResponse, snapshotResponse, buildSourceResponse] = await Promise.all([
        fetch(API_ROOT + '/health', { headers, signal }),
        fetch(API_ROOT + '/snapshots?limit=50', { headers, signal }),
        fetch(API_ROOT + '/builds', { headers, signal }),
      ]);
      const healthBody = await healthResponse.json() as Health;
      setHealth(healthBody);
      const [snapshotBody, buildSourceBody] = await Promise.all([
        readEnvelope<SnapshotPayload>(snapshotResponse),
        readEnvelope<BuildSourcePayload>(buildSourceResponse),
      ]);
      setSnapshots(snapshotBody.snapshots);
      setActive(snapshotBody.active);
      setBuildSources(buildSourceBody.sources);
      setSelectedBuildSourceKey(current => (
        buildSourceBody.sources.some(source => buildSourceKey(source) === current)
          ? current
          : buildSourceKey(buildSourceBody.sources[0])
      ));
    } catch (cause) {
      if (!isAbortError(cause)) setError(errorMessage(cause));
    } finally {
      if (!signal?.aborted) setBusy('');
    }
  }, [corpusId]);

  useEffect(() => {
    const controller = new AbortController();
    const task = window.setTimeout(() => void loadOverview(controller.signal), 0);
    return () => {
      window.clearTimeout(task);
      controller.abort();
    };
  }, [loadOverview]);

  const buildJobId = buildJob?.id;
  const buildJobStatus = buildJob?.status;

  useEffect(() => {
    if (!buildJobId || !buildJobStatus || isTerminalBuildStatus(buildJobStatus)) return;
    const controller = new AbortController();
    let timer: number | undefined;

    const poll = async () => {
      try {
        const params = new URLSearchParams({ jobId: buildJobId });
        const response = await fetch(API_ROOT + '/builds?' + params, {
          headers: scopeHeaders(corpusId),
          signal: controller.signal,
        });
        const nextJob = await readEnvelope<BuildJob>(response);
        if (nextJob.status === 'validated' || nextJob.status === 'published') {
          await loadOverview(controller.signal);
          setBuildJob(nextJob);
          return;
        }
        setBuildJob(nextJob);
        if (!isTerminalBuildStatus(nextJob.status)) {
          timer = window.setTimeout(() => void poll(), 2_000);
        }
      } catch (cause) {
        if (!isAbortError(cause)) setError(errorMessage(cause));
      }
    };

    timer = window.setTimeout(() => void poll(), 1_000);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      controller.abort();
    };
  }, [buildJobId, buildJobStatus, corpusId, loadOverview]);

  async function searchEntities(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setEntitySearchAttempted(false);
    await run('entities', async () => {
      const params = new URLSearchParams({ q: query.trim(), limit: '25' });
      const body = await request<EntityResult[]>(API_ROOT + '/entities?' + params);
      setEntities(body.data);
      setNeighbors([]);
      setSelectedEntityId('');
      setEntitySearchAttempted(true);
    });
  }

  async function loadNeighbors(entityId: string) {
    setSelectedEntityId(entityId);
    await run('neighbors', async () => {
      const params = new URLSearchParams({
        entityId,
        maxHops: String(maxHops),
        limit: '50',
      });
      const body = await request<PathResult[]>(API_ROOT + '/entities?' + params);
      setNeighbors(body.data);
    });
  }

  async function findPaths(event: FormEvent) {
    event.preventDefault();
    if (!sourceEntityId.trim() || !targetEntityId.trim()) return;
    setPathSearchAttempted(false);
    await run('paths', async () => {
      const [resolvedSourceId, resolvedTargetId] = await Promise.all([
        resolveEntityReference(sourceEntityId),
        resolveEntityReference(targetEntityId),
      ]);
      const body = await request<PathResult[]>(API_ROOT + '/paths', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceEntityId: resolvedSourceId,
          targetEntityId: resolvedTargetId,
          maxHops,
          limit: 25,
        }),
      });
      setPaths(body.data);
      setPathSearchAttempted(true);
    });
  }

  async function resolveEntityReference(reference: string): Promise<string> {
    const value = reference.trim();
    const knownEntity = findEntityReference(entities, value);
    if (knownEntity) return knownEntity.id;

    const params = new URLSearchParams({ q: value, limit: '25' });
    const body = await request<EntityResult[]>(API_ROOT + '/entities?' + params);
    const matchedEntity = findEntityReference(body.data, value)
      ?? (body.data.length === 1 ? body.data[0]?.entity : undefined);

    // Preserve direct entity-ID queries even though full-text search does not index entityKey.
    if (body.data.length === 0) return value;
    if (!matchedEntity) {
      throw new Error('实体“' + value + '”匹配到多个结果，请输入更完整的名称或实体 ID。');
    }
    return matchedEntity.id;
  }

  async function loadCommunities(event?: FormEvent) {
    event?.preventDefault();
    if (!communityQuery.trim()) return;
    await run('communities', async () => {
      const params = new URLSearchParams({ limit: '25', q: communityQuery.trim() });
      const body = await request<CommunityResult[]>(API_ROOT + '/communities?' + params);
      setCommunities(body.data);
    });
  }

  async function loadClaimSources(claimId: string) {
    await run('claim-sources', async () => {
      const body = await request<ClaimSource>(
        API_ROOT + '/claims/' + encodeURIComponent(claimId) + '/sources?limit=10'
      );
      setClaimSource(body.data);
    });
  }

  async function updateActive(snapshot: Snapshot | null) {
    await run('snapshot', async () => {
      const expectedRevision = active?.revision ?? 0;
      await request<ActivePointer>(API_ROOT + '/snapshots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(snapshot
          ? { action: 'activate', expectedRevision, ...snapshot.identity }
          : { action: 'deactivate', expectedRevision }),
      });
      setEntities([]);
      setEntitySearchAttempted(false);
      setSelectedEntityId('');
      setNeighbors([]);
      setPaths([]);
      setPathSearchAttempted(false);
      setClaimSource(null);
      setCommunities([]);
      await loadOverview();
    });
  }

  async function deleteSnapshot(snapshot: Snapshot) {
    const name = snapshot.graphName || snapshot.identity.documentVersion;
    if (!window.confirm('确定删除快照“' + name + '”吗？活动快照必须先停用。')) return;
    await run('snapshot', async () => {
      const params = new URLSearchParams({
        documentId: snapshot.identity.documentId,
        documentVersion: snapshot.identity.documentVersion,
        trustLevel: snapshot.identity.trustLevel,
      });
      await request<{ deleted: boolean }>(API_ROOT + '/snapshots?' + params, {
        method: 'DELETE',
      });
      await loadOverview();
    });
  }

  async function createSnapshot(event: FormEvent) {
    event.preventDefault();
    const source = buildSources.find(item => buildSourceKey(item) === selectedBuildSourceKey);
    if (!source) return;
    await run('build', async () => {
      const body = await request<BuildJob>(API_ROOT + '/builds', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          documentId: source.documentId,
          documentVersion: source.documentVersion,
          trustLevel: 'external',
        }),
      });
      setBuildJob(body.data);
    });
  }

  async function run(name: string, action: () => Promise<void>) {
    setBusy(name);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }

  async function request<T>(url: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (corpusId) headers.set('x-rag-corpus-id', corpusId);
    const response = await fetch(url, {
      ...init,
      headers,
    });
    const data = await readEnvelope<T>(response);
    return { data, response };
  }

  const ready = health?.status === 'ready';
  const managementEnabled = health?.managementEnabled === true;
  const activeVersion = active?.identity?.documentVersion ?? null;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-sm text-slate-400 hover:text-white">← 返回首页</Link>
            <div className="h-6 w-px bg-slate-800" />
            <div>
              <h1 className="text-lg font-semibold">Neo4j 知识图谱控制台</h1>
              <p className="text-xs text-slate-400">按知识库隔离 · 版本化发布 · 局部图探索</p>
            </div>
          </div>
          <StatusBadge health={health} />
        </div>
      </header>

      <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
        <section className="grid gap-4 md:grid-cols-[1fr_auto]">
          <label className="block rounded-xl border border-slate-800 bg-slate-900 p-4">
            <span className="mb-2 block text-xs font-medium uppercase tracking-wider text-slate-400">知识库范围</span>
            <input
              value={scopeInput}
              onChange={event => setScopeInput(event.target.value)}
              placeholder="留空使用当前默认知识库，或输入 corpusId"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-cyan-500"
            />
          </label>
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => setCorpusId(scopeInput.trim())}
              className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400"
            >应用范围</button>
            <button
              type="button"
              onClick={() => void loadOverview()}
              disabled={busy === 'overview'}
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm hover:bg-slate-800 disabled:opacity-50"
            >刷新</button>
          </div>
        </section>

        {error && (
          <div role="alert" className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="图存储" value={health?.backend ?? '检测中'} detail={health?.status ?? 'loading'} />
          <Metric label="活动版本" value={activeVersion ?? '未发布'} detail={'revision ' + (active?.revision ?? 0)} />
          <Metric label="可用快照" value={String(snapshots.length)} detail="最多显示 50 个" />
          <Metric
            label="Neo4j 数据库"
            value={health?.neo4j?.database ?? '—'}
            detail={health?.neo4j?.connected ? '连接正常' : '未连接'}
          />
        </section>

        {!ready && (
          <section className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
            图查询当前不可用。请设置 <code>RAG_GRAPH_BACKEND=neo4j</code> 并确认 Neo4j 健康检查通过；RAG 主链仍会降级为向量检索。
          </section>
        )}

        {!managementEnabled && (
          <section className="rounded-xl border border-sky-500/30 bg-sky-500/10 p-4 text-sm text-sky-100">
            当前页面仅提供只读查询。快照激活、停用和删除只在本地开发模式开放；生产环境请通过服务端管理接口和独立操作者凭据执行。
          </section>
        )}

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
          <div className="space-y-6">
            <Panel title="实体搜索与局部展开" subtitle="只查询活动图版本；点击实体后读取最多 2 跳路径。">
              <form onSubmit={searchEntities} className="flex flex-col gap-3 sm:flex-row">
                <input
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder="输入实体名称、别名或摘要关键词"
                  className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-cyan-500"
                />
                <HopSelect value={maxHops} onChange={setMaxHops} />
                <button className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 transition-colors hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50" disabled={!ready || busy === 'entities'}>
                  {busy === 'entities' ? '搜索中…' : '搜索'}
                </button>
              </form>
              <div className="mt-4">
                {busy === 'entities'
                  ? <Empty>正在当前活动快照中搜索实体…</Empty>
                  : entities.length > 0
                    ? (
                        <div className="grid gap-3 md:grid-cols-2">
                          {entities.map(({ entity, score }) => (
                            <button
                              type="button"
                              key={entity.id}
                              onClick={() => void loadNeighbors(entity.id)}
                              className={'rounded-xl border p-4 text-left transition ' + (selectedEntityId === entity.id ? 'border-cyan-400 bg-cyan-500/10' : 'border-slate-800 bg-slate-950 hover:border-slate-600')}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <strong className="text-sm text-white">{entity.name}</strong>
                                {score !== undefined && <span className="text-xs text-cyan-300">{score.toFixed(2)}</span>}
                              </div>
                              <div className="mt-2 flex flex-wrap gap-1">
                                {entity.labels.map(label => <Tag key={label}>{label}</Tag>)}
                              </div>
                              <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-400">{entity.summary || '暂无摘要'}</p>
                              <p className="mt-2 break-all font-mono text-[10px] text-slate-500">{entity.id}</p>
                            </button>
                          ))}
                        </div>
                      )
                    : <Empty>{entitySearchAttempted ? '当前活动快照中没有匹配的实体，请尝试实体全称或切换快照。' : '输入名称、别名或摘要关键词开始搜索。'}</Empty>}
              </div>
              {selectedEntityId && (
                <div className="mt-5 border-t border-slate-800 pt-4">
                  <h3 className="mb-3 text-sm font-medium">局部路径（{neighbors.length}）</h3>
                      <PathList paths={neighbors} empty="当前范围内未发现有证据支撑的邻居路径。" onClaimSelect={loadClaimSources} />
                </div>
              )}
            </Panel>

            <Panel title="实体路径查询" subtitle="服务端限制为 1–2 跳，并要求每条路径具有可追溯 Passage 证据。">
              <form onSubmit={findPaths} className="grid gap-3 sm:grid-cols-2">
                <input value={sourceEntityId} onChange={event => setSourceEntityId(event.target.value)} placeholder="源实体名称、别名或 ID" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-violet-500" />
                <input value={targetEntityId} onChange={event => setTargetEntityId(event.target.value)} placeholder="目标实体名称、别名或 ID" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-violet-500" />
                <HopSelect value={maxHops} onChange={setMaxHops} />
                <button disabled={!ready || busy === 'paths'} className="rounded-lg bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-50">
                  {busy === 'paths' ? '解析并查询中…' : '查询路径'}
                </button>
              </form>
                  <p className="mt-2 text-[11px] leading-5 text-slate-500">支持直接输入实体名称或别名；系统会先在当前活动快照中解析为实体 ID。</p>
                  <div className="mt-4">
                    {busy === 'paths'
                      ? <Empty>正在解析实体并查询图路径…</Empty>
                      : <PathList paths={paths} empty={pathSearchAttempted ? '查询已完成，但两个实体之间没有发现可追溯路径。' : '输入两个实体名称或 ID 查询它们之间的路径。'} onClaimSelect={loadClaimSources} />}
                  </div>
                </Panel>

                {claimSource && (
                  <Panel title="声明与原文来源" subtitle="仅展示当前活动图版本中、当前可信范围允许访问的 Passage。">
                    <div className="rounded-xl border border-cyan-500/30 bg-cyan-500/10 p-4">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-cyan-200">
                        <span>{claimSource.claim.sourceEntityName}</span>
                        <span>— {claimSource.claim.predicate} →</span>
                        <span>{claimSource.claim.targetEntityName}</span>
                        <span className="ml-auto">置信度 {claimSource.claim.confidence.toFixed(3)}</span>
                      </div>
                      <p className="mt-2 text-sm leading-6 text-slate-100">{claimSource.claim.fact}</p>
                    </div>
                    <div className="mt-3 space-y-3">
                      {claimSource.passages.map(passage => (
                        <article key={passage.id} className="rounded-xl border border-slate-800 bg-slate-950 p-4">
                          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
                            <span>{passage.source || passage.documentId}</span>
                            {passage.page !== undefined && <span>第 {passage.page} 页</span>}
                            <span>{passage.trustLevel}</span>
                          </div>
                          <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-slate-300">{passage.content}</p>
                          {passage.contentTruncated && <p className="mt-2 text-[11px] text-amber-300">内容已截断为 16KB 预览。</p>}
                        </article>
                      ))}
                    </div>
                  </Panel>
                )}
          </div>

          <div className="space-y-6">
            <Panel title="创建快照" subtitle="直接使用 PostgreSQL 中已完成向量化的文档，不再需要前往 MiroFish Graph RAG 页面。">
              {buildSources.length > 0 ? (
                <form onSubmit={createSnapshot} className="space-y-3">
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-slate-400">已向量化文档</span>
                    <select
                      value={selectedBuildSourceKey}
                      onChange={event => setSelectedBuildSourceKey(event.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-cyan-500"
                    >
                      {buildSources.map(source => (
                        <option key={buildSourceKey(source)} value={buildSourceKey(source)}>
                          {source.sourceName} · {source.chunkCount} 个分块
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="submit"
                    disabled={!managementEnabled || !selectedBuildSourceKey || busy === 'build'}
                    className="w-full rounded-lg bg-cyan-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy === 'build' ? '正在提交…' : '创建图谱快照'}
                  </button>
                </form>
              ) : (
                <Empty>PostgreSQL 中还没有已完成向量化的文档。请先在首页上传并完成向量化。</Empty>
              )}

              {buildJob && (
                <div className={'mt-4 rounded-xl border p-3 ' + buildJobTone(buildJob.status)}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-medium">{buildJobStatusLabel(buildJob.status)}</span>
                    <span className="text-xs tabular-nums">{Math.round(buildJob.progress * 100)}%</span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
                    <div
                      className="h-full rounded-full bg-cyan-400 transition-[width]"
                      style={{ width: Math.max(2, Math.round(buildJob.progress * 100)) + '%' }}
                    />
                  </div>
                  <p className="mt-2 truncate font-mono text-[10px] text-slate-500" title={buildJob.graphVersion}>
                    {buildJob.graphVersion}
                  </p>
                  {buildJob.errorMessage && (
                    <p className="mt-2 text-xs leading-5 text-red-200">
                      {buildJob.errorCode ? buildJob.errorCode + '：' : ''}{buildJob.errorMessage}
                    </p>
                  )}
                </div>
              )}
            </Panel>

            <Panel title="快照与发布" subtitle="切换采用 revision CAS，避免并发请求覆盖活动版本。">
              {active?.identity && (
                <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.07] p-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-400/10" aria-hidden="true">
                      <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_14px_rgba(52,211,153,0.8)]" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-emerald-200">当前版本正在提供图查询</p>
                      <p className="mt-0.5 truncate font-mono text-[10px] text-slate-500" title={activeVersion ?? undefined}>{activeVersion}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void updateActive(null)}
                    disabled={!managementEnabled || busy === 'snapshot'}
                    className="shrink-0 whitespace-nowrap rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-1.5 text-xs font-medium text-amber-200 transition-colors hover:border-amber-300/50 hover:bg-amber-400/15 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    停用版本
                  </button>
                </div>
              )}
              <div className="space-y-3">
                {snapshots.map(snapshot => {
                  const isActive = sameIdentity(snapshot.identity, active?.identity);
                  const snapshotName = snapshot.graphName || snapshot.identity.documentId;
                  return (
                    <article
                      key={snapshot.identity.documentId + ':' + snapshot.identity.documentVersion + ':' + snapshot.identity.trustLevel}
                      className={'relative overflow-hidden rounded-xl border p-4 transition-colors ' + (isActive
                        ? 'border-emerald-400/30 bg-emerald-500/[0.045] shadow-[inset_3px_0_0_rgba(52,211,153,0.85)]'
                        : 'border-slate-800 bg-slate-950/80 hover:border-slate-700')}
                    >
                      <div className="flex min-w-0 items-start gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-slate-100" title={snapshotName}>{snapshotName}</div>
                          <div className="mt-1.5 truncate font-mono text-[10px] leading-4 text-slate-500" title={snapshot.identity.documentVersion}>
                            {snapshot.identity.documentVersion}
                          </div>
                        </div>
                        <span className={'ml-auto inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[10px] font-medium ' + (isActive
                          ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300'
                          : 'border-slate-700 bg-slate-800/70 text-slate-400')}
                        >
                          <span className={'h-1.5 w-1.5 rounded-full ' + (isActive ? 'bg-emerald-400' : 'bg-slate-500')} aria-hidden="true" />
                          {isActive ? '活动中' : '待激活'}
                        </span>
                      </div>

                      <dl className="mt-3 grid grid-cols-3 divide-x divide-slate-800 rounded-lg border border-slate-800/80 bg-slate-900/50 py-2">
                        <div className="px-3">
                          <dt className="text-[10px] text-slate-500">实体</dt>
                          <dd className="mt-0.5 text-sm font-semibold tabular-nums text-slate-200">{snapshot.nodeCount}</dd>
                        </div>
                        <div className="px-3">
                          <dt className="text-[10px] text-slate-500">关系</dt>
                          <dd className="mt-0.5 text-sm font-semibold tabular-nums text-slate-200">{snapshot.edgeCount}</dd>
                        </div>
                        <div className="px-3">
                          <dt className="text-[10px] text-slate-500">信任级别</dt>
                          <dd className="mt-0.5 truncate text-xs font-medium text-slate-300">{TRUST_LEVEL_LABELS[snapshot.identity.trustLevel]}</dd>
                        </div>
                      </dl>

                      <div className="mt-3 flex min-h-8 items-center justify-between gap-3">
                        <time dateTime={snapshot.createdAt} className="min-w-0 truncate text-[10px] text-slate-500" title={snapshot.createdAt}>
                          创建于 {formatSnapshotDate(snapshot.createdAt)}
                        </time>
                        {!isActive ? (
                          <div className="flex shrink-0 items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void updateActive(snapshot)}
                              disabled={!managementEnabled || busy === 'snapshot'}
                              aria-label={'激活快照 ' + snapshotName}
                              className="whitespace-nowrap rounded-lg bg-emerald-400 px-3 py-1.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              激活
                            </button>
                            <button
                              type="button"
                              onClick={() => void deleteSnapshot(snapshot)}
                              disabled={!managementEnabled || busy === 'snapshot'}
                              aria-label={'删除快照 ' + snapshotName}
                              className="whitespace-nowrap rounded-lg border border-red-400/20 bg-red-400/[0.07] px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:border-red-400/35 hover:bg-red-400/10 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              删除
                            </button>
                          </div>
                        ) : (
                          <span className="shrink-0 text-[10px] font-medium text-emerald-300/80">正在服务</span>
                        )}
                      </div>
                    </article>
                  );
                })}
                {snapshots.length === 0 && <Empty>当前知识库还没有可用快照。</Empty>}
              </div>
            </Panel>

            <Panel title="社区摘要" subtitle="社区结果同样限定在活动版本和当前知识库。">
              <form onSubmit={loadCommunities} className="flex gap-2">
                <input required value={communityQuery} onChange={event => setCommunityQuery(event.target.value)} placeholder="输入社区关键词" className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-pink-500" />
                <button disabled={!ready || !communityQuery.trim() || busy === 'communities'} className="rounded-lg bg-pink-500 px-3 py-2 text-sm text-white hover:bg-pink-400 disabled:opacity-50">查询</button>
              </form>
              <div className="mt-4 space-y-3">
                {communities.map(({ community }) => (
                  <article key={community.id} className="rounded-xl border border-slate-800 bg-slate-950 p-4">
                    <div className="flex justify-between gap-3"><strong className="text-sm">{community.name}</strong><span className="text-xs text-pink-300">L{community.level}</span></div>
                    <p className="mt-2 text-xs leading-5 text-slate-400">{community.summary || '暂无摘要'}</p>
                    <div className="mt-3 flex flex-wrap gap-1">{community.keywords.map(keyword => <Tag key={keyword}>{keyword}</Tag>)}</div>
                    <p className="mt-3 text-[11px] text-slate-500">{community.entityIds.length} 实体 · {community.claimIds.length} 关系声明</p>
                  </article>
                ))}
                {communities.length === 0 && <Empty>查询活动图的社区摘要。</Empty>}
              </div>
            </Panel>
          </div>
        </section>
      </div>
    </main>
  );
}

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5 shadow-xl shadow-black/10"><h2 className="text-base font-semibold">{title}</h2><p className="mb-4 mt-1 text-xs leading-5 text-slate-400">{subtitle}</p>{children}</section>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="rounded-xl border border-slate-800 bg-slate-900 p-4"><div className="text-xs uppercase tracking-wider text-slate-500">{label}</div><div className="mt-2 truncate text-lg font-semibold text-white">{value}</div><div className="mt-1 text-xs text-slate-400">{detail}</div></div>;
}

function StatusBadge({ health }: { health: Health | null }) {
  const ready = health?.status === 'ready';
  return <span className={'rounded-full border px-3 py-1 text-xs ' + (ready ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-slate-700 bg-slate-900 text-slate-400')}><span className={'mr-2 inline-block h-2 w-2 rounded-full ' + (ready ? 'bg-emerald-400' : 'bg-slate-500')} />{ready ? 'Neo4j 就绪' : health?.status === 'disabled' ? '图后端未启用' : '检测中'}</span>;
}

function HopSelect({ value, onChange }: { value: 1 | 2; onChange: (value: 1 | 2) => void }) {
  return <select aria-label="最大跳数" value={value} onChange={event => onChange(Number(event.target.value) as 1 | 2)} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none"><option value={1}>1 跳</option><option value={2}>2 跳</option></select>;
}

function PathList({
  paths,
  empty,
  onClaimSelect,
}: {
  paths: PathResult[];
  empty: string;
  onClaimSelect: (claimId: string) => Promise<void>;
}) {
  if (paths.length === 0) return <Empty>{empty}</Empty>;
  return (
    <ol className="space-y-2">
      {paths.map((path, index) => (
        <li key={path.claimIds.join(':') + ':' + index} className="rounded-lg border border-slate-800 bg-slate-950 p-3">
          <div className="break-all text-xs font-medium text-cyan-200">{path.entityIds.join(' → ')}</div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
            <span>{path.passageIds.length} 个证据片段</span>
            <span>score {path.score.toFixed(3)}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {path.claimIds.map(claimId => (
              <button
                key={claimId}
                type="button"
                onClick={() => void onClaimSelect(claimId)}
                className="rounded-md border border-cyan-500/30 px-2 py-1 text-[11px] text-cyan-300 hover:bg-cyan-500/10"
              >查看来源 · {claimId}</button>
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300">{children}</span>;
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-slate-800 p-4 text-center text-xs text-slate-500">{children}</div>;
}

function formatSnapshotDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : SNAPSHOT_DATE_FORMATTER.format(date);
}

function findEntityReference(results: EntityResult[], reference: string): Entity | undefined {
  const normalizedReference = reference.toLocaleLowerCase();
  return results.find(({ entity }) => (
    entity.id.toLocaleLowerCase() === normalizedReference
    || entity.name.toLocaleLowerCase() === normalizedReference
    || entity.aliases.some(alias => alias.toLocaleLowerCase() === normalizedReference)
  ))?.entity;
}

function scopeHeaders(corpusId: string): HeadersInit {
  return corpusId ? { 'x-rag-corpus-id': corpusId } : {};
}

async function readEnvelope<T>(response: Response): Promise<T> {
  const body = await response.json() as Envelope<T>;
  if (!response.ok || !body.success || body.data === undefined) {
    throw new Error(body.error || '知识图谱请求失败。');
  }
  return body.data;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : '知识图谱请求失败。';
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError';
}

function sameIdentity(left: ArtifactIdentity, right: ArtifactIdentity | null | undefined): boolean {
  return !!right
    && left.tenantId === right.tenantId
    && left.corpusId === right.corpusId
    && left.documentId === right.documentId
    && left.documentVersion === right.documentVersion
    && left.trustLevel === right.trustLevel;
}

function buildSourceKey(source: BuildSource | undefined): string {
  return source ? source.documentId + '\u001f' + source.documentVersion : '';
}

function isTerminalBuildStatus(status: BuildJob['status']): boolean {
  return status === 'validated' || status === 'published' || status === 'failed' || status === 'cancelled';
}

function buildJobStatusLabel(status: BuildJob['status']): string {
  const labels: Record<BuildJob['status'], string> = {
    queued: '任务已入队',
    running: '正在抽取实体与关系',
    staged: '图谱已暂存',
    validated: '快照创建完成，等待激活',
    published: '快照创建完成',
    failed: '快照创建失败',
    cancelled: '任务已取消',
  };
  return labels[status];
}

function buildJobTone(status: BuildJob['status']): string {
  if (status === 'failed') return 'border-red-500/30 bg-red-500/10 text-red-200';
  if (status === 'validated' || status === 'published') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
  }
  if (status === 'cancelled') return 'border-slate-700 bg-slate-950 text-slate-400';
  return 'border-cyan-500/30 bg-cyan-500/10 text-cyan-200';
}

'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { PublishedDocumentGraph as Graph, PublishedGraphHead } from '@/lib/knowledge-graph/document-graph-reader';

const API_ROOT = '/rag-api/documents/graph';

export default function PublishedDocumentGraph() {
  const [list, setList] = useState<{ documents: PublishedGraphHead[]; epoch: number; error: string }>({ documents: [], epoch: -1, error: '' });
  const [selection, setSelection] = useState('');
  const [result, setResult] = useState<{ documentId: string; epoch: number; graph: Graph | null; error: string }>({ documentId: '', epoch: -1, graph: null, error: '' });
  const [selectedClaim, setSelectedClaim] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const documents = list.epoch === refresh ? list.documents : [];
  const documentId = documents.some(item => item.documentId === selection) ? selection : documents[0]?.documentId || '';
  const current = result.documentId === documentId && result.epoch === refresh;
  const graph = current ? result.graph : null;
  const error = list.epoch === refresh ? list.error || (current ? result.error : '') : '';
  const loading = !error && (list.epoch !== refresh || (!!documentId && !current));

  useEffect(() => {
    const controller = new AbortController();
    fetch(API_ROOT, { cache: 'no-store', signal: controller.signal })
      .then(async response => { const body = await response.json(); if (!response.ok || !body.success) throw new Error(body.error || '图谱列表读取失败。'); return body.documents as PublishedGraphHead[]; })
      .then(items => { if (!controller.signal.aborted) setList({ documents: items, epoch: refresh, error: '' }); })
      .catch(cause => { if (!controller.signal.aborted) setList({ documents: [], epoch: refresh, error: cause instanceof Error ? cause.message : '图谱列表读取失败。' }); });
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (!documentId) return;
    const controller = new AbortController();
    fetch(`${API_ROOT}?documentId=${encodeURIComponent(documentId)}`, { cache: 'no-store', signal: controller.signal })
      .then(async response => { const body = await response.json(); if (!response.ok || !body.success) throw new Error(body.error || '图谱读取失败。'); return body.graph as Graph; })
      .then(value => { if (!controller.signal.aborted) setResult({ documentId, epoch: refresh, graph: value, error: '' }); })
      .catch(cause => { if (!controller.signal.aborted) setResult({ documentId, epoch: refresh, graph: null, error: cause instanceof Error ? cause.message : '图谱读取失败。' }); });
    return () => controller.abort();
  }, [documentId, refresh]);

  const positions = useMemo(() => new Map(graph?.entities.map((entity, index, items) => [entity.id, {
    x: 360 + Math.cos(index * 2 * Math.PI / items.length) * 240,
    y: 230 + Math.sin(index * 2 * Math.PI / items.length) * 155,
  }]) || []), [graph]);
  const claim = graph?.claims.find(item => item.id === selectedClaim);
  const sources = graph?.passages.filter(passage => claim?.passageIds.includes(passage.id)) || [];

  return <main className="min-h-screen bg-slate-950 px-6 py-8 text-slate-100">
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div><h1 className="text-2xl font-semibold">已发布知识图谱</h1><p className="mt-2 text-sm text-slate-400">查看文档当前已发布版本的关键词及共现关系，点击关系查看原文。</p></div>
        <div className="flex gap-4 text-sm"><Link href="/documents" className="text-cyan-300">文档管理</Link><Link href="/document-search" className="text-cyan-300">文档搜索</Link><Link href="/" className="text-cyan-300">返回首页</Link></div>
      </header>
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex flex-wrap items-center gap-4"><label className="text-sm" htmlFor="published-graph-document">文档</label>
          <select id="published-graph-document" value={documentId} onChange={event => { setSelection(event.target.value); setSelectedClaim(null); }} className="min-w-64 max-w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm">
            {!documents.length && <option value="">暂无已发布图谱</option>}
            {documents.map(item => <option key={item.documentId} value={item.documentId}>{item.documentId} · 第 {item.generation} 版</option>)}
          </select>
          <button onClick={() => setRefresh(value => value + 1)} className="rounded bg-cyan-700 px-4 py-2 text-sm hover:bg-cyan-600">刷新</button>
        </div>
        <p className="mt-3 text-xs text-slate-400">共现表示关键词出现在同一段原文中。</p>
      </section>
      {error && <p role="alert" className="rounded border border-rose-900 bg-rose-950 p-4 text-sm text-rose-200">{error}</p>}
      {loading && <p role="status" className="text-slate-400">正在读取已发布图谱…</p>}
      {!loading && !error && !documents.length && <p className="text-slate-400">请先在文档管理中发布文档，完成后刷新此页。</p>}
      {graph && <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900 p-4">
          <p className="text-sm text-slate-300">{graph.entities.length} 个关键词 · {graph.claims.length} 条关系 · {graph.passages.length} 段原文</p>
          <svg viewBox="0 0 720 460" className="mt-4 w-full" role="img" aria-label="文档关键词共现图">
            {graph.claims.map(item => { const from = positions.get(item.sourceEntityId), to = positions.get(item.targetEntityId); return from && to ? <line key={item.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={item.id === selectedClaim ? '#22d3ee' : '#475569'} strokeWidth={item.id === selectedClaim ? 4 : 1} /> : null; })}
            {graph.entities.map(entity => { const position = positions.get(entity.id)!; return <g key={entity.id}><circle cx={position.x} cy={position.y} r={8} fill="#22d3ee" /><text x={position.x} y={position.y + 26} textAnchor="middle" fill="#e2e8f0" fontSize={13}>{entity.name}</text></g>; })}
          </svg>
          {!graph.entities.length && <p className="py-8 text-sm text-slate-400">当前文档没有可展示的关键词。</p>}
        </section>
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4"><h2 className="font-medium">关系与来源</h2>
          <div className="mt-4 max-h-64 space-y-2 overflow-auto">{graph.claims.map(item => <button key={item.id} onClick={() => setSelectedClaim(item.id)} className="block w-full rounded border border-slate-700 p-2 text-left text-sm hover:border-cyan-500">{graph.entities.find(entity => entity.id === item.sourceEntityId)?.name} ↔ {graph.entities.find(entity => entity.id === item.targetEntityId)?.name}<span className="ml-2 text-xs text-slate-400">共现 · 查看原文</span></button>)}</div>
          {sources.map(passage => <article key={passage.id} className="mt-4 border-t border-slate-700 pt-4"><p className="text-xs text-cyan-300">{passage.source || '原文'}{passage.page === undefined ? '' : ` · 第 ${passage.page} 页`} · 字符 {passage.startOffset}–{passage.endOffset}</p><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-300">{passage.content}</p></article>)}
          {!graph.claims.length && <p className="mt-4 text-sm text-slate-400">当前文档没有共现关系。</p>}
        </section>
      </div>}
    </div>
  </main>;
}

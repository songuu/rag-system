'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { reviewDraftCase, serializeDatasetDraft, updateDraftCase, validateDatasetDraft } from '@/lib/rag/eval/dataset-draft';
import type { RagEvalCase, RagEvalDataset, RagEvalRelevance } from '@/lib/rag/eval/types';
import type { DocumentCatalogItem } from '@/lib/documents/document-catalog';

interface SourceInput { source: string; content: string }
interface SourceCoverage {
  documentAssetId: string; source: string; documentVersion: string;
  totalChunks: number; selectedChunks: number; characterCount: number; sampled: boolean;
}
interface GenerationSummary {
  requestedCount: number; generatedCount: number; attempts: number; complete: boolean;
  reason?: 'attempt_limit' | 'timeout' | 'provider_error'; message?: string;
}
const PARTIAL_GENERATION_REASONS = {
  attempt_limit: '已达到本次自动补齐次数上限。',
  timeout: '本次补生成超时，已生成的有效题目已保留。',
  provider_error: '模型服务暂不可用，已生成的有效题目已保留。',
};
const MAX_SOURCES = 8;
const MAX_CHARACTERS = 24_000;
const fieldClass = 'mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal text-slate-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100 disabled:bg-slate-50';
const secondaryButton = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-sky-500 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50';

function unavailableDocumentReason(document: DocumentCatalogItem): string | null {
  if (document.lifecycle !== 'active') return '删除中';
  if (!document.enabled) return '已停用';
  if (document.trustLevel === 'quarantined') return '已隔离';
  if (document.milvusStatus !== 'ready') return '正文尚未就绪';
  if (!Number.isSafeInteger(document.chunkCount) || document.chunkCount <= 0) return '没有可用分块';
  if (document.chunkCount > 100_000) return '文档分块过多';
  if (!document.documentVersion || ['unknown', 'unversioned'].includes(document.documentVersion)) return '缺少文档版本';
  return null;
}

function CaseEditor({ item, index, dataset, disabled, onChange, onReview, onDelete }: {
  item: RagEvalCase; index: number; dataset: RagEvalDataset; disabled: boolean;
  onChange: (patch: Partial<RagEvalCase>) => void; onReview: () => void; onDelete: () => void;
}) {
  const [factsText, setFactsText] = useState(item.expectedAnswer?.requiredFacts.map(fact => fact.join(' | ')).join('\n') ?? '');
  const reviewed = item.tags.includes('human-reviewed');
  const number = index + 1;
  return <article className="overflow-hidden rounded-xl border border-slate-200 bg-white">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
      <div className="flex items-center gap-3"><span className="font-mono text-xs text-slate-400">{String(number).padStart(2, '0')}</span>
        <h3 className="text-sm font-semibold">问题与标注</h3>
        <span className={'rounded px-2 py-1 text-xs ' + (reviewed ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800')}>{reviewed ? '已审核' : 'AI 草稿 · 待审核'}</span>
      </div>
      <div className="flex gap-3"><button type="button" disabled={disabled || reviewed} onClick={onReview} className="text-xs font-medium text-sky-800 disabled:text-slate-400">{reviewed ? '审核完成' : '标记已审核'}</button>
        <button type="button" disabled={disabled} aria-label={'删除问题 ' + number} onClick={onDelete} className="text-xs text-slate-400 hover:text-rose-700 disabled:opacity-50">删除</button></div>
    </div>
    <fieldset disabled={disabled} className="grid min-w-0 gap-5 p-5 lg:grid-cols-2">
      <legend className="sr-only">第 {number} 题标注编辑</legend>
      <div className="min-w-0 space-y-4">
        <label className="block text-xs font-semibold text-slate-600">问题
          <textarea aria-label={'问题 ' + number} rows={2} value={item.query} onChange={event => onChange({ query: event.target.value })} className={fieldClass} />
        </label>
        <label className="block text-xs font-semibold text-slate-600">参考答案
          <textarea aria-label={'参考答案 ' + number} rows={4} value={item.expectedAnswer?.referenceAnswer ?? ''}
            onChange={event => onChange({ expectedAnswer: { requiredFacts: item.expectedAnswer?.requiredFacts ?? [], referenceAnswer: event.target.value } })} className={fieldClass} />
        </label>
        <label className="block text-xs font-semibold text-slate-600">答案要点
          <textarea aria-label={'答案要点 ' + number} rows={4} value={factsText} onChange={event => {
            const text = event.target.value;
            setFactsText(text);
            onChange({ expectedAnswer: { referenceAnswer: item.expectedAnswer?.referenceAnswer,
              requiredFacts: text.split('\n').filter(line => line.trim()).map(line => line.split('|').map(value => value.trim()).filter(Boolean)) } });
          }} className={fieldClass} />
          <span className="mt-2 block text-[11px] font-normal leading-5 text-slate-400">每行一个必答事实；同义表达用 | 分隔。评测按这些要点匹配答案，全文供人工核对。</span>
        </label>
      </div>
      <div className="min-w-0 rounded-lg bg-slate-50 p-4">
        <h4 className="text-xs font-semibold text-slate-700">相关资料标注</h4>
        <p className="mt-2 text-xs leading-5 text-slate-500">核对引用是否足以支持答案。相关度：3 核心依据，2 重要补充，1 部分相关。</p>
        <div className="mt-4 space-y-4">{item.goldEvidence.map((gold, evidenceIndex) => {
          const document = dataset.corpus.find(source => source.evidenceId === gold.evidenceId);
          return <div key={gold.evidenceId} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 break-all text-xs font-medium text-slate-700">{document?.source ?? gold.evidenceId}</p>
              <label className="flex items-center gap-2 text-xs text-slate-500">相关度
                <select aria-label={'相关度 ' + number + '-' + (evidenceIndex + 1)} value={gold.relevance} onChange={event => onChange({
                  goldEvidence: item.goldEvidence.map((value, position) => position === evidenceIndex ? { ...value, relevance: Number(event.target.value) as RagEvalRelevance } : value),
                })} className="rounded border border-slate-200 bg-white px-2 py-1 text-slate-800">
                  <option value={3}>3 · 核心</option><option value={2}>2 · 补充</option><option value={1}>1 · 部分</option>
                </select>
              </label>
            </div>
            {document?.documentVersion ? <p title={document.documentVersion} className="mt-2 break-all text-[10px] text-slate-400">文档版本 {document.documentVersion}</p> : null}
            {(gold.spans ?? []).map((span, spanIndex) => <div key={spanIndex} className="mt-3">
              <blockquote className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-l-2 border-sky-300 pl-3 text-sm leading-7 text-slate-600">{document?.content.slice(span.startOffset, span.endOffset)}</blockquote>
              <p className="mt-2 font-mono text-[10px] text-slate-400">原文区间 [{span.startOffset}, {span.endOffset})</p>
            </div>)}
            <details className="mt-3 text-xs text-slate-500"><summary className="cursor-pointer">{document?.documentVersion ? '查看该分块全文' : '查看完整资料'}</summary>
              <p className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words leading-6">{document?.content}</p>
            </details>
          </div>;
        })}</div>
      </div>
    </fieldset>
  </article>;
}

export default function RagDatasetBuilder() {
  const [sourceMode, setSourceMode] = useState<'knowledge' | 'manual'>('knowledge');
  const [sources, setSources] = useState<SourceInput[]>([{ source: '资料 1', content: '' }]);
  const [documents, setDocuments] = useState<DocumentCatalogItem[]>([]);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [documentSearch, setDocumentSearch] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [catalogNotice, setCatalogNotice] = useState('');
  const [sourceCoverage, setSourceCoverage] = useState<SourceCoverage[]>([]);
  const [generationSummary, setGenerationSummary] = useState<GenerationSummary | null>(null);
  const [datasetId, setDatasetId] = useState('rag-evaluation');
  const [datasetVersion, setDatasetVersion] = useState('1');
  const [count, setCount] = useState(5);
  const [dataset, setDataset] = useState<RagEvalDataset | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [generating, setGenerating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [generation, setGeneration] = useState(0);
  const requestSequence = useRef(0);
  const importSequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const catalogController = useRef<AbortController | null>(null);
  const catalogSequence = useRef(0);
  const selectedDocumentIdsRef = useRef<string[]>([]);
  const busy = generating || importing;
  const totalCharacters = sources.reduce((sum, source) => sum + source.content.length, 0);
  const reviewedCount = dataset?.cases.filter(item => item.tags.includes('human-reviewed')).length ?? 0;
  const incompleteGeneration = !!dataset && !!generationSummary
    && (!generationSummary.complete || dataset.cases.length < generationSummary.requestedCount);
  const issues = dataset ? validateDatasetDraft(dataset) : [];
  const visibleDocuments = documents.filter(document => document.name.toLocaleLowerCase().includes(documentSearch.trim().toLocaleLowerCase()));

  const loadDocuments = useCallback(async () => {
    const sequence = ++catalogSequence.current;
    catalogController.current?.abort();
    const abortController = new AbortController();
    catalogController.current = abortController;
    try {
      const response = await fetch('/rag-api/documents', { signal: abortController.signal, cache: 'no-store' });
      const result = await response.json();
      if (sequence !== catalogSequence.current || abortController.signal.aborted) return;
      if (!response.ok || !result.success || !Array.isArray(result.documents)) {
        throw new Error(result.error?.message || '无法读取知识库文档，请刷新重试。');
      }
      const nextDocuments = result.documents as DocumentCatalogItem[];
      const eligible = new Set(nextDocuments.filter(document => !unavailableDocumentReason(document)).map(document => document.id));
      const nextSelected = selectedDocumentIdsRef.current.filter(id => eligible.has(id));
      if (nextSelected.length !== selectedDocumentIdsRef.current.length) setCatalogNotice('已移除不可用或已失效的文档选择，请重新核对。');
      selectedDocumentIdsRef.current = nextSelected;
      setSelectedDocumentIds(nextSelected);
      setDocuments(nextDocuments);
    } catch (failure) {
      if (sequence === catalogSequence.current && !abortController.signal.aborted) {
        setCatalogError(failure instanceof Error ? failure.message : '无法读取知识库文档，请刷新重试。');
      }
    } finally {
      if (sequence === catalogSequence.current) { setCatalogLoading(false); catalogController.current = null; }
    }
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => { if (active) void loadDocuments(); });
    return () => { active = false; };
  }, [loadDocuments]);
  useEffect(() => () => {
      requestSequence.current++; importSequence.current++; catalogSequence.current++;
      controller.current?.abort(); catalogController.current?.abort();
  }, []);

  function toggleDocument(id: string, checked: boolean) {
    const next = checked ? [...selectedDocumentIds, id] : selectedDocumentIds.filter(value => value !== id);
    if (next.length > MAX_SOURCES) return;
    selectedDocumentIdsRef.current = next;
    setSelectedDocumentIds(next); setError('');
  }

  async function importFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (!files.length || busy) return;
    const sequence = ++importSequence.current;
    setImporting(true); setError('');
    try {
      const existing = sources.filter(source => source.content.trim());
      if (existing.length + files.length > MAX_SOURCES) throw new Error('最多保留 8 份资料，请先删除不需要的资料。');
      if (files.some(file => !/\.(txt|md|markdown)$/i.test(file.name))) throw new Error('请选择 TXT 或 Markdown 文本文件。');
      if (files.some(file => file.size > 96_000)) throw new Error('单个文本文件不能超过 96 KB；资料总计不超过 24,000 字符。');
      const incoming = await Promise.all(files.map(async file => ({ source: file.name, content: await file.text() })));
      if (incoming.some(source => !source.content.trim())) throw new Error('导入的文件没有正文，请选择包含资料的文件。');
      if (totalCharacters + incoming.reduce((sum, source) => sum + source.content.length, 0) > MAX_CHARACTERS) throw new Error('资料总计不能超过 24,000 字符，请按主题分批生成。');
      if (sequence === importSequence.current) {
        setSources([...existing, ...incoming]);
        setStatus('已导入 ' + incoming.length + ' 份资料。');
      }
    } catch (failure) { if (sequence === importSequence.current) setError(failure instanceof Error ? failure.message : '资料读取失败。'); }
    finally { if (sequence === importSequence.current) setImporting(false); }
  }

  async function generate() {
    if (busy || (sourceMode === 'knowledge' && (catalogLoading || catalogError))) return;
    setError(''); setStatus('');
    const activeSources = sources.filter(source => source.content.trim());
    if (!datasetId.trim() || !datasetVersion.trim() || datasetId.length > 80 || datasetVersion.length > 80) {
      setError('请填写测试集名称和版本，每项最多 80 个字符。'); return;
    }
    if (!Number.isInteger(count) || count < 1 || count > 20) { setError('生成题数必须为 1 到 20 的整数。'); return; }
    if (sourceMode === 'knowledge') {
      const eligible = new Set(documents.filter(document => !unavailableDocumentReason(document)).map(document => document.id));
      if (!selectedDocumentIds.length || selectedDocumentIds.some(id => !eligible.has(id))) {
        setError('请先选择至少一份可用的知识库文档。'); return;
      }
    } else {
      if (!activeSources.length) { setError('请先粘贴资料正文或导入 TXT / Markdown 文件。'); return; }
      if (activeSources.some(source => !source.source.trim() || source.source.length > 200)) { setError('请填写每份资料的名称，最多 200 个字符。'); return; }
      if (totalCharacters > MAX_CHARACTERS) { setError('资料总计不能超过 24,000 字符，请按主题分批生成。'); return; }
    }
    const sequence = ++requestSequence.current;
    const abortController = new AbortController();
    controller.current = abortController;
    setGenerating(true);
    try {
      const response = await fetch('/rag-api/rag-evaluation/datasets/generate', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, signal: abortController.signal,
        body: JSON.stringify({ datasetId: datasetId.trim(), datasetVersion: datasetVersion.trim(), count,
          ...(sourceMode === 'knowledge' ? { documentAssetIds: selectedDocumentIds } : { sources: activeSources }) }),
      });
      const result = await response.json();
      if (sequence !== requestSequence.current || abortController.signal.aborted) return;
      if (!response.ok || !result.success) throw new Error(result.error?.message || '测试集生成失败，请检查模型服务后重试。');
      const nextDataset = result.dataset as RagEvalDataset;
      const validation = validateDatasetDraft(nextDataset);
      if (validation.length) throw new Error('生成结果不完整：' + validation[0]);
      const nextSummary: GenerationSummary = {
        requestedCount: count,
        generatedCount: nextDataset.cases.length,
        attempts: Number.isSafeInteger(result.generation?.attempts) && result.generation.attempts >= 0 ? result.generation.attempts : 0,
        complete: result.generation?.complete !== false && nextDataset.cases.length === count,
        reason: result.generation?.reason,
        message: typeof result.generation?.message === 'string' ? result.generation.message : undefined,
      };
      setDataset(nextDataset); setSourceCoverage(result.sourceCoverage ?? []); setGenerationSummary(nextSummary); setGeneration(value => value + 1);
      setStatus(nextSummary.complete
        ? '已生成 ' + nextDataset.cases.length + ' / ' + nextSummary.requestedCount + ' 题，请核对参考答案、答案要点和原文标注。'
        : '已保留 ' + nextDataset.cases.length + ' / ' + nextSummary.requestedCount + ' 题，尚未补齐，可下载草稿。');
    } catch (failure) {
      if (sequence === requestSequence.current && !abortController.signal.aborted) setError(failure instanceof Error ? failure.message : '测试集生成失败。');
    } finally {
      if (sequence === requestSequence.current) { setGenerating(false); controller.current = null; }
    }
  }

  function cancel() {
    requestSequence.current++; controller.current?.abort(); controller.current = null;
    setGenerating(false); setStatus('已取消生成，资料和已有草稿已保留。');
  }

  function download() {
    if (!dataset) return;
    setError('');
    try {
      const content = serializeDatasetDraft(dataset);
      const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }));
      try {
        const link = document.createElement('a'); link.href = url; link.download = 'rag-eval-dataset.json';
        document.body.appendChild(link); link.click(); link.remove();
      } finally { URL.revokeObjectURL(url); }
      setStatus(incompleteGeneration
        ? '已下载 ' + dataset.cases.length + ' / ' + generationSummary!.requestedCount + ' 题的部分草稿，尚未达到目标题数。'
        : reviewedCount === dataset.cases.length ? '已下载审核后的测试集。' : '已下载 JSON 草稿，使用前请完成人工核对。');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '测试集下载失败。'); }
  }

  function reviewCase(caseId: string) {
    if (!dataset) return;
    setError('');
    try { setDataset(reviewDraftCase(dataset, caseId)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '该题标注尚不完整，请修正后再审核。'); }
  }

  return <div className="space-y-6">
    <section aria-label="准备测试资料" className="rounded-xl border border-slate-200 bg-white p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><p className="font-mono text-xs text-sky-700">01 / 准备资料</p><h2 className="mt-2 text-lg font-semibold">从可信的原文开始</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">选择已上传的知识库文档，直接生成问题和标注。也可使用粘贴或导入的文本。</p></div>
        {sourceMode === 'manual' ? <label className={secondaryButton + ' relative cursor-pointer focus-within:outline-2 focus-within:outline-sky-600 ' + (busy ? 'opacity-50' : '')}>
          {importing ? '正在导入…' : '导入文本资料'}
          <input type="file" multiple accept=".txt,.md,.markdown,text/plain,text/markdown" aria-label="导入 TXT 或 Markdown 资料" disabled={busy}
            onChange={event => { void importFiles(event); }} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
        </label> : null}
      </div>
      <div className="mt-5 inline-flex max-w-full gap-1 rounded-lg bg-slate-100 p-1" aria-label="资料来源方式">
        {([['knowledge', '知识库文档'], ['manual', '粘贴 / 导入文本']] as const).map(([mode, label]) => <button key={mode} type="button"
          aria-pressed={sourceMode === mode} disabled={busy} onClick={() => { setSourceMode(mode); setError(''); }}
          className={'rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50 ' + (sourceMode === mode ? 'bg-white text-sky-900 shadow-sm' : 'text-slate-500 hover:text-slate-900')}>{label}</button>)}
      </div>
      <fieldset disabled={busy} className="mt-6 space-y-4">
        <legend className="sr-only">测试集与资料设置</legend>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="text-xs font-semibold text-slate-600">测试集名称<input aria-label="测试集名称" value={datasetId} maxLength={80} onChange={event => setDatasetId(event.target.value)} className={fieldClass} /></label>
          <label className="text-xs font-semibold text-slate-600">版本<input aria-label="测试集版本" value={datasetVersion} maxLength={80} onChange={event => setDatasetVersion(event.target.value)} className={fieldClass} /></label>
          <label className="text-xs font-semibold text-slate-600">生成题数<input aria-label="生成题数" type="number" min={1} max={20} value={Number.isNaN(count) ? '' : count} onChange={event => setCount(event.target.valueAsNumber)} className={fieldClass} /></label>
        </div>
      </fieldset>
      {sourceMode === 'knowledge' ? <div className="mt-5 space-y-4" aria-label="选择知识库文档">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-0 flex-1 text-xs font-semibold text-slate-600">搜索文档
            <input aria-label="搜索知识库文档" type="search" value={documentSearch} disabled={busy || catalogLoading || !!catalogError}
              onChange={event => setDocumentSearch(event.target.value)} placeholder="按文档名称筛选…" className={fieldClass} />
          </label>
          <button type="button" disabled={busy || catalogLoading} onClick={() => {
            setCatalogLoading(true); setCatalogError(''); setCatalogNotice(''); void loadDocuments();
          }} className={secondaryButton}>{catalogLoading ? '读取文档中…' : '刷新文档'}</button>
        </div>
        <div className="flex flex-wrap justify-between gap-2 text-xs leading-6">
          <p className="text-slate-500">长文档将选取部分分块出题，生成后可查看实际覆盖范围。</p>
          <p className="font-mono text-sky-800">已选 {selectedDocumentIds.length} / 8 份文档</p>
        </div>
        {catalogError ? <p role="alert" className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-800">{catalogError}</p> : null}
        {catalogNotice ? <p role="status" className="rounded-lg bg-amber-50 px-4 py-3 text-xs text-amber-900">{catalogNotice}</p> : null}
        {catalogLoading ? <p role="status" className="py-5 text-center text-sm text-slate-500">正在读取已上传的文档…</p>
          : !catalogError && !documents.length ? <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
            <p className="text-sm text-slate-600">暂无已上传文档。</p><a href="/documents" className="mt-3 inline-block text-sm font-medium text-sky-800 hover:underline">前往文档管理</a>
          </div> : !catalogError ? <div className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
            {visibleDocuments.map(document => {
              const reason = unavailableDocumentReason(document);
              const selected = selectedDocumentIds.includes(document.id);
              return <label key={document.id} className={'flex items-start gap-3 px-4 py-3 ' + (reason ? 'bg-slate-50' : 'cursor-pointer hover:bg-sky-50')}>
                <input type="checkbox" aria-label={'选择文档 ' + document.name} checked={selected}
                  disabled={busy || !!reason || (!selected && selectedDocumentIds.length >= MAX_SOURCES)}
                  onChange={event => toggleDocument(document.id, event.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-sky-800" />
                <span className="min-w-0 flex-1"><span className="block break-all text-sm font-medium text-slate-700">{document.name}</span>
                  <span className="mt-1 block break-all text-xs leading-5 text-slate-400">{document.chunkCount} 个分块 · <span title={document.documentVersion}>版本 {document.documentVersion?.slice(0, 16) ?? '未知'}</span></span>
                </span>
                <span className={'shrink-0 rounded px-2 py-1 text-[11px] ' + (reason ? 'bg-slate-100 text-slate-500' : 'bg-emerald-50 text-emerald-800')}>{reason || '可用'}</span>
              </label>;
            })}
            {!visibleDocuments.length ? <p className="p-6 text-center text-sm text-slate-400">没有匹配的文档，请调整搜索词。</p> : null}
          </div> : null}
      </div> : <fieldset disabled={busy} className="mt-5 space-y-4">
        <legend className="sr-only">手动文本资料</legend>
        {sources.map((source, index) => <div key={index} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-end gap-3"><label className="min-w-0 flex-1 text-xs font-semibold text-slate-600">资料名称 {index + 1}
            <input aria-label={'资料名称 ' + (index + 1)} value={source.source} maxLength={200} onChange={event => setSources(current => current.map((value, position) => position === index ? { ...value, source: event.target.value } : value))} className={fieldClass} />
          </label>
            {sources.length > 1 ? <button type="button" aria-label={'删除资料 ' + (index + 1)} onClick={() => setSources(current => current.filter((_, position) => position !== index))} className="mb-3 text-xs text-slate-500 hover:text-rose-700">删除</button> : null}
          </div>
          <label className="mt-4 block text-xs font-semibold text-slate-600">资料正文
            <textarea aria-label={'资料正文 ' + (index + 1)} rows={5} placeholder="粘贴可用于出题和核对答案的原文…" value={source.content}
              onChange={event => setSources(current => current.map((value, position) => position === index ? { ...value, content: event.target.value } : value))} className={fieldClass} />
          </label>
        </div>)}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button type="button" disabled={sources.length >= MAX_SOURCES} onClick={() => setSources(current => [...current, { source: '资料 ' + (current.length + 1), content: '' }])} className="text-sm font-medium text-sky-800 disabled:text-slate-400">＋ 添加资料</button>
          <p className={'font-mono text-xs ' + (totalCharacters > MAX_CHARACTERS ? 'text-rose-700' : 'text-slate-400')}>{sources.length} / 8 份 · {totalCharacters.toLocaleString()} / 24,000 字符</p>
        </div>
      </fieldset>}
      <div className="mt-6 flex flex-wrap items-center gap-4 border-t border-slate-100 pt-5">
        <button type="button" disabled={busy || (sourceMode === 'knowledge' && (catalogLoading || !!catalogError))} onClick={() => { void generate(); }} className="rounded-lg bg-slate-900 px-5 py-3 text-sm font-medium text-white hover:bg-sky-900 disabled:cursor-wait disabled:opacity-50">{generating ? '生成中…' : dataset ? '重新生成测试集' : '生成测试集'}</button>
        {generating ? <button type="button" onClick={cancel} className={secondaryButton}>取消生成</button> : null}
        <p className="text-xs leading-5 text-slate-400">只生成资料中有依据的问题。重新生成会替换当前草稿；失败时保留。</p>
      </div>
    </section>

    {error ? <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-800">{error}</p> : null}
    <p role="status" aria-live="polite" className="text-xs leading-6 text-slate-500">{generating ? '正在分批生成并自动补齐缺少的题目，最多约 5 分钟，可取消…' : status || '内容仅保留在当前页面，刷新后清空。请及时下载 JSON。'}</p>

    {dataset ? <section aria-label="审核测试集" className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4 rounded-xl border border-sky-200 bg-sky-50 p-5 md:p-6">
        <div><p className="font-mono text-xs text-sky-700">02 / 核对与导出</p><h2 className="mt-2 text-lg font-semibold">把生成草稿，变成可信的标准。</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">已审核 {reviewedCount} / {dataset.cases.length} 题 · {dataset.datasetId} @ {dataset.datasetVersion}</p>
          <p className="mt-2 max-w-2xl text-xs leading-6 text-slate-500">AI 生成内容需人工核对。确认问题、参考答案、要点和证据后逐题标记；修改会重置该题审核状态。</p>
        </div>
        <button type="button" onClick={download} disabled={busy || issues.length > 0} className="rounded-lg bg-sky-800 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-900 disabled:cursor-not-allowed disabled:opacity-50">{incompleteGeneration ? '下载部分 JSON 草稿' : dataset.cases.length > 0 && reviewedCount === dataset.cases.length ? '下载审核后 JSON' : '下载 JSON 草稿'}</button>
      </div>
      {generationSummary ? <div aria-label="生成进度" role={incompleteGeneration ? 'alert' : 'status'}
        className={'rounded-xl border px-5 py-4 text-sm leading-6 ' + (incompleteGeneration ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900')}>
        <p className="font-medium">{incompleteGeneration
          ? '已保留 ' + dataset.cases.length + ' / ' + generationSummary.requestedCount + ' 题，尚未补齐，可下载草稿。'
          : '已生成 ' + dataset.cases.length + ' / ' + generationSummary.requestedCount + ' 题，已达到本次目标题数。'}</p>
        {incompleteGeneration && (generationSummary.message || generationSummary.reason) ? <p className="mt-1 text-xs">
          {generationSummary.message || (generationSummary.reason ? PARTIAL_GENERATION_REASONS[generationSummary.reason] : '')}
        </p> : null}
      </div> : null}
      {sourceCoverage.length ? <div aria-label="出题资料范围" className="rounded-xl border border-slate-200 bg-white p-5 text-xs leading-6 text-slate-500">
        <h3 className="font-semibold text-slate-700">本次出题的资料范围</h3>
        <ul className="mt-2 space-y-2">{sourceCoverage.map(source => <li key={source.documentAssetId} className="break-all">
          <span className="font-medium text-slate-700">{source.source}</span> · {source.selectedChunks} / {source.totalChunks} 分块 · {source.characterCount.toLocaleString()} 字符
          <span title={source.documentVersion} className="block font-mono text-[10px] text-slate-400">版本 {source.documentVersion}</span>
          {source.sampled ? <span className="block text-amber-800">仅依据所选的部分内容出题，不代表全文覆盖。</span> : null}
        </li>)}</ul>
      </div> : null}
      {issues.length ? <div role="alert" className="rounded-lg bg-amber-50 p-4 text-sm leading-6 text-amber-900">导出前请修正：{issues.slice(0, 3).join('；')}</div> : null}
      {dataset.cases.map((item, index) => <CaseEditor key={generation + ':' + item.id} item={item} index={index} dataset={dataset} disabled={busy}
        onChange={patch => { setError(''); setDataset(current => current ? updateDraftCase(current, item.id, patch) : current); }}
        onReview={() => reviewCase(item.id)}
        onDelete={() => {
          setStatus(''); setError('');
          setGenerationSummary(current => current ? { ...current, message: undefined } : current);
          setDataset(current => current ? { ...current, cases: current.cases.filter(value => value.id !== item.id) } : current);
        }} />)}
      <details className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600">
        <summary className="cursor-pointer font-medium text-slate-800">下载后，如何用于评测？</summary>
        <p className="mt-3 text-xs leading-6">将 JSON 放到项目目录，先校验再运行。默认检索目标为夹具流程；验证真实优化收益时还需真实检索目标和固定的文档快照。</p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-50 p-3 font-mono text-xs leading-7">pnpm rag:eval --fixture ./rag-eval-dataset.json --validate-only{'\n'}pnpm rag:eval --fixture ./rag-eval-dataset.json</pre>
        <p className="mt-3 text-xs leading-6">文件包含原文和全部标注，请妥善保存。生成的参考答案仅作审核依据，当前自动评测以答案要点匹配衡量事实覆盖。</p>
      </details>
    </section> : <div className="grid gap-4 sm:grid-cols-3" aria-label="测试集生成步骤">
      {[
        ['01', '选资料', '每份原文保留来源，按同一主题分批生成。'],
        ['02', '自动标注', '生成问题、参考答案、答案要点和可定位的原文引用。'],
        ['03', '审核导出', '逐题核对并下载 JSON，交给现有评测流程。'],
      ].map(([number, title, description]) => <div key={number} className="rounded-xl border border-slate-200 bg-white p-6"><span className="font-mono text-xs text-sky-600">{number}</span><h3 className="mt-4 font-semibold">{title}</h3><p className="mt-3 text-xs leading-6 text-slate-500">{description}</p></div>)}
    </div>}
  </div>;
}

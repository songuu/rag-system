'use client';

import Link from 'next/link';
import {
  ArrowUpRight,
  CheckCircle2,
  FilePlus2,
  FileText,
  Globe2,
  LoaderCircle,
  RefreshCw,
  Search,
  Trash2,
  Type,
  UploadCloud,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from 'react';
import styles from './KnowledgeWorkspace.module.css';
import type { DocumentCatalogSummary } from '@/lib/documents/document-catalog';

type SourceTab = 'file' | 'url' | 'text';
type IndexStatus = 'ready' | 'pending' | 'failed' | 'disabled' | 'unknown';

interface CatalogDocument {
  id: string;
  documentId: string;
  name: string;
  contentType: string;
  sourceKind: string;
  byteSize: number;
  chunkCount: number;
  documentVersion: string;
  trustLevel: string;
  createdAt: string;
  updatedAt: string;
  milvusStatus: IndexStatus;
  elasticsearchStatus: IndexStatus;
  enabled: boolean;
  lifecycle: 'active' | 'deleting';
}

interface WorkspaceRuntime {
  milvus: 'ready' | 'unavailable' | 'checking';
  elasticsearch: 'ready' | 'shadow' | 'disabled' | 'unavailable' | 'checking';
  embeddingModel: string;
}

const API_ROOT = '/rag-api';
const ACCEPTED_FILES = '.txt,.md,.markdown,.pdf,.docx,.xlsx,.xls,.csv,.json,.epub,.mobi';
const FORMATS = ['PDF', 'DOCX', 'XLSX', 'CSV', 'MD', 'TXT', 'JSON', 'EPUB', 'MOBI'];

export default function DocumentManagementWorkspace() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [documents, setDocuments] = useState<CatalogDocument[]>([]);
  const [summary, setSummary] = useState<DocumentCatalogSummary>({
    documentCount: 0,
    enabledDocumentCount: 0,
    disabledDocumentCount: 0,
    chunkCount: 0,
    searchableChunkCount: 0,
    disabledChunkCount: 0,
    byteSize: 0,
    syncedCount: 0,
    elasticsearchMode: 'off',
  });
  const [runtime, setRuntime] = useState<WorkspaceRuntime>({
    milvus: 'checking',
    elasticsearch: 'checking',
    embeddingModel: '读取中',
  });
  const [activeTab, setActiveTab] = useState<SourceTab>('file');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [chunkSize, setChunkSize] = useState(500);
  const [chunkOverlap, setChunkOverlap] = useState(50);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const mutationInFlight = useRef(false);
  const [deleteTarget, setDeleteTarget] = useState<CatalogDocument | null>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = deleteDialogRef.current;
    if (!dialog) return;
    if (deleteTarget && !dialog.open) dialog.showModal();
    else if (!deleteTarget && dialog.open) dialog.close();
  }, [deleteTarget]);

  const mutateDocument = async (document: CatalogDocument, method: 'PATCH' | 'DELETE') => {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setMutatingId(document.id);
    setError('');
    setNotice('');
    let failure = '';
    try {
      const response = await fetch(`${API_ROOT}/documents`, {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: document.id, ...(method === 'PATCH' ? { enabled: !document.enabled } : {}) }),
      });
      const payload = await response.json();
      if (!response.ok || payload.success !== true) throw new Error(readApiError(payload, '文档操作失败'));
      setNotice(method === 'DELETE' ? `已删除 ${document.name}` : `已${document.enabled ? '禁用' : '启用'} ${document.name}`);
      setDeleteTarget(null);
    } catch (mutationError) {
      failure = mutationError instanceof Error ? mutationError.message : '文档操作失败';
    } finally {
      await loadWorkspace();
      if (failure) setError(failure);
      setMutatingId(null);
      mutationInFlight.current = false;
    }
  };

  const loadWorkspace = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const responses = await Promise.all([
        fetch(`${API_ROOT}/documents`, { signal, cache: 'no-store' }),
        fetch(`${API_ROOT}/health`, { signal, cache: 'no-store' }),
        fetch(`${API_ROOT}/milvus?action=status`, { signal, cache: 'no-store' }),
        fetch(`${API_ROOT}/pipeline?action=info`, { signal, cache: 'no-store' }),
      ]);
      const [catalog, health, milvus, pipeline] = await Promise.all(
        responses.map(response => response.json())
      );
      if (!responses[0].ok || catalog.success !== true) {
        throw new Error(readApiError(catalog, '文档目录暂不可用'));
      }
      setDocuments(Array.isArray(catalog.documents) ? catalog.documents : []);
      setSummary(current => catalog.summary ?? current);
      const elasticsearchMode = health.elasticsearch?.mode;
      setRuntime({
        milvus: milvus.connected === true ? 'ready' : 'unavailable',
        elasticsearch: elasticsearchMode === 'off'
          ? 'disabled'
          : health.elasticsearch?.connected !== true
            ? 'unavailable'
            : elasticsearchMode === 'shadow'
              ? 'shadow'
              : 'ready',
        embeddingModel:
          pipeline.pipeline?.config?.embeddingModel
          || health.modelConfig?.embedding?.model
          || '未配置',
      });
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      setError(loadError instanceof Error ? loadError.message : '读取文档工作区失败');
      setRuntime(current => ({ ...current, milvus: 'unavailable', elasticsearch: 'unavailable' }));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void loadWorkspace(controller.signal); }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadWorkspace]);

  const filteredDocuments = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return documents.filter(document => {
      const matchesText = !normalized
        || document.name.toLowerCase().includes(normalized)
        || document.documentId.toLowerCase().includes(normalized);
      const matchesType = typeFilter === 'all' || normalizeSourceKind(document.sourceKind) === typeFilter;
      return matchesText && matchesType;
    });
  }, [documents, query, typeFilter]);

  const canSubmit = activeTab === 'file'
    ? selectedFiles.length > 0
    : activeTab === 'url'
      ? /^https?:\/\//i.test(url.trim())
      : text.trim().length > 0;

  const addFiles = (incoming: File[]) => {
    const accepted = incoming.filter(file => supportedFilename(file.name));
    setSelectedFiles(current => {
      const unique = new Map(current.map(file => [fileKey(file), file]));
      for (const file of accepted) unique.set(fileKey(file), file);
      return [...unique.values()];
    });
    if (accepted.length !== incoming.length) {
      setError('已忽略不支持的文件；仅接收 PDF、Word、Excel、CSV、Markdown、TXT、JSON、EPUB 和 MOBI。');
    } else {
      setError('');
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    addFiles(Array.from(event.dataTransfer.files));
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || uploading) return;
    setUploading(true);
    setError('');
    setNotice('');
    try {
      const response = activeTab === 'file'
        ? await uploadFiles()
        : await uploadRemoteSource();
      const payload = await response.json();
      const succeeded = Number(payload.successful ?? (payload.success === true ? 1 : 0));
      if (!response.ok || payload.success !== true || succeeded < 1) {
        throw new Error(readApiError(payload, '文档未能写入知识库'));
      }
      const chunks = Number(payload.totalChunks ?? payload.chunks ?? 0);
      setNotice(`导入完成：${succeeded} 个文档，${chunks} 个文档块已提交到索引链路。`);
      setSelectedFiles([]);
      setUrl('');
      setText('');
      setSourceName('');
      if (inputRef.current) inputRef.current.value = '';
      await loadWorkspace();
      if (Number(payload.failed) > 0) setError(readApiError(payload, '部分文档导入失败'));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '文档导入失败');
    } finally {
      setUploading(false);
    }
  };

  const uploadFiles = () => {
    const form = new FormData();
    selectedFiles.forEach(file => form.append('files', file));
    form.append('chunkSize', String(chunkSize));
    form.append('chunkOverlap', String(chunkOverlap));
    return fetch(`${API_ROOT}/pipeline`, { method: 'POST', body: form });
  };

  const uploadRemoteSource = () => {
    const isYoutube = activeTab === 'url' && /(?:youtube\.com|youtu\.be)/i.test(url);
    const body = activeTab === 'url'
      ? {
          action: isYoutube ? 'process-youtube' : 'process-url',
          ...(isYoutube ? { videoUrl: url.trim() } : { url: url.trim() }),
          chunkSize,
          chunkOverlap,
        }
      : {
          action: 'process-text',
          text: text.trim(),
          source: sourceName.trim() || `粘贴文本-${new Date().toISOString().slice(0, 10)}.txt`,
          chunkSize,
          chunkOverlap,
        };
    return fetch(`${API_ROOT}/pipeline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  return (
    <main className={styles.main}>
      <section className={styles.hero}>
        <div>
          <div className={styles.eyebrow}>Document operations</div>
          <h1>文档进入知识库的统一入口</h1>
          <p className={styles.heroCopy}>
            文件、网页、视频与粘贴文本都通过同一条受保护的 RAG 管道处理；成功后写入 Milvus 语义索引，
            并按部署模式同步 Elasticsearch 关键词索引与 PostgreSQL 资产目录。
          </p>
        </div>
        <div className={styles.backendRail} aria-label="文档索引链路">
          <BackendNode step="01 / INGEST" label="Canonical Pipeline" detail={runtime.embeddingModel} />
          <BackendNode step="02 / SEMANTIC" label="Milvus" detail={runtimeLabel(runtime.milvus)} />
          <BackendNode step="03 / LEXICAL" label="Elasticsearch" detail={runtimeLabel(runtime.elasticsearch)} />
        </div>
      </section>

      <section className={styles.metricGrid} aria-label="文档统计">
        <Metric label="文档资产" value={loading ? '—' : String(summary.documentCount)}
          detail={loading ? undefined : `已启用 ${summary.enabledDocumentCount} · 已停用 ${summary.disabledDocumentCount}`} />
        <Metric label="可检索文档块" value={loading ? '—' : summary.searchableChunkCount.toLocaleString('zh-CN')}
          detail={loading ? undefined : `已存储 ${summary.chunkCount.toLocaleString('zh-CN')} · 已停用 ${summary.disabledChunkCount.toLocaleString('zh-CN')}`} />
        <Metric label="原始资料体积" value={loading ? '—' : formatBytes(summary.byteSize)} detail="包含保留的已停用文档" />
        <Metric label="双索引就绪" value={loading ? '—' : `${summary.syncedCount}/${summary.documentCount}`} detail="索引存储状态，包含已停用文档" />
      </section>

      <div className={styles.managementGrid}>
        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h2>导入文档</h2>
              <p>上传后直接进入当前受保护语料库</p>
            </div>
            <FilePlus2 size={20} strokeWidth={1.6} />
          </div>
          <form className={styles.panelBody} onSubmit={handleSubmit}>
            <div className={styles.sourceTabs} role="tablist" aria-label="导入来源">
              <SourceTabButton active={activeTab === 'file'} icon={UploadCloud} label="文件上传" onClick={() => setActiveTab('file')} />
              <SourceTabButton active={activeTab === 'url'} icon={Globe2} label="网页地址" onClick={() => setActiveTab('url')} />
              <SourceTabButton active={activeTab === 'text'} icon={Type} label="粘贴文本" onClick={() => setActiveTab('text')} />
            </div>

            {activeTab === 'file' && (
              <>
                <input
                  ref={inputRef}
                  type="file"
                  accept={ACCEPTED_FILES}
                  multiple
                  hidden
                  onChange={event => addFiles(Array.from(event.target.files ?? []))}
                />
                <div
                  className={`${styles.dropzone} ${dragActive ? styles.dropzoneActive : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => inputRef.current?.click()}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
                  }}
                  onDragEnter={event => { event.preventDefault(); setDragActive(true); }}
                  onDragOver={event => event.preventDefault()}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={handleDrop}
                >
                  <div>
                    <span className={styles.dropIcon}><UploadCloud size={24} /></span>
                    <strong>拖拽文档到这里，或点击选择</strong>
                    <p>支持多文件导入，单次请求最大 10MB；文档会自动解析、分块并生成向量。</p>
                  </div>
                </div>
                {selectedFiles.length > 0 && (
                  <div className={styles.selectedFiles} aria-label="待上传文件">
                    {selectedFiles.map(file => (
                      <div className={styles.selectedFile} key={fileKey(file)}>
                        <FileText size={14} />
                        <span>{file.name}</span>
                        <span>{formatBytes(file.size)}</span>
                        <button type="button" onClick={() => setSelectedFiles(current => current.filter(item => fileKey(item) !== fileKey(file)))} aria-label={`移除 ${file.name}`}>
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {activeTab === 'url' && (
              <div className={styles.fieldGroup}>
                <div className={styles.field}>
                  <label htmlFor="document-url">网页或 YouTube 地址</label>
                  <input id="document-url" type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/knowledge/article" />
                </div>
                <div className={styles.notice}>系统会识别普通网页与 YouTube 地址，并分别提取正文或字幕内容。</div>
              </div>
            )}

            {activeTab === 'text' && (
              <div className={styles.fieldGroup}>
                <div className={styles.field}>
                  <label htmlFor="source-name">文档名称</label>
                  <input id="source-name" value={sourceName} onChange={event => setSourceName(event.target.value)} placeholder="例如：采购流程补充说明.txt" />
                </div>
                <div className={styles.field}>
                  <label htmlFor="document-text">文档正文</label>
                  <textarea id="document-text" value={text} onChange={event => setText(event.target.value)} placeholder="粘贴需要进入 RAG 知识库的完整文本…" />
                </div>
              </div>
            )}

            <div className={styles.advancedGrid}>
              <div className={styles.compactField}>
                <label htmlFor="chunk-size">分块长度</label>
                <input id="chunk-size" type="number" min={100} max={4000} value={chunkSize} onChange={event => setChunkSize(Number(event.target.value))} />
              </div>
              <div className={styles.compactField}>
                <label htmlFor="chunk-overlap">重叠长度</label>
                <input id="chunk-overlap" type="number" min={0} max={1000} value={chunkOverlap} onChange={event => setChunkOverlap(Number(event.target.value))} />
              </div>
            </div>

            <button className={styles.actionButton} type="submit" disabled={!canSubmit || uploading || runtime.milvus !== 'ready'}>
              {uploading ? <LoaderCircle className={styles.spin} size={17} /> : <UploadCloud size={17} />}
              {uploading ? '正在解析并写入索引…' : '写入知识库'}
            </button>
            {error && <div className={styles.errorNotice} role="alert">{error}</div>}
            {notice && <div className={styles.successNotice} role="status"><CheckCircle2 size={14} /> {notice}</div>}
            <div className={styles.formatStrip} aria-label="支持格式">
              {FORMATS.map(format => <span className={styles.formatBadge} key={format}>{format}</span>)}
            </div>
          </form>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h2>知识库文档</h2>
              <p>仅展示 canonical RAG 管道已接收的受保护文档</p>
            </div>
            <button className={styles.secondaryButton} type="button" onClick={() => void loadWorkspace()} disabled={loading}>
              <RefreshCw className={loading ? styles.spin : ''} size={15} />
              刷新
            </button>
          </div>
          <div className={styles.catalogToolbar}>
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="按文档名或文档 ID 筛选" aria-label="筛选文档" />
            <select value={typeFilter} onChange={event => setTypeFilter(event.target.value)} aria-label="文件类型">
              <option value="all">全部来源</option>
              <option value="pdf">PDF</option>
              <option value="docx">Word</option>
              <option value="xlsx">Excel</option>
              <option value="markdown">Markdown</option>
              <option value="epub">EPUB</option>
              <option value="mobi">MOBI</option>
              <option value="text">文本</option>
              <option value="url">网页 / 视频</option>
            </select>
            <Link className={styles.secondaryButton} href="/document-search">
              <Search size={14} /> 全库搜索
            </Link>
          </div>
          <div className={styles.catalogList}>
            {loading ? (
              <div className={styles.catalogEmpty}><LoaderCircle className={styles.spin} size={22} /></div>
            ) : filteredDocuments.length === 0 ? (
              <div className={styles.catalogEmpty}>
                <div>
                  <FileText size={28} />
                  <p>{documents.length === 0 ? '还没有进入知识库的文档' : '没有符合筛选条件的文档'}</p>
                </div>
              </div>
            ) : filteredDocuments.map(document => (
              <DocumentRow key={document.id} document={document} busy={mutatingId !== null}
                onToggle={() => void mutateDocument(document, 'PATCH')} onDelete={() => setDeleteTarget(document)} />
            ))}
          </div>
        </section>
      </div>
      <dialog ref={deleteDialogRef} className={styles.deleteDialog} aria-labelledby="delete-document-title" aria-describedby="delete-document-description"
        onCancel={event => { event.preventDefault(); if (!mutatingId) setDeleteTarget(null); }}>
            <h2 id="delete-document-title">删除文档</h2>
            <p id="delete-document-description">
              确认删除「{deleteTarget?.name}」？原文、文档块和索引将被清理，此操作无法撤销。
              如果只想暂停检索，请使用禁用。
            </p>
            {error ? <p className={styles.errorNotice} role="alert">{error}</p> : null}
            <div className={styles.documentActions}>
              <button type="button" className={styles.secondaryButton} disabled={mutatingId !== null} onClick={() => setDeleteTarget(null)}>取消</button>
              <button type="button" className={`${styles.secondaryButton} ${styles.dangerAction}`} disabled={mutatingId !== null}
                onClick={() => { if (deleteTarget) void mutateDocument(deleteTarget, 'DELETE'); }}>
                {mutatingId ? <LoaderCircle size={14} className={styles.spin} /> : <Trash2 size={14} />} {mutatingId ? '正在清理…' : '确认删除'}
              </button>
            </div>
      </dialog>
    </main>
  );
}

function BackendNode({ step, label, detail }: { step: string; label: string; detail: string }) {
  return <div className={styles.backendNode}><span>{step}</span><strong>{label}</strong><small>{detail}</small></div>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className={styles.metric}><span>{label}</span><strong>{value}</strong>{detail ? <small className={styles.metricDetail}>{detail}</small> : null}</div>;
}

function SourceTabButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: typeof UploadCloud;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className={`${styles.sourceTab} ${active ? styles.sourceTabActive : ''}`} type="button" role="tab" aria-selected={active} onClick={onClick}>
      <Icon size={14} /> {label}
    </button>
  );
}

function DocumentRow({ document, busy, onToggle, onDelete }: {
  document: CatalogDocument; busy: boolean; onToggle: () => void; onDelete: () => void;
}) {
  const type = displayKind(document.sourceKind, document.name);
  const searchHref = `/document-search?documentId=${encodeURIComponent(document.documentId)}`;
  return (
    <article className={styles.documentRow}>
      <div className={styles.documentIdentity}>
        <span className={styles.fileMark}>{type}</span>
        <div style={{ minWidth: 0 }}>
          <div className={styles.documentName}>{document.name}</div>
          <div className={styles.documentMeta}>
            <span>{formatBytes(document.byteSize)}</span>
            <span>更新于 {formatDate(document.updatedAt)}</span>
            <span>{document.trustLevel}</span>
            <span className={document.enabled ? styles.documentEnabled : styles.documentDisabled}>
              {document.lifecycle === 'deleting' ? '删除未完成 · 可重试' : document.enabled ? '已启用' : '已禁用 · 不参与检索'}
            </span>
          </div>
        </div>
      </div>
      <div className={styles.documentStat}><span>已存储块</span><strong>{document.chunkCount}</strong></div>
      <div className={styles.indexCell}>
        <span>索引存储状态</span>
        <div className={styles.indexStack}>
          <IndexLine label="Milvus" status={document.milvusStatus} />
          <IndexLine label="Elasticsearch" status={document.elasticsearchStatus} />
        </div>
      </div>
      <div className={styles.documentActions}>
        <button type="button" className={styles.secondaryButton} disabled={busy || document.lifecycle === 'deleting'}
          aria-label={`${document.enabled ? '禁用' : '启用'} ${document.name}`} onClick={onToggle}>
          {document.enabled ? '禁用' : '启用'}
        </button>
        <button type="button" className={`${styles.rowAction} ${styles.dangerAction}`} disabled={busy}
          title={document.lifecycle === 'deleting' ? '重试删除' : '删除文档'} aria-label={`删除 ${document.name}`} onClick={onDelete}><Trash2 size={15} /></button>
      {document.enabled ? <Link className={styles.rowAction} href={searchHref} title={`在 ${document.name} 中搜索`} aria-label={`在 ${document.name} 中搜索`}>
        <ArrowUpRight size={16} />
      </Link> : null}
      </div>
    </article>
  );
}

function IndexLine({ label, status }: { label: string; status: IndexStatus }) {
  const statusClass = status === 'ready'
    ? styles.statusReady
    : status === 'pending'
      ? styles.statusPending
      : status === 'failed'
        ? styles.statusFailed
        : styles.statusDisabled;
  return <div className={styles.indexLine}><span className={`${styles.statusDot} ${statusClass}`} />{label} · {statusLabel(status)}</div>;
}

function statusLabel(status: IndexStatus): string {
  return { ready: '就绪', pending: '同步中', failed: '失败', disabled: '未启用', unknown: '未知' }[status];
}

function runtimeLabel(status: WorkspaceRuntime['milvus'] | WorkspaceRuntime['elasticsearch']): string {
  return {
    ready: '索引就绪', shadow: '影子验证', disabled: '未启用', unavailable: '不可用', checking: '检查中',
  }[status];
}

function supportedFilename(filename: string): boolean {
  return ACCEPTED_FILES.split(',').some(extension => filename.toLowerCase().endsWith(extension));
}

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function normalizeSourceKind(value: string): string {
  if (value === 'youtube') return 'url';
  if (value === 'csv') return 'xlsx';
  return value;
}

function displayKind(sourceKind: string, filename: string): string {
  const extension = filename.split('.').pop();
  return (extension && extension.length <= 5 ? extension : sourceKind).slice(0, 5);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '未知时间'
    : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

function readApiError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const value = payload as { error?: unknown; results?: { success?: boolean; filename?: string; error?: unknown }[] };
  if (typeof value.error === 'string' && value.error.trim()) return value.error;
  if (value.error && typeof value.error === 'object' && 'message' in value.error) {
    const message = (value.error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  const failed = Array.isArray(value.results)
    ? value.results.filter(result => result.success === false && typeof result.error === 'string')
    : [];
  if (failed.length > 0) return failed.map(result => `${result.filename || '文档'}：${result.error}`).join('；');
  return fallback;
}

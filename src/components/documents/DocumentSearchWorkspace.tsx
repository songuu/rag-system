'use client';

import {
  Braces,
  Database,
  FileSearch,
  Layers3,
  LoaderCircle,
  Search,
  Sparkles,
  TextSearch,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import styles from './KnowledgeWorkspace.module.css';

type SearchStrategy = 'hybrid' | 'semantic' | 'keyword';

interface SearchResult {
  id: string;
  documentId: string;
  documentVersion: string;
  title: string;
  snippet: string;
  page?: number;
  score: number;
  trustLevel: string;
  match: SearchStrategy;
  chunkIndex?: number;
  totalChunks?: number;
}

interface CatalogDocument {
  documentId: string;
  name: string;
}

interface SearchDiagnostics {
  status?: string;
  mode?: string;
  denseCandidateCount?: number;
  lexicalCandidateCount?: number;
  fusedCandidateCount?: number;
  failureCode?: string;
}

const API_ROOT = '/rag-api';

const strategies = [
  {
    id: 'hybrid' as const,
    label: '融合搜索',
    detail: 'Milvus + Elasticsearch',
    tag: 'DEFAULT',
    icon: Layers3,
  },
  {
    id: 'semantic' as const,
    label: '语义搜索',
    detail: '理解相近表达与上下文',
    tag: 'MILVUS',
    icon: Sparkles,
  },
  {
    id: 'keyword' as const,
    label: '关键词搜索',
    detail: '精确命中术语、编号与名称',
    tag: 'ES',
    icon: TextSearch,
  },
];

export default function DocumentSearchWorkspace({
  initialQuery = '',
  initialDocumentId = '',
}: {
  initialQuery?: string;
  initialDocumentId?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [strategy, setStrategy] = useState<SearchStrategy>('hybrid');
  const [fileType, setFileType] = useState('');
  const [documentId, setDocumentId] = useState(initialDocumentId);
  const [topK, setTopK] = useState(12);
  const [documents, setDocuments] = useState<CatalogDocument[]>([]);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [diagnostics, setDiagnostics] = useState<SearchDiagnostics>({});
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [lastQuery, setLastQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${API_ROOT}/documents`, { signal: controller.signal, cache: 'no-store' })
      .then(response => response.json())
      .then(payload => {
        if (payload.success === true && Array.isArray(payload.documents)) {
          setDocuments(payload.documents);
        }
      })
      .catch(fetchError => {
        if (!(fetchError instanceof DOMException && fetchError.name === 'AbortError')) {
          setDocuments([]);
        }
      });
    return () => controller.abort();
  }, []);

  const selectedDocumentName = useMemo(
    () => documents.find(document => document.documentId === documentId)?.name,
    [documentId, documents]
  );

  const handleSearch = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedQuery = query.trim();
    if (!normalizedQuery || loading) return;
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${API_ROOT}/document-search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: normalizedQuery,
          strategy,
          topK,
          ...(fileType ? { fileType } : {}),
          ...(documentId ? { documentId } : {}),
        }),
      });
      const payload = await response.json();
      if (!response.ok || payload.success !== true) {
        throw new Error(readApiError(payload, '文档搜索暂不可用'));
      }
      setResults(Array.isArray(payload.results) ? payload.results : []);
      setDiagnostics(payload.diagnostics ?? {});
      setElapsedMs(Number(payload.elapsedMs ?? 0));
      setLastQuery(normalizedQuery);
    } catch (searchError) {
      setResults([]);
      setDiagnostics({});
      setElapsedMs(null);
      setError(searchError instanceof Error ? searchError.message : '文档搜索失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className={styles.main}>
      <section className={styles.hero}>
        <div>
          <div className={styles.eyebrow}>Evidence retrieval</div>
          <h1>先找到原文，再开始回答</h1>
          <p className={styles.heroCopy}>
            独立查看 RAG 实际检索到的文档片段、来源页码和命中方式。默认融合 Milvus 的语义召回与
            Elasticsearch 的关键词召回，便于核验答案证据，而不是直接生成结论。
          </p>
        </div>
        <div className={styles.backendRail} aria-label="融合检索流程">
          <BackendNode step="01 / VECTOR" label="Milvus" detail="语义候选" />
          <BackendNode step="02 / LEXICAL" label="Elasticsearch" detail="关键词候选" />
          <BackendNode step="03 / FUSION" label="RRF" detail="统一证据排序" />
        </div>
      </section>

      <div className={styles.searchLayout}>
        <section className={styles.searchPanel}>
          <div className={styles.panelHeader}>
            <div>
              <h2>文档搜索</h2>
              <p>{documentId ? `当前范围：${selectedDocumentName ?? documentId}` : '当前范围：全部有权限的知识库文档'}</p>
            </div>
            <FileSearch size={21} strokeWidth={1.6} />
          </div>
          <form onSubmit={handleSearch}>
            <div className={styles.searchForm}>
              <div className={styles.searchInputWrap}>
                <Search size={19} />
                <input
                  className={styles.searchInput}
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder="搜索术语、流程、编号，或描述你想查找的内容…"
                  aria-label="文档搜索词"
                />
              </div>
              <button className={styles.searchButton} type="submit" disabled={!query.trim() || loading}>
                {loading ? <LoaderCircle className={styles.spin} size={17} /> : <Search size={17} />}
                {loading ? '检索中' : '搜索文档'}
              </button>
            </div>
            <div className={styles.searchFilters}>
              <div className={styles.compactField}>
                <label htmlFor="document-scope">文档范围</label>
                <select id="document-scope" value={documentId} onChange={event => setDocumentId(event.target.value)}>
                  <option value="">全部文档</option>
                  {documentId && !documents.some(document => document.documentId === documentId) && (
                    <option value={documentId}>指定文档 · {documentId}</option>
                  )}
                  {documents.map(document => (
                    <option key={document.documentId} value={document.documentId}>{document.name}</option>
                  ))}
                </select>
              </div>
              <div className={styles.compactField}>
                <label htmlFor="search-file-type">文件类型</label>
                <select id="search-file-type" value={fileType} onChange={event => setFileType(event.target.value)}>
                  <option value="">全部类型</option>
                  <option value="pdf">PDF</option>
                  <option value="docx">Word</option>
                  <option value="xlsx">Excel</option>
                  <option value="csv">CSV</option>
                  <option value="markdown">Markdown</option>
                  <option value="text">TXT</option>
                  <option value="json">JSON</option>
                  <option value="url">网页</option>
                  <option value="youtube">YouTube</option>
                </select>
              </div>
              <div className={styles.compactField}>
                <label htmlFor="search-top-k">返回条数</label>
                <select id="search-top-k" value={topK} onChange={event => setTopK(Number(event.target.value))}>
                  <option value={12}>12 条</option>
                  <option value={24}>24 条</option>
                  <option value={48}>48 条</option>
                </select>
              </div>
            </div>
          </form>

          {error && <div className={styles.errorNotice} style={{ margin: 20 }} role="alert">{error}</div>}
          {lastQuery && !error && (
            <div className={styles.resultSummary}>
              <span>“<strong>{lastQuery}</strong>” 找到 {results.length} 条证据</span>
              <span>{elapsedMs === null ? '—' : `${elapsedMs} ms`}</span>
            </div>
          )}
          <div className={styles.resultList}>
            {!lastQuery && !loading ? (
              <div className={styles.resultEmpty}>
                <div><Braces size={30} /><p>输入关键词或自然语言描述，查看原始文档证据。</p></div>
              </div>
            ) : !loading && lastQuery && results.length === 0 && !error ? (
              <div className={styles.resultEmpty}>
                <div><FileSearch size={30} /><p>当前范围没有匹配证据，试试放宽文件类型或切换搜索方式。</p></div>
              </div>
            ) : results.map((result, index) => (
              <SearchResultCard key={result.id} result={result} index={index} query={lastQuery} />
            ))}
          </div>
        </section>

        <aside className={styles.panel}>
          <div className={styles.panelHeader}>
            <div><h3>检索方式</h3><p>按查询目的切换召回通道</p></div>
            <Database size={19} strokeWidth={1.6} />
          </div>
          <div className={styles.panelBody}>
            <div className={styles.strategyRail}>
              {strategies.map(({ id, label, detail, tag, icon: Icon }) => (
                <button
                  key={id}
                  className={`${styles.strategyButton} ${strategy === id ? styles.strategyButtonActive : ''}`}
                  type="button"
                  onClick={() => setStrategy(id)}
                  aria-pressed={strategy === id}
                >
                  <span className={styles.strategyIcon}><Icon size={17} /></span>
                  <span><strong>{label}</strong><small>{detail}</small></span>
                  <span className={styles.strategyTag}>{tag}</span>
                </button>
              ))}
            </div>

            <div className={styles.diagnostics} aria-label="检索诊断">
              <Diagnostic label="运行状态" value={diagnosticStatus(diagnostics.status)} />
              <Diagnostic label="ES 模式" value={modeLabel(diagnostics.mode)} />
              <Diagnostic label="Milvus 候选" value={String(diagnostics.denseCandidateCount ?? '—')} />
              <Diagnostic label="ES 候选" value={String(diagnostics.lexicalCandidateCount ?? '—')} />
            </div>
            {diagnostics.failureCode && (
              <div className={styles.errorNotice}>已降级到 Milvus：{diagnostics.failureCode}</div>
            )}
            <div className={styles.sidebarNote}>
              融合搜索会并行请求两种索引，再用 RRF 合并排名。ES 处于 shadow 模式时只观测关键词结果，不改变 Milvus 的最终排序。
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

function BackendNode({ step, label, detail }: { step: string; label: string; detail: string }) {
  return <div className={styles.backendNode}><span>{step}</span><strong>{label}</strong><small>{detail}</small></div>;
}

function Diagnostic({ label, value }: { label: string; value: string }) {
  return <div className={styles.diagnostic}><span>{label}</span><strong>{value}</strong></div>;
}

function SearchResultCard({
  result,
  index,
  query,
}: {
  result: SearchResult;
  index: number;
  query: string;
}) {
  return (
    <article className={styles.resultItem}>
      <div className={styles.resultTopline}>
        <span className={styles.resultIndex}>{String(index + 1).padStart(2, '0')}</span>
        <h3 className={styles.resultTitle}>{result.title}</h3>
        <span className={styles.resultBadge}>{matchLabel(result.match)}</span>
      </div>
      <p className={styles.resultSnippet}>{highlight(result.snippet, query)}</p>
      <div className={styles.resultMeta}>
        {result.page && <span>第 {result.page} 页</span>}
        {result.chunkIndex !== undefined && <span>片段 {result.chunkIndex + 1}{result.totalChunks ? ` / ${result.totalChunks}` : ''}</span>}
        <span>相关分 {result.score.toFixed(4)}</span>
        <span>{result.trustLevel}</span>
        <span title={result.documentVersion}>版本 {compactVersion(result.documentVersion)}</span>
      </div>
    </article>
  );
}

function highlight(content: string, query: string): ReactNode {
  const terms = [...new Set(query.trim().split(/\s+/).filter(term => term.length > 1))].slice(0, 8);
  if (terms.length === 0) return content;
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
  return content.split(pattern).map((part, index) => (
    terms.some(term => term.toLowerCase() === part.toLowerCase())
      ? <mark key={`${index}:${part}`}>{part}</mark>
      : part
  ));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchLabel(match: SearchStrategy): string {
  return { hybrid: '双通道', semantic: '语义', keyword: '关键词' }[match];
}

function diagnosticStatus(status: string | undefined): string {
  return {
    fused: '融合完成',
    shadow: '影子观测',
    degraded: '已降级',
    'dense-only': '仅语义',
    'lexical-only': '仅关键词',
  }[status ?? ''] ?? '等待搜索';
}

function modeLabel(mode: string | undefined): string {
  return { active: 'ACTIVE', shadow: 'SHADOW', off: 'OFF' }[mode ?? ''] ?? '—';
}

function compactVersion(version: string): string {
  return version.startsWith('sha256:') ? version.slice(7, 15) : version.slice(0, 12);
}

function readApiError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

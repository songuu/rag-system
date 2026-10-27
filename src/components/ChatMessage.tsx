'use client';

import React, { useState, useMemo, useEffect, useRef } from 'react';
import AnswerProcessingPanel from '@/components/AnswerProcessingPanel';
import type { AnswerProcessingDetails } from '@/lib/rag/answer-processing';
import { parseCitationReferences } from '@/lib/rag/citations/reference-parser';
import type { RagCitationItem, RagCitationPreview, RagCitations } from '@/lib/rag/citations/types';

interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  traceId?: string;
  storageBackend?: 'memory' | 'milvus';
  retrievalDetails?: any;
  queryAnalysis?: any;
  processingDetails?: AnswerProcessingDetails;
  citations?: RagCitations;
}

/**
 * 安全提取消息内容为字符串
 * 防止 LangChain 对象被直接渲染导致 React 错误
 */
function safeContentString(content: any): string {
  // 如果已经是字符串，直接返回
  if (typeof content === 'string') {
    return content;
  }
  
  // 如果是 null 或 undefined，返回空字符串
  if (content == null) {
    return '';
  }
  
  // 如果是 LangChain 对象（有 content 属性）
  if (typeof content === 'object' && 'content' in content) {
    return safeContentString(content.content);
  }
  
  // 如果是数组，连接所有元素
  if (Array.isArray(content)) {
    return content.map(item => safeContentString(item)).join('');
  }
  
  // 其他对象类型，尝试转换为字符串
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

interface ChatMessageProps {
  message: Message;
  currentQuery: string;
  highlightMatchingText: (content: string, query: string) => string;
  citationPartition?: string | null;
  citationAccessStatus?: 'loading' | 'ready' | 'unavailable';
  citationClockOffsetMs?: number | null;
}

function CitationSourceModal({ item, partition, onClose }: {
  item: RagCitationItem;
  partition: string;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<RagCitationPreview | null>(null);
  const [error, setError] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void (async () => {
      try {
        const response = await fetch('/rag-api/ask/citations/preview', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locator: item.locator }), signal: controller.signal,
        });
        if (!response.ok) throw new Error('Citation preview unavailable.');
        const body: unknown = await response.json();
        if (!body || typeof body !== 'object') throw new Error('Invalid citation preview.');
        const candidate = body as Record<string, unknown>;
        if (candidate.success !== true || typeof candidate.content !== 'string' || typeof candidate.contentTruncated !== 'boolean'
          || candidate.content.length > 65_536) throw new Error('Invalid citation preview.');
        const relations: NonNullable<RagCitationPreview['relations']> = [];
        if (Array.isArray(candidate.relations)) {
          if (candidate.relations.length > 64) throw new Error('Invalid citation relations.');
          for (const relation of candidate.relations) {
            if (!relation || typeof relation !== 'object'
              || !['source', 'predicate', 'target', 'fact'].every(key => typeof relation[key] === 'string')) {
              throw new Error('Invalid citation relation.');
            }
            relations.push({ source: relation.source, predicate: relation.predicate, target: relation.target, fact: relation.fact });
          }
        }
        if (active) setPreview({
          success: true, content: candidate.content, contentTruncated: candidate.contentTruncated,
          ...(typeof candidate.source === 'string' ? { source: candidate.source } : {}),
          ...(Number.isSafeInteger(candidate.page) && (candidate.page as number) > 0 ? { page: candidate.page as number } : {}),
          ...(relations.length ? { relations } : {}),
        });
      } catch {
        // An old token or a failed authorization must never reveal a cached passage.
        if (active) setError(true);
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [item.locator, partition]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const close = dialogRef.current?.querySelector<HTMLButtonElement>('button');
        if (close) { event.preventDefault(); close.focus(); }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); previousFocus?.focus(); };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`引用 ${item.number} 原文`} tabIndex={-1}
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-5 text-gray-900 shadow-xl"
        onClick={event => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <h3 className="font-semibold">引用 {item.number} 原文</h3>
          <button type="button" aria-label="关闭原文" onClick={onClose} className="rounded px-2 py-1 text-sm hover:bg-gray-100">关闭</button>
        </div>
        {!preview && !error && <p role="status" className="text-sm text-gray-600">正在重新核验权限并读取原文…</p>}
        {error && <p role="alert" className="text-sm text-amber-800">引用不可用、已过期或当前无权访问，请重新提问获取有效来源。</p>}
        {preview && <>
          {(preview.source || preview.page) && <p className="mb-3 text-xs text-gray-600">{preview.source}{preview.page ? ` · 第 ${preview.page} 页` : ''}</p>}
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{preview.content}</p>
          {preview.contentTruncated && <p className="mt-2 text-xs text-amber-800">原文片段已截断，以上内容不代表完整文档。</p>}
          {preview.relations?.length ? <section className="mt-4 border-t pt-3" aria-label="关系依据">
            <h4 className="mb-2 text-sm font-semibold">关系依据</h4>
            <ul className="space-y-2 text-sm">{preview.relations.map((relation, index) => <li key={index}>
              <p>{relation.source} → {relation.predicate} → {relation.target}</p>
              {relation.fact && <p className="mt-1 text-xs text-gray-600">{relation.fact}</p>}
            </li>)}</ul>
          </section> : null}
        </>}
      </div>
    </div>
  );
}

// 相似度等级
function getSimilarityLevel(similarity: number): { 
  label: string; 
  color: string; 
  bgColor: string;
  description: string;
} {
  if (similarity >= 0.85) return { label: '极高', color: 'text-green-700', bgColor: 'bg-green-100', description: '语义高度匹配，信息可靠性强' };
  if (similarity >= 0.7) return { label: '高', color: 'text-emerald-700', bgColor: 'bg-emerald-100', description: '语义较好匹配，信息相关度高' };
  if (similarity >= 0.5) return { label: '中', color: 'text-blue-700', bgColor: 'bg-blue-100', description: '语义部分匹配，可作为参考' };
  if (similarity >= 0.3) return { label: '低', color: 'text-yellow-700', bgColor: 'bg-yellow-100', description: '语义弱匹配，需要谨慎使用' };
  return { label: '极低', color: 'text-red-700', bgColor: 'bg-red-100', description: '语义几乎不匹配，信息相关度低' };
}

// 格式化元数据值
function formatMetaValue(value: any): string {
  if (value === null || value === undefined) return 'N/A';
  if (typeof value === 'object') {
    if (Array.isArray(value)) return value.join(', ');
    if ('start' in value && 'end' in value) return `${value.start}-${value.end}`;
    if ('line' in value) return `Line ${value.line}`;
    try { return JSON.stringify(value); } catch { return '[Object]'; }
  }
  return String(value);
}

// 分析匹配原因
function analyzeMatchReasons(content: string, query: string, similarity: number): {
  reasons: Array<{ type: string; description: string; importance: 'high' | 'medium' | 'low'; icon: string }>;
  matchedTerms: string[];
  keyInsights: string[];
} {
  const queryTerms = query.toLowerCase().split(/[\s,，。？！、]+/).filter(t => t.length > 1);
  const contentLower = content.toLowerCase();
  
  const matchedTerms: string[] = [];
  const reasons: Array<{ type: string; description: string; importance: 'high' | 'medium' | 'low'; icon: string }> = [];
  const keyInsights: string[] = [];
  
  // 检查关键词直接匹配
  queryTerms.forEach(term => {
    if (contentLower.includes(term)) {
      matchedTerms.push(term);
    }
  });
  
  if (matchedTerms.length > 0) {
    const coverage = (matchedTerms.length / queryTerms.length * 100).toFixed(0);
    reasons.push({
      type: '关键词匹配',
      description: `文档包含 ${matchedTerms.length}/${queryTerms.length} 个查询关键词（覆盖率 ${coverage}%）`,
      importance: matchedTerms.length >= 3 ? 'high' : matchedTerms.length >= 1 ? 'medium' : 'low',
      icon: '🔤'
    });
    keyInsights.push(`匹配词: ${matchedTerms.slice(0, 5).join(', ')}`);
  }
  
  // 领域匹配分析
  const domains = [
    { name: 'AI/技术', keywords: ['AI', '人工智能', '机器学习', '深度学习', '算法', '模型', '神经网络', '数据', '系统'] },
    { name: '商业', keywords: ['市场', '销售', '客户', '产品', '服务', '管理', '运营', '投资', '收入', '成本'] },
    { name: '学术', keywords: ['研究', '论文', '实验', '理论', '分析', '方法', '结论', '假设'] },
    { name: '历史', keywords: ['历史', '世纪', '年代', '时期', '王朝', '战争', '文明', '古代'] },
  ];
  
  for (const domain of domains) {
    const queryDomainMatch = domain.keywords.some(kw => query.includes(kw));
    const contentDomainMatch = domain.keywords.some(kw => content.includes(kw));
    
    if (queryDomainMatch && contentDomainMatch) {
      reasons.push({
        type: '领域匹配',
        description: `查询和文档都属于【${domain.name}】领域，语义空间接近`,
        importance: 'high',
        icon: '🎯'
      });
      keyInsights.push(`领域: ${domain.name}`);
      break;
    }
  }
  
  // 语义相似度分析
  if (similarity >= 0.7) {
    reasons.push({
      type: '高语义相似',
      description: '向量空间距离近，表示深层语义关联强',
      importance: 'high',
      icon: '🧠'
    });
  } else if (similarity >= 0.5) {
    reasons.push({
      type: '语义相关',
      description: '存在一定的语义关联，可能涉及相似概念',
      importance: 'medium',
      icon: '💡'
    });
  }
  
  // 问答模式匹配
  const questionPatterns = ['什么', '如何', '为什么', '怎么', '哪些', '多少', '是否'];
  const hasQuestion = questionPatterns.some(p => query.includes(p));
  const explanationPatterns = ['是', '指', '表示', '意味', '因为', '由于', '通过', '可以', '用于'];
  const hasExplanation = explanationPatterns.some(p => content.includes(p));
  
  if (hasQuestion && hasExplanation) {
    reasons.push({
      type: '问答匹配',
      description: '文档包含解释性内容，可能直接回答查询问题',
      importance: 'medium',
      icon: '❓'
    });
  }
  
  // 信息丰富度
  const contentLength = content.length;
  if (contentLength > 500) {
    reasons.push({
      type: '信息丰富',
      description: `文档包含 ${contentLength} 字符的详细信息，内容充实`,
      importance: 'low',
      icon: '📚'
    });
  }
  
  // 结构化内容检测
  const hasStructure = content.includes('：') || content.includes(':') || 
                       content.includes('1.') || content.includes('•') ||
                       content.includes('##') || content.includes('**');
  if (hasStructure) {
    reasons.push({
      type: '结构化内容',
      description: '文档包含结构化格式，信息组织清晰',
      importance: 'low',
      icon: '📋'
    });
  }
  
  // 如果没有找到具体原因
  if (reasons.length === 0) {
    reasons.push({
      type: '语义推断',
      description: '基于深度学习模型的向量表示进行语义匹配',
      importance: 'medium',
      icon: '🔮'
    });
  }
  
  return { reasons, matchedTerms, keyInsights };
}

// 智能高亮组件
function SmartHighlight({ content, query, maxLength = 500 }: { content: string; query: string; maxLength?: number }) {
  const highlighted = useMemo(() => {
    const queryTerms = query.toLowerCase().split(/[\s,，。？！、]+/).filter(t => t.length > 1);
    if (queryTerms.length === 0) return content;
    
    // 创建高亮正则
    const pattern = new RegExp(`(${queryTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    
    // 截取内容
    let displayContent = content;
    if (content.length > maxLength) {
      // 尝试找到第一个匹配位置，从那里开始截取
      const firstMatch = content.toLowerCase().search(pattern);
      if (firstMatch > 50) {
        const start = Math.max(0, firstMatch - 50);
        displayContent = '...' + content.slice(start, start + maxLength) + '...';
      } else {
        displayContent = content.slice(0, maxLength) + '...';
      }
    }
    
    // 高亮替换
    return displayContent.replace(pattern, '<mark class="bg-yellow-200 text-yellow-900 px-0.5 rounded font-medium">$1</mark>');
  }, [content, query, maxLength]);
  
  return (
    <div 
      className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap"
      dangerouslySetInnerHTML={{ __html: highlighted }}
    />
  );
}

// 详情弹窗组件
function DetailModal({ 
  result, 
  index, 
  query, 
  onClose 
}: { 
  result: any; 
  index: number; 
  query: string; 
  onClose: () => void;
}) {
  const similarity = result.similarity || 0;
  const simLevel = getSimilarityLevel(similarity);
  const source = result.document?.metadata?.source || `文档 ${index + 1}`;
  const content = result.document?.content || '';
  const analysis = useMemo(() => analyzeMatchReasons(content, query, similarity), [content, query, similarity]);
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div 
        className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="bg-gradient-to-r from-purple-600 to-blue-600 text-white px-5 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className={`w-8 h-8 rounded-full text-sm font-bold flex items-center justify-center ${
                index === 0 ? 'bg-yellow-400 text-yellow-900' :
                index === 1 ? 'bg-gray-200 text-gray-700' :
                index === 2 ? 'bg-orange-300 text-orange-800' :
                'bg-white/20 text-white'
              }`}>
                {index + 1}
              </span>
              <div>
                <h3 className="font-semibold">{source}</h3>
                <p className="text-sm text-white/80">检索结果详情</p>
              </div>
            </div>
            <button 
              onClick={onClose}
              className="p-2 hover:bg-white/20 rounded-lg transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        
        {/* 内容 */}
        <div className="overflow-y-auto max-h-[calc(85vh-80px)]">
          {/* 相似度仪表 */}
          <div className="px-5 py-4 bg-gray-50 border-b">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-700">相似度评分</span>
              <span className={`px-3 py-1 rounded-full text-sm font-bold ${simLevel.bgColor} ${simLevel.color}`}>
                {(similarity * 100).toFixed(1)}% · {simLevel.label}
              </span>
            </div>
            <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
              <div 
                className={`h-full transition-all duration-500 ${
                  similarity >= 0.7 ? 'bg-gradient-to-r from-green-400 to-green-600' :
                  similarity >= 0.5 ? 'bg-gradient-to-r from-blue-400 to-blue-600' :
                  similarity >= 0.3 ? 'bg-gradient-to-r from-yellow-400 to-yellow-600' :
                  'bg-gradient-to-r from-red-400 to-red-600'
                }`}
                style={{ width: `${similarity * 100}%` }}
              />
            </div>
            <p className="text-xs text-gray-500 mt-2">{simLevel.description}</p>
          </div>
          
          {/* 匹配原因分析 */}
          <div className="px-5 py-4 border-b">
            <h4 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
              <span className="w-6 h-6 rounded bg-purple-100 text-purple-600 flex items-center justify-center text-xs">✓</span>
              匹配原因分析
            </h4>
            <div className="space-y-2">
              {analysis.reasons.map((reason, i) => (
                <div 
                  key={i} 
                  className={`flex items-start gap-3 p-3 rounded-lg ${
                    reason.importance === 'high' ? 'bg-green-50 border border-green-200' :
                    reason.importance === 'medium' ? 'bg-blue-50 border border-blue-200' :
                    'bg-gray-50 border border-gray-200'
                  }`}
                >
                  <span className="text-xl">{reason.icon}</span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-800">{reason.type}</span>
                      <span className={`px-1.5 py-0.5 rounded text-xs ${
                        reason.importance === 'high' ? 'bg-green-200 text-green-800' :
                        reason.importance === 'medium' ? 'bg-blue-200 text-blue-800' :
                        'bg-gray-200 text-gray-700'
                      }`}>
                        {reason.importance === 'high' ? '高相关' : reason.importance === 'medium' ? '中相关' : '参考'}
                      </span>
                    </div>
                    <p className="text-xs text-gray-600 mt-1">{reason.description}</p>
                  </div>
                </div>
              ))}
            </div>
            
            {/* 关键洞察 */}
            {analysis.keyInsights.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {analysis.keyInsights.map((insight, i) => (
                  <span key={i} className="inline-flex items-center px-2 py-1 bg-purple-100 text-purple-700 rounded-full text-xs">
                    💡 {insight}
                  </span>
                ))}
              </div>
            )}
          </div>
          
          {/* 匹配关键词 */}
          {analysis.matchedTerms.length > 0 && (
            <div className="px-5 py-3 border-b bg-yellow-50">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-medium text-yellow-800">🔍 匹配的关键词</span>
                <span className="text-xs text-yellow-600">({analysis.matchedTerms.length} 个)</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {analysis.matchedTerms.map((term, i) => (
                  <span key={i} className="px-2 py-1 bg-yellow-200 text-yellow-900 rounded text-xs font-medium">
                    {term}
                  </span>
                ))}
              </div>
            </div>
          )}
          
          {/* 完整文档内容 */}
          <div className="px-5 py-4">
            <h4 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
              <span className="w-6 h-6 rounded bg-blue-100 text-blue-600 flex items-center justify-center text-xs">📄</span>
              完整文档内容
              <span className="text-xs text-gray-400 font-normal">({content.length} 字符)</span>
            </h4>
            <div className="bg-gray-50 rounded-lg p-4 border border-gray-200 max-h-64 overflow-y-auto">
              <SmartHighlight content={content} query={query} maxLength={2000} />
            </div>
          </div>
          
          {/* 元数据 */}
          {result.document?.metadata && Object.keys(result.document.metadata).length > 0 && (
            <div className="px-5 py-4 bg-gray-50 border-t">
              <h4 className="text-sm font-semibold text-gray-800 mb-2">📋 文档元数据</h4>
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(result.document.metadata).map(([key, value]) => (
                  <div key={key} className="flex items-center gap-2 text-xs">
                    <span className="text-gray-500 min-w-[60px]">{key}:</span>
                    <span className="text-gray-700 font-medium truncate" title={formatMetaValue(value)}>
                      {formatMetaValue(value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ChatMessage({ message, currentQuery, highlightMatchingText, citationPartition, citationAccessStatus, citationClockOffsetMs = null }: ChatMessageProps) {
  const [showDetails, setShowDetails] = useState(false);
  const [selectedDocIndex, setSelectedDocIndex] = useState<number | null>(null);
  const [selectedCitation, setSelectedCitation] = useState<RagCitationItem | null>(null);
  const [wallNow, setWallNow] = useState(() => Date.now());
  const citationNow = citationClockOffsetMs === null ? null : wallNow - citationClockOffsetMs;
  const content = safeContentString(message.content);
  const citationRanges = useMemo(() => parseCitationReferences(content).ranges, [content]);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => { if (active) setWallNow(Date.now()); });
    return () => { active = false; };
  }, [message.citations, citationClockOffsetMs]);
  useEffect(() => {
    if (citationNow === null || citationClockOffsetMs === null) return;
    const expiry = Math.min(...(message.citations?.items ?? []).map(item => item.expiresAt).filter(value => value > citationNow));
    if (!Number.isFinite(expiry)) return;
    const timer = setTimeout(() => setWallNow(Date.now()), Math.max(1, Math.min(2_147_483_647, expiry - (Date.now() - citationClockOffsetMs) + 1)));
    return () => clearTimeout(timer);
  }, [message.citations, citationNow, citationClockOffsetMs]);
  const citationItems = new Map<number, RagCitationItem>();
  if (message.type === 'assistant' && citationAccessStatus === 'ready' && citationNow !== null
    && message.citations?.version === 'rag-citations/v1' && message.citations.status === 'available'
    && message.citations.partition === citationPartition) {
    for (const item of message.citations.items) {
      if (item.expiresAt > citationNow) citationItems.set(item.number, item);
    }
  }
  const selectedAvailable = selectedCitation
    && citationItems.get(selectedCitation.number)?.locator === selectedCitation.locator
    ? selectedCitation : null;
  const contentParts: React.ReactNode[] = [];
  let offset = 0;
  for (const range of citationRanges) {
    contentParts.push(content.slice(offset, range.start));
    const marker = content.slice(range.start, range.end);
    let markerOffset = 0;
    for (const match of marker.matchAll(/\d+/g)) {
      contentParts.push(marker.slice(markerOffset, match.index));
      const item = citationItems.get(Number(match[0]));
      contentParts.push(item ? <button key={`${range.start}:${match.index}`} type="button"
        aria-label={`查看引用 ${item.number}`} onClick={() => {
          if (citationClockOffsetMs === null) return;
          const now = Date.now();
          if (item.expiresAt <= now - citationClockOffsetMs) { setWallNow(now); return; }
          setSelectedCitation(item);
        }}
        className="rounded px-0.5 font-medium text-blue-700 underline decoration-blue-300 underline-offset-2 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-500">{match[0]}</button> : match[0]);
      markerOffset = match.index + match[0].length;
    }
    contentParts.push(marker.slice(markerOffset));
    offset = range.end;
  }
  contentParts.push(content.slice(offset));
  
  const searchResults = message.retrievalDetails?.searchResults || [];
  const hasRetrievalDetails = message.type === 'assistant' && searchResults.length > 0;
  const isDirectMessage = message.processingDetails?.mode === 'direct';
  const isMilvusMessage =
    !isDirectMessage && (
      message.storageBackend === 'milvus' ||
      (message.storageBackend === undefined && message.traceId?.startsWith('milvus'))
    );
  
  return (
    <>
      <div className={`flex chat-message ${message.type === 'user' ? 'justify-end' : 'justify-start'}`}>
        <div className={`max-w-[85%] rounded-xl shadow-sm ${
          message.type === 'user'
            ? 'bg-gradient-to-br from-blue-600 to-blue-700 text-white'
            : 'bg-white border border-gray-200 text-gray-900'
        }`}>
          {/* 消息内容 */}
          <div className="px-4 py-3">
            <p className="text-sm whitespace-pre-wrap leading-relaxed">{contentParts}</p>
            {message.type === 'assistant' && message.citations?.status === 'unavailable' &&
              <p role="status" className="mt-2 text-xs text-amber-800">引用服务暂不可用，当前回答没有可核验的原文入口。</p>}
            {message.type === 'assistant' && message.citations?.status === 'available' && (citationAccessStatus !== 'ready' || citationClockOffsetMs === null) &&
              <p role="status" className="mt-2 text-xs text-gray-500">{citationAccessStatus === 'loading' ? '正在核验引用身份…' : '引用身份暂未通过校验，来源入口已停用。'}</p>}
            {message.type === 'assistant' && message.citations?.status === 'available' && citationAccessStatus === 'ready' && citationClockOffsetMs !== null && citationItems.size === 0 &&
              <p role="status" className="mt-2 text-xs text-gray-500">引用已过期或不属于当前账号及知识库，请重新提问获取有效来源。</p>}
            
            {/* 时间和 Trace ID */}
            <div className={`flex items-center justify-between mt-2 text-xs ${
              message.type === 'user' ? 'text-blue-200' : 'text-gray-400'
            }`}>
              <span>{message.timestamp.toLocaleTimeString()}</span>
              {message.traceId && (
                <span className="flex items-center gap-1.5 font-mono">
                  {isDirectMessage && (
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                      直接回复
                    </span>
                  )}
                  {isMilvusMessage && (
                    <span className="px-1.5 py-0.5 bg-purple-100 text-purple-600 rounded text-[10px] font-medium">
                      Milvus
                    </span>
                  )}
                  <span className="text-gray-400">#{message.traceId.split('-').pop()?.slice(0, 6) || message.traceId.slice(0, 8)}</span>
                </span>
              )}
            </div>
          </div>

          {message.type === 'assistant' && message.processingDetails && (
            <div className="border-t border-gray-100 px-3 py-3">
              <AnswerProcessingPanel details={message.processingDetails} />
            </div>
          )}
          
          {/* 检索结果摘要（助手消息） */}
          {hasRetrievalDetails && (
            <div className="border-t border-gray-100">
              {/* 展开/收起按钮 */}
              <button
                onClick={() => setShowDetails(!showDetails)}
                className="w-full px-4 py-2 flex items-center justify-between text-xs text-gray-500 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <span>检索到 {searchResults.length} 个相关文档</span>
                  {message.retrievalDetails.searchTime > 0 && (
                    <>
                      <span className="text-gray-400">·</span>
                      <span className="text-gray-400">{message.retrievalDetails.searchTime}ms</span>
                    </>
                  )}
                </div>
                <svg 
                  className={`w-4 h-4 transition-transform ${showDetails ? 'rotate-180' : ''}`}
                  fill="none" 
                  stroke="currentColor" 
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              
              {/* 检索详情展开内容 */}
              {showDetails && (
                <div className="px-4 pb-3 space-y-2">
                  {/* 检索统计 */}
                  <div className="flex gap-3 text-xs text-gray-500 pb-2 border-b border-gray-100">
                    <span>总文档: {message.retrievalDetails.totalDocuments || searchResults.length}</span>
                    <span>·</span>
                    <span>阈值: {message.retrievalDetails.threshold != null ? (message.retrievalDetails.threshold * 100).toFixed(0) + '%' : '-'}</span>
                    <span>·</span>
                    <span>Top-{message.retrievalDetails.topK || searchResults.length}</span>
                  </div>
                  
                  {/* 检索结果列表 */}
                  <div className="space-y-2">
                    {searchResults.map((result: any, index: number) => {
                      const similarity = result.similarity || 0;
                      const simLevel = getSimilarityLevel(similarity);
                      const source = result.document?.metadata?.source || `文档 ${index + 1}`;
                      const content = result.document?.content || '';
                      const previewAnalysis = analyzeMatchReasons(content, currentQuery, similarity);
                      
                      return (
                        <div 
                          key={index}
                          className="rounded-lg border border-gray-200 bg-gray-50 hover:border-purple-300 hover:bg-purple-50/30 transition-all cursor-pointer"
                          onClick={() => setSelectedDocIndex(index)}
                        >
                          {/* 文档头部 */}
                          <div className="px-3 py-2 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              {/* 排名徽章 */}
                              <span className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center ${
                                index === 0 ? 'bg-yellow-400 text-yellow-900' :
                                index === 1 ? 'bg-gray-300 text-gray-700' :
                                index === 2 ? 'bg-orange-300 text-orange-800' :
                                'bg-gray-200 text-gray-600'
                              }`}>
                                {index + 1}
                              </span>
                              
                              {/* 文档名称 */}
                              <span className="text-xs font-medium text-gray-700">
                                {source}
                              </span>
                            </div>
                            
                            <div className="flex items-center gap-2">
                              {/* 快速标签 */}
                              {previewAnalysis.reasons[0] && (
                                <span className="text-[10px] text-gray-500">
                                  {previewAnalysis.reasons[0].icon} {previewAnalysis.reasons[0].type}
                                </span>
                              )}
                              
                              {/* 相似度 */}
                              <span className={`px-2 py-0.5 rounded text-xs font-bold ${simLevel.bgColor} ${simLevel.color}`}>
                                {(similarity * 100).toFixed(1)}%
                              </span>
                              
                              {/* 点击提示 */}
                              <span className="text-xs text-purple-500">查看详情 →</span>
                            </div>
                          </div>
                          
                          {/* 内容预览 */}
                          <div className="px-3 pb-2">
                            <div className="text-xs text-gray-600 line-clamp-2 leading-relaxed">
                              <SmartHighlight content={content} query={currentQuery} maxLength={150} />
                            </div>
                            
                            {/* 匹配词预览 */}
                            {previewAnalysis.matchedTerms.length > 0 && (
                              <div className="flex items-center gap-1 mt-1">
                                <span className="text-[10px] text-gray-400">匹配:</span>
                                {previewAnalysis.matchedTerms.slice(0, 3).map((term, i) => (
                                  <span key={i} className="px-1 py-0.5 bg-yellow-100 text-yellow-800 rounded text-[10px]">
                                    {term}
                                  </span>
                                ))}
                                {previewAnalysis.matchedTerms.length > 3 && (
                                  <span className="text-[10px] text-gray-400">+{previewAnalysis.matchedTerms.length - 3}</span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      
      {/* 详情弹窗 */}
      {selectedDocIndex !== null && searchResults[selectedDocIndex] && (
        <DetailModal
          result={searchResults[selectedDocIndex]}
          index={selectedDocIndex}
          query={currentQuery}
          onClose={() => setSelectedDocIndex(null)}
        />
      )}
      {selectedAvailable && citationPartition && <CitationSourceModal
        key={`${message.id}:${selectedAvailable.locator}:${citationPartition}`}
        item={selectedAvailable} partition={citationPartition} onClose={() => setSelectedCitation(null)} />}
    </>
  );
}

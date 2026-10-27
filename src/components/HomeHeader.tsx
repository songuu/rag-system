'use client';

import { useEffect, useId, useRef, useState, type FocusEvent } from 'react';
import Link from 'next/link';

interface HomeHeaderProps {
  vectorBackendDisabled: boolean;
  milvusConnected: boolean;
  showRagModes: boolean;
  useAgenticRAG: boolean;
  useAdaptiveEntityRAG: boolean;
  systemStatus: string;
  onToggleAgentic: () => void;
  onToggleEntity: () => void;
  onClearConversations: () => void;
  onRefreshStatus: () => void;
}

interface HeaderNavigationLink {
  href: string;
  label: string;
  icon: string;
  color: string;
  desktopLabel: boolean;
}

const NAVIGATION_GROUPS: readonly { label: string; links: readonly HeaderNavigationLink[] }[] = [
  { label: '知识与内容', links: [
    { href: '/documents', label: '文档管理', icon: 'fa-file-lines', color: 'text-blue-600', desktopLabel: true },
    { href: '/document-search', label: '文档搜索', icon: 'fa-magnifying-glass', color: 'text-emerald-600', desktopLabel: true },
    { href: '/blog', label: '技术博客', icon: 'fa-book-open', color: 'text-orange-500', desktopLabel: false },
    { href: '/prompt-optimizer', label: '提示词优化台', icon: 'fa-wand-magic-sparkles', color: 'text-amber-600', desktopLabel: false },
  ] },
  { label: '观察与评测', links: [
    { href: '/history', label: '历史对话', icon: 'fa-history', color: 'text-slate-500', desktopLabel: false },
    { href: '/observability', label: '可观测性', icon: 'fa-chart-line', color: 'text-blue-500', desktopLabel: false },
    { href: '/rag-evaluation', label: '效果评测', icon: 'fa-scale-balanced', color: 'text-sky-700', desktopLabel: false },
    { href: '/trace-trie', label: 'Trace-Trie', icon: 'fa-sitemap', color: 'text-purple-500', desktopLabel: false },
    { href: '/domain-vectors', label: '领域向量', icon: 'fa-crosshairs', color: 'text-emerald-500', desktopLabel: false },
  ] },
  { label: '检索与实验', links: [
    { href: '/self-rag', label: 'Self-RAG', icon: 'fa-sync-alt', color: 'text-indigo-500', desktopLabel: false },
    { href: '/agentic-rag', label: 'Agentic RAG', icon: 'fa-robot', color: 'text-fuchsia-500', desktopLabel: false },
    { href: '/self-corrective-rag', label: 'Self-Corrective RAG', icon: 'fa-redo-alt', color: 'text-teal-500', desktopLabel: false },
    { href: '/milvus', label: 'Milvus', icon: 'fa-database', color: 'text-violet-500', desktopLabel: false },
    { href: '/entity-extraction', label: '实体抽取', icon: 'fa-project-diagram', color: 'text-rose-500', desktopLabel: false },
    { href: '/knowledge-graph', label: 'Neo4j 知识图谱', icon: 'fa-share-alt', color: 'text-cyan-600', desktopLabel: false },
    { href: '/mirofish', label: 'MiroFish 群体模拟', icon: 'fa-fish', color: 'text-pink-500', desktopLabel: false },
    { href: '/adaptive-entity-rag', label: '自适应实体路由', icon: 'fa-route', color: 'text-cyan-500', desktopLabel: false },
    { href: '/context-management', label: '上下文管理', icon: 'fa-layer-group', color: 'text-amber-500', desktopLabel: false },
  ] },
];
const NOOP = () => undefined;
const DESKTOP_MEDIA_QUERY = '(min-width: 1536px)';

function ModeControls({ settings, onActivate = NOOP }: { settings: HomeHeaderProps; onActivate?: () => void }) {
  return <div className="flex shrink-0 flex-wrap items-center gap-2" aria-label="检索模式">
    <span className={'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium '
      + (settings.vectorBackendDisabled ? 'bg-amber-50 text-amber-700' : 'bg-purple-50 text-purple-700')}
      title={settings.vectorBackendDisabled ? '知识库向量检索已临时关闭' : '生产环境使用受认证的 Milvus 语料库'}>
      <i aria-hidden="true" className={'fas ' + (settings.vectorBackendDisabled ? 'fa-pause-circle' : 'fa-database')} />
      {settings.vectorBackendDisabled ? '知识库维护' : 'Milvus'}
      <span aria-hidden="true" className={'h-1.5 w-1.5 rounded-full ' + (settings.vectorBackendDisabled
        ? 'bg-amber-400' : settings.milvusConnected ? 'bg-green-400' : 'bg-red-400')} />
    </span>
    {settings.showRagModes ? <>
      <button type="button" aria-pressed={settings.useAgenticRAG} title="启用 Agentic RAG 代理化工作流"
        onClick={() => { settings.onToggleAgentic(); onActivate(); }}
        className={'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 '
          + (settings.useAgenticRAG ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200')}>
        <i aria-hidden="true" className="fas fa-robot" />Agent
      </button>
      <button type="button" aria-pressed={settings.useAdaptiveEntityRAG} title="启用自适应实体路由 RAG"
        onClick={() => { settings.onToggleEntity(); onActivate(); }}
        className={'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-600 '
          + (settings.useAdaptiveEntityRAG ? 'bg-cyan-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200')}>
        <i aria-hidden="true" className="fas fa-route" />Entity
      </button>
    </> : null}
  </div>;
}

export default function HomeHeader(settings: HomeHeaderProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const compactRef = useRef<HTMLDivElement>(null);
  const desktopRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const brandRef = useRef<HTMLAnchorElement>(null);
  const focusedRegion = useRef<'desktop' | 'compact' | null>(null);
  const activeMode = settings.vectorBackendDisabled ? '维护'
    : settings.useAgenticRAG ? 'Agent' : settings.useAdaptiveEntityRAG ? 'Entity' : 'Milvus';

  function closeAndRestoreFocus() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleRegionBlur(event: FocusEvent<HTMLDivElement>, region: 'desktop' | 'compact') {
    if (event.relatedTarget instanceof window.Node && event.currentTarget.contains(event.relatedTarget)) return;
    const wide = window.matchMedia(DESKTOP_MEDIA_QUERY).matches;
    const regionWasHidden = region === 'desktop' ? !wide : wide;
    // CSS can blur a hidden control to body before the media change event runs.
    // Retain ownership only for that transition, not for normal Tab/window blur.
    if (event.relatedTarget !== null || !regionWasHidden) focusedRegion.current = null;
    if (region === 'compact' && event.relatedTarget !== null) setOpen(false);
  }

  useEffect(() => {
    // Match the CSS breakpoint so a previously open mobile menu cannot reappear
    // after switching to desktop and then back to a narrow window.
    const media = window.matchMedia(DESKTOP_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      if (!event.matches) {
        if (focusedRegion.current === 'desktop' || desktopRef.current?.contains(document.activeElement)) {
          focusedRegion.current = null;
          triggerRef.current?.focus();
        }
        return;
      }
      const hadFocus = focusedRegion.current === 'compact' || compactRef.current?.contains(document.activeElement);
      setOpen(false);
      if (hadFocus) {
        focusedRegion.current = null;
        brandRef.current?.focus();
      }
    };
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (event: PointerEvent) => {
      if (event.target instanceof window.Node && !compactRef.current?.contains(event.target)) setOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', handleOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handleOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  return <header className="relative z-40 border-b border-slate-200 bg-white shadow-sm" aria-label="主导航">
    <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
      <div className="flex h-14 items-center gap-2 sm:gap-3">
        <Link ref={brandRef} href="/" prefetch={false} aria-label="RAG 知识库首页"
          className="flex shrink-0 items-center gap-2 rounded text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-600">
          <i aria-hidden="true" className="fas fa-brain w-5 text-xl text-blue-600" />
          <h1 className="whitespace-nowrap text-base font-semibold sm:text-lg">RAG<span className="hidden sm:inline"> 知识库</span></h1>
        </Link>

        <div ref={desktopRef} className="hidden min-w-0 flex-1 items-center gap-4 2xl:flex"
          onFocusCapture={() => { focusedRegion.current = 'desktop'; }}
          onBlur={event => handleRegionBlur(event, 'desktop')}>
          <ModeControls settings={settings} />
          <nav aria-label="桌面功能导航" className="flex min-w-0 flex-1 items-center justify-center gap-0.5">
            {NAVIGATION_GROUPS.flatMap(group => group.links).map(link => <Link key={link.href} href={link.href}
              prefetch={false} title={link.label} aria-label={link.label}
              className={'inline-flex h-8 shrink-0 items-center justify-center rounded-lg text-xs font-medium transition-colors hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-600 '
                + link.color + (link.desktopLabel ? ' gap-1.5 px-2' : ' w-8')}>
              <i aria-hidden="true" className={'fas ' + link.icon} />
              {link.desktopLabel ? <span className="whitespace-nowrap">{link.label}</span> : null}
            </Link>)}
          </nav>
          <button type="button" onClick={settings.onClearConversations} aria-label="清空历史对话" title="清空对话"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-red-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline-2 focus-visible:outline-red-600">
            <i aria-hidden="true" className="fas fa-trash-alt" />
          </button>
        </div>

        <div ref={compactRef} className="ml-auto flex shrink-0 items-center 2xl:hidden"
          onFocusCapture={() => { focusedRegion.current = 'compact'; }}
          onBlur={event => handleRegionBlur(event, 'compact')}>
          <button ref={triggerRef} type="button" aria-label={'功能菜单，当前 ' + activeMode + ' 模式'}
            aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(value => !value)}
            className={'inline-flex h-9 items-center gap-2 rounded-lg border px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 sm:px-3 '
              + (open ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-700 hover:bg-slate-50')}>
            <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
            <span><span className="hidden sm:inline">功能</span>菜单</span>
            <span className="border-l border-current/15 pl-2 text-[11px] font-normal text-slate-500">{activeMode}</span>
            <svg aria-hidden="true" className={'h-3 w-3 transition-transform motion-reduce:transition-none ' + (open ? 'rotate-180' : '')}
              viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="m4 6 4 4 4-4" /></svg>
          </button>
          {open ? <div id={menuId} className="absolute inset-x-4 top-[calc(100%+0.5rem)] max-h-[calc(100dvh-5rem)] overflow-y-auto overscroll-contain rounded-xl border border-slate-200 bg-white p-4 shadow-xl shadow-slate-900/10 sm:left-auto sm:right-6 sm:w-[30rem]">
            <div className="border-b border-slate-100 pb-4">
              <p className="mb-3 text-[11px] font-medium text-slate-400">检索模式</p>
              <ModeControls settings={settings} onActivate={closeAndRestoreFocus} />
            </div>
            <nav aria-label="折叠功能导航" className="space-y-4 py-4" onClick={event => {
              if (event.target instanceof window.Element && event.target.closest('a[href]')) setOpen(false);
            }}>
              {NAVIGATION_GROUPS.map(group => <section key={group.label}>
                <h2 className="mb-2 px-2 text-[11px] font-medium tracking-wide text-slate-400">{group.label}</h2>
                <div className="grid grid-cols-1 gap-1 min-[380px]:grid-cols-2">
                  {group.links.map(link => <Link key={link.href} href={link.href} prefetch={false}
                    className="flex min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-950 focus-visible:outline-2 focus-visible:outline-blue-600">
                    <i aria-hidden="true" className={'fas w-4 shrink-0 text-center text-xs ' + link.icon + ' ' + link.color} />
                    <span className="min-w-0 break-words">{link.label}</span>
                  </Link>)}
                </div>
              </section>)}
            </nav>
            <div className="border-t border-slate-100 pt-3">
              <button type="button" onClick={() => { closeAndRestoreFocus(); settings.onClearConversations(); }}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-red-600 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-red-600">
                <i aria-hidden="true" className="fas fa-trash-alt w-4 text-center text-xs" />清空历史对话
              </button>
            </div>
          </div> : null}
        </div>

        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <div role="status" aria-label={'系统状态：' + settings.systemStatus}
            className="flex h-8 items-center gap-2 rounded-lg bg-slate-50 px-2">
            <span aria-hidden="true" className={'h-2 w-2 shrink-0 rounded-full ' + (settings.systemStatus === '运行中' ? 'bg-green-400' : 'bg-slate-400')} />
            <span className="hidden whitespace-nowrap text-xs text-slate-600 sm:inline">{settings.systemStatus}</span>
          </div>
          <button type="button" onClick={settings.onRefreshStatus} aria-label="刷新运行状态" title="刷新"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-2 focus-visible:outline-blue-600">
            <i aria-hidden="true" className="fas fa-sync-alt text-sm" />
          </button>
        </div>
      </div>
    </div>
  </header>;
}

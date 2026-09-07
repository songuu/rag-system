'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';

const DIAGRAM_PATH = '/diagrams/knowledge-retrieval-flow.svg';

export default function KnowledgeRetrievalFlow() {
  const [open, setOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown);
    closeButtonRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 rounded-lg p-2 text-xs font-medium text-sky-600 transition-colors hover:bg-sky-50 hover:text-sky-800"
        title="查看知识库检索流程图"
      >
        <i className="fas fa-project-diagram" aria-hidden="true"></i>
        <span className="hidden xl:inline">检索流程</span>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/75 p-3 backdrop-blur-sm sm:p-6"
          onMouseDown={() => setOpen(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="knowledge-retrieval-flow-title"
            className="flex max-h-[94vh] w-full max-w-[1600px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <div>
                <h2 id="knowledge-retrieval-flow-title" className="text-base font-semibold text-slate-900 sm:text-lg">
                  知识库检索流程
                </h2>
                <p className="mt-1 text-xs text-slate-500 sm:text-sm">
                  基于当前代码：受保护范围、检索路由、多通道证据、拒答判断与回答生成
                </p>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={() => setOpen(false)}
                className="ml-4 grid h-9 w-9 shrink-0 place-items-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-sky-500"
                aria-label="关闭知识库检索流程图"
              >
                <i className="fas fa-times" aria-hidden="true"></i>
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-auto bg-slate-100 p-3 sm:p-5">
              <Image
                src={DIAGRAM_PATH}
                alt="知识库检索流程：安全范围校验、检索路由、问题向量化、Milvus 检索、证据归一化、拒答判断、上下文编排和模型回答"
                width={1680}
                height={1020}
                className="mx-auto h-auto min-w-[1080px] max-w-none rounded-xl bg-white shadow-sm xl:min-w-0 xl:max-w-full"
                draggable={false}
              />
            </div>

            <footer className="flex items-center justify-between gap-3 border-t border-slate-200 px-5 py-3 text-xs text-slate-500">
              <span>增强通道仅在功能已启用且运行时能力可用时加入检索计划。</span>
              <a
                href={DIAGRAM_PATH}
                download="knowledge-retrieval-flow.svg"
                className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                下载 SVG
              </a>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}

'use client';

import { useState } from 'react';

interface TOCItem {
  id: string;
  text: string;
  level: number;
}

interface ArticleTOCProps {
  toc: TOCItem[];
}

export function ArticleTOCSidebar({ toc }: ArticleTOCProps) {
  if (toc.length === 0) return null;

  return (
    <aside className="hidden lg:block w-64 flex-shrink-0">
      <div className="sticky top-20">
        <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">目录</h4>
        <nav className="space-y-1 max-h-[calc(100vh-8rem)] overflow-y-auto pr-2 custom-scrollbar">
          {toc.map((item, index) => (
            <a
              key={index}
              href={`#${item.id}`}
              className={`block text-sm text-gray-500 hover:text-blue-600 transition-colors truncate py-0.5 ${
                item.level === 2 ? 'font-medium text-gray-700' : ''
              }`}
              style={{ paddingLeft: `${(item.level - 2) * 16}px` }}
            >
              {item.text}
            </a>
          ))}
        </nav>
      </div>
    </aside>
  );
}

export function ArticleTOCMobile({ toc }: ArticleTOCProps) {
  const [showToc, setShowToc] = useState(false);

  if (toc.length === 0) return null;

  return (
    <>
      <button
        onClick={() => setShowToc(!showToc)}
        className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors lg:hidden"
        title="目录"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
        </svg>
      </button>

      {/* Mobile TOC Overlay */}
      {showToc && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setShowToc(false)}>
          <div className="absolute inset-0 bg-black/30"></div>
          <div
            className="absolute right-0 top-14 bottom-0 w-72 bg-white shadow-xl p-6 overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">目录</h4>
            <nav className="space-y-2">
              {toc.map((item, index) => (
                <a
                  key={index}
                  href={`#${item.id}`}
                  onClick={() => setShowToc(false)}
                  className={`block text-sm text-gray-600 hover:text-blue-600 transition-colors ${
                    item.level === 2 ? 'font-medium' : ''
                  }`}
                  style={{ paddingLeft: `${(item.level - 2) * 16}px` }}
                >
                  {item.text}
                </a>
              ))}
            </nav>
          </div>
        </div>
      )}
    </>
  );
}

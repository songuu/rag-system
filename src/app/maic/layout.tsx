import type { ReactNode } from 'react';
import Link from 'next/link';

export default function MaicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link href="/maic" className="flex items-center gap-3">
            <span className="text-2xl">🎓</span>
            <div>
              <div className="text-lg font-semibold tracking-wide">MAIC Classroom</div>
              <div className="text-xs text-slate-400">多智能体交互课堂</div>
            </div>
          </Link>
          <nav className="flex gap-4 text-sm text-slate-400">
            <Link href="/maic" className="hover:text-slate-100">
              课程
            </Link>
            <Link href="/" className="hover:text-slate-100">
              返回主页
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-[1800px] px-4 py-5 sm:px-6">{children}</main>
    </div>
  );
}

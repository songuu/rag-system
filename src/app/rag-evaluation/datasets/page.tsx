import Link from 'next/link';
import RagDatasetBuilder from '@/components/RagDatasetBuilder';

export const metadata = { title: 'RAG 测试集生成' };

export default function RagDatasetPage() {
  return <main className="min-h-screen bg-[#f5f6f8] text-slate-900">
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-5">
        <Link href="/rag-evaluation" className="text-sm text-slate-500 hover:text-slate-900">← 返回效果评测</Link>
        <span className="font-mono text-xs tracking-[0.2em] text-slate-400">RAG / DATASET</span>
      </div>
    </header>
    <div className="mx-auto max-w-6xl px-5 py-10 md:py-14">
      <div className="mb-9 max-w-2xl"><p className="mb-3 text-xs font-semibold tracking-widest text-sky-700">问题 · 参考答案 · 原文标注</p>
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">让测试集，从资料中长出来。</h1>
        <p className="mt-4 text-sm leading-7 text-slate-600">提供可信资料，直接生成带相关证据与参考答案的测试集。逐题核对后导出，用同一套标准衡量每次调整。</p>
      </div>
      <RagDatasetBuilder />
    </div>
  </main>;
}

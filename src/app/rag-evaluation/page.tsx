import Link from 'next/link';
import RagEvaluationPanel from '@/components/RagEvaluationPanel';

export const metadata = { title: 'RAG 效果评测' };

export default function RagEvaluationPage() {
  return (
    <main className="min-h-screen bg-[#f5f6f8] text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-5">
          <Link href="/" className="text-sm text-slate-500 hover:text-slate-900">← 返回问答</Link>
          <span className="font-mono text-xs tracking-[0.2em] text-slate-400">RAG / EVALUATION</span>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-5 py-10 md:py-14">
        <div className="mb-9 max-w-2xl">
          <p className="mb-3 text-xs font-semibold tracking-widest text-sky-700">召回 · 排序 · 答案 · 成本</p>
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">让每次优化，有据可查。</h1>
          <p className="mt-4 text-sm leading-7 text-slate-600">
            导入同一批问题的评测报告，对照相关证据是否找全、是否排到前面，以及答案与成本的变化。
          </p>
          <Link href="/rag-evaluation/datasets" className="mt-5 inline-flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-4 py-2.5 text-sm font-medium text-sky-800 hover:border-sky-400 hover:bg-sky-100">
            生成带参考答案与资料标注的测试集 <span aria-hidden="true">→</span>
          </Link>
        </div>
        <RagEvaluationPanel />
      </div>
    </main>
  );
}

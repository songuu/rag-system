import Link from 'next/link';
import type { RetrievalDiagnostics } from '@/lib/rag/retrieval/retrieval-diagnostics';

export default function RetrievalEffectSummary({ diagnostics }: { diagnostics?: RetrievalDiagnostics }) {
  return (
    <section aria-label="本次检索效果" className="border-b border-slate-200 bg-slate-50/70 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-slate-900">本次检索效果</h4>
          <p className="mt-1 text-xs leading-5 text-slate-500">排名变化反映排序过程；是否优化需通过标注问题集对照。</p>
        </div>
        <Link href="/rag-evaluation" className="shrink-0 rounded border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:border-sky-500 hover:text-sky-700">
          效果评测 →
        </Link>
      </div>
      <div className="mb-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-600">
        <span>候选 <strong className="font-mono text-slate-900">{diagnostics?.candidateCount ?? '—'}</strong></span>
        <span>进入上下文 <strong className="font-mono text-slate-900">{diagnostics?.contextCount ?? '—'}</strong></span>
        <span>被引用 <strong className="font-mono text-slate-900">{diagnostics?.citedCount ?? '—'}</strong></span>
        <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-800">质量未评测</span>
      </div>
      {diagnostics?.rows.length ? (
        <div className="max-h-72 overflow-auto rounded border border-slate-200 bg-white">
          <table className="w-full min-w-[440px] text-left text-xs">
            <thead className="sticky top-0 bg-slate-100 text-slate-600">
              <tr>
                {['证据 / 来源', '重排前 → 后', '检索 / 重排分数', '上下文', '引用'].map(label => (
                  <th key={label} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {diagnostics.rows.map(row => (
                <tr key={row.evidenceId}>
                  <th scope="row" className="max-w-40 px-3 py-2 font-normal">
                    <span className="block truncate text-slate-800" title={row.source}>{row.source}</span>
                    <span className="text-[10px] text-slate-400">{row.laneId}</span>
                  </th>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-sky-800" title={row.rerankLaneId}>
                    {row.beforeRerankRank !== undefined && row.afterRerankRank !== undefined
                      ? '#' + row.beforeRerankRank + ' → #' + row.afterRerankRank : '未记录'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-slate-600">
                    {Number.isFinite(row.retrievalScore) ? row.retrievalScore!.toFixed(4) : '—'}
                    {' / '}
                    {Number.isFinite(row.rerankScore) ? row.rerankScore!.toFixed(4) : '—'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{row.inContext ? '已入选' : '未入选'}</td>
                  <td className="whitespace-nowrap px-3 py-2">{row.cited === null ? '未计量' : row.cited ? '已引用' : '未引用'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="text-xs text-slate-500">本次请求未记录候选与重排轨迹。</p>}
      <p className="mt-3 text-[11px] leading-5 text-slate-500">
        检索与重排分数的量纲可能不同，不能相减判断提升。引用仅表示编号已关联，尚未评估语义支持度。
      </p>
    </section>
  );
}

'use client';

import { useState } from 'react';
import type {
  AnswerProcessingDetails,
  AnswerProcessingStatus,
} from '@/lib/rag/answer-processing';

interface AnswerProcessingPanelProps {
  details: AnswerProcessingDetails;
  defaultExpanded?: boolean;
  isLive?: boolean;
  slowMessage?: string;
  onCancel?: () => void;
}

const STATUS_LABELS: Record<AnswerProcessingStatus, string> = {
  pending: '等待中',
  active: '进行中',
  completed: '已完成',
  skipped: '已跳过',
  failed: '失败',
};

const STATUS_STYLES: Record<AnswerProcessingStatus, string> = {
  pending: 'border-gray-300 bg-gray-100 text-gray-400',
  active: 'border-blue-500 bg-blue-50 text-blue-600',
  completed: 'border-emerald-500 bg-emerald-50 text-emerald-600',
  skipped: 'border-amber-400 bg-amber-50 text-amber-600',
  failed: 'border-red-500 bg-red-50 text-red-600',
};

function StepIcon({ status }: { status: AnswerProcessingStatus }) {
  if (status === 'active') {
    return (
      <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" aria-hidden="true">
        <circle className="opacity-25" cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" />
        <path className="opacity-90" fill="currentColor" d="M12 3a9 9 0 0 1 9 9h-3a6 6 0 0 0-6-6V3Z" />
      </svg>
    );
  }
  if (status === 'completed') return <span aria-hidden="true">✓</span>;
  if (status === 'skipped') return <span aria-hidden="true">–</span>;
  if (status === 'failed') return <span aria-hidden="true">!</span>;
  return <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />;
}

export default function AnswerProcessingPanel({
  details,
  defaultExpanded = false,
  isLive = false,
  slowMessage,
  onCancel,
}: AnswerProcessingPanelProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const activeStep = details.steps.find(step => step.status === 'active');
  const statusText = activeStep
    ? activeStep.label
    : details.steps.some(step => step.status === 'failed')
      ? '处理失败'
      : '处理完成';

  return (
    <section
      className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50/80"
      aria-live={isLive ? 'polite' : undefined}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded(value => !value)}
          className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
          aria-expanded={expanded}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
              activeStep ? STATUS_STYLES.active : STATUS_STYLES.completed
            }`}>
              <StepIcon status={activeStep ? 'active' : 'completed'} />
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-medium text-slate-700">处理过程 · {statusText}</span>
              <span className="block truncate text-[11px] text-slate-500">
                {slowMessage || details.summary}
              </span>
            </span>
          </span>
          <svg
            className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m19 9-7 7-7-7" />
          </svg>
        </button>
        {isLive && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="shrink-0 rounded px-2 py-1 text-xs text-red-600 transition-colors hover:bg-red-50 hover:text-red-800"
          >
            取消
          </button>
        )}
      </div>

      {expanded && (
        <div className="border-t border-slate-200 bg-white px-3 py-3">
          <ol className="space-y-3">
            {details.steps.map((step, index) => (
              <li key={step.id} className="relative flex gap-3">
                {index < details.steps.length - 1 && (
                  <span className="absolute left-3 top-6 h-[calc(100%+0.75rem)] w-px bg-slate-200" aria-hidden="true" />
                )}
                <span className={`relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${STATUS_STYLES[step.status]}`}>
                  <StepIcon status={step.status} />
                </span>
                <div className="min-w-0 flex-1 pb-0.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-xs font-medium text-slate-700">{step.label}</span>
                    <span className="text-[10px] text-slate-400">{STATUS_LABELS[step.status]}</span>
                    {step.durationMs !== undefined && (
                      <span className="text-[10px] tabular-nums text-slate-400">{step.durationMs}ms</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] leading-4 text-slate-500">{step.detail}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-3 border-t border-dashed border-slate-200 pt-2 text-[10px] leading-4 text-slate-400">
            {details.disclosure}
          </p>
        </div>
      )}
    </section>
  );
}

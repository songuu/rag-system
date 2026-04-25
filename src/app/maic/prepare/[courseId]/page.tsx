'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';

interface PrepareEvent {
  type: string;
  data: {
    message?: string;
    page_index?: number;
    total_pages?: number;
    progress?: number;
    error?: string;
    course_id?: string;
    cache_status?: 'hit' | 'miss' | 'stored';
  };
}

const STEP_LABELS: Record<string, string> = {
  'prepare:start': '启动',
  'prepare:cache': '课程缓存',
  'prepare:read_raw': '解析文本',
  'prepare:describe': '生成描述',
  'prepare:tree': '构建知识树',
  'prepare:script': '生成讲课脚本',
  'prepare:questions': '生成主动提问',
  'prepare:scenes': '生成场景动作',
  'prepare:done': '完成',
  'prepare:error': '错误',
};

export default function PreparePage() {
  const params = useParams<{ courseId: string }>();
  const courseId = params.courseId;
  const router = useRouter();

  const [events, setEvents] = useState<PrepareEvent[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [currentStep, setCurrentStep] = useState('准备中');
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!courseId) return;
    let cancelled = false;

    async function start(): Promise<void> {
      await fetch(`/api/maic/prepare/${courseId}`, { method: 'POST' });
      if (cancelled) return;
      const es = new EventSource(`/api/maic/prepare/${courseId}`);
      esRef.current = es;
      es.onmessage = ev => {
        try {
          const parsed = JSON.parse(ev.data) as PrepareEvent;
          setEvents(prev => [...prev, parsed]);
          if (parsed.data.progress !== undefined) setProgress(parsed.data.progress);
          setCurrentStep(STEP_LABELS[parsed.type] ?? parsed.type);
          if (parsed.type === 'prepare:done') {
            setDone(true);
            es.close();
          } else if (parsed.type === 'prepare:error') {
            setError(parsed.data.error || 'unknown error');
            es.close();
          }
        } catch {
          /* ignore parse error */
        }
      };
      es.onerror = () => {
        /* will auto reconnect; ignore transient */
      };
    }

    void start();
    return () => {
      cancelled = true;
      esRef.current?.close();
    };
  }, [courseId]);

  const pct = Math.round(progress * 100);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">课程准备中</h1>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
        <div className="mb-3 flex items-center justify-between text-sm">
          <span className="text-slate-300">{currentStep}</span>
          <span className="text-slate-500">{pct}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-slate-800">
          <div
            className="h-full bg-emerald-500 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>

        {done && (
          <div className="mt-4 flex items-center justify-between rounded-lg bg-emerald-500/10 p-3">
            <span className="text-emerald-300">✅ 课程准备完成</span>
            <button
              type="button"
              onClick={() => router.push(`/maic/classroom/${courseId}`)}
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400"
            >
              进入课堂 →
            </button>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-lg bg-rose-500/10 p-3 text-rose-300">
            ❌ {error}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
        <h2 className="mb-3 text-sm font-semibold text-slate-300">实时事件</h2>
        <div className="max-h-80 space-y-1 overflow-y-auto font-mono text-xs text-slate-400">
          {events.map((e, i) => (
            <div key={i}>
              <span className="text-slate-600">
                [{String(i).padStart(3, '0')}]
              </span>{' '}
              <span className="text-emerald-400">{e.type}</span>{' '}
              {e.data.message ?? ''}
              {e.data.cache_status && ` [cache:${e.data.cache_status}]`}
              {e.data.page_index !== undefined && ` (page ${e.data.page_index + 1})`}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

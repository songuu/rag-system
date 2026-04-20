'use client';

import Link from 'next/link';

interface CourseSummary {
  course_id: string;
  title: string;
  source_filename: string;
  status: string;
  page_count: number;
  updated_at: string;
  error?: string;
}

const STATUS_COLORS: Record<string, string> = {
  uploaded: 'bg-slate-600/40 text-slate-300',
  preparing: 'bg-amber-500/20 text-amber-300',
  ready: 'bg-emerald-500/20 text-emerald-300',
  failed: 'bg-rose-500/20 text-rose-300',
};

const STATUS_LABEL: Record<string, string> = {
  uploaded: '待准备',
  preparing: '准备中',
  ready: '就绪',
  failed: '失败',
};

export function CourseCard({
  course,
  onDelete,
}: {
  course: CourseSummary;
  onDelete: (id: string) => void;
}) {
  const canEnter = course.status === 'ready';
  const primaryHref = canEnter
    ? `/maic/classroom/${course.course_id}`
    : `/maic/prepare/${course.course_id}`;

  return (
    <div className="flex flex-col rounded-2xl border border-slate-800 bg-slate-900/50 p-5 transition hover:border-slate-700 hover:bg-slate-900/70">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="line-clamp-1 text-lg font-semibold">{course.title}</div>
          <div className="mt-1 line-clamp-1 text-xs text-slate-500">
            {course.source_filename}
          </div>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            STATUS_COLORS[course.status] ?? 'bg-slate-600/40 text-slate-300'
          }`}
        >
          {STATUS_LABEL[course.status] ?? course.status}
        </span>
      </div>

      <div className="mb-4 text-sm text-slate-400">
        {course.page_count > 0 ? `${course.page_count} 页` : '尚未解析'}
        {course.error && <span className="ml-2 text-rose-400">· {course.error}</span>}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2">
        <Link
          href={primaryHref}
          className="flex-1 rounded-lg bg-emerald-500 px-3 py-2 text-center text-sm font-medium text-slate-950 hover:bg-emerald-400"
        >
          {canEnter ? '进入课堂' : '准备课程'}
        </Link>
        <button
          type="button"
          onClick={() => onDelete(course.course_id)}
          className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-400 hover:bg-slate-800 hover:text-slate-200"
        >
          删除
        </button>
      </div>
    </div>
  );
}

'use client';

import React, { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { UploadDropzone } from '@/components/maic/UploadDropzone';
import { CourseCard } from '@/components/maic/CourseCard';

interface CourseSummary {
  course_id: string;
  title: string;
  source_filename: string;
  status: string;
  page_count: number;
  updated_at: string;
  scene_types?: string[];
  error?: string;
}

export default function MaicHomePage() {
  const router = useRouter();
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  const loadCourses = useCallback(async () => {
    try {
      const resp = await fetch('/api/maic/courses');
      const json = await resp.json();
      if (json.success) setCourses(json.data as CourseSummary[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCourses();
    const timer = setInterval(() => void loadCourses(), 5000);
    return () => clearInterval(timer);
  }, [loadCourses]);

  async function handleDelete(id: string): Promise<void> {
    if (!confirm('确定删除?')) return;
    await fetch(`/api/maic/courses/${id}`, { method: 'DELETE' });
    void loadCourses();
  }

  function handleUploaded(courseId: string): void {
    router.push(`/maic/prepare/${courseId}`);
  }

  const filteredCourses = useMemo(() => {
    const keyword = deferredQuery.trim().toLowerCase();
    if (!keyword) return courses;

    return courses.filter(course =>
      [course.title, course.source_filename, course.status, ...(course.scene_types ?? [])]
        .join(' ')
        .toLowerCase()
        .includes(keyword)
    );
  }, [courses, deferredQuery]);

  const featuredCourses = useMemo(
    () =>
      courses
        .filter(course => course.status === 'ready')
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
        .slice(0, 3),
    [courses]
  );

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-3xl font-bold tracking-tight">我的课程</h1>
        <p className="mt-2 text-sm text-slate-400">
          上传一份课程资料,MAIC 会自动生成知识树和讲课脚本,7 个智能 agent 将合力为你上课。
        </p>
      </section>

      <UploadDropzone onUploaded={handleUploaded} />

      {featuredCourses.length > 0 && (
        <section>
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-200">精选课程 / 发现</h2>
            <span className="text-xs text-slate-500">最近更新</span>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {featuredCourses.map(c => (
              <CourseCard key={`featured-${c.course_id}`} course={c} onDelete={handleDelete} />
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg font-semibold text-slate-200">课程列表</h2>
          <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
            <span className="text-xs text-slate-500">搜索</span>
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="课程、文件、状态"
              className="w-52 bg-transparent text-sm text-slate-200 outline-none placeholder:text-slate-600"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="rounded-md px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-800 hover:text-slate-200"
              >
                清除
              </button>
            )}
          </div>
        </div>
        {loading ? (
          <div className="text-sm text-slate-500">加载中…</div>
        ) : courses.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-800 p-10 text-center text-sm text-slate-500">
            还没有课程,先上传一份吧。
          </div>
        ) : filteredCourses.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-800 p-10 text-center text-sm text-slate-500">
            没有匹配的课程。
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filteredCourses.map(c => (
              <CourseCard key={c.course_id} course={c} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

'use client';

import React, { useCallback, useEffect, useState } from 'react';
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
  error?: string;
}

export default function MaicHomePage() {
  const router = useRouter();
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [loading, setLoading] = useState(true);

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

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-3xl font-bold tracking-tight">我的课程</h1>
        <p className="mt-2 text-sm text-slate-400">
          上传一份课程资料,MAIC 会自动生成知识树和讲课脚本,7 个智能 agent 将合力为你上课。
        </p>
      </section>

      <UploadDropzone onUploaded={handleUploaded} />

      <section>
        <h2 className="mb-4 text-lg font-semibold text-slate-200">课程列表</h2>
        {loading ? (
          <div className="text-sm text-slate-500">加载中…</div>
        ) : courses.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-800 p-10 text-center text-sm text-slate-500">
            还没有课程,先上传一份吧。
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {courses.map(c => (
              <CourseCard key={c.course_id} course={c} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

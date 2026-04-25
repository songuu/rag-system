import { NextResponse } from 'next/server';
import { getMaicStore } from '@/lib/maic/course-store';

export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  const courses = getMaicStore()
    .listCourses()
    .map(c => ({
      course_id: c.course_id,
      title: c.title,
      source_filename: c.source_filename,
      status: c.status,
      error: c.error,
      created_at: c.created_at,
      updated_at: c.updated_at,
      page_count: c.prepared?.pages.length ?? c.source_pages?.length ?? 0,
    }));
  return NextResponse.json({ success: true, data: courses });
}

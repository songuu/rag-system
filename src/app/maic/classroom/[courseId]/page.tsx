'use client';

import { useParams } from 'next/navigation';
import { OpenMaicClassroom } from '@/components/maic/OpenMaicClassroom';

export default function ClassroomPage() {
  const params = useParams<{ courseId: string }>();
  return <OpenMaicClassroom courseId={params.courseId} />;
}

import { redirect } from 'next/navigation';

/** Legacy bookmarks enter the durable project workspace. */
export default async function LegacyMiroFishProcessPage({ searchParams }: {
  searchParams: Promise<{ projectId?: string; project_id?: string }>;
}) {
  const query = await searchParams;
  const projectId = query.projectId || query.project_id;
  redirect(projectId ? `/mirofish/console/${encodeURIComponent(projectId)}` : '/mirofish');
}

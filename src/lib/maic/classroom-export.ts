import type { Course, CourseScene, CourseSceneType } from './types';

const EXPORT_SCENE_LABELS: Record<CourseSceneType, string> = {
  slide: 'Slides',
  quiz: 'Quiz',
  interactive: 'Simulation',
  pbl: 'PBL',
  mindmap: 'Mind Map',
  code: 'Code Lab',
};

export interface ClassroomExportWarning {
  sceneIndex: number;
  sceneId?: string;
  message: string;
}

export interface ClassroomExportResult {
  html: string;
  warnings: ClassroomExportWarning[];
}

export function buildOpenMaicClassroomHtml(
  course: Pick<Course, 'course_id' | 'title' | 'prepared'>,
  scenes: CourseScene[]
): ClassroomExportResult {
  const warnings: ClassroomExportWarning[] = [];
  const sceneCards = scenes
    .map((scene, index) => renderSceneCard(scene, index, warnings))
    .join('\n');
  const summary = course.prepared?.stage?.summary ?? '多智能体交互课堂导出';

  return {
    warnings,
    html: `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(course.title)}</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui; background: #08111f; color: #e5eefb; }
    main { max-width: 1080px; margin: 0 auto; padding: 48px 24px; }
    .hero, .scene { border: 1px solid rgba(255,255,255,.12); border-radius: 28px; background: rgba(255,255,255,.06); padding: 28px; margin-bottom: 18px; }
    .scene-error { border-color: rgba(251,113,133,.45); background: rgba(251,113,133,.08); }
    .kind { color: #5eead4; letter-spacing: .22em; text-transform: uppercase; font-size: 12px; }
    .scene-error .kind { color: #fda4af; }
    h1 { font-size: 42px; margin: 0 0 12px; }
    h2 { font-size: 28px; margin: 6px 0 12px; }
    li { margin: 8px 0; }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <p class="kind">OpenMAIC Export</p>
      <h1>${escapeHtml(course.title)}</h1>
      <p>${escapeHtml(summary)}</p>
    </section>
    ${sceneCards}
  </main>
</body>
</html>`,
  };
}

function renderSceneCard(
  scene: CourseScene,
  index: number,
  warnings: ClassroomExportWarning[]
): string {
  try {
    const sceneRecord = scene as unknown as Record<string, unknown>;
    const type = asSceneType(sceneRecord.type);
    const kind = type ? EXPORT_SCENE_LABELS[type] : 'Scene';
    const title = asText(sceneRecord.title, `Scene ${index + 1}`);
    const description = asText(sceneRecord.description, '');
    const keyPoints = Array.isArray(sceneRecord.key_points)
      ? sceneRecord.key_points.map(point => asText(point, '')).filter(Boolean)
      : [];
    const points = keyPoints.map(point => `<li>${escapeHtml(point)}</li>`).join('');

    return `<section class="scene"><p class="kind">${escapeHtml(kind)}</p><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p><ul>${points}</ul></section>`;
  } catch (error) {
    const sceneRecord = scene as unknown as Record<string, unknown>;
    const warning = {
      sceneIndex: index,
      sceneId: asOptionalText(sceneRecord?.id),
      message: formatError(error),
    };
    warnings.push(warning);
    return `<section class="scene scene-error"><p class="kind">Skipped Scene</p><h2>Scene ${index + 1}</h2><p>${escapeHtml(warning.message)}</p></section>`;
  }
}

function asSceneType(value: unknown): CourseSceneType | null {
  return typeof value === 'string' && value in EXPORT_SCENE_LABELS
    ? (value as CourseSceneType)
    : null;
}

function asText(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function asOptionalText(value: unknown): string | undefined {
  const text = asText(value, '');
  return text || undefined;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import type { ModelProvider } from '../model-config';

export type MaicPrepareStage = 'describe' | 'tree' | 'script' | 'questions' | 'focus';

export interface MaicStageRoute {
  raw: string;
  modelName: string;
  provider?: ModelProvider;
}

const MAIC_PREPARE_STAGES: MaicPrepareStage[] = [
  'describe',
  'tree',
  'script',
  'questions',
  'focus',
];

const SUPPORTED_ROUTE_PROVIDERS = new Set<ModelProvider>([
  'ollama',
  'openai',
  'azure',
  'custom',
  'openrouter',
  'lemonade',
]);

export function getMaicStageRoute(stage: MaicPrepareStage): MaicStageRoute | undefined {
  const routes = loadMaicModelRoutes();
  const raw =
    routes[`maic:${stage}`] ??
    routes[stage] ??
    routes['maic:prepare'] ??
    routes.maic;
  return raw ? parseMaicStageRoute(raw) : undefined;
}

export function getMaicModelRoutesSnapshot(): Record<string, string> {
  const routes = loadMaicModelRoutes();
  const snapshot: Record<string, string> = {};
  for (const key of ['maic', 'maic:prepare', ...MAIC_PREPARE_STAGES, ...MAIC_PREPARE_STAGES.map(stage => `maic:${stage}`)]) {
    if (routes[key]) snapshot[key] = routes[key];
  }
  return snapshot;
}

function loadMaicModelRoutes(): Record<string, string> {
  return {
    ...parseRouteEnv(process.env.MODEL_ROUTES),
    ...parseRouteEnv(process.env.MAIC_MODEL_ROUTES),
  };
}

function parseRouteEnv(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const routes: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const route = normalizeRouteValue(value);
      if (route) routes[key] = route;
    }
    return routes;
  } catch {
    return {};
  }
}

function normalizeRouteValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const model = (value as { model?: unknown }).model;
  return typeof model === 'string' && model.trim() ? model.trim() : undefined;
}

function parseMaicStageRoute(raw: string): MaicStageRoute {
  const separator = raw.indexOf(':');
  if (separator <= 0) return { raw, modelName: raw };

  const provider = raw.slice(0, separator) as ModelProvider;
  const modelName = raw.slice(separator + 1).trim();
  if (!modelName || !SUPPORTED_ROUTE_PROVIDERS.has(provider)) {
    return { raw, modelName: raw };
  }
  return { raw, provider, modelName };
}

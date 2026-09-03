export const PROMPT_OPTIMIZER_MODES = ['general', 'structured', 'image'] as const;
export const MODEL_PROVIDERS = ['openai', 'openrouter', 'compatible', 'ollama'] as const;

export type PromptOptimizerMode = typeof PROMPT_OPTIMIZER_MODES[number];
export type ModelProvider = typeof MODEL_PROVIDERS[number];
export type VersionKind = 'original' | 'optimized' | 'iterated' | 'manual';
export type PromptVariables = Record<string, string>;

export interface OptimizationAnalysis {
  summary: string;
  improvements: string[];
}

export interface OptimizeInput {
  prompt: string;
  mode: PromptOptimizerMode;
  variables: PromptVariables;
  instruction: string;
  workspaceId: string | null;
  modelProfileId: string | null;
  templateId: string;
  parentVersion: number | null;
  expectedCurrentVersion: number | null;
}

const VARIABLE_PATTERN = /\{\{([A-Za-z_][A-Za-z0-9_]{0,63})\}\}/g;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPTIMIZE_FIELDS = new Set([
  'prompt', 'mode', 'variables', 'instruction', 'workspaceId', 'modelProfileId', 'templateId', 'parentVersion', 'expectedCurrentVersion',
]);

export function extractVariableNames(prompt: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of prompt.matchAll(VARIABLE_PATTERN)) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      names.push(match[1]);
    }
  }
  if (names.length > 50) throw new Error('A prompt can contain at most 50 variables.');
  return names;
}

export function validateVariables(value: unknown): PromptVariables {
  if (!isRecord(value)) throw new Error('variables must be an object.');
  const entries = Object.entries(value);
  if (entries.length > 50) throw new Error('variables can contain at most 50 entries.');
  const variables: PromptVariables = {};
  for (const [name, variableValue] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error(`Invalid variable name: ${name}`);
    if (typeof variableValue !== 'string') throw new Error(`Variable ${name} must be a string.`);
    if (variableValue.length > 4000) throw new Error(`Variable ${name} must not exceed 4000 characters.`);
    variables[name] = variableValue;
  }
  return variables;
}

export function interpolateVariables(prompt: string, value: unknown): string {
  const variables = validateVariables(value);
  return prompt.replace(VARIABLE_PATTERN, (_token, name: string) => {
    if (!Object.hasOwn(variables, name)) throw new Error(`Missing variable value: ${name}`);
    return variables[name];
  });
}

export function parseOptimizerOutput(raw: string): { prompt: string; analysis: OptimizationAnalysis } {
  const text = raw.trim();
  if (!text) throw new Error('The model returned an empty optimization result.');
  const candidate = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (isRecord(parsed) && typeof parsed.prompt === 'string' && parsed.prompt.trim()) {
      const analysis = isRecord(parsed.analysis) ? parsed.analysis : {};
      return {
        prompt: boundedPrompt(parsed.prompt),
        analysis: {
          summary: typeof analysis.summary === 'string' ? analysis.summary.slice(0, 1000) : '',
          improvements: Array.isArray(analysis.improvements)
            ? analysis.improvements.filter((item): item is string => typeof item === 'string').slice(0, 12).map(item => item.slice(0, 300))
            : [],
        },
      };
    }
  } catch {
    // Some compatible models ignore JSON mode; retaining their text keeps optimization usable.
  }
  return { prompt: boundedPrompt(text), analysis: { summary: '', improvements: [] } };
}

export function validateOptimizeInput(value: unknown): OptimizeInput {
  if (!isRecord(value)) throw new Error('Request body must be an object.');
  for (const key of Object.keys(value)) if (!OPTIMIZE_FIELDS.has(key)) throw new Error(`Unknown field: ${key}`);
  const prompt = boundedPrompt(value.prompt);
  const mode = value.mode ?? 'general';
  if (!PROMPT_OPTIMIZER_MODES.includes(mode as PromptOptimizerMode)) throw new Error('mode is invalid.');
  const instruction = value.instruction ?? '';
  if (typeof instruction !== 'string' || instruction.length > 2000) throw new Error('instruction must not exceed 2000 characters.');
  return {
    prompt,
    mode: mode as PromptOptimizerMode,
    variables: validateVariables(value.variables ?? {}),
    instruction,
    workspaceId: nullableIdentifier(value.workspaceId, 'workspaceId'),
    modelProfileId: nullableIdentifier(value.modelProfileId, 'modelProfileId'),
    templateId: requiredIdentifier(value.templateId ?? `${mode}-v1`, 'templateId'),
    parentVersion: nullableVersion(value.parentVersion),
    expectedCurrentVersion: nullableNonnegativeVersion(value.expectedCurrentVersion),
  };
}

function boundedPrompt(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('prompt is required.');
  if (value.length > 20000) throw new Error('prompt must not exceed 20000 characters.');
  return value.trim();
}

function nullableIdentifier(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requiredIdentifier(value, name);
}

function requiredIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) throw new Error(`${name} is invalid.`);
  return value;
}

function nullableVersion(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('parentVersion must be a positive integer.');
  return value as number;
}

function nullableNonnegativeVersion(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('expectedCurrentVersion must be a nonnegative integer.');
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

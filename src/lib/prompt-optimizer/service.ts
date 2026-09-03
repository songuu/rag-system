import { randomUUID } from 'node:crypto';
import { MODEL_PROVIDERS, parseOptimizerOutput, validateOptimizeInput, type ModelProvider } from './contracts';
import { requestOptimization } from './providers';
import { PostgresPromptOptimizerStore, type StoredModelProfile } from './store';
import { buildOptimizationMessages } from './templates';
import type { RagSecurityContext } from '../security/request-context';

export class PromptOptimizerService {
  private readonly store: PostgresPromptOptimizerStore;
  private readonly requestModel: typeof requestOptimization;

  constructor(
    store = new PostgresPromptOptimizerStore(),
    requestModel = requestOptimization
  ) { this.store = store; this.requestModel = requestModel; }

  async optimize(raw: unknown) {
    const input = validateOptimizeInput(raw);
    const profile = input.modelProfileId
      ? await this.store.getModelProfile(input.modelProfileId)
      : await this.store.getDefaultModelProfile();
    if (!profile) throw new Error('Create and select a prompt optimizer model profile first.');
    const modelOutput = await this.requestModel(profile, buildOptimizationMessages(input));
    const optimized = parseOptimizerOutput(modelOutput);
    let workspaceId = input.workspaceId;
    let expectedCurrentVersion = input.expectedCurrentVersion ?? input.parentVersion ?? 0;
    if (!workspaceId) {
      const workspace = await this.store.createWorkspace({
        title: input.prompt.replace(/\s+/g, ' ').slice(0, 60), originalPrompt: input.prompt,
        mode: input.mode, variables: input.variables, selectedModelProfileId: profile.profileId,
      });
      workspaceId = String(workspace?.workspace_id);
      expectedCurrentVersion = 0;
    }
    const version = await this.store.appendVersion({
      workspaceId, kind: input.parentVersion ? 'iterated' : 'optimized', prompt: optimized.prompt,
      instruction: input.instruction, analysis: optimized.analysis, variables: input.variables,
      modelProfileId: profile.profileId, templateId: input.templateId, expectedCurrentVersion,
      parentVersion: input.parentVersion,
    });
    return { workspaceId, version, model: { profileId: profile.profileId, name: profile.name, provider: profile.provider, model: profile.model } };
  }

  async saveProfile(raw: unknown): Promise<StoredModelProfile> {
    if (!isRecord(raw)) throw new Error('Model profile must be an object.');
    const allowed = new Set(['profileId', 'name', 'provider', 'model', 'baseUrl', 'settings', 'isDefault', 'token']);
    for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`Unknown field: ${key}`);
    const provider = requiredString(raw.provider, 'provider') as ModelProvider;
    if (!MODEL_PROVIDERS.includes(provider)) throw new Error('provider is invalid.');
    const baseUrl = raw.baseUrl == null || raw.baseUrl === '' ? null : safeBaseUrl(requiredString(raw.baseUrl, 'baseUrl'));
    if (baseUrl && baseUrl.length > 2048) throw new Error('baseUrl is too long.');
    const settings = validateModelSettings(raw.settings);
    const credential = raw.token == null || raw.token === '' ? null : requiredString(raw.token, 'token');
    if (credential && credential.length > 4096) throw new Error('token exceeds 4096 characters.');
    return this.store.saveModelProfile({
      profileId: raw.profileId == null ? randomUUID() : requiredIdentifier(raw.profileId, 'profileId'),
      name: requiredString(raw.name, 'name').slice(0, 120), provider,
      model: requiredString(raw.model, 'model').slice(0, 200), baseUrl, settings,
      isDefault: raw.isDefault === true, archivedAt: null, credential, hasCredential: Boolean(credential),
    });
  }
}

export function getPromptOptimizerService(context?: Pick<RagSecurityContext, 'tenantId' | 'corpusId'>) {
  return context
    ? new PromptOptimizerService(new PostgresPromptOptimizerStore(undefined, undefined, context))
    : new PromptOptimizerService();
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}
function requiredIdentifier(value: unknown, field: string): string {
  const text = requiredString(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) throw new Error(`${field} is invalid.`);
  return text;
}
function safeBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
    return url.toString().replace(/\/$/, '');
  } catch { throw new Error('baseUrl is invalid and must not include credentials or a fragment.'); }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function validateModelSettings(value: unknown): Record<string, number> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error('settings must be an object.');
  const bounds: Record<string, [number, number]> = {
    temperature: [0, 2], maxTokens: [256, 16384], topP: [0, 1], timeoutMs: [5000, 120000],
  };
  const settings: Record<string, number> = {};
  for (const [key, setting] of Object.entries(value)) {
    const bound = bounds[key];
    if (!bound) throw new Error(`Unknown model setting: ${key}`);
    if (typeof setting !== 'number' || !Number.isFinite(setting) || setting < bound[0] || setting > bound[1]) {
      throw new Error(`${key} is outside its allowed range.`);
    }
    settings[key] = setting;
  }
  return settings;
}

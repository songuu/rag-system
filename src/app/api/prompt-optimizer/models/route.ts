import { NextResponse } from 'next/server';
import { promptOptimizerError, readPromptOptimizerJson } from '@/lib/prompt-optimizer/http';
import { getPromptOptimizerService } from '@/lib/prompt-optimizer/service';
import { PostgresPromptOptimizerStore, type StoredModelProfile } from '@/lib/prompt-optimizer/store';
import { resolveRagSecurityContext } from '@/lib/security/request-context';

export const runtime = 'nodejs';

const selectorProfile = ({ profileId, name, provider, model, isDefault, hasCredential }: StoredModelProfile) =>
  ({ profileId, name, provider, model, isDefault, hasCredential });

const editableProfile = (profile: StoredModelProfile) => ({
  ...selectorProfile(profile),
  baseUrl: sanitizedBaseUrl(profile.baseUrl),
  settings: sanitizedSettings(profile.settings),
});

export async function GET(request: Request) {
  try {
    const detailed = new URL(request.url).searchParams.get('detail') === '1';
    const context = await resolveRagSecurityContext(request, { capability: detailed ? 'manage-runtime' : 'query' });
    const profiles = await new PostgresPromptOptimizerStore(undefined, undefined, context).listModelProfiles();
    return NextResponse.json({ success: true, data: profiles.map(detailed ? editableProfile : selectorProfile) });
  } catch (error) {
    return promptOptimizerError(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await resolveRagSecurityContext(request, { capability: 'manage-runtime' });
    const profile = await getPromptOptimizerService(context).saveProfile(await readPromptOptimizerJson(request));
    return NextResponse.json({ success: true, data: editableProfile(profile) }, { status: 201 });
  } catch (error) {
    return promptOptimizerError(error);
  }
}

function sanitizedBaseUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function sanitizedSettings(value: Record<string, unknown>): Record<string, number> {
  const sanitized: Record<string, number> = {};
  for (const key of ['temperature', 'topP', 'maxTokens', 'timeoutMs']) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) sanitized[key] = value[key];
  }
  return sanitized;
}

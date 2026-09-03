import { NextResponse } from 'next/server';
import { promptOptimizerError, readPromptOptimizerJson } from '@/lib/prompt-optimizer/http';
import { getPromptOptimizerService } from '@/lib/prompt-optimizer/service';
import { PostgresPromptOptimizerStore } from '@/lib/prompt-optimizer/store';
import { resolveRagSecurityContext } from '@/lib/security/request-context';
export const runtime = 'nodejs';
const publicProfile = ({ profileId, name, provider, model, isDefault, hasCredential }: { profileId:string; name:string; provider:string; model:string; isDefault:boolean; hasCredential:boolean }) => ({ profileId, name, provider, model, isDefault, hasCredential });
export async function GET(request: Request) { try { const context = await resolveRagSecurityContext(request, { capability: 'query' }); const profiles = await new PostgresPromptOptimizerStore(undefined, undefined, context).listModelProfiles(); return NextResponse.json({ success: true, data: profiles.map(publicProfile) }); } catch (error) { return promptOptimizerError(error); } }
export async function POST(request: Request) { try { const context = await resolveRagSecurityContext(request, { capability: 'manage-runtime' }); const profile = await getPromptOptimizerService(context).saveProfile(await readPromptOptimizerJson(request)); return NextResponse.json({ success: true, data: publicProfile(profile) }, { status: 201 }); } catch (error) { return promptOptimizerError(error); } }

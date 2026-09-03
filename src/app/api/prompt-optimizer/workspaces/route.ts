import { NextResponse } from 'next/server';
import { promptOptimizerError } from '@/lib/prompt-optimizer/http';
import { PostgresPromptOptimizerStore } from '@/lib/prompt-optimizer/store';
import { resolveRagSecurityContext } from '@/lib/security/request-context';
export const runtime = 'nodejs';
export async function GET(request: Request) { try { const context = await resolveRagSecurityContext(request, { capability: 'query' }); return NextResponse.json({ success: true, data: await new PostgresPromptOptimizerStore(undefined, undefined, context).listWorkspaces() }); } catch (error) { return promptOptimizerError(error); } }

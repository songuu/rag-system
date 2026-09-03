import { NextResponse } from 'next/server';
import { listPromptTemplates } from '@/lib/prompt-optimizer/templates';
import { promptOptimizerError } from '@/lib/prompt-optimizer/http';
import { resolveRagSecurityContext } from '@/lib/security/request-context';
export const runtime = 'nodejs';
export async function GET(request: Request) { try { await resolveRagSecurityContext(request, { capability: 'query' }); return NextResponse.json({ success: true, data: listPromptTemplates() }); } catch (error) { return promptOptimizerError(error); } }

import { NextResponse } from 'next/server';
import { promptOptimizerError, readPromptOptimizerJson } from '@/lib/prompt-optimizer/http';
import { getPromptOptimizerService } from '@/lib/prompt-optimizer/service';
import { resolveRagSecurityContext } from '@/lib/security/request-context';
export const runtime = 'nodejs';
export async function POST(request: Request) { try { const context = await resolveRagSecurityContext(request, { capability: 'ingest' }); return NextResponse.json({ success: true, data: await getPromptOptimizerService(context).optimize(await readPromptOptimizerJson(request)) }); } catch (error) { return promptOptimizerError(error); } }

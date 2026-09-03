import { NextResponse } from 'next/server';
import { promptOptimizerError } from '@/lib/prompt-optimizer/http';
import { PostgresPromptOptimizerStore } from '@/lib/prompt-optimizer/store';
import { resolveRagSecurityContext } from '@/lib/security/request-context';
export const runtime = 'nodejs';
export async function GET(request: Request, routeContext: { params: Promise<{ workspaceId: string }> }) { try { const securityContext = await resolveRagSecurityContext(request, { capability: 'query' }); const { workspaceId } = await routeContext.params; const store = new PostgresPromptOptimizerStore(undefined, undefined, securityContext); const workspace = await store.getWorkspace(workspaceId); if (!workspace) return NextResponse.json({ success: false, error: 'Workspace not found.' }, { status: 404 }); return NextResponse.json({ success: true, data: { workspace, versions: await store.listVersions(workspaceId) } }); } catch (error) { return promptOptimizerError(error); } }

import { NextResponse } from 'next/server';
import { readJsonObjectWithLimit } from '../security/request-validation';
import { RagSecurityError } from '../security/request-context';
import { PostgresQueryError } from '../postgres/client';
import { PromptOptimizerBusyError, PromptOptimizerOutputLimitError } from './providers';

export async function readPromptOptimizerJson(request: Request) { return readJsonObjectWithLimit(request, 96 * 1024); }
export function promptOptimizerError(error: unknown, requestId = crypto.randomUUID()) {
  if (error instanceof RagSecurityError) return NextResponse.json(error.toResponseBody(), { status: error.status });
  if (error instanceof PromptOptimizerBusyError) return NextResponse.json({ success: false, error: error.message, requestId }, { status: 429 });
  if (error instanceof PromptOptimizerOutputLimitError) {
    return NextResponse.json({ success: false, error: error.message, code: error.code, requestId }, { status: error.status });
  }
  if (error instanceof PostgresQueryError) {
    if (error.code === '23505' && error.constraint === 'prompt_optimizer_profile_name_idx') {
      return NextResponse.json({ success: false, error: 'A model profile with this name already exists.', requestId }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: 'Prompt optimizer storage is unavailable.', requestId }, { status: 503 });
  }
  const message = error instanceof Error ? error.message : 'Prompt optimizer request failed.';
  const expected = /required|invalid|unknown field|must|exceed|missing|conflict|create and select/i.test(message);
  if (!expected) console.error('[prompt-optimizer]', requestId, error instanceof Error ? error.name : 'UnknownError');
  return NextResponse.json({ success: false, error: expected ? message : 'Prompt optimizer request failed.', requestId }, { status: expected ? 400 : 500 });
}

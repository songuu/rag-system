import { NextResponse } from 'next/server';
import { RagSecurityError } from '../security/request-context';
import { RequestValidationError } from '../security/request-validation';
import { MiroFishProjectInUseError } from './project-lifecycle';

export function miroFishProjectApiError(error: unknown, fallback: string): NextResponse {
  if (error instanceof MiroFishProjectInUseError) return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: 409 });
  if (error instanceof RagSecurityError) {
    const { error: detail } = error.toResponseBody();
    return NextResponse.json({ success: false, error: detail.message, code: detail.code, requestId: detail.requestId }, { status: error.status });
  }
  if (error instanceof RequestValidationError) return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
  return NextResponse.json({ success: false, error: fallback }, { status: 500 });
}

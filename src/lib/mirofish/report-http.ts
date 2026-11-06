import { NextResponse } from 'next/server';
import { RagSecurityError } from '../security/request-context';
import { RequestValidationError } from '../security/request-validation';
import { KnowledgeGraphError } from '../knowledge-graph/contracts';
import { MiroFishReportError, safeReportError } from './report-contracts';
export function reportHttpError(error: unknown): NextResponse {
  if (error instanceof RagSecurityError) return NextResponse.json({ success: false, ...error.toResponseBody() }, { status: error.status });
  if (error instanceof KnowledgeGraphError) return NextResponse.json({ success: false, code: error.code, error: '图谱来源已变化或不可读取，请刷新后重试。' }, { status: 409 });
  const safe = error instanceof RequestValidationError || error instanceof MiroFishReportError ? error : safeReportError(error);
  return NextResponse.json({ success: false, code: safe.code, error: safe.message }, { status: safe.status });
}
export function reportBoolean(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new MiroFishReportError('MIROFISH_REPORT_INVALID_INPUT', name + ' 必须是布尔值。', 400);
  return value;
}
export function reportInteger(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 0 || number > max) throw new MiroFishReportError('MIROFISH_REPORT_INVALID_INPUT', '分页或章节参数无效。', 400);
  return number;
}

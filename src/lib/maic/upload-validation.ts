import { SUPPORTED_EXTENSIONS } from '../document-parser';

// MAIC 课堂接受 document-parser 支持的扩展 + PPTX（parseSlides 内部走 parsePptxSlides 解析）。
// 单独维护一份是为了：
// 1) MAIC 比 RAG 通用 document-parser 多一个 .pptx；
// 2) 不污染 mirofish/RAG 链路的全局 SUPPORTED_EXTENSIONS；
// 3) upload route 与测试共享同一份白名单，避免漂移。
export const MAIC_SUPPORTED_EXTENSIONS = [...SUPPORTED_EXTENSIONS, '.pptx'] as const;

export type MaicSupportedExtension = typeof MAIC_SUPPORTED_EXTENSIONS[number];

export function isMaicSupportedFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  const dotIndex = lower.lastIndexOf('.');
  if (dotIndex < 0) return false;
  const ext = lower.slice(dotIndex);
  return (MAIC_SUPPORTED_EXTENSIONS as readonly string[]).includes(ext);
}

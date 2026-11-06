/** Legacy writers cannot participate in the versioned publication protocol. */
export function getUnifiedPublicationWriteBlock(env: NodeJS.ProcessEnv = process.env):
  { status: 503; code: 'PUBLICATION_LEGACY_WRITE_UNAVAILABLE'; message: string } | null {
  const value = env.RAG_UNIFIED_PUBLICATION_MODE;
  if (value === undefined || value.trim().toLowerCase() === 'off') return null;
  return { status: 503, code: 'PUBLICATION_LEGACY_WRITE_UNAVAILABLE',
    message: '统一发布模式下旧检索和修改入口暂不可用。' };
}

export function assertUnifiedPublicationLegacyWriteAllowed(): void {
  const block = getUnifiedPublicationWriteBlock();
  if (block) throw Object.assign(new Error(block.message), { code: block.code, status: block.status });
}

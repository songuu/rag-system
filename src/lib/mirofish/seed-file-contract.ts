export const MIROFISH_SEED_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MIROFISH_SEED_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const MIROFISH_SEED_MAX_FILES = 10;
export const MIROFISH_SEED_EXTENSIONS = ['pdf', 'md', 'markdown', 'txt'] as const;
export interface MiroFishSeedFileInfo { filename: string; size: number; pages?: number; encoding?: string }

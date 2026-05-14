/**
 * Cache parsed slide text so repeated uploads avoid re-running expensive PDF
 * extraction before the prepared-artifact cache can even be checked.
 */

import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import type { ParsedSlides } from './slide-parser';

const CACHE_VERSION = 'maic-parsed-slides-v1';
const CACHE_DIR = path.join(process.cwd(), 'uploads', 'maic-parsed-cache');

export interface MaicParsedSlidesCacheIdentity {
  cache_key: string;
  cache_file: string;
  file_hash: string;
}

interface MaicParsedSlidesCacheRecord {
  version: string;
  cache_key: string;
  file_hash: string;
  source_filename: string;
  created_at: string;
  parsed: ParsedSlides;
}

export function getMaicParsedSlidesCacheIdentity(input: {
  buffer: Buffer;
  filename: string;
}): MaicParsedSlidesCacheIdentity {
  const extension = path.extname(input.filename).toLowerCase();
  const fileHash = createHash('sha256')
    .update(extension)
    .update('\0')
    .update(input.buffer)
    .digest('hex');
  const cacheKey = fileHash.slice(0, 32);

  return {
    cache_key: cacheKey,
    cache_file: path.join(CACHE_DIR, `${cacheKey}.json`),
    file_hash: fileHash,
  };
}

export async function loadParsedSlidesFromCache(
  identity: MaicParsedSlidesCacheIdentity
): Promise<ParsedSlides | null> {
  try {
    if (!existsSync(identity.cache_file)) return null;

    const raw = await readFile(identity.cache_file, 'utf-8');
    const record = JSON.parse(raw) as unknown;
    if (!isValidRecord(record, identity)) return null;

    return record.parsed;
  } catch (error) {
    console.warn('[MAIC Parsed Cache] 读取解析缓存失败:', formatError(error));
    return null;
  }
}

export async function saveParsedSlidesToCache(
  identity: MaicParsedSlidesCacheIdentity,
  parsed: ParsedSlides
): Promise<boolean> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const record: MaicParsedSlidesCacheRecord = {
      version: CACHE_VERSION,
      cache_key: identity.cache_key,
      file_hash: identity.file_hash,
      source_filename: parsed.filename,
      created_at: new Date().toISOString(),
      parsed,
    };
    const tempFile = `${identity.cache_file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempFile, JSON.stringify(record, null, 2), 'utf-8');
    await rename(tempFile, identity.cache_file);
    return true;
  } catch (error) {
    console.warn('[MAIC Parsed Cache] 写入解析缓存失败:', formatError(error));
    return false;
  }
}

function isValidRecord(
  value: unknown,
  identity: MaicParsedSlidesCacheIdentity
): value is MaicParsedSlidesCacheRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<MaicParsedSlidesCacheRecord>;
  return (
    record.version === CACHE_VERSION &&
    record.cache_key === identity.cache_key &&
    record.file_hash === identity.file_hash &&
    !!record.parsed &&
    typeof record.parsed.filename === 'string' &&
    typeof record.parsed.raw_text === 'string' &&
    Array.isArray(record.parsed.pages)
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

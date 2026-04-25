/**
 * Bridge MAIC uploads into the existing RAG document source.
 *
 * Current RAG initialization reads parsed text files from `uploads/`, so MAIC
 * mirrors its parsed slide text there instead of inventing a second corpus.
 */

import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { getCurrentRagSystem, resetRagSystem } from '../rag-instance';
import type { MaicRagAsset } from './types';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
const MANIFEST_FILE = path.join(UPLOAD_DIR, 'file-manifest.json');

interface FileManifestItem {
  id: string;
  originalName: string;
  originalExtension: string;
  storedFilename: string;
  parsedFilename: string;
  size: number;
  contentLength: number;
  uploadedAt: string;
  parseMethod: string;
  pages?: number;
  source?: 'maic';
  sourceHash?: string;
}

export async function mirrorMaicCourseToRagUploads(input: {
  sourceText: string;
  sourceFilename: string;
  sourceHash?: string;
  pageCount?: number;
}): Promise<MaicRagAsset> {
  try {
    await mkdir(UPLOAD_DIR, { recursive: true });

    const sourceHash = input.sourceHash ?? hashText(input.sourceText);
    const shortHash = sourceHash.slice(0, 12);
    const baseName = sanitizeBaseName(path.basename(input.sourceFilename, path.extname(input.sourceFilename)));
    const parsedFilename = `maic_${shortHash}_${baseName}_parsed.txt`;
    const parsedFilePath = path.join(UPLOAD_DIR, parsedFilename);

    await writeParsedTextIfChanged(parsedFilePath, input.sourceText);
    await upsertManifestItem({
      id: `maic_${shortHash}`,
      originalName: input.sourceFilename,
      originalExtension: path.extname(input.sourceFilename) || '.txt',
      storedFilename: parsedFilename,
      parsedFilename,
      size: Buffer.byteLength(input.sourceText, 'utf-8'),
      contentLength: input.sourceText.length,
      uploadedAt: new Date().toISOString(),
      parseMethod: 'maic-slide-parser',
      pages: input.pageCount,
      source: 'maic',
      sourceHash,
    });

    invalidateCurrentRagInstance();

    return {
      source_hash: sourceHash,
      parsed_filename: parsedFilename,
      manifest_id: `maic_${shortHash}`,
      mirrored_at: new Date().toISOString(),
    };
  } catch (error) {
    throw new Error(`同步 MAIC 课程到 RAG uploads 失败: ${formatError(error)}`);
  }
}

async function writeParsedTextIfChanged(filePath: string, sourceText: string): Promise<void> {
  if (existsSync(filePath)) {
    const existing = await readFile(filePath, 'utf-8');
    if (existing === sourceText) return;
  }
  await writeFile(filePath, sourceText, 'utf-8');
}

async function upsertManifestItem(item: FileManifestItem): Promise<void> {
  const manifest = await loadManifest();
  manifest[item.id] = {
    ...manifest[item.id],
    ...item,
  };
  await writeFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf-8');
}

async function loadManifest(): Promise<Record<string, FileManifestItem>> {
  try {
    if (!existsSync(MANIFEST_FILE)) return {};
    const raw = await readFile(MANIFEST_FILE, 'utf-8');
    return JSON.parse(raw) as Record<string, FileManifestItem>;
  } catch (error) {
    console.warn('[MAIC RAG] 读取 uploads manifest 失败，将重建 manifest:', formatError(error));
    return {};
  }
}

function invalidateCurrentRagInstance(): void {
  if (!getCurrentRagSystem()) return;
  resetRagSystem();
}

function hashText(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n').trim()).digest('hex');
}

function sanitizeBaseName(name: string): string {
  return name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]/g, '_').slice(0, 80) || 'course';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bridge MAIC uploads into the existing RAG document source.
 *
 * MAIC uses the same upload persistence seam as ordinary RAG documents, so
 * local development and PostgreSQL production share one corpus contract.
 */

import { createHash } from 'crypto';
import path from 'path';
import { createUploadPersistence } from '../persistence/upload-store';
import type { BlobStore } from '../persistence/ports';
import type { MaicRagAsset } from './types';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
const MANIFEST_FILE = path.join(UPLOAD_DIR, 'file-manifest.json');

interface MaicRagBridgeDependencies {
  createPersistence?: typeof createUploadPersistence;
  invalidateRagInstance?: () => void | Promise<void>;
  now?: () => Date;
}

export async function mirrorMaicCourseToRagUploads(input: {
  sourceText: string;
  sourceFilename: string;
  sourceHash?: string;
  pageCount?: number;
}, dependencies: MaicRagBridgeDependencies = {}): Promise<MaicRagAsset> {
  try {
    const sourceHash = input.sourceHash ?? hashText(input.sourceText);
    const shortHash = sourceHash.slice(0, 12);
    const baseName = sanitizeBaseName(path.basename(input.sourceFilename, path.extname(input.sourceFilename)));
    const parsedFilename = `maic_${shortHash}_${baseName}_parsed.txt`;
    const mirroredAt = (dependencies.now ?? (() => new Date()))().toISOString();
    const { blobStore, manifestStore } = (dependencies.createPersistence ?? createUploadPersistence)({
      uploadDir: UPLOAD_DIR,
      manifestFile: MANIFEST_FILE,
    });

    await blobStore.ensureRoot();
    await writeParsedTextIfChanged(blobStore, parsedFilename, input.sourceText, sourceHash);
    await manifestStore.recordUpload({
      id: `maic_${shortHash}`,
      originalName: input.sourceFilename,
      originalExtension: path.extname(input.sourceFilename) || '.txt',
      storedFilename: parsedFilename,
      parsedFilename,
      size: Buffer.byteLength(input.sourceText, 'utf-8'),
      contentLength: input.sourceText.length,
      uploadedAt: mirroredAt,
      parseMethod: 'maic-slide-parser',
      pages: input.pageCount,
      source: 'maic',
      sourceHash,
    });

    await (dependencies.invalidateRagInstance ?? invalidateCurrentRagInstance)();

    return {
      source_hash: sourceHash,
      parsed_filename: parsedFilename,
      manifest_id: `maic_${shortHash}`,
      mirrored_at: mirroredAt,
    };
  } catch (error) {
    throw new Error(`同步 MAIC 课程到 RAG uploads 失败: ${formatError(error)}`);
  }
}

async function writeParsedTextIfChanged(
  blobStore: BlobStore,
  filename: string,
  sourceText: string,
  sourceHash: string
): Promise<void> {
  if (await blobStore.exists(filename)) {
    const existing = await blobStore.readText(filename);
    if (existing === sourceText) return;
  }
  await blobStore.write(filename, sourceText, {
    kind: 'parsed',
    contentType: 'text/plain; charset=utf-8',
    metadata: { source: 'maic', source_hash: sourceHash },
  });
}

async function invalidateCurrentRagInstance(): Promise<void> {
  // The heavy RAG runtime is only needed after the durable write succeeds.
  const { getCurrentRagSystem, resetRagSystem } = await import('../rag-instance');
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

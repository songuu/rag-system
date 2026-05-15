import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { BlobStat, BlobStore, FileManifestItem, UploadManifestStore } from './ports';

export class LocalBlobStore implements BlobStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  async exists(filename: string): Promise<boolean> {
    return existsSync(this.resolve(filename));
  }

  async write(filename: string, data: string | Uint8Array): Promise<void> {
    await this.ensureRoot();
    await writeFile(this.resolve(filename), data);
  }

  async readText(filename: string): Promise<string> {
    return await readFile(this.resolve(filename), 'utf-8');
  }

  async list(): Promise<string[]> {
    if (!existsSync(this.rootDir)) return [];
    return await readdir(this.rootDir);
  }

  async stat(filename: string): Promise<BlobStat> {
    const fileStat = await stat(this.resolve(filename));
    return {
      size: fileStat.size,
      modified: fileStat.mtime.toISOString(),
    };
  }

  async delete(filename: string): Promise<boolean> {
    const fullPath = this.resolve(filename);
    if (!existsSync(fullPath)) return false;
    await unlink(fullPath);
    return true;
  }

  private resolve(filename: string): string {
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      throw new Error(`Invalid blob filename: ${filename}`);
    }
    return path.join(this.rootDir, filename);
  }
}

export class LocalUploadManifestStore implements UploadManifestStore {
  private readonly manifestFile: string;

  constructor(manifestFile: string) {
    this.manifestFile = manifestFile;
  }

  async loadManifest(): Promise<Record<string, FileManifestItem>> {
    try {
      if (existsSync(this.manifestFile)) {
        const content = await readFile(this.manifestFile, 'utf-8');
        return JSON.parse(content) as Record<string, FileManifestItem>;
      }
    } catch (error) {
      console.error('[LocalUploadManifestStore] 加载文件清单失败:', error);
    }
    return {};
  }

  async saveManifest(manifest: Record<string, FileManifestItem>): Promise<void> {
    await mkdir(path.dirname(this.manifestFile), { recursive: true });
    await writeFile(this.manifestFile, JSON.stringify(manifest, null, 2), 'utf-8');
  }

  async recordUpload(item: FileManifestItem): Promise<void> {
    const manifest = await this.loadManifest();
    manifest[item.id] = item;
    await this.saveManifest(manifest);
  }

  async removeUpload(match: string): Promise<FileManifestItem | null> {
    const manifest = await this.loadManifest();

    for (const [key, item] of Object.entries(manifest)) {
      if (
        item.id === match ||
        item.originalName === match ||
        item.storedFilename === match ||
        item.parsedFilename === match
      ) {
        delete manifest[key];
        await this.saveManifest(manifest);
        return item;
      }
    }

    return null;
  }
}

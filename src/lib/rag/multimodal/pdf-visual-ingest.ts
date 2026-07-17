import {
  PDF_ASSET_MANIFEST_VERSION,
  buildPdfAssetManifest,
  type PdfAssetImageMimeType,
} from './pdf-asset-manifest';
import type { PdfAssetStore } from './pdf-asset-store';
import type { PdfPageImageRenderer } from './pdf-page-image-renderer';
import type { PdfParseOutput } from '../../pdf-parser';
import type {
  RagRetrievalScope,
  RagTrustLevel,
} from '../../security/retrieval-scope';
import type { PdfMultimodalMode } from './pdf-modality-router';

export const PDF_VISUAL_INGEST_VERSION = 'pdf-visual-ingest-v1' as const;
export const DEFAULT_PDF_VISUAL_MAX_RENDER_PAGES = 20;
export const MAX_PDF_VISUAL_MAX_RENDER_PAGES = 100;

export interface PublishPdfVisualSidecarInput {
  mode: PdfMultimodalMode;
  source: Uint8Array;
  sourceName: string;
  documentId: string;
  documentVersion: string;
  parsed: PdfParseOutput;
  scope: RagRetrievalScope;
  trustLevel: RagTrustLevel;
  store?: PdfAssetStore;
  renderer?: PdfPageImageRenderer;
  maxRenderPages?: number;
  signal?: AbortSignal;
}

export interface PdfVisualIngestSummary {
  version: typeof PDF_VISUAL_INGEST_VERSION;
  mode: PdfMultimodalMode;
  status: 'disabled' | 'published';
  manifestVersion?: typeof PDF_ASSET_MANIFEST_VERSION;
  documentId: string;
  documentVersion: string;
  pageCount: number;
  visualPageCount: number;
}

/**
 * Publishes page images only after the caller has committed authoritative text
 * retrieval. Off mode intentionally dereferences neither the renderer nor store.
 */
export async function publishPdfVisualSidecar(
  input: PublishPdfVisualSidecarInput
): Promise<PdfVisualIngestSummary> {
  if (input.mode === 'off') {
    return {
      version: PDF_VISUAL_INGEST_VERSION,
      mode: input.mode,
      status: 'disabled',
      documentId: input.documentId,
      documentVersion: input.documentVersion,
      pageCount: input.parsed.pages,
      visualPageCount: 0,
    };
  }
  if (!input.store || !input.renderer) {
    throw new Error('PDF visual sidecar publication requires a store and renderer.');
  }
  if (!input.scope.allowedTrustLevels.includes(input.trustLevel)) {
    throw new Error('PDF visual ingest trust level is outside the retrieval scope.');
  }
  const maxRenderPages = resolveMaxRenderPages(input.maxRenderPages);
  input.signal?.throwIfAborted();
  const pageNumbers = Array.from(
    { length: Math.min(input.parsed.pages, maxRenderPages) },
    (_, index) => index + 1
  );
  const rendered = await input.renderer.render({
    source: input.source,
    pageCount: input.parsed.pages,
    pageNumbers,
    signal: input.signal,
  });
  input.signal?.throwIfAborted();

  const manifest = buildPdfAssetManifest({
    source: input.source,
    sourceName: input.sourceName,
    documentId: input.documentId,
    documentVersion: input.documentVersion,
    parsed: input.parsed,
    scope: input.scope,
    trustLevel: input.trustLevel,
    pageImages: rendered.pages.map(page => ({
      pageNumber: page.pageNumber,
      imageRef: createPageImageRef(page.pageNumber, page.mimeType),
      contentDigest: page.contentDigest,
      width: page.width,
      height: page.height,
      byteLength: page.byteLength,
      mimeType: page.mimeType as PdfAssetImageMimeType,
    })),
  });
  if (rendered.sourceHash !== manifest.sourceHash) {
    throw new Error('PDF renderer source identity does not match the asset manifest.');
  }

  await input.store.put({
    manifest,
    pageImages: rendered.pages.map(page => ({
      pageNumber: page.pageNumber,
      bytes: page.data,
    })),
  });
  input.signal?.throwIfAborted();
  return {
    version: PDF_VISUAL_INGEST_VERSION,
    mode: input.mode,
    status: 'published',
    manifestVersion: manifest.schemaVersion,
    documentId: manifest.documentId,
    documentVersion: manifest.documentVersion,
    pageCount: manifest.pageCount,
    visualPageCount: rendered.pages.length,
  };
}

function resolveMaxRenderPages(value = DEFAULT_PDF_VISUAL_MAX_RENDER_PAGES): number {
  if (
    !Number.isInteger(value)
    || value < 1
    || value > MAX_PDF_VISUAL_MAX_RENDER_PAGES
  ) {
    throw new Error(
      'PDF visual maxRenderPages must be an integer between 1 and '
      + MAX_PDF_VISUAL_MAX_RENDER_PAGES
      + '.'
    );
  }
  return value;
}

function createPageImageRef(
  pageNumber: number,
  mimeType: 'image/png' | 'image/jpeg'
): string {
  const extension = mimeType === 'image/png' ? 'png' : 'jpg';
  return 'pages/page-' + String(pageNumber).padStart(4, '0') + '.' + extension;
}

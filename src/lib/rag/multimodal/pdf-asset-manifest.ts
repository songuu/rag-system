import { createHash } from 'node:crypto';
import type { PdfParseOutput } from '../../pdf-parser';
import type {
  RagRetrievalScope,
  RagTrustLevel,
} from '../../security/retrieval-scope';

export const PDF_ASSET_MANIFEST_VERSION = 'pdf-asset-manifest-v1' as const;

export interface PdfAssetLimits {
  maxPages: number;
  maxPageWidth: number;
  maxPageHeight: number;
  maxPixelsPerPage: number;
  maxTotalPixels: number;
  maxImageBytes: number;
  maxTotalImageBytes: number;
  maxTextCharactersPerPage: number;
}

export const DEFAULT_PDF_ASSET_LIMITS: Readonly<PdfAssetLimits> = Object.freeze({
  maxPages: 100,
  maxPageWidth: 2_048,
  maxPageHeight: 2_048,
  maxPixelsPerPage: 4_194_304,
  maxTotalPixels: 41_943_040,
  maxImageBytes: 8 * 1024 * 1024,
  maxTotalImageBytes: 32 * 1024 * 1024,
  maxTextCharactersPerPage: 100_000,
});

export type PdfAssetImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface PdfPageImageAsset {
  pageNumber: number;
  imageRef: string;
  contentDigest: string;
  width: number;
  height: number;
  byteLength: number;
  mimeType: PdfAssetImageMimeType;
}

export interface PdfAssetManifestPage {
  pageNumber: number;
  textHash: string;
  textLength: number;
  startOffset: number;
  endOffset: number;
  imageRef?: string;
  contentDigest?: string;
  width?: number;
  height?: number;
  byteLength?: number;
  mimeType?: PdfAssetImageMimeType;
}

export interface PdfAssetManifest {
  schemaVersion: typeof PDF_ASSET_MANIFEST_VERSION;
  sourceHash: string;
  documentId: string;
  documentVersion: string;
  sourceName: string;
  parseMethod: PdfParseOutput['parseMethod'];
  tenantId: string;
  corpusId: string;
  trustLevel: RagTrustLevel;
  pageCount: number;
  pages: PdfAssetManifestPage[];
  createdAt: string;
}

export interface BuildPdfAssetManifestInput {
  source: Uint8Array;
  sourceName: string;
  documentId: string;
  documentVersion: string;
  parsed: PdfParseOutput;
  scope: RagRetrievalScope;
  trustLevel?: RagTrustLevel;
  pageImages?: readonly PdfPageImageAsset[];
  limits?: Partial<PdfAssetLimits>;
  now?: Date;
}

const SAFE_DOCUMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
export const PDF_PAGE_SEPARATOR = '\n\f\n';

export function buildPdfAssetManifest(
  input: BuildPdfAssetManifestInput
): PdfAssetManifest {
  const limits = resolvePdfAssetLimits(input.limits);
  const trustLevel = input.trustLevel ?? 'external';
  if (!input.scope.allowedTrustLevels.includes(trustLevel)) {
    throw new Error('PDF asset trust level is outside the retrieval scope.');
  }
  const documentId = assertSafeDocumentIdentifier(input.documentId, 'documentId');
  const documentVersion = assertSafeDocumentIdentifier(
    input.documentVersion,
    'documentVersion'
  );
  const sourceName = assertSourceName(input.sourceName);
  if (!Number.isInteger(input.parsed.pages) || input.parsed.pages < 1) {
    throw new Error('PDF asset manifest requires at least one parsed page.');
  }
  if (input.parsed.pages > limits.maxPages) {
    throw new Error('PDF asset page count exceeds the configured limit.');
  }

  const pageTexts = resolvePageTexts(input.parsed);
  const imagesByPage = validatePageImages(
    input.pageImages ?? [],
    input.parsed.pages,
    limits
  );
  let offset = 0;
  const pages = pageTexts.map((pageText, index): PdfAssetManifestPage => {
    const normalizedText = normalizePageText(pageText);
    if (normalizedText.length > limits.maxTextCharactersPerPage) {
      throw new Error('PDF page text exceeds the configured character limit.');
    }
    const pageNumber = index + 1;
    const image = imagesByPage.get(pageNumber);
    const page: PdfAssetManifestPage = {
      pageNumber,
      textHash: sha256Hex(normalizedText),
      textLength: normalizedText.length,
      startOffset: offset,
      endOffset: offset + normalizedText.length,
      ...(image
        ? {
            imageRef: image.imageRef,
            contentDigest: image.contentDigest,
            width: image.width,
            height: image.height,
            byteLength: image.byteLength,
            mimeType: image.mimeType,
          }
        : {}),
    };
    offset = page.endOffset + (index < pageTexts.length - 1 ? PDF_PAGE_SEPARATOR.length : 0);
    return page;
  });

  return {
    schemaVersion: PDF_ASSET_MANIFEST_VERSION,
    sourceHash: sha256Hex(input.source),
    documentId,
    documentVersion,
    sourceName,
    parseMethod: input.parsed.parseMethod,
    tenantId: input.scope.tenantId,
    corpusId: input.scope.corpusId,
    trustLevel,
    pageCount: pages.length,
    pages,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}
export function createCanonicalPdfDocumentText(parsed: PdfParseOutput): string {
  return resolvePageTexts(parsed)
    .map(normalizePageText)
    .join(PDF_PAGE_SEPARATOR);
}

export function assertPdfAssetManifestScope(
  manifest: PdfAssetManifest,
  scope: RagRetrievalScope
): void {
  assertPdfAssetManifestIntegrity(manifest);
  if (manifest.tenantId !== scope.tenantId) {
    throw new Error('PDF asset manifest tenant scope mismatch.');
  }
  if (manifest.corpusId !== scope.corpusId) {
    throw new Error('PDF asset manifest corpus scope mismatch.');
  }
  if (!scope.allowedTrustLevels.includes(manifest.trustLevel)) {
    throw new Error('PDF asset manifest trust scope mismatch.');
  }
}

/** Revalidate manifests after serialization/storage boundaries. */
export function assertPdfAssetManifestIntegrity(manifest: PdfAssetManifest): void {
  const limits = resolvePdfAssetLimits();
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('PDF asset manifest must be an object.');
  }
  if (manifest.schemaVersion !== PDF_ASSET_MANIFEST_VERSION) {
    throw new Error('Unsupported PDF asset manifest schema.');
  }
  assertSha256Hex(manifest.sourceHash, 'sourceHash');
  if (typeof manifest.documentId !== 'string') {
    throw new Error('PDF asset manifest documentId must be a string.');
  }
  if (typeof manifest.documentVersion !== 'string') {
    throw new Error('PDF asset manifest documentVersion must be a string.');
  }
  if (typeof manifest.sourceName !== 'string') {
    throw new Error('PDF asset manifest sourceName must be a string.');
  }
  assertSafeDocumentIdentifier(manifest.documentId, 'documentId');
  assertSafeDocumentIdentifier(manifest.documentVersion, 'documentVersion');
  assertSourceName(manifest.sourceName);
  if (!['pdf-parse-v2', 'liteparse-v2'].includes(manifest.parseMethod)) {
    throw new Error('PDF asset manifest parse method is unsupported.');
  }
  if (typeof manifest.tenantId !== 'string' || !SAFE_DOCUMENT_ID.test(manifest.tenantId)) {
    throw new Error('PDF asset manifest tenantId must be a safe identifier.');
  }
  if (typeof manifest.corpusId !== 'string' || !SAFE_DOCUMENT_ID.test(manifest.corpusId)) {
    throw new Error('PDF asset manifest corpusId must be a safe identifier.');
  }
  if (!['trusted', 'reviewed', 'external', 'quarantined'].includes(manifest.trustLevel)) {
    throw new Error('PDF asset manifest trust level is invalid.');
  }
  if (!Number.isInteger(manifest.pageCount) || manifest.pageCount < 1 || manifest.pageCount > limits.maxPages) {
    throw new Error('PDF asset manifest page count exceeds the configured limit.');
  }
  if (!Array.isArray(manifest.pages) || manifest.pages.length !== manifest.pageCount) {
    throw new Error('PDF asset manifest page count does not match its page records.');
  }

  const images: PdfPageImageAsset[] = [];
  let expectedStartOffset = 0;
  manifest.pages.forEach((page, index) => {
    if (!page || typeof page !== 'object' || page.pageNumber !== index + 1) {
      throw new Error('PDF asset manifest pages must be sequential and unique.');
    }
    assertSha256Hex(page.textHash, 'page textHash');
    if (!Number.isInteger(page.textLength) || page.textLength < 0 || page.textLength > limits.maxTextCharactersPerPage) {
      throw new Error('PDF asset manifest page text length is outside the configured limit.');
    }
    if (!Number.isInteger(page.startOffset) || !Number.isInteger(page.endOffset)
      || page.startOffset !== expectedStartOffset
      || page.endOffset !== page.startOffset + page.textLength) {
      throw new Error('PDF asset manifest page offsets are inconsistent.');
    }
    expectedStartOffset = page.endOffset
      + (index < manifest.pages.length - 1 ? PDF_PAGE_SEPARATOR.length : 0);
    const imageFields = [
      page.imageRef,
      page.contentDigest,
      page.width,
      page.height,
      page.byteLength,
      page.mimeType,
    ];
    const presentImageFields = imageFields.filter(value => value !== undefined).length;
    if (presentImageFields !== 0 && presentImageFields !== imageFields.length) {
      throw new Error('PDF asset manifest page image fields must be complete.');
    }
    if (presentImageFields === imageFields.length) {
      images.push({
        pageNumber: page.pageNumber,
        imageRef: page.imageRef as string,
        contentDigest: page.contentDigest as string,
        width: page.width as number,
        height: page.height as number,
        byteLength: page.byteLength as number,
        mimeType: page.mimeType as PdfAssetImageMimeType,
      });
    }
  });
  validatePageImages(images, manifest.pageCount, limits);
  if (typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error('PDF asset manifest createdAt must be a valid timestamp.');
  }
}

export function isSafePdfAssetImageRef(value: string): boolean {
  const normalized = value.trim();
  return Boolean(
    normalized
      && normalized.length <= 512
      && !normalized.startsWith('/')
      && !normalized.includes('\\')
      && !normalized.split('/').includes('..')
      && !/^[a-z][a-z0-9+.-]*:/i.test(normalized)
      && !/[\u0000-\u001f]/.test(normalized)
      && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(normalized)
  );
}

function resolvePdfAssetLimits(overrides?: Partial<PdfAssetLimits>): PdfAssetLimits {
  const limits = { ...DEFAULT_PDF_ASSET_LIMITS, ...(overrides ?? {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`PDF asset limit ${name} must be a positive integer.`);
    }
    const hardLimit = DEFAULT_PDF_ASSET_LIMITS[name as keyof PdfAssetLimits];
    if (value > hardLimit) {
      throw new Error(`PDF asset limit ${name} cannot exceed the hard limit.`);
    }
  }
  return limits;
}

function assertSha256Hex(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`PDF asset manifest ${field} must be a SHA-256 hex digest.`);
  }
}

function resolvePageTexts(parsed: PdfParseOutput): string[] {
  if (parsed.pageTexts?.length === parsed.pages) {
    return [...parsed.pageTexts];
  }
  if (parsed.pages === 1) {
    return [parsed.text];
  }
  throw new Error('PDF parser must provide page-wise text for a multi-page asset manifest.');
}

function validatePageImages(
  images: readonly PdfPageImageAsset[],
  pageCount: number,
  limits: PdfAssetLimits
): Map<number, PdfPageImageAsset> {
  const byPage = new Map<number, PdfPageImageAsset>();
  let totalPixels = 0;
  let totalBytes = 0;
  for (const image of images) {
    if (!Number.isInteger(image.pageNumber) || image.pageNumber < 1 || image.pageNumber > pageCount) {
      throw new Error('PDF image asset references an invalid page number.');
    }
    if (byPage.has(image.pageNumber)) {
      throw new Error('PDF image asset contains a duplicate page number.');
    }
    if (!isSafePdfAssetImageRef(image.imageRef)) {
      throw new Error('PDF image asset reference must be a safe storage key.');
    }
    assertSha256Hex(image.contentDigest, 'image contentDigest');
    assertBoundedPositiveInteger(image.width, limits.maxPageWidth, 'width');
    assertBoundedPositiveInteger(image.height, limits.maxPageHeight, 'height');
    assertBoundedPositiveInteger(image.byteLength, limits.maxImageBytes, 'byteLength');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)) {
      throw new Error('PDF image asset has an unsupported MIME type.');
    }
    const pixels = image.width * image.height;
    if (!Number.isSafeInteger(pixels) || pixels > limits.maxPixelsPerPage) {
      throw new Error('PDF image asset exceeds the per-page pixel limit.');
    }
    totalPixels += pixels;
    totalBytes += image.byteLength;
    if (totalPixels > limits.maxTotalPixels) {
      throw new Error('PDF image assets exceed the total pixel limit.');
    }
    if (totalBytes > limits.maxTotalImageBytes) {
      throw new Error('PDF image assets exceed the total byte limit.');
    }
    byPage.set(image.pageNumber, {
      ...image,
      imageRef: image.imageRef.trim(),
      contentDigest: image.contentDigest,
    });
  }
  return byPage;
}

function assertBoundedPositiveInteger(value: number, maximum: number, field: string): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`PDF image asset ${field} is outside the configured limit.`);
  }
}

function assertSafeDocumentIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!SAFE_DOCUMENT_ID.test(normalized)) {
    throw new Error(`${field} must be a safe identifier of at most 256 characters.`);
  }
  return normalized;
}

function assertSourceName(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f]/.test(normalized)) {
    throw new Error('sourceName must be a non-empty name without control characters.');
  }
  return normalized;
}

function normalizePageText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

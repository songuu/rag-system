import { createHash } from 'node:crypto';
import {
  DEFAULT_PDF_ASSET_LIMITS,
  type PdfAssetLimits,
} from './pdf-asset-manifest';

export const PDF_PAGE_IMAGE_RENDERER_VERSION = 'pdf-page-image-renderer-v1' as const;
export const DEFAULT_PDF_PAGE_IMAGE_DESIRED_WIDTH = 1_280;
export const MAX_PDF_PAGE_IMAGE_DESIRED_WIDTH = 2_048;
export const DEFAULT_PDF_PAGE_IMAGE_MAX_CONCURRENT_RENDERS = 4;
export const MAX_PDF_PAGE_IMAGE_MAX_CONCURRENT_RENDERS = 64;
export const DEFAULT_PDF_PAGE_IMAGE_MAX_IN_FLIGHT_SOURCE_BYTES = 256 * 1024 * 1024;
export const MAX_PDF_PAGE_IMAGE_MAX_IN_FLIGHT_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;

let activePdfPageRenderCount = 0;
let activePdfPageRenderSourceBytes = 0;

export type RenderedPdfPageImageMimeType = 'image/png' | 'image/jpeg';

export type PdfPageImageRendererLimits = Pick<
  PdfAssetLimits,
  | 'maxPages'
  | 'maxPageWidth'
  | 'maxPageHeight'
  | 'maxPixelsPerPage'
  | 'maxTotalPixels'
  | 'maxImageBytes'
  | 'maxTotalImageBytes'
>;

export interface PdfPageScreenshotParameters {
  partial: [number];
  desiredWidth: number;
  imageBuffer: true;
  imageDataUrl: false;
  signal?: AbortSignal;
}

export interface PdfPageScreenshot {
  data: Uint8Array;
  pageNumber: number;
  width: number;
  height: number;
  mimeType?: string;
}

export interface PdfPageScreenshotResult {
  total: number;
  pages: readonly PdfPageScreenshot[];
}

/** A document-scoped renderer. Implementations must release native resources in destroy(). */
export interface PdfPageScreenshotRenderer {
  getScreenshot(
    parameters: PdfPageScreenshotParameters
  ): Promise<PdfPageScreenshotResult>;
  destroy(): Promise<void> | void;
}

export type PdfPageScreenshotRendererFactory = (
  source: Uint8Array
) => Promise<PdfPageScreenshotRenderer> | PdfPageScreenshotRenderer;

export interface PdfPageImageRendererOptions {
  desiredWidth?: number;
  limits?: Partial<PdfPageImageRendererLimits>;
  rendererFactory?: PdfPageScreenshotRendererFactory;
  clock?: () => Date;
  /** Process-wide admission ceiling observed by this renderer instance. */
  maxConcurrentRenders?: number;
  /** Process-wide source-byte ceiling observed by this renderer instance. */
  maxInFlightSourceBytes?: number;
}

export class PdfPageImageRendererCapacityError extends Error {
  readonly code = 'PDF_PAGE_RENDER_CAPACITY';

  constructor(message: string) {
    super(message);
    this.name = 'PdfPageImageRendererCapacityError';
  }
}

export interface RenderPdfPageImagesInput {
  source: Uint8Array;
  pageCount: number;
  /** Defaults to all pages. Selected pages are always rendered in document order. */
  pageNumbers?: readonly number[];
  signal?: AbortSignal;
}

export interface RenderedPdfPageImage {
  pageNumber: number;
  data: Uint8Array;
  contentDigest: string;
  width: number;
  height: number;
  byteLength: number;
  mimeType: RenderedPdfPageImageMimeType;
}

export interface RenderPdfPageImagesResult {
  rendererVersion: typeof PDF_PAGE_IMAGE_RENDERER_VERSION;
  sourceHash: string;
  totalPages: number;
  renderedAt: string;
  pages: RenderedPdfPageImage[];
}

/**
 * Renders bounded PDF page images one page at a time. This prevents pdf-parse
 * from materializing every page before the caller can enforce aggregate limits.
 */
export class PdfPageImageRenderer {
  private readonly desiredWidth: number;
  private readonly limits: PdfPageImageRendererLimits;
  private readonly rendererFactory: PdfPageScreenshotRendererFactory;
  private readonly clock: () => Date;
  private readonly maxConcurrentRenders: number;
  private readonly maxInFlightSourceBytes: number;

  constructor(options: PdfPageImageRendererOptions = {}) {
    this.limits = resolveRendererLimits(options.limits);
    this.desiredWidth = options.desiredWidth
      ?? Math.min(DEFAULT_PDF_PAGE_IMAGE_DESIRED_WIDTH, this.limits.maxPageWidth);
    const maximumWidth = Math.min(
      MAX_PDF_PAGE_IMAGE_DESIRED_WIDTH,
      this.limits.maxPageWidth
    );
    if (
      !Number.isInteger(this.desiredWidth)
      || this.desiredWidth < 1
      || this.desiredWidth > maximumWidth
    ) {
      throw new Error(
        `PDF desiredWidth must be an integer between 1 and ${maximumWidth}.`
      );
    }
    this.rendererFactory = options.rendererFactory
      ?? createPdfParsePageScreenshotRenderer;
    this.clock = options.clock ?? (() => new Date());
    this.maxConcurrentRenders = readRendererAdmissionLimit(
      options.maxConcurrentRenders,
      DEFAULT_PDF_PAGE_IMAGE_MAX_CONCURRENT_RENDERS,
      MAX_PDF_PAGE_IMAGE_MAX_CONCURRENT_RENDERS,
      'maxConcurrentRenders'
    );
    this.maxInFlightSourceBytes = readRendererAdmissionLimit(
      options.maxInFlightSourceBytes,
      DEFAULT_PDF_PAGE_IMAGE_MAX_IN_FLIGHT_SOURCE_BYTES,
      MAX_PDF_PAGE_IMAGE_MAX_IN_FLIGHT_SOURCE_BYTES,
      'maxInFlightSourceBytes'
    );
  }

  async render(
    input: RenderPdfPageImagesInput
  ): Promise<RenderPdfPageImagesResult> {
    assertPdfSource(input.source);
    const pageNumbers = resolvePageNumbers(
      input.pageCount,
      input.pageNumbers,
      this.limits.maxPages
    );
    throwIfRenderingAborted(input.signal);
    const renderedAt = resolveTimestamp(this.clock());
    const releaseAdmission = acquireRendererAdmission(
      input.source.byteLength,
      this.maxConcurrentRenders,
      this.maxInFlightSourceBytes
    );
    const settlement = new RendererWorkSettlement();

    try {
      // Snapshot caller-owned bytes only after process-wide byte admission.
      const source = new Uint8Array(input.source);
      let renderer: PdfPageScreenshotRenderer | undefined;
      let primaryFailure: unknown;
      const factoryWork = settlement.track(
        Promise.resolve().then(() => this.rendererFactory(source))
      );
      try {
        renderer = await runWithAbort(factoryWork, input.signal);
      } catch (error) {
        if (input.signal?.aborted || isAbortError(error)) {
          // A factory may ignore AbortSignal and resolve later. Keep admission
          // until it settles and destroy the late-created native session.
          const lateCleanup = factoryWork.then(
            lateRenderer => Promise.resolve(lateRenderer.destroy()),
            () => undefined
          );
          void settlement.track(lateCleanup).catch(() => undefined);
          throw createRenderingAbortError();
        }
        throw new Error(
          'PDF page renderer initialization failed: ' + getErrorMessage(error),
          { cause: error }
        );
      }

      try {
        const pages: RenderedPdfPageImage[] = [];
        let totalBytes = 0;
        let totalPixels = 0;

        for (const pageNumber of pageNumbers) {
          throwIfRenderingAborted(input.signal);
          let screenshotResult: PdfPageScreenshotResult;
          try {
            const nativeWork = settlement.track(
              Promise.resolve().then(() => renderer!.getScreenshot({
                partial: [pageNumber],
                desiredWidth: this.desiredWidth,
                imageBuffer: true,
                imageDataUrl: false,
                signal: input.signal,
              }))
            );
            screenshotResult = await runWithAbort(nativeWork, input.signal);
          } catch (error) {
            if (input.signal?.aborted || isAbortError(error)) {
              throw createRenderingAbortError();
            }
            throw new Error(
              'PDF page ' + pageNumber + ' rendering failed: ' + getErrorMessage(error),
              { cause: error }
            );
          }
          throwIfRenderingAborted(input.signal);
          const page = validateSinglePageResult(
            screenshotResult,
            pageNumber,
            input.pageCount,
            this.limits
          );
          totalBytes += page.byteLength;
          totalPixels += page.width * page.height;
          if (totalBytes > this.limits.maxTotalImageBytes) {
            throw new Error('Rendered PDF pages exceed the total byte limit.');
          }
          if (totalPixels > this.limits.maxTotalPixels) {
            throw new Error('Rendered PDF pages exceed the total pixel limit.');
          }
          pages.push(page);
        }

        return {
          rendererVersion: PDF_PAGE_IMAGE_RENDERER_VERSION,
          sourceHash: sha256Hex(source),
          totalPages: input.pageCount,
          renderedAt,
          pages,
        };
      } catch (error) {
        primaryFailure = error;
        throw error;
      } finally {
        if (renderer) {
          try {
            await settlement.track(Promise.resolve().then(() => renderer!.destroy()));
          } catch (error) {
            if (primaryFailure === undefined) {
              throw new Error(
                'PDF page renderer cleanup failed: ' + getErrorMessage(error),
                { cause: error }
              );
            }
          }
        }
      }
    } finally {
      // Public abort may return before a non-cooperative native promise settles,
      // but process admission stays reserved until every tracked work item does.
      settlement.seal();
      void settlement.whenIdle().then(releaseAdmission);
    }
  }
}

export async function renderPdfPageImages(
  input: RenderPdfPageImagesInput,
  options: PdfPageImageRendererOptions = {}
): Promise<RenderPdfPageImagesResult> {
  return new PdfPageImageRenderer(options).render(input);
}

export async function createPdfParsePageScreenshotRenderer(
  source: Uint8Array
): Promise<PdfPageScreenshotRenderer> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: source });
  return {
    async getScreenshot(parameters) {
      // pdf-parse does not currently accept AbortSignal. The bounded caller
      // races this operation with the signal and destroys this session on exit.
      const result = await parser.getScreenshot({
        partial: parameters.partial,
        desiredWidth: parameters.desiredWidth,
        imageBuffer: parameters.imageBuffer,
        imageDataUrl: parameters.imageDataUrl,
      });
      return result;
    },
    async destroy() {
      await parser.destroy();
    },
  };
}

class RendererWorkSettlement {
  private pending = 0;
  private sealed = false;
  private readonly idleResolvers: Array<() => void> = [];

  track<T>(operation: Promise<T>): Promise<T> {
    if (this.sealed) {
      throw new Error('PDF renderer work cannot be registered after settlement.');
    }
    this.pending += 1;
    void operation.then(
      () => this.finishOne(),
      () => this.finishOne()
    );
    return operation;
  }

  seal(): void {
    this.sealed = true;
    this.flushIfIdle();
  }

  whenIdle(): Promise<void> {
    if (this.sealed && this.pending === 0) return Promise.resolve();
    return new Promise(resolve => this.idleResolvers.push(resolve));
  }

  private finishOne(): void {
    this.pending -= 1;
    this.flushIfIdle();
  }

  private flushIfIdle(): void {
    if (!this.sealed || this.pending !== 0) return;
    for (const resolve of this.idleResolvers.splice(0)) resolve();
  }
}

function acquireRendererAdmission(
  sourceBytes: number,
  maxConcurrentRenders: number,
  maxInFlightSourceBytes: number
): () => void {
  if (activePdfPageRenderCount + 1 > maxConcurrentRenders) {
    throw new PdfPageImageRendererCapacityError(
      'PDF page renderer process concurrency capacity is exhausted.'
    );
  }
  if (activePdfPageRenderSourceBytes + sourceBytes > maxInFlightSourceBytes) {
    throw new PdfPageImageRendererCapacityError(
      'PDF page renderer in-flight source byte capacity is exhausted.'
    );
  }
  activePdfPageRenderCount += 1;
  activePdfPageRenderSourceBytes += sourceBytes;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activePdfPageRenderCount -= 1;
    activePdfPageRenderSourceBytes -= sourceBytes;
  };
}

function readRendererAdmissionLimit(
  value: number | undefined,
  fallback: number,
  hardMaximum: number,
  field: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > hardMaximum) {
    throw new Error(
      'PDF page renderer ' + field + ' must be an integer between 1 and '
      + hardMaximum + '.'
    );
  }
  return resolved;
}

function resolveRendererLimits(
  overrides?: Partial<PdfPageImageRendererLimits>
): PdfPageImageRendererLimits {
  const limits: PdfPageImageRendererLimits = {
    maxPages: overrides?.maxPages ?? DEFAULT_PDF_ASSET_LIMITS.maxPages,
    maxPageWidth: overrides?.maxPageWidth ?? DEFAULT_PDF_ASSET_LIMITS.maxPageWidth,
    maxPageHeight: overrides?.maxPageHeight ?? DEFAULT_PDF_ASSET_LIMITS.maxPageHeight,
    maxPixelsPerPage: overrides?.maxPixelsPerPage
      ?? DEFAULT_PDF_ASSET_LIMITS.maxPixelsPerPage,
    maxTotalPixels: overrides?.maxTotalPixels
      ?? DEFAULT_PDF_ASSET_LIMITS.maxTotalPixels,
    maxImageBytes: overrides?.maxImageBytes ?? DEFAULT_PDF_ASSET_LIMITS.maxImageBytes,
    maxTotalImageBytes: overrides?.maxTotalImageBytes
      ?? DEFAULT_PDF_ASSET_LIMITS.maxTotalImageBytes,
  };
  for (const [name, value] of Object.entries(limits)) {
    const hardLimit = DEFAULT_PDF_ASSET_LIMITS[name as keyof PdfPageImageRendererLimits];
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`PDF page renderer limit ${name} must be a positive integer.`);
    }
    if (value > hardLimit) {
      throw new Error(`PDF page renderer limit ${name} cannot exceed the hard limit.`);
    }
  }
  return limits;
}

function resolvePageNumbers(
  pageCount: number,
  requestedPageNumbers: readonly number[] | undefined,
  maxPages: number
): number[] {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > maxPages) {
    throw new Error('PDF page count is outside the configured rendering limit.');
  }
  if (requestedPageNumbers === undefined) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }
  if (requestedPageNumbers.length < 1 || requestedPageNumbers.length > maxPages) {
    throw new Error('PDF rendered page selection is outside the configured limit.');
  }
  const seen = new Set<number>();
  const pageNumbers = requestedPageNumbers.map(pageNumber => {
    if (
      !Number.isInteger(pageNumber)
      || pageNumber < 1
      || pageNumber > pageCount
      || seen.has(pageNumber)
    ) {
      throw new Error('PDF rendered page selection must contain unique valid pages.');
    }
    seen.add(pageNumber);
    return pageNumber;
  });
  return pageNumbers.sort((left, right) => left - right);
}

function validateSinglePageResult(
  result: PdfPageScreenshotResult,
  expectedPageNumber: number,
  expectedTotalPages: number,
  limits: PdfPageImageRendererLimits
): RenderedPdfPageImage {
  if (
    !result
    || !Number.isInteger(result.total)
    || result.total !== expectedTotalPages
    || !Array.isArray(result.pages)
    || result.pages.length !== 1
  ) {
    throw new Error('PDF renderer must return exactly the requested page and total count.');
  }
  const screenshot = result.pages[0];
  if (!screenshot || screenshot.pageNumber !== expectedPageNumber) {
    throw new Error('PDF renderer returned a mismatched page number.');
  }
  if (!(screenshot.data instanceof Uint8Array) || screenshot.data.byteLength < 1) {
    throw new Error('PDF renderer returned an empty or invalid image buffer.');
  }
  const data = new Uint8Array(screenshot.data);
  const inspected = inspectRenderedImage(data);
  if (screenshot.mimeType !== undefined) {
    const claimedMimeType = screenshot.mimeType.trim().toLowerCase();
    if (!['image/png', 'image/jpeg'].includes(claimedMimeType)) {
      throw new Error('PDF renderer returned an unsupported image MIME type.');
    }
    if (claimedMimeType !== inspected.mimeType) {
      throw new Error('PDF renderer image MIME type does not match its magic bytes.');
    }
  }
  assertReportedDimension(screenshot.width, inspected.width, 'width');
  assertReportedDimension(screenshot.height, inspected.height, 'height');
  if (inspected.width > limits.maxPageWidth || inspected.height > limits.maxPageHeight) {
    throw new Error('Rendered PDF page dimensions exceed the configured limit.');
  }
  const pixels = inspected.width * inspected.height;
  if (!Number.isSafeInteger(pixels) || pixels > limits.maxPixelsPerPage) {
    throw new Error('Rendered PDF page exceeds the per-page pixel limit.');
  }
  if (data.byteLength > limits.maxImageBytes) {
    throw new Error('Rendered PDF page exceeds the per-page byte limit.');
  }
  return {
    pageNumber: expectedPageNumber,
    data,
    contentDigest: sha256Hex(data),
    width: inspected.width,
    height: inspected.height,
    byteLength: data.byteLength,
    mimeType: inspected.mimeType,
  };
}

function inspectRenderedImage(data: Uint8Array): {
  mimeType: RenderedPdfPageImageMimeType;
  width: number;
  height: number;
} {
  if (hasBytes(data, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    if (
      data.byteLength < 24
      || !hasBytes(data, 12, [0x49, 0x48, 0x44, 0x52])
    ) {
      throw new Error('Rendered PDF PNG is missing a valid IHDR header.');
    }
    const width = readUint32BigEndian(data, 16);
    const height = readUint32BigEndian(data, 20);
    assertEncodedDimensions(width, height);
    return { mimeType: 'image/png', width, height };
  }
  if (hasBytes(data, 0, [0xff, 0xd8, 0xff])) {
    if (!hasBytes(data, data.byteLength - 2, [0xff, 0xd9])) {
      throw new Error('Rendered PDF JPEG is missing its end marker.');
    }
    const dimensions = readJpegDimensions(data);
    return { mimeType: 'image/jpeg', ...dimensions };
  }
  throw new Error('Rendered PDF page must contain PNG or JPEG magic bytes.');
}

function readJpegDimensions(data: Uint8Array): { width: number; height: number } {
  let offset = 2;
  while (offset < data.byteLength) {
    while (offset < data.byteLength && data[offset] === 0xff) offset += 1;
    if (offset >= data.byteLength) break;
    const marker = data[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > data.byteLength) break;
    const segmentLength = readUint16BigEndian(data, offset);
    if (segmentLength < 2 || offset + segmentLength > data.byteLength) break;
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 7) break;
      const height = readUint16BigEndian(data, offset + 3);
      const width = readUint16BigEndian(data, offset + 5);
      assertEncodedDimensions(width, height);
      return { width, height };
    }
    offset += segmentLength;
  }
  throw new Error('Rendered PDF JPEG is missing a valid frame header.');
}

function isJpegStartOfFrame(marker: number): boolean {
  return [
    0xc0, 0xc1, 0xc2, 0xc3,
    0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb,
    0xcd, 0xce, 0xcf,
  ].includes(marker);
}

function assertEncodedDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width < 1
    || height < 1
  ) {
    throw new Error('Rendered PDF image contains invalid encoded dimensions.');
  }
}

function assertReportedDimension(
  reported: number,
  encoded: number,
  field: string
): void {
  // pdf-parse reports viewport floats while the encoded canvas uses integer
  // dimensions, so a sub-pixel rounding difference is legitimate.
  if (!Number.isFinite(reported) || reported <= 0 || Math.abs(reported - encoded) > 1) {
    throw new Error(`PDF renderer reported ${field} does not match encoded image bytes.`);
  }
}

function assertPdfSource(source: Uint8Array): void {
  if (!(source instanceof Uint8Array) || source.byteLength < 1) {
    throw new Error('PDF page renderer requires a non-empty byte source.');
  }
}

function resolveTimestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('PDF page renderer clock must return a valid Date.');
  }
  return value.toISOString();
}

async function runWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  throwIfRenderingAborted(signal);
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(createRenderingAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function throwIfRenderingAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createRenderingAbortError();
}

function createRenderingAbortError(): Error {
  const error = new Error('PDF page rendering was aborted.');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasBytes(data: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (offset < 0 || offset + expected.length > data.byteLength) return false;
  return expected.every((value, index) => data[offset + index] === value);
}

function readUint16BigEndian(data: Uint8Array, offset: number): number {
  return data[offset] * 0x100 + data[offset + 1];
}

function readUint32BigEndian(data: Uint8Array, offset: number): number {
  return (
    data[offset] * 0x1000000
    + data[offset + 1] * 0x10000
    + data[offset + 2] * 0x100
    + data[offset + 3]
  );
}

function sha256Hex(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

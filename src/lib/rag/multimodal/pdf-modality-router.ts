import type { RagEvidence, RagStopReason } from '../core/types';
import type { RagRetrievalScope, RagTrustLevel } from '../../security/retrieval-scope';
import {
  assertPdfAssetManifestScope,
  sha256Hex,
  type PdfAssetManifest,
  type PdfAssetManifestPage,
} from './pdf-asset-manifest';

export const PDF_MODALITY_ROUTER_VERSION = 'pdf-modality-router-v1' as const;
export const DEFAULT_PDF_VISUAL_ANALYZER_TIMEOUT_MS = 30_000;
export const MAX_PDF_VISUAL_ANALYZER_TIMEOUT_MS = 120_000;
export const DEFAULT_PDF_VISUAL_ANALYZER_CONCURRENCY = 1;
export const MAX_PDF_VISUAL_ANALYZER_CONCURRENCY = 8;

interface VisualAnalyzerAdmissionState {
  reservations: Set<symbol>;
  maxConcurrentAnalyses: number;
}

const activeVisualAnalyzerReservations = new Map<string, VisualAnalyzerAdmissionState>();

export type PdfMultimodalMode = 'off' | 'shadow' | 'active';
export type PdfModalityRoute = 'text' | 'visual-page';

export interface PdfVisualCapability {
  available: boolean;
  analyzerId?: string;
}

export interface PdfModalityDecision {
  version: typeof PDF_MODALITY_ROUTER_VERSION;
  route: PdfModalityRoute;
  requestedVisual: boolean;
  reason:
    | 'feature_off'
    | 'text_intent'
    | 'no_visual_assets'
    | 'visual_asset_quarantined'
    | 'visual_capability_unavailable'
    | 'shadow_visual_candidate'
    | 'requested_page_asset_unavailable'
    | 'visual_intent';
  selectedPageNumbers: number[];
  missingPageNumbers: number[];
  fallbackRoute?: 'text';
  shadowRoute?: 'visual-page';
  analyzerId?: string;
}

export interface RoutePdfModalityInput {
  query: string;
  manifest: PdfAssetManifest;
  scope: RagRetrievalScope;
  mode: PdfMultimodalMode;
  capability?: PdfVisualCapability;
  maxVisualPages?: number;
}

const VISUAL_INTENT_ZH = /(?:图表|表格|图像|图片|插图|截图|流程图|示意图|架构图|曲线图|柱状图|饼图|视觉)/;
const VISUAL_INTENT_EN = /\b(?:chart|table|figure|diagram|image|illustration|screenshot|visual)\b/i;
const PAGE_REFERENCE = /(?:第\s*(\d{1,5})\s*页|page\s*#?\s*(\d{1,5}))/gi;

export function resolvePdfMultimodalMode(
  env: Record<string, string | undefined> = process.env
): PdfMultimodalMode {
  const value = env.RAG_PDF_VISUAL_MODE?.trim().toLowerCase() || 'off';
  if (value === 'off' || value === 'shadow' || value === 'active') return value;
  throw new Error('Unsupported RAG_PDF_VISUAL_MODE: ' + value);
}

export function isPdfVisualIntent(query: string): boolean {
  return VISUAL_INTENT_ZH.test(query) || VISUAL_INTENT_EN.test(query);
}

export function routePdfModality(input: RoutePdfModalityInput): PdfModalityDecision {
  assertPdfAssetManifestScope(input.manifest, input.scope);
  if (!['off', 'shadow', 'active'].includes(input.mode)) {
    throw new Error('Unsupported PDF multimodal mode.');
  }
  const requestedVisual = isPdfVisualIntent(input.query);
  const capability = input.capability ?? { available: false };
  const maxVisualPages = input.maxVisualPages ?? 4;
  if (!Number.isInteger(maxVisualPages) || maxVisualPages < 1 || maxVisualPages > 20) {
    throw new Error('maxVisualPages must be an integer between 1 and 20.');
  }
  if (input.mode === 'off') {
    return textDecision(requestedVisual, 'feature_off');
  }
  if (!requestedVisual) {
    return textDecision(false, 'text_intent');
  }
  if (input.manifest.trustLevel === 'quarantined') {
    return textDecision(true, 'visual_asset_quarantined', {
      fallbackRoute: 'text',
    });
  }

  const visualPages = input.manifest.pages.filter(hasImageAsset);
  if (visualPages.length === 0) {
    return textDecision(true, 'no_visual_assets', { fallbackRoute: 'text' });
  }
  const requestedPages = extractRequestedPageNumbers(input.query);
  const availablePageNumbers = new Set(visualPages.map(page => page.pageNumber));
  const missingPageNumbers = requestedPages.filter(page => !availablePageNumbers.has(page));
  const selectedPageNumbers = (requestedPages.length > 0
    ? requestedPages.filter(page => availablePageNumbers.has(page))
    : visualPages.map(page => page.pageNumber)
  ).slice(0, maxVisualPages);

  if (selectedPageNumbers.length === 0) {
    return {
      ...textDecision(true, 'requested_page_asset_unavailable', {
        fallbackRoute: 'text',
      }),
      missingPageNumbers,
    };
  }
  if (input.mode === 'shadow') {
    return {
      ...textDecision(true, 'shadow_visual_candidate', {
        shadowRoute: 'visual-page',
      }),
      selectedPageNumbers,
      missingPageNumbers,
      analyzerId: capability.analyzerId,
    };
  }
  if (!capability.available) {
    return {
      ...textDecision(true, 'visual_capability_unavailable', {
        fallbackRoute: 'text',
      }),
      missingPageNumbers,
    };
  }
  return {
    version: PDF_MODALITY_ROUTER_VERSION,
    route: 'visual-page',
    requestedVisual: true,
    reason: 'visual_intent',
    selectedPageNumbers,
    missingPageNumbers,
    fallbackRoute: 'text',
    analyzerId: capability.analyzerId,
  };
}

export interface PdfVisualPageRequest {
  tenantId: string;
  corpusId: string;
  sourceHash: string;
  documentId: string;
  documentVersion: string;
  trustLevel: RagTrustLevel;
  query: string;
  pages: Array<{
    pageNumber: number;
    imageRef: string;
    /** The analyzer must verify fetched bytes against this digest before model input. */
    expectedContentDigest: string;
    width: number;
    height: number;
    byteLength: number;
    mimeType: string;
  }>;
  signal?: AbortSignal;
}

export interface PdfVisualPageAnalysis {
  pageNumber: number;
  content: string;
  confidence?: number;
}

export interface PdfVisualAnalyzer {
  readonly id: string;
  analyze(request: PdfVisualPageRequest): Promise<readonly PdfVisualPageAnalysis[]>;
}

/** Integrity/scope failures must not be downgraded by the optional visual lane. */
export class PdfVisualAnalyzerIntegrityError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PdfVisualAnalyzerIntegrityError';
  }
}

export interface PdfVisualPageHandlerResult {
  status: 'completed' | 'skipped';
  route: PdfModalityRoute;
  evidence: RagEvidence[];
  stopReason: RagStopReason;
  fallbackRoute?: 'text';
  analyzerId?: string;
  errorCode?:
    | 'VISUAL_ANALYZER_UNAVAILABLE'
    | 'VISUAL_ANALYZER_BUSY'
    | 'VISUAL_ANALYZER_TIMEOUT'
    | 'VISUAL_ANALYZER_FAILED';
}

export interface PdfVisualPageHandlerOptions {
  analyzer?: PdfVisualAnalyzer;
  maxPages?: number;
  maxQueryCharacters?: number;
  maxOutputCharactersPerPage?: number;
  maxTotalOutputCharacters?: number;
  analyzerTimeoutMs?: number;
  maxConcurrentAnalyses?: number;
}

export class OptionalPdfVisualPageHandler {
  private readonly analyzer?: PdfVisualAnalyzer;
  private readonly maxPages: number;
  private readonly maxQueryCharacters: number;
  private readonly maxOutputCharactersPerPage: number;
  private readonly maxTotalOutputCharacters: number;
  private readonly analyzerTimeoutMs: number;
  private readonly maxConcurrentAnalyses: number;

  constructor(options: PdfVisualPageHandlerOptions = {}) {
    this.analyzer = options.analyzer;
    if (
      this.analyzer
      && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(this.analyzer.id)
    ) {
      throw new Error('Visual analyzer ID must be a safe identifier.');
    }
    this.maxPages = options.maxPages ?? 4;
    this.maxQueryCharacters = options.maxQueryCharacters ?? 10_000;
    this.maxOutputCharactersPerPage = options.maxOutputCharactersPerPage ?? 8_000;
    this.maxTotalOutputCharacters = options.maxTotalOutputCharacters ?? 24_000;
    this.analyzerTimeoutMs = options.analyzerTimeoutMs
      ?? DEFAULT_PDF_VISUAL_ANALYZER_TIMEOUT_MS;
    this.maxConcurrentAnalyses = options.maxConcurrentAnalyses
      ?? DEFAULT_PDF_VISUAL_ANALYZER_CONCURRENCY;
    if (!Number.isInteger(this.maxPages) || this.maxPages < 1 || this.maxPages > 20) {
      throw new Error('maxPages must be an integer between 1 and 20.');
    }
    assertPositiveOutputLimit(this.maxQueryCharacters, 'maxQueryCharacters');
    assertPositiveOutputLimit(this.maxOutputCharactersPerPage, 'maxOutputCharactersPerPage');
    assertPositiveOutputLimit(this.maxTotalOutputCharacters, 'maxTotalOutputCharacters');
    if (
      !Number.isInteger(this.analyzerTimeoutMs)
      || this.analyzerTimeoutMs < 1
      || this.analyzerTimeoutMs > MAX_PDF_VISUAL_ANALYZER_TIMEOUT_MS
    ) {
      throw new Error(
        `analyzerTimeoutMs must be an integer between 1 and ${MAX_PDF_VISUAL_ANALYZER_TIMEOUT_MS}.`
      );
    }
    if (
      !Number.isInteger(this.maxConcurrentAnalyses)
      || this.maxConcurrentAnalyses < 1
      || this.maxConcurrentAnalyses > MAX_PDF_VISUAL_ANALYZER_CONCURRENCY
    ) {
      throw new Error(
        `maxConcurrentAnalyses must be an integer between 1 and ${MAX_PDF_VISUAL_ANALYZER_CONCURRENCY}.`
      );
    }
  }

  async execute(input: {
    decision: PdfModalityDecision;
    manifest: PdfAssetManifest;
    scope: RagRetrievalScope;
    query: string;
    laneId?: string;
    signal?: AbortSignal;
  }): Promise<PdfVisualPageHandlerResult> {
    assertPdfAssetManifestScope(input.manifest, input.scope);
    if (input.query.length > this.maxQueryCharacters) {
      throw new Error('Visual page query exceeds the handler character limit.');
    }
    const canonicalDecision = routePdfModality({
      query: input.query,
      manifest: input.manifest,
      scope: input.scope,
      mode: 'active',
      capability: {
        available: Boolean(this.analyzer),
        analyzerId: this.analyzer?.id,
      },
      maxVisualPages: this.maxPages,
    });
    assertCanonicalVisualDecision(input.decision, canonicalDecision);
    if (canonicalDecision.route !== 'visual-page') {
      const analyzerUnavailable = canonicalDecision.reason === 'visual_capability_unavailable';
      return {
        status: 'skipped',
        route: 'text',
        evidence: [],
        stopReason: analyzerUnavailable
          ? 'capability_unavailable'
          : 'no_gain',
        fallbackRoute: canonicalDecision.fallbackRoute,
        ...(analyzerUnavailable
          ? { errorCode: 'VISUAL_ANALYZER_UNAVAILABLE' as const }
          : {}),
      };
    }
    if (!this.analyzer) {
      throw new Error('Canonical visual decision requires an available analyzer.');
    }
    const analyzer = this.analyzer;
    if (input.decision.selectedPageNumbers.length > this.maxPages) {
      throw new Error('Visual page decision exceeds the handler page limit.');
    }
    if (input.decision.selectedPageNumbers.length === 0) {
      throw new Error('Visual page decision must select at least one page.');
    }
    const selectedPages = resolveSelectedManifestPages(
      input.manifest,
      input.decision.selectedPageNumbers
    );
    throwIfAborted(input.signal);
    const reservation = reserveVisualAnalyzer(
      analyzer.id,
      this.maxConcurrentAnalyses
    );
    if (!reservation) {
      return createVisualAnalyzerFallback(analyzer.id, 'VISUAL_ANALYZER_BUSY');
    }

    const combinedAbortController = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let onExternalAbort: (() => void) | undefined;
    const externalAbortOutcome = new Promise<VisualAnalyzerOutcome>(resolve => {
      if (!input.signal) return;
      onExternalAbort = () => {
        resolve({ kind: 'aborted' });
        abortWithStableReason(
          combinedAbortController,
          'Visual page analysis was aborted.'
        );
      };
      input.signal.addEventListener('abort', onExternalAbort, { once: true });
      if (input.signal.aborted) onExternalAbort();
    });
    const timeoutOutcome = new Promise<VisualAnalyzerOutcome>(resolve => {
      timeoutHandle = setTimeout(() => {
        resolve({ kind: 'timeout' });
        abortWithStableReason(
          combinedAbortController,
          'Visual page analysis timed out.'
        );
      }, this.analyzerTimeoutMs);
    });
    const operation = Promise.resolve().then(() => analyzer.analyze({
      tenantId: input.scope.tenantId,
      corpusId: input.scope.corpusId,
      sourceHash: input.manifest.sourceHash,
      documentId: input.manifest.documentId,
      documentVersion: input.manifest.documentVersion,
      trustLevel: input.manifest.trustLevel,
      query: input.query,
      pages: selectedPages.map(page => ({
        pageNumber: page.pageNumber,
        imageRef: page.imageRef as string,
        expectedContentDigest: page.contentDigest as string,
        width: page.width as number,
        height: page.height as number,
        byteLength: page.byteLength as number,
        mimeType: page.mimeType as string,
      })),
      signal: combinedAbortController.signal,
    }));
    void operation.then(reservation.release, reservation.release);
    const operationOutcome = operation.then(
      (analyses): VisualAnalyzerOutcome => ({ kind: 'completed', analyses }),
      (error): VisualAnalyzerOutcome => ({ kind: 'failed', error })
    );

    const outcome = await Promise.race([
      operationOutcome,
      timeoutOutcome,
      externalAbortOutcome,
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (input.signal && onExternalAbort) {
      input.signal.removeEventListener('abort', onExternalAbort);
    }
    if (outcome.kind === 'aborted' || input.signal?.aborted) {
      throwVisualAnalysisAbortError();
    }
    if (outcome.kind === 'timeout') {
      return createVisualAnalyzerFallback(analyzer.id, 'VISUAL_ANALYZER_TIMEOUT');
    }
    if (outcome.kind === 'failed') {
      if (outcome.error instanceof PdfVisualAnalyzerIntegrityError) {
        throw outcome.error;
      }
      return createVisualAnalyzerFallback(analyzer.id, 'VISUAL_ANALYZER_FAILED');
    }

    try {
      throwIfAborted(input.signal);
      if (outcome.analyses.length > selectedPages.length) {
        throw new Error('Visual analyzer returned too many page analyses.');
      }
      const evidence = buildVisualEvidence({
        analyses: outcome.analyses,
        selectedPages,
        manifest: input.manifest,
        analyzerId: analyzer.id,
        laneId: input.laneId ?? 'visual-page',
        maxPerPage: this.maxOutputCharactersPerPage,
        maxTotal: this.maxTotalOutputCharacters,
      });
      return {
        status: 'completed',
        route: 'visual-page',
        evidence,
        stopReason: evidence.length > 0 ? 'sufficient' : 'no_gain',
        fallbackRoute: evidence.length > 0 ? undefined : 'text',
        analyzerId: analyzer.id,
      };
    } catch {
      if (input.signal?.aborted) {
        throwVisualAnalysisAbortError();
      }
      return createVisualAnalyzerFallback(analyzer.id, 'VISUAL_ANALYZER_FAILED');
    }
  }
}

type VisualAnalyzerOutcome =
  | { kind: 'completed'; analyses: readonly PdfVisualPageAnalysis[] }
  | { kind: 'failed'; error: unknown }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

function reserveVisualAnalyzer(
  analyzerId: string,
  maxConcurrentAnalyses: number
): { release: () => void } | undefined {
  const state = activeVisualAnalyzerReservations.get(analyzerId) ?? {
    reservations: new Set<symbol>(),
    maxConcurrentAnalyses,
  };
  // A more permissive handler must not bypass the strict limit that admitted
  // already-running operations for the same analyzer capability.
  state.maxConcurrentAnalyses = Math.min(
    state.maxConcurrentAnalyses,
    maxConcurrentAnalyses
  );
  if (state.reservations.size >= state.maxConcurrentAnalyses) return undefined;
  if (!activeVisualAnalyzerReservations.has(analyzerId)) {
    activeVisualAnalyzerReservations.set(analyzerId, state);
  }
  const token = Symbol();
  state.reservations.add(token);
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      state.reservations.delete(token);
      if (state.reservations.size === 0) {
        activeVisualAnalyzerReservations.delete(analyzerId);
      }
    },
  };
}

function createVisualAnalyzerFallback(
  analyzerId: string,
  errorCode: 'VISUAL_ANALYZER_BUSY' | 'VISUAL_ANALYZER_TIMEOUT' | 'VISUAL_ANALYZER_FAILED'
): PdfVisualPageHandlerResult {
  return {
    status: 'skipped',
    route: 'text',
    evidence: [],
    stopReason: 'capability_unavailable',
    fallbackRoute: 'text',
    analyzerId,
    errorCode,
  };
}

function abortWithStableReason(controller: AbortController, message: string): void {
  if (controller.signal.aborted) return;
  const abortError = new Error(message);
  abortError.name = 'AbortError';
  controller.abort(abortError);
}

function throwVisualAnalysisAbortError(): never {
  const abortError = new Error('Visual page analysis was aborted.');
  abortError.name = 'AbortError';
  throw abortError;
}

function assertCanonicalVisualDecision(
  decision: PdfModalityDecision,
  canonicalDecision: PdfModalityDecision
): void {
  const canonicalKeys = Object.keys(canonicalDecision).sort();
  const decisionKeys = Object.keys(decision).sort();
  const scalarFields = [
    'version',
    'route',
    'requestedVisual',
    'reason',
    'fallbackRoute',
    'shadowRoute',
    'analyzerId',
  ] as const;
  const scalarMismatch = scalarFields.some(
    field => decision[field] !== canonicalDecision[field]
  );
  if (
    scalarMismatch
    || !sameNumberArray(decision.selectedPageNumbers, canonicalDecision.selectedPageNumbers)
    || !sameNumberArray(decision.missingPageNumbers, canonicalDecision.missingPageNumbers)
    || canonicalKeys.length !== decisionKeys.length
    || canonicalKeys.some((key, index) => key !== decisionKeys[index])
  ) {
    throw new Error('Visual page decision does not match the canonical active decision.');
  }
}

function sameNumberArray(left: unknown, right: readonly number[]): boolean {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function buildVisualEvidence(input: {
  analyses: readonly PdfVisualPageAnalysis[];
  selectedPages: PdfAssetManifestPage[];
  manifest: PdfAssetManifest;
  analyzerId: string;
  laneId: string;
  maxPerPage: number;
  maxTotal: number;
}): RagEvidence[] {
  const selectedByPage = new Map(input.selectedPages.map(page => [page.pageNumber, page]));
  const seen = new Set<number>();
  const normalized = [...input.analyses].sort((left, right) => left.pageNumber - right.pageNumber);
  const evidence: RagEvidence[] = [];
  let remainingCharacters = input.maxTotal;
  for (const analysis of normalized) {
    if (seen.has(analysis.pageNumber)) {
      throw new Error('Visual analyzer returned a duplicate page.');
    }
    seen.add(analysis.pageNumber);
    const page = selectedByPage.get(analysis.pageNumber);
    if (!page) {
      throw new Error('Visual analyzer returned an unrequested page.');
    }
    if (analysis.confidence !== undefined
      && (!Number.isFinite(analysis.confidence)
        || analysis.confidence < 0
        || analysis.confidence > 1)) {
      throw new Error('Visual analyzer confidence must be between 0 and 1.');
    }
    const content = analysis.content.trim().slice(
      0,
      Math.min(input.maxPerPage, remainingCharacters)
    );
    if (!content) continue;
    remainingCharacters -= content.length;
    evidence.push({
      id: `visual:${input.manifest.sourceHash}:${page.pageNumber}:${sha256Hex(content).slice(0, 16)}`,
      tenantId: input.manifest.tenantId,
      corpusId: input.manifest.corpusId,
      documentId: input.manifest.documentId,
      documentVersion: input.manifest.documentVersion,
      content,
      source: input.manifest.sourceName,
      page: page.pageNumber,
      retrievalScore: analysis.confidence,
      trustLevel: input.manifest.trustLevel,
      laneId: input.laneId,
      metadata: {
        modality: 'visual-page',
        analyzerId: input.analyzerId,
        imageRef: page.imageRef,
        imageContentDigest: page.contentDigest,
        imageByteLength: page.byteLength,
        parseMethod: input.manifest.parseMethod,
        routerVersion: PDF_MODALITY_ROUTER_VERSION,
      },
    });
    if (remainingCharacters === 0) break;
  }
  return evidence;
}

function resolveSelectedManifestPages(
  manifest: PdfAssetManifest,
  pageNumbers: readonly number[]
): PdfAssetManifestPage[] {
  const pagesByNumber = new Map(manifest.pages.map(page => [page.pageNumber, page]));
  const seen = new Set<number>();
  return pageNumbers.map(pageNumber => {
    if (seen.has(pageNumber)) {
      throw new Error('Visual page decision contains a duplicate page number.');
    }
    seen.add(pageNumber);
    const page = pagesByNumber.get(pageNumber);
    if (!page || !hasImageAsset(page)) {
      throw new Error('Visual page decision references an unavailable page asset.');
    }
    return page;
  });
}

function extractRequestedPageNumbers(query: string): number[] {
  const pageNumbers: number[] = [];
  const seen = new Set<number>();
  for (const match of query.matchAll(PAGE_REFERENCE)) {
    const pageNumber = Number(match[1] ?? match[2]);
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || seen.has(pageNumber)) continue;
    seen.add(pageNumber);
    pageNumbers.push(pageNumber);
  }
  return pageNumbers.sort((left, right) => left - right);
}

function hasImageAsset(page: PdfAssetManifestPage): boolean {
  return Boolean(
    page.imageRef
      && page.contentDigest
      && Number.isInteger(page.width)
      && Number.isInteger(page.height)
      && Number.isInteger(page.byteLength)
      && page.mimeType
  );
}

function textDecision(
  requestedVisual: boolean,
  reason: PdfModalityDecision['reason'],
  extras: Pick<PdfModalityDecision, 'fallbackRoute' | 'shadowRoute'> = {}
): PdfModalityDecision {
  return {
    version: PDF_MODALITY_ROUTER_VERSION,
    route: 'text',
    requestedVisual,
    reason,
    selectedPageNumbers: [],
    missingPageNumbers: [],
    ...extras,
  };
}

function assertPositiveOutputLimit(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000) {
    throw new Error(`${field} must be an integer between 1 and 1000000.`);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const abortError = new Error('Visual page analysis was aborted.');
  abortError.name = 'AbortError';
  throw abortError;
}

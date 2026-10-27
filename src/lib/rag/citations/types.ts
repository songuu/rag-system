/** Browser-safe response contracts. Locators are opaque and never contain a source URL. */
export interface RagCitationItem {
  number: number;
  locator: string;
  expiresAt: number;
  source?: string;
  page?: number;
}

export interface RagCitations {
  version: 'rag-citations/v1';
  status: 'available' | 'missing' | 'unavailable';
  partition: string;
  items: RagCitationItem[];
  diagnostics: {
    reason: 'ready' | 'no-numbered-citations' | 'configuration-unavailable' | 'sources-unavailable';
    citationCount: number;
    invalidCitationCount: number;
    unavailableCitationCount: number;
  };
}

export interface RagCitationPreview {
  success: true;
  source?: string;
  page?: number;
  content: string;
  contentTruncated: boolean;
  relations?: Array<{ source: string; predicate: string; target: string; fact: string }>;
}

export interface RagCitationPartition {
  success: true;
  partition: string;
  now: number;
}

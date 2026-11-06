import type { ComponentProps } from 'react';
import type QueryAnalysis from '@/components/QueryAnalysis';
import type RetrievalDetailsPanel from '@/components/RetrievalDetailsPanel';

type QueryAnalysisView = NonNullable<ComponentProps<typeof QueryAnalysis>['analysis']>;
type RetrievalDetailsView = NonNullable<ComponentProps<typeof RetrievalDetailsPanel>['retrievalDetails']>;
type SearchResultView = RetrievalDetailsView['searchResults'][number];

/** Keep persisted display metadata independent of provider SDK instance types,
 * while retaining optional diagnostics from older conversation records. */
export type ChatQueryAnalysis = QueryAnalysisView & {
  analysisMode?: 'canonical-create-agent';
  originalQuery?: string;
  adaptiveEntityAnalysis?: QueryAnalysisView['adaptiveEntityAnalysis'] & {
    originalQuery?: string;
    logicalRelations?: unknown;
  };
  agenticAnalysis?: {
    originalQuery?: string;
    rewrittenQuery?: string;
    intent?: string;
    complexity?: string;
    needsRetrieval?: boolean;
    keywords?: string[];
  };
};

export type ChatSearchResult = Omit<SearchResultView, 'document'> & {
  id?: string;
  content?: string;
  score?: number;
  metadata?: Record<string, unknown>;
  document: SearchResultView['document'] & { id?: string; pageContent?: string };
};

export type ChatRetrievalDetails = Omit<RetrievalDetailsView, 'searchResults'> & {
  searchResults: ChatSearchResult[];
};

export type QueryToken = NonNullable<NonNullable<QueryAnalysisView['tokenization']>['tokens']>[number];

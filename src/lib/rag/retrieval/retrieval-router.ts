export const RETRIEVAL_ROUTER_VERSION = 'retrieval-router/rules-v1' as const;

export type RetrievalRoute = 'dense' | 'hybrid' | 'ordered-context';
export type RetrievalQueryKind = 'identifier' | 'global' | 'multi-hop' | 'semantic';
export type RetrievalFeatureMode = 'off' | 'shadow' | 'active';

export interface RetrievalRouterInput {
  query: string;
  capabilities: {
    hybridActive: boolean;
    orderedContextActive: boolean;
  };
  corpus?: {
    documentCount: number;
    characterCount: number;
    complete: boolean;
  };
  orderedContextLimits?: {
    maxDocuments: number;
    maxCharacters: number;
  };
}

export interface RetrievalRouteDecision {
  version: typeof RETRIEVAL_ROUTER_VERSION;
  route: RetrievalRoute;
  queryKind: RetrievalQueryKind;
  reason:
    | 'identifier_prefers_lexical'
    | 'identifier_hybrid_unavailable'
    | 'bounded_global_prefers_ordered_context'
    | 'ordered_context_unavailable'
    | 'ordered_context_corpus_unbounded'
    | 'multi_hop_uses_dense_control'
    | 'semantic_dense_default';
  signals: string[];
}

export function resolveRetrievalRouterCapabilities(input: {
  hybrid: { mode: RetrievalFeatureMode; usable: boolean };
  orderedContext: { mode: RetrievalFeatureMode; usable: boolean };
}): RetrievalRouterInput['capabilities'] {
  validateFeatureCapability(input.hybrid, 'hybrid');
  validateFeatureCapability(input.orderedContext, 'orderedContext');
  return {
    // Shadow execution may collect metrics, but cannot alter generation routing.
    hybridActive: input.hybrid.mode === 'active' && input.hybrid.usable,
    orderedContextActive:
      input.orderedContext.mode === 'active' && input.orderedContext.usable,
  };
}

export function routeRetrievalQuery(input: RetrievalRouterInput): RetrievalRouteDecision {
  const query = required(input.query, 'query');
  validateCapabilities(input.capabilities);
  const identifierSignals = findIdentifierSignals(query);
  const globalSignals = findGlobalSignals(query);
  const multiHopSignals = findMultiHopSignals(query);

  if (identifierSignals.length > 0) {
    return decision(
      input.capabilities.hybridActive ? 'hybrid' : 'dense',
      'identifier',
      input.capabilities.hybridActive
        ? 'identifier_prefers_lexical'
        : 'identifier_hybrid_unavailable',
      identifierSignals
    );
  }

  if (globalSignals.length > 0) {
    if (!input.capabilities.orderedContextActive) {
      return decision('dense', 'global', 'ordered_context_unavailable', globalSignals);
    }
    if (!isCorpusBounded(input)) {
      return decision('dense', 'global', 'ordered_context_corpus_unbounded', globalSignals);
    }
    return decision(
      'ordered-context',
      'global',
      'bounded_global_prefers_ordered_context',
      globalSignals
    );
  }

  if (multiHopSignals.length > 0) {
    return decision('dense', 'multi-hop', 'multi_hop_uses_dense_control', multiHopSignals);
  }
  return decision('dense', 'semantic', 'semantic_dense_default', []);
}

export function classifyRetrievalQuery(query: string): {
  queryKind: RetrievalQueryKind;
  signals: string[];
} {
  const normalized = required(query, 'query');
  const identifierSignals = findIdentifierSignals(normalized);
  if (identifierSignals.length > 0) return { queryKind: 'identifier', signals: identifierSignals };
  const globalSignals = findGlobalSignals(normalized);
  if (globalSignals.length > 0) return { queryKind: 'global', signals: globalSignals };
  const multiHopSignals = findMultiHopSignals(normalized);
  if (multiHopSignals.length > 0) return { queryKind: 'multi-hop', signals: multiHopSignals };
  return { queryKind: 'semantic', signals: [] };
}

function isCorpusBounded(input: RetrievalRouterInput): boolean {
  if (!input.corpus?.complete) return false;
  const limits = input.orderedContextLimits ?? {
    maxDocuments: 6,
    maxCharacters: 120_000,
  };
  if (!Number.isInteger(limits.maxDocuments) || limits.maxDocuments < 1) {
    throw new Error('Retrieval router maxDocuments must be a positive integer.');
  }
  if (!Number.isInteger(limits.maxCharacters) || limits.maxCharacters < 1) {
    throw new Error('Retrieval router maxCharacters must be a positive integer.');
  }
  if (!Number.isInteger(input.corpus.documentCount) || input.corpus.documentCount < 0) {
    throw new Error('Retrieval router corpus documentCount must be a non-negative integer.');
  }
  if (!Number.isInteger(input.corpus.characterCount) || input.corpus.characterCount < 0) {
    throw new Error('Retrieval router corpus characterCount must be a non-negative integer.');
  }
  return (
    input.corpus.documentCount <= limits.maxDocuments &&
    input.corpus.characterCount <= limits.maxCharacters
  );
}

function findIdentifierSignals(query: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ['explicit_identifier_term', /(?:编号|标识符|错误码|型号|版本号|代码|\b(?:id|sku|error\s*code|invoice)\b)/iu],
    ['quoted_literal', /["'“‘][^"'”’\r\n]{2,}["'”’]/u],
    ['uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu],
    ['structured_code', /\b(?=[A-Z0-9_./-]{4,}\b)(?=[A-Z0-9_./-]*[A-Z])(?=[A-Z0-9_./-]*\d)[A-Z0-9]+(?:[-_./][A-Z0-9]+)+\b/iu],
  ];
  return matchingSignals(query, patterns);
}

function findGlobalSignals(query: string): string[] {
  return matchingSignals(query, [
    ['whole_corpus', /(?:全文|整篇|整体|全部文档|所有文档|whole\s+(?:document|corpus)|across\s+all\s+documents)/iu],
    ['ordered_request', /(?:按顺序|依次|从头到尾|时间线|chronological(?:ly)?|in\s+order|from\s+beginning\s+to\s+end)/iu],
    ['global_summary', /(?:总结|概括|summari[sz]e).{0,12}(?:全文|整篇|文档|材料|document)/iu],
  ]);
}

function findMultiHopSignals(query: string): string[] {
  return matchingSignals(query, [
    ['cross_document', /(?:跨文档|综合.{0,8}(?:资料|文档)|across\s+(?:documents|sources))/iu],
    ['relationship', /(?:之间.{0,8}(?:关系|影响)|如何.{0,8}影响|relationship\s+between|how\s+does.+affect)/iu],
    ['comparison', /(?:比较|对比|compare).{0,30}(?:与|和|and|versus|vs\.?)/iu],
  ]);
}

function matchingSignals(query: string, patterns: Array<[string, RegExp]>): string[] {
  return patterns.filter(([, pattern]) => pattern.test(query)).map(([name]) => name);
}

function decision(
  route: RetrievalRoute,
  queryKind: RetrievalQueryKind,
  reason: RetrievalRouteDecision['reason'],
  signals: string[]
): RetrievalRouteDecision {
  return {
    version: RETRIEVAL_ROUTER_VERSION,
    route,
    queryKind,
    reason,
    signals,
  };
}

function validateCapabilities(capabilities: RetrievalRouterInput['capabilities']): void {
  if (
    typeof capabilities.hybridActive !== 'boolean' ||
    typeof capabilities.orderedContextActive !== 'boolean'
  ) {
    throw new Error('Retrieval router capabilities must be explicit booleans.');
  }
}

function validateFeatureCapability(
  capability: { mode: RetrievalFeatureMode; usable: boolean },
  field: string
): void {
  if (!['off', 'shadow', 'active'].includes(capability.mode)) {
    throw new Error('Retrieval router ' + field + ' mode is invalid.');
  }
  if (typeof capability.usable !== 'boolean') {
    throw new Error('Retrieval router ' + field + ' usable flag must be boolean.');
  }
}

function required(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Retrieval router ' + field + ' is required.');
  }
  return value.trim();
}

import {
  buildReranker,
  isRerankerConfigured,
  type RerankerInput,
  type RerankerProvider,
  type RerankerProviderId,
} from './rerank-providers';

export interface RerankableDocument {
  id?: string;
  content: string;
}

export type RerankedDocument<TDocument extends RerankableDocument> = TDocument & {
  relevanceScore?: number;
  rerankScore?: number;
};

export interface RerankDocumentsOptions {
  provider?: RerankerProvider;
  providerId?: RerankerProviderId;
  topK?: number;
  onError?: (error: Error) => void;
}

export async function rerankDocuments<TDocument extends RerankableDocument>(
  query: string,
  documents: TDocument[],
  options: RerankDocumentsOptions = {}
): Promise<Array<RerankedDocument<TDocument>>> {
  const limit = typeof options.topK === 'number' && options.topK > 0
    ? Math.min(options.topK, documents.length)
    : documents.length;

  if (documents.length === 0) return [];

  try {
    const provider = options.provider ?? (
      isRerankerConfigured(options.providerId) ? buildReranker(options.providerId) : undefined
    );

    if (!provider) {
      return documents.slice(0, limit) as Array<RerankedDocument<TDocument>>;
    }

    const inputs: RerankerInput[] = documents.map((document, index) => ({
      id: document.id ?? String(index),
      content: document.content,
    }));

    const outputs = await provider.rerank(query, inputs, limit);
    return outputs
      .filter((output) => output.originalIndex >= 0 && output.originalIndex < documents.length)
      .map((output) => ({
        ...documents[output.originalIndex],
        relevanceScore: output.relevanceScore,
        rerankScore: output.relevanceScore,
      }));
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    options.onError?.(normalizedError);
    return documents.slice(0, limit) as Array<RerankedDocument<TDocument>>;
  }
}

export {
  buildReranker,
  isRerankerConfigured,
  type RerankerInput,
  type RerankerOutput,
  type RerankerProvider,
  type RerankerProviderId,
} from './rerank-providers';

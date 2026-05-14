import { createStableHash } from '../../artifact-cache';

export type CorpusSourceKind = 'upload' | 'url' | 'maic-course' | 'mirofish-project' | 'manual';

export interface Corpus {
  id: string;
  name: string;
  sourceKind: CorpusSourceKind;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface DocumentAsset {
  id: string;
  corpusId: string;
  source: string;
  sourceHash: string;
  contentType: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface IndexManifest {
  corpusId: string;
  versionHash: string;
  documentIds: string[];
  embeddingModel?: string;
  updatedAt: string;
}

export class MemoryCorpusStore {
  private corpora = new Map<string, Corpus>();
  private documents = new Map<string, DocumentAsset>();
  private manifests = new Map<string, IndexManifest>();

  upsertCorpus(input: Omit<Corpus, 'createdAt'> & { createdAt?: string }): Corpus {
    const corpus: Corpus = {
      ...input,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.corpora.set(corpus.id, corpus);
    return corpus;
  }

  upsertDocument(
    input: Omit<DocumentAsset, 'id' | 'sourceHash' | 'createdAt'> & {
      id?: string;
      sourceHash?: string;
      content?: string;
      createdAt?: string;
    }
  ): DocumentAsset {
    const sourceHash = input.sourceHash ?? createStableHash({
      source: input.source,
      content: input.content ?? '',
      metadata: input.metadata ?? {},
    });
    const document: DocumentAsset = {
      id: input.id ?? `doc_${sourceHash.slice(0, 16)}`,
      corpusId: input.corpusId,
      source: input.source,
      sourceHash,
      contentType: input.contentType,
      createdAt: input.createdAt ?? new Date().toISOString(),
      metadata: input.metadata,
    };

    this.documents.set(document.id, document);
    return document;
  }

  updateManifest(input: Omit<IndexManifest, 'versionHash' | 'updatedAt'>): IndexManifest {
    const versionHash = createStableHash({
      corpusId: input.corpusId,
      documentIds: [...input.documentIds].sort(),
      embeddingModel: input.embeddingModel,
    });
    const manifest: IndexManifest = {
      ...input,
      versionHash,
      updatedAt: new Date().toISOString(),
    };
    this.manifests.set(input.corpusId, manifest);
    return manifest;
  }

  getCorpus(id: string): Corpus | undefined {
    return this.corpora.get(id);
  }

  getManifest(corpusId: string): IndexManifest | undefined {
    return this.manifests.get(corpusId);
  }
}


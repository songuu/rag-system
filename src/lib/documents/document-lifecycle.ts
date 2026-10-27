import type { RagRetrievalScope } from '../security/retrieval-scope';

export type DocumentLifecycle = 'active' | 'deleting' | 'deleted';
export interface ManagedDocument {
  id: string;
  documentId: string;
  metadata: Record<string, unknown>;
  lifecycle: DocumentLifecycle;
}
export interface DocumentMutation {
  id: string;
  scope: RagRetrievalScope;
}
export interface DocumentLifecycleStore {
  beginDelete(input: DocumentMutation): Promise<ManagedDocument>;
  completeDelete(input: DocumentMutation): Promise<void>;
  setEnabled(input: DocumentMutation & { enabled: boolean }): Promise<void>;
}
export interface DocumentDeletionPorts {
  store: DocumentLifecycleStore;
  deleteVectors(document: ManagedDocument, scope: RagRetrievalScope): Promise<void>;
  deleteLexical(document: ManagedDocument, scope: RagRetrievalScope): Promise<void>;
  deleteAssets(document: ManagedDocument, scope: RagRetrievalScope): Promise<void>;
}

export class DocumentLifecycleError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number, cause?: unknown) {
    super(message, { cause });
    this.name = 'DocumentLifecycleError';
    this.code = code;
    this.status = status;
  }
}

export async function deleteManagedDocument(input: DocumentMutation, ports: DocumentDeletionPorts): Promise<void> {
  // Commit the block before contacting external indexes. Failed cleanup must
  // never make the source retrievable again; every cleanup step is idempotent.
  const document = await ports.store.beginDelete(input);
  if (document.lifecycle === 'deleted') return;
  try {
    await ports.deleteVectors(document, input.scope);
    await ports.deleteLexical(document, input.scope);
    await ports.deleteAssets(document, input.scope);
    await ports.store.completeDelete(input);
  } catch (cause) {
    throw new DocumentLifecycleError('DOCUMENT_DELETE_INCOMPLETE', '文档已停止检索，但清理尚未完成，请重试删除。', 503, cause);
  }
}

export async function setManagedDocumentEnabled(
  input: DocumentMutation & { enabled: boolean }, store: DocumentLifecycleStore
): Promise<void> {
  await store.setEnabled(input);
}

export function parseDocumentMutation(value: unknown, method: 'PATCH' | 'DELETE'): { id: string; enabled?: boolean } {
  const invalid = () => new DocumentLifecycleError('INVALID_DOCUMENT_MUTATION', '文档操作参数无效。', 400);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !['id', ...(method === 'PATCH' ? ['enabled'] : [])].includes(key))) throw invalid();
  if (typeof body.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(body.id)) throw invalid();
  if (method === 'PATCH' && typeof body.enabled !== 'boolean') throw invalid();
  return { id: body.id, ...(method === 'PATCH' ? { enabled: body.enabled as boolean } : {}) };
}

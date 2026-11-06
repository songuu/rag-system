import { queryPostgres, type PostgresQueryClient } from '../postgres/client';
import { Client, type ClientConfig } from 'pg';
import type { PublicationAttempt } from '../documents/publication-control-cas';
import { createDocumentGraphIdentity, DocumentGraphUnknownError, stageDocumentGraph, type DocumentGraphGeneration } from './document-generation';

/** Low-level diagnostic only. A caller-supplied connection may be in a transaction. */
export async function reserveDocumentGraphDispatch(db: PostgresQueryClient, attempt: PublicationAttempt,
  input: DocumentGraphGeneration): Promise<ReturnType<typeof createDocumentGraphIdentity>> {
  const identity = createDocumentGraphIdentity(input);
  if (!attempt || attempt.tenantId !== identity.tenantId || attempt.corpusId !== identity.corpusId
    || attempt.documentId !== identity.documentId || attempt.generation !== identity.generation
    || attempt.manifestDigest !== identity.manifestDigest || !/^[1-9][0-9]{0,18}$/.test(attempt.revision)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attempt.leaseToken)) {
    throw new Error('Document graph reservation identity mismatch.');
  }
  await queryPostgres(db, 'select public.rag_reserve_document_graph($1,$2,$3,$4::bigint,$5::bigint,$6::uuid,$7,$8,$9)',
    [identity.tenantId, identity.corpusId, identity.documentId, identity.generation, attempt.revision,
      attempt.leaseToken, identity.graphVersion, identity.contentVersion, identity.manifestDigest], 'reserve document graph dispatch');
  return identity;
}

/**
 * Diagnostic staging uses a fresh private connection. Its single reserve query
 * commits before graph dispatch, independently of any caller transaction.
 * This does not prove graph sealing or prevent writes by other actors.
 */
export async function stageReservedDocumentGraph(config: ClientConfig, attempt: PublicationAttempt,
  ...args: Parameters<typeof stageDocumentGraph>): Promise<Awaited<ReturnType<typeof stageDocumentGraph>>> {
  const identity = createDocumentGraphIdentity(args[0]);
  const db = new Client({ ...config, connectionTimeoutMillis: 5000, query_timeout: 10000, statement_timeout: 10000 });
  let closeStarted = false;
  const closeBounded = async () => {
    closeStarted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([db.end(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Graph reservation connection close timed out.')), 5000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  try {
    await db.connect();
    await reserveDocumentGraphDispatch(db, attempt, args[0]);
    // Failure or timeout closing the session remains an unknown reservation;
    // never issue the graph write unless the reserve query and close succeeded.
    await closeBounded();
  } catch (error) {
    // Do not wait twice on a close which may already have hung.
    if (!closeStarted) await closeBounded().catch(() => {});
    // A lost database response may hide a committed reservation. Never retry.
    throw new DocumentGraphUnknownError(identity, error);
  }
  return stageDocumentGraph(...args);
}

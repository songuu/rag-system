import type {
  EntityExtractionCheckpoint,
  EntityExtractionCheckpointValue,
  EntityExtractionSegment,
} from '../entity-extraction';
import type { KnowledgeGraphBuildJob, PostgresKnowledgeGraphBuildJobStore } from './postgres-graph-build-store';

type CheckpointStore = Pick<PostgresKnowledgeGraphBuildJobStore, 'saveExtractionCheckpoint'>;
type CheckpointJob = Pick<KnowledgeGraphBuildJob,
  'id' | 'tenantId' | 'corpusId' | 'graphVersion' | 'leaseToken' | 'metadata'>;

/** Only a leased job may persist or restore results for its own extraction profile. */
export function createGraphExtractionCheckpoint(
  job: CheckpointJob,
  store: CheckpointStore,
  profile: string,
  leaseMs: number,
): EntityExtractionCheckpoint {
  if (!job.leaseToken) throw new Error('Graph extraction checkpoint requires an active lease.');
  const leaseToken = job.leaseToken;
  const stored = job.metadata.graphExtractionCheckpoint;
  const segments = new Map<string, unknown>();
  if (stored !== undefined) {
    if (!isRecord(stored) || stored.profile !== profile || !isRecord(stored.segments)) {
      throw new Error('Graph extraction checkpoint profile or configuration does not match.');
    }
    const entries = Object.entries(stored.segments);
    if (entries.length > 2_500) throw new Error('Graph extraction checkpoint has too many segments.');
    for (const [key, record] of entries) segments.set(key, structuredClone(record));
  }
  return {
    async load(segment) {
      const record = segments.get(segment.key);
      if (record === undefined) return null;
      if (!isRecord(record) || record.sourceDigest !== segment.sourceDigest) {
        throw new Error('Graph extraction checkpoint source does not match the document.');
      }
      if (!isRecord(record.value) || (record.value.kind !== 'split' && record.value.kind !== 'complete')) {
        throw new Error('Graph extraction checkpoint entry is invalid.');
      }
      if (record.value.kind === 'complete' && !isRecord(record.value.result)) {
        throw new Error('Graph extraction checkpoint result is invalid.');
      }
      return structuredClone(record.value) as EntityExtractionCheckpointValue;
    },
    async save(segment: EntityExtractionSegment, value: EntityExtractionCheckpointValue) {
      const record = { sourceDigest: segment.sourceDigest, value: structuredClone(value) };
      await store.saveExtractionCheckpoint({
        jobId: job.id, tenantId: job.tenantId, corpusId: job.corpusId,
        graphVersion: job.graphVersion, leaseToken, profile, segmentKey: segment.key,
        record, progress: segment.progress, leaseMs,
      });
      segments.set(segment.key, record);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

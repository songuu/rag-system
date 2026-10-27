/** Relations retain the claim's direction even when retrieval walks it backwards. */
export interface GraphRelationEvidence {
  claimId: string;
  sourceEntityId: string;
  sourceEntityName: string;
  predicate: string;
  targetEntityId: string;
  targetEntityName: string;
  passageIds: string[];
}

export type GraphEvidencePath = GraphRelationEvidence[];

export const GRAPH_EVIDENCE_LIMITS = Object.freeze({
  maxPathsPerEvidence: 8,
  maxHops: 2,
  maxPassagesPerRelation: 32,
  maxFieldCharacters: 512,
});

/** Fail closed on malformed metadata; legacy evidence without paths stays usable. */
export function readGraphEvidencePaths(value: unknown): GraphEvidencePath[] {
  try {
    if (!Array.isArray(value) || value.length > GRAPH_EVIDENCE_LIMITS.maxPathsPerEvidence) return [];
    const paths: GraphEvidencePath[] = [];
    for (let pathIndex = 0; pathIndex < value.length; pathIndex++) {
      const input = ownData(value, String(pathIndex));
      if (!Array.isArray(input) || input.length < 1 || input.length > GRAPH_EVIDENCE_LIMITS.maxHops) return [];
      const path: GraphEvidencePath = [];
      for (let index = 0; index < input.length; index++) {
        const relation = readRelation(ownData(input, String(index)));
        if (!relation || path.some(previous => previous.claimId === relation.claimId)) return [];
        path.push(relation);
      }
      if (path.length === 2 && !shareEndpoint(path[0], path[1])) return [];
      paths.push(path);
    }
    return paths;
  } catch {
    return [];
  }
}

export function graphEvidencePathConnects(path: GraphEvidencePath, start: string, end: string): boolean {
  let current = start;
  for (const relation of path) {
    if (relation.sourceEntityId === current) current = relation.targetEntityId;
    else if (relation.targetEntityId === current) current = relation.sourceEntityId;
    else return false;
  }
  return current === end;
}

function readRelation(value: unknown): GraphRelationEvidence | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const fields = ['claimId', 'sourceEntityId', 'sourceEntityName', 'predicate', 'targetEntityId', 'targetEntityName'] as const;
  const parsed: Partial<Record<typeof fields[number], string>> = {};
  for (const field of fields) {
    const text = ownData(value, field);
    if (typeof text !== 'string' || !text.trim() || text.length > GRAPH_EVIDENCE_LIMITS.maxFieldCharacters) return undefined;
    parsed[field] = text;
  }
  const ids = ownData(value, 'passageIds');
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > GRAPH_EVIDENCE_LIMITS.maxPassagesPerRelation) return undefined;
  const passageIds: string[] = [];
  for (let index = 0; index < ids.length; index++) {
    const id = ownData(ids, String(index));
    if (typeof id !== 'string' || !id.trim() || id.length > GRAPH_EVIDENCE_LIMITS.maxFieldCharacters) return undefined;
    passageIds.push(id);
  }
  return { ...parsed, passageIds: [...new Set(passageIds)] } as GraphRelationEvidence;
}

function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function shareEndpoint(left: GraphRelationEvidence, right: GraphRelationEvidence): boolean {
  return left.sourceEntityId === right.sourceEntityId || left.sourceEntityId === right.targetEntityId
    || left.targetEntityId === right.sourceEntityId || left.targetEntityId === right.targetEntityId;
}

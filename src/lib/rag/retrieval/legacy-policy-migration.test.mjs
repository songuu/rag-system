import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [agenticSource, adaptiveSource, askRouteSource] = await Promise.all([
  readFile(new URL('../../agentic-rag.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../adaptive-entity-rag.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../../app/api/ask/route.ts', import.meta.url), 'utf8'),
]);

test('agentic initial and rewrite retrieval share the server-scope resolver', () => {
  const scopedAttempts = agenticSource.match(
    /retrievalScope: this\.config\.retrievalScope/g
  ) ?? [];
  assert.equal(scopedAttempts.length, 2);
  assert.match(agenticSource, /config\.retrievalScope\s*\?\s*false/);
});

test('adaptive retries use the scope resolver and fail instead of swallowing search errors', () => {
  assert.match(adaptiveSource, /legacyLocalFilter: filterExpr \|\| undefined/);
  assert.match(adaptiveSource, /throw new Error\('Adaptive structured retrieval failed\.'/);
  assert.match(adaptiveSource, /throw new Error\('Adaptive semantic retrieval failed\.'/);
  assert.match(adaptiveSource, /export class AdaptiveEntityRAGExecutionError/);
  assert.match(adaptiveSource, /throw new AdaptiveEntityRAGExecutionError\(state, error\)/);
});

test('authenticated legacy passages are validated before agentic or adaptive LLM use', () => {
  assert.match(agenticSource, /toAgenticRetrievedDocuments\([\s\S]*adaptMilvusSearchResultsToEvidence/);
  assert.match(agenticSource, /assertAgenticDocumentsInScope\([\s\S]*agentic-pre-llm/);
  assert.match(agenticSource, /function invokeAgenticGeneration/);
  assert.match(agenticSource, /laneId: 'agentic-generation'/);
  assert.ok((agenticSource.match(/invokeAgenticGeneration\(/g) ?? []).length >= 1);
  assert.match(agenticSource, /error instanceof LegacyEvidenceValidationError\) throw error/);

  assert.match(adaptiveSource, /toAdaptiveSearchResults\([\s\S]*adaptMilvusSearchResultsToEvidence/);
  assert.match(adaptiveSource, /assertAdaptiveResultsInScope\([\s\S]*adaptive-pre-rerank/);
  assert.match(adaptiveSource, /function invokeAdaptiveGeneration/);
  assert.match(adaptiveSource, /laneId: 'adaptive-generation'/);
  assert.ok((adaptiveSource.match(/invokeAdaptiveGeneration\(/g) ?? []).length >= 1);
});

test('legacy policy stranglers forward lane cancellation without reusing it after completion', () => {
  assert.match(agenticSource, /signal: options\.signal/);
  assert.match(agenticSource, /signal\?: AbortSignal/);
  assert.match(adaptiveSource, /async query\([\s\S]*signal\?: AbortSignal/);
  assert.match(adaptiveSource, /this\.llm\.invoke\(prompt, \{ signal \}\)/);
  assert.ok((askRouteSource.match(/executeLegacy\(signal\)/g) ?? []).length >= 6);
  assert.ok((askRouteSource.match(/if \(result\) return Promise\.resolve\(result\)/g) ?? []).length >= 2);
  assert.match(askRouteSource, /memory-generation-v1[\s\S]*llm\.invoke\([\s\S]*\{ signal \}/);
});

test('ask policies execute with policy context and expose lane evidence', () => {
  assert.match(askRouteSource, /execute: context => handleAgenticQuery\(context\)/);
  assert.match(askRouteSource, /execute: context => handleAdaptiveEntityQuery\(context\)/);
  assert.match(askRouteSource, /execute: context => handleMemoryQuery\(context\)/);
  assert.ok((askRouteSource.match(/evidence: laneResult\.evidence/g) ?? []).length >= 4);
  assert.ok((askRouteSource.match(/laneExecutions: laneResult\.laneExecutions/g) ?? []).length >= 4);
  assert.ok((askRouteSource.match(/type: 'generation-only'/g) ?? []).length >= 3);
});

test('ask policies preserve stable public failures and a sanitized partial kernel envelope', () => {
  assert.match(askRouteSource, /status: 502, code: 'AGENTIC_QUERY_FAILED'/);
  assert.match(askRouteSource, /status: 500, code: 'ADAPTIVE_QUERY_FAILED'/);
  assert.match(askRouteSource, /publicEnvelope:/);
  assert.match(askRouteSource, /rag: kernelFailure\.publicEnvelope/);
});

test('MiroFish graph activation is server-owned and version-bound', () => {
  assert.match(askRouteSource, /function resolveServerMiroFishPolicy/);
  assert.match(
    askRouteSource,
    /resolveRagFeatureRolloutMode\('RAG_MIROFISH_GRAPH_MODE', 'off'\)/
  );
  assert.match(askRouteSource, /graphArtifactIdentity:/);
});

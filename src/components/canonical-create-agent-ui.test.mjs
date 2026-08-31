import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pageSource = await readFile(
  new URL('../app/page.tsx', import.meta.url),
  'utf8'
);
const traceViewerSource = await readFile(
  new URL('./LangSmithTraceViewer.tsx', import.meta.url),
  'utf8'
);

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('canonical createAgent page branch preserves server facts without legacy mock projections', () => {
  const canonicalBranch = sliceBetween(
    pageSource,
    '// Canonical createAgent',
    '// 处理 legacy Agentic RAG'
  );

  assert.match(
    canonicalBranch,
    /queryAnalysisData = isCanonicalCreateAgentQueryAnalysis\(data\.queryAnalysis\)/
  );
  assert.match(canonicalBranch, /canonicalCreateAgentResponse/);
  assert.match(pageSource, /workflow\?\.runtime === 'langchain-create-agent-v1'/);
  assert.match(canonicalBranch, /setRadarChartData\(null\)/);
  assert.doesNotMatch(
    canonicalBranch,
    /generateMockTokens|generateEnhancedTokens|embeddingDimension|vectorFeatures|vectorMagnitude/
  );

  assert.match(
    pageSource,
    /!isCanonicalCreateAgentQueryAnalysis\(currentAnalysis\)[\s\S]*?<QueryAnalysis/
  );
  assert.match(
    pageSource,
    /queryAnalysis=\{isCanonicalCreateAgentQueryAnalysis\(queryAnalysis\) \? null : queryAnalysis\}/
  );
});

test('LangSmith trace viewer discriminates canonical analysis from legacy-only fields', () => {
  const canonicalView = sliceBetween(
    traceViewerSource,
    'isCanonicalCreateAgentQueryAnalysis(queryAnalysis) ? (',
    ') : (\n            <div className="space-y-2">'
  );

  for (const actualField of [
    'originalQuery',
    'intent',
    'semanticCategory',
    'nearestConcepts',
    'queryQualityScore',
    'specificity',
    'ambiguity',
    'retrievability',
  ]) {
    assert.match(canonicalView, new RegExp(`queryAnalysis(?:\\.quality)?\\.${actualField}`));
  }
  assert.match(traceViewerSource, /formatPercentage\(queryAnalysis\.confidence\)/);
  assert.match(canonicalView, /canonicalConfidence/);
  assert.doesNotMatch(canonicalView, /queryAnalysis\.(?:complexity|needsRetrieval|keywords)/);
  assert.match(
    traceViewerSource,
    /typeof queryAnalysis\.needsRetrieval === 'boolean'/
  );
});

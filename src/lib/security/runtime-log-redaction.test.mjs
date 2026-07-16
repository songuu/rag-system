import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sensitiveConsoleFragments = [
  '${question}',
  '${query}',
  'query.substring',
  '${enhancedQuery',
  '${entity.name}',
  'candidates.map(c => c.standardName)',
  '${aliasMatch.standardName}',
  '${exactMatch.standardName}',
  '${c.value}',
  '${metadata.standardName}',
  '${metadata.aliases',
  '${standardName}',
  '"${name}"',
];

function extractConsoleCalls(source) {
  return source.match(/console\.(?:log|warn|error)\([\s\S]*?\);/g) ?? [];
}

test('ask and adaptive runtime logs do not interpolate query or entity payloads', async () => {
  const sources = await Promise.all([
    readFile(new URL('../../app/api/ask/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../adaptive-entity-rag.ts', import.meta.url), 'utf8'),
  ]);
  const consoleCalls = sources.flatMap(extractConsoleCalls).join('\n');

  for (const fragment of sensitiveConsoleFragments) {
    assert.doesNotMatch(
      consoleCalls,
      new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `console output must not contain sensitive interpolation: ${fragment}`
    );
  }
});

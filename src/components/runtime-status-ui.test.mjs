import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pageSource = await readFile(
  new URL('../app/page.tsx', import.meta.url),
  'utf8'
);

function sliceBetween(source, startMarker, endMarker) {
  source = source.replace(/\r\n/g, '\n');
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('Milvus badge probes Milvus even when aggregate health is not ready', () => {
  const refreshRuntimeStatus = sliceBetween(
    pageSource,
    'const refreshRuntimeStatus = useCallback(',
    '}, [checkMilvusStatus, checkSystemHealth, refreshDocumentCounts]);'
  );

  // /api/health also returns 503 when Elasticsearch or PostgreSQL is not
  // ready. Skipping the probe then painted a healthy Milvus as disconnected.
  assert.match(
    refreshRuntimeStatus,
    /if \(runtimeStatus !== 'disabled'\) await checkMilvusStatus\(\);/
  );
  assert.doesNotMatch(refreshRuntimeStatus, /runtimeStatus === 'enabled'/);
});

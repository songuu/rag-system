import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(
  new URL('./KnowledgeGraphConsole.tsx', import.meta.url),
  'utf8'
);
const pageSource = await readFile(
  new URL('../app/knowledge-graph/page.tsx', import.meta.url),
  'utf8'
);

test('loads independent overview resources in parallel', () => {
  assert.match(source, /Promise\.all\(\[/);
  assert.match(source, /API_ROOT = '\/rag-api\/knowledge-graph'/);
  assert.match(source, /API_ROOT \+ '\/health'/);
  assert.match(source, /API_ROOT \+ '\/snapshots\?limit=50'/);
  assert.match(source, /API_ROOT \+ '\/builds'/);
});

test('creates durable graph snapshots from PostgreSQL document sources', () => {
  assert.match(source, /创建快照/);
  assert.match(source, /documentId/);
  assert.match(source, /documentVersion/);
  assert.match(source, /method: 'POST'/);
  assert.match(source, /buildJob/);
});

test('treats a validated build as a ready snapshot instead of polling forever', () => {
  assert.match(
    source,
    /nextJob\.status === 'validated' \|\| nextJob\.status === 'published'/
  );
  assert.match(
    source,
    /return status === 'validated' \|\| status === 'published'/
  );
});

test('refreshes the overview before the terminal build state aborts the polling effect', () => {
  const pollStart = source.indexOf('const nextJob = await readEnvelope<BuildJob>(response);');
  const refreshIndex = source.indexOf('await loadOverview(controller.signal);', pollStart);
  const terminalStateIndex = source.indexOf('setBuildJob(nextJob);', pollStart);

  assert.ok(pollStart >= 0);
  assert.ok(refreshIndex > pollStart);
  assert.ok(terminalStateIndex > refreshIndex);
});

test('uses bounded server-side graph exploration endpoints', () => {
  assert.match(source, /API_ROOT \+ '\/entities\?'/);
  assert.match(source, /maxHops/);
  assert.match(source, /API_ROOT \+ '\/paths'/);
  assert.match(source, /API_ROOT \+ '\/communities\?'/);
  assert.match(source, /API_ROOT \+ '\/claims\/' \+ encodeURIComponent\(claimId\) \+ '\/sources/);
  assert.match(source, /查看来源/);
  assert.doesNotMatch(source, /KnowledgeGraphViewer/);
  assert.doesNotMatch(source, /action=graph/);
});

test('requires an explicit confirmation before deleting a snapshot', () => {
  assert.match(source, /window\.confirm/);
  assert.match(source, /method: 'DELETE'/);
});

test('keeps management credentials server-side and disables production mutations', () => {
  assert.match(source, /health\?\.managementEnabled === true/);
  assert.match(source, /disabled=\{!managementEnabled \|\| busy === 'snapshot'\}/);
  assert.match(source, /生产环境请通过服务端管理接口/);
  assert.doesNotMatch(source, /authorization/i);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
});

test('requires a non-empty community query and caps claim-source requests', () => {
  assert.match(source, /if \(!communityQuery\.trim\(\)\) return/);
  assert.match(source, /required/);
  assert.match(source, /\/sources\?limit=10/);
});

test('does not render the unauthenticated client console in production', () => {
  assert.match(pageSource, /isKnowledgeGraphConsoleAvailable/);
  assert.match(pageSource, /local-only/);
  assert.match(pageSource, /NODE_ENV/);
  assert.doesNotMatch(pageSource, /TOKEN|authorization|NEXT_PUBLIC/i);
});

test('uses the complete immutable identity as the snapshot React key', () => {
  assert.match(
    source,
    /key=\{snapshot\.identity\.documentId \+ ':' \+ snapshot\.identity\.documentVersion \+ ':' \+ snapshot\.identity\.trustLevel\}/
  );
});

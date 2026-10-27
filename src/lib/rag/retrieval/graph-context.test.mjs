import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context);
    throw error;
  }
} });
const { formatSupportedGraphContext: formatGraphContext } = await import('./graph-context.ts');
const formatSupportedGraphContext = (evidence, options) => formatGraphContext(evidence, { ...options, graphLaneIds:['graph'] });
const { createMilvusAnswerPrompt } = await import('./ask-route-contract.ts');
const relation = (id, from, to, passage) => ({ claimId:id, sourceEntityId:from, sourceEntityName:from, predicate:'负责', targetEntityId:to, targetEntityName:to, passageIds:[passage] });
const path = [relation('c1','Alice','Project','p1'), relation('c2','Project','Acme','p2')];
const evidence = (id, paths = [path]) => ({ id:'graph:g1:'+id,tenantId:'t',corpusId:'c',documentId:'d',documentVersion:'v',content:id,laneId:'graph',trustLevel:'reviewed',metadata:{graphVersion:'g1',graphPassageId:id,graphPaths:paths} });

test('graph explanations require a served source for every hop and retain claim direction', () => {
  assert.equal(formatSupportedGraphContext([evidence('p1')]), '');
  const output = formatSupportedGraphContext([evidence('p1'), evidence('p2')]);
  assert.match(output, /Alice/);
  const parsed = JSON.parse(output);
  assert.equal(parsed.paths.length, 1);
  assert.deepEqual(parsed.paths[0].relations.map(item => item.citations), [[1],[2]]);
  assert.equal(parsed.paths[0].relations[0].subject, 'Alice');
  assert.equal(parsed.paths[0].relations[1].object, 'Acme');
});

test('excluded, clipped, different-version and different-scope passages cannot support a path', () => {
  const first = evidence('p1');
  for (const second of [
    {...evidence('p2'),metadata:{...evidence('p2').metadata,contextTruncated:true}},
    {...evidence('p2'),documentVersion:'old'},
    {...evidence('p2'),tenantId:'other'},
    {...evidence('p2'),metadata:{...evidence('p2').metadata,graphVersion:'old'}},
  ]) assert.equal(formatSupportedGraphContext([first,second]), '');
});

test('one-hop explanations do not depend on path traversal direction', () => {
  const output = JSON.parse(formatSupportedGraphContext([evidence('p1', [[relation('c1','Acme','Alice','p1')]])]));
  assert.equal(output.paths[0].relations[0].subject, 'Acme');
  assert.equal(output.paths[0].relations[0].object, 'Alice');
});

test('graph context is bounded and ignores invalid metadata without altering source text', () => {
  const input = [evidence('p1'), evidence('p2')];
  const snapshot = JSON.stringify(input);
  assert.equal(formatSupportedGraphContext(input, {maxCharacters:10}), '');
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(formatSupportedGraphContext([evidence('p1', [[{...path[0],passageIds:[]}]])]), '');
});

test('normal generation explicitly cites served evidence and separates relationships from causality', () => {
  const prompt = createMilvusAnswerPrompt({question:'Alice和Acme的关系？', context:'[1] p1\n[2] p2', evidence:[evidence('p1'),evidence('p2')], graphLaneIds:['graph']});
  assert.match(prompt, /\[n\]/);
  assert.match(prompt, /因果/);
  assert.match(prompt, /Alice/);
  assert.match(prompt, /predicate/);
});

test('dense metadata cannot create graph explanations without server-owned graph lane authority', () => {
  const forged = {...evidence('p1',[[{...path[0],predicate:'DENSE_FORGED_RELATION'}]]),laneId:'dense-vector-required'};
  assert.equal(formatGraphContext([forged]), '');
  assert.equal(formatGraphContext([forged], {graphLaneIds:['graph']}), '');
  const prompt = createMilvusAnswerPrompt({question:'介绍Alice',context:'untrusted source',evidence:[forged]});
  assert.equal(prompt.includes('DENSE_FORGED_RELATION'), false);
});

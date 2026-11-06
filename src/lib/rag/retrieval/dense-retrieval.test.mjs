import assert from 'node:assert/strict';
import test from 'node:test';

import { executeDenseRetrieval } from './dense-retrieval.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

test('overlaps embedding with setup and search with statistics while respecting initialization', async () => {
  const connection = deferred();
  const embedding = deferred();
  const search = deferred();
  const statistics = deferred();
  const events = [];
  const result = executeDenseRetrieval({
    connect: () => { events.push('connect'); return connection.promise; },
    initialize: async () => { events.push('initialize'); },
    embed: () => { events.push('embed'); return embedding.promise; },
    search: vector => { events.push(['search', vector]); return search.promise; },
    statistics: () => { events.push('statistics'); return statistics.promise; },
    assertNotAborted: () => {},
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['connect', 'embed']);
  connection.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['connect', 'embed', 'initialize']);
  embedding.resolve([1, 2]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['connect', 'embed', 'initialize', ['search', [1, 2]], 'statistics']);
  search.resolve(['hit']);
  statistics.resolve({ count: 1 });
  assert.deepEqual(await result, { results: ['hit'], statistics: { count: 1 } });
});

test('waits for both in-flight branches when one fails and does not search', async () => {
  const connection = deferred();
  const failure = new Error('embedding failed');
  let searched = false;
  let settled = false;
  const result = executeDenseRetrieval({
    connect: () => connection.promise,
    initialize: async () => {},
    embed: async () => { throw failure; },
    search: async () => { searched = true; return []; },
    assertNotAborted: () => {},
  });
  result.catch(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  connection.resolve();
  await assert.rejects(result, error => error === failure);
  assert.equal(searched, false);
});

test('an abort during setup prevents initialization or search after in-flight work settles', async () => {
  const connection = deferred();
  const embedding = deferred();
  const abort = new Error('aborted');
  let aborted = false;
  let initialized = false;
  let searched = false;
  const result = executeDenseRetrieval({
    connect: () => connection.promise,
    initialize: async () => { initialized = true; },
    embed: () => embedding.promise,
    search: async () => { searched = true; return []; },
    assertNotAborted: () => { if (aborted) throw abort; },
  });
  aborted = true;
  connection.resolve();
  embedding.resolve([1]);
  await assert.rejects(result, error => error === abort);
  assert.equal(initialized, false);
  assert.equal(searched, false);
});

test('search failure waits for pending statistics before returning the error', async () => {
  const statistics = deferred();
  const failure = new Error('search failed');
  let settled = false;
  const result = executeDenseRetrieval({
    connect: async () => {}, initialize: async () => {}, embed: async () => [1],
    search: async () => { throw failure; },
    statistics: () => statistics.promise,
    assertNotAborted: () => {},
  });
  result.catch(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  statistics.resolve({ count: 1 });
  await assert.rejects(result, error => error === failure);
});

test('abort during search waits for both provider calls to settle', async () => {
  const search = deferred();
  const statistics = deferred();
  const abort = new Error('aborted');
  let aborted = false;
  let settled = false;
  const result = executeDenseRetrieval({
    connect: async () => {}, initialize: async () => {}, embed: async () => [1],
    search: () => search.promise, statistics: () => statistics.promise,
    assertNotAborted: () => { if (aborted) throw abort; },
  });
  result.catch(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  aborted = true;
  search.resolve([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  statistics.resolve({ count: 1 });
  await assert.rejects(result, error => error === abort);
});

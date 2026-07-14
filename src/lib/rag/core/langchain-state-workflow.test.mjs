import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeImport(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { applyStatePatch } = await import('./langchain-state-workflow.ts');

test('applyStatePatch appends into a fresh array when state did not initialize the channel', () => {
  const patchItems = ['first'];
  const result = applyStatePatch({}, { events: patchItems }, ['events']);

  assert.deepEqual(result.events, ['first']);
  assert.notEqual(result.events, patchItems);

  patchItems.push('mutated');
  assert.deepEqual(result.events, ['first']);
});

test('applyStatePatch preserves append order without mutating existing state arrays', () => {
  const state = { events: ['existing'] };
  const patch = { events: ['next'] };
  const result = applyStatePatch(state, patch, ['events']);

  assert.deepEqual(result.events, ['existing', 'next']);
  assert.deepEqual(state.events, ['existing']);
  assert.notEqual(result.events, state.events);
  assert.notEqual(result.events, patch.events);
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

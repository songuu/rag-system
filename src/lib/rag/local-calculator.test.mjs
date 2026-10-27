import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateExpression } from './local-calculator.ts';

test('arithmetic parser handles precedence, signs, decimals and parentheses', () => {
  for (const [expression, value] of [
    ['3+2*4', 11], ['(3+2)*4', 20], ['-2*(-3+1)', 4],
    ['.5+1.5', 2], ['12%5', 2], ['0.1+0.2', 0.30000000000000004],
  ]) assert.deepEqual(calculateExpression(expression), { success: true, value });
});

test('invalid inputs never execute code or quietly produce a partial answer', () => {
  for (const expression of ['1+', '(1+2', '1+2)', '1..2+3', '1(2)', '2**3', 'process.exit()', 'globalThis.x=1']) {
    assert.equal(calculateExpression(expression).success, false, expression);
  }
  for (const expression of ['1/0', '1%0']) {
    assert.deepEqual(calculateExpression(expression), { success: false, code: 'DIVISION_BY_ZERO' });
  }
});

test('parser bounds length, recursion and unsafe numeric ranges', () => {
  for (const expression of ['('.repeat(20)+'1'+')'.repeat(20), '1+'.repeat(100)+'1', '9999999999999999999+1']) {
    assert.deepEqual(calculateExpression(expression), { success: false, code: 'CALCULATION_LIMIT' });
  }
});

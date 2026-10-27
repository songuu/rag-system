export type CalculationResult =
  | { success: true; value: number }
  | { success: false; code: 'INVALID_EXPRESSION' | 'DIVISION_BY_ZERO' | 'CALCULATION_LIMIT' };

/** Bounded arithmetic grammar. User expressions never become JavaScript code. */
export function calculateExpression(expression: string): CalculationResult {
  if (expression.length > 160) return { success: false, code: 'CALCULATION_LIMIT' };
  const compact = expression.replace(/\s+/gu, '');
  const tokens = compact.match(/(?:\d+(?:\.\d+)?|\.\d+)|[()+*/%-]/gu) || [];
  if (!tokens.length || tokens.join('') !== compact) {
    return { success: false, code: 'INVALID_EXPRESSION' };
  }
  if (tokens.length > 80) return { success: false, code: 'CALCULATION_LIMIT' };
  let index = 0;
  let depth = 0;
  let failure: Exclude<CalculationResult, { success: true }>['code'] | undefined;

  function bounded(value: number): number {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      failure ??= 'CALCULATION_LIMIT';
    }
    return value;
  }
  function atom(): number {
    if (++depth > 16) { failure = 'CALCULATION_LIMIT'; return 0; }
    const token = tokens[index++];
    let value: number;
    if (token === '+' || token === '-') value = (token === '-' ? -1 : 1) * atom();
    else if (token === '(') {
      value = sum();
      if (tokens[index++] !== ')') failure ??= 'INVALID_EXPRESSION';
    } else if (token && /^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(token)) value = Number(token);
    else { failure ??= 'INVALID_EXPRESSION'; value = 0; }
    depth--;
    return bounded(value);
  }
  function product(): number {
    let value = atom();
    while (!failure && ['*', '/', '%'].includes(tokens[index])) {
      const operator = tokens[index++];
      const right = atom();
      if (operator !== '*' && right === 0) { failure = 'DIVISION_BY_ZERO'; return 0; }
      value = bounded(operator === '*' ? value * right : operator === '/' ? value / right : value % right);
    }
    return value;
  }
  function sum(): number {
    let value = product();
    while (!failure && ['+', '-'].includes(tokens[index])) {
      const operator = tokens[index++];
      const right = product();
      value = bounded(operator === '+' ? value + right : value - right);
    }
    return value;
  }
  const value = sum();
  if (failure) return { success: false, code: failure };
  if (index !== tokens.length) return { success: false, code: 'INVALID_EXPRESSION' };
  return { success: true, value: Object.is(value, -0) ? 0 : value };
}

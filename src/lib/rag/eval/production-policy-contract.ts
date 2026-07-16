import { createHash } from 'node:crypto';

import { stableStringify } from './dataset';

export const PRODUCTION_POLICY_CONTRACT_SCHEMA_VERSION =
  'rag-production-policy-contract/v1' as const;
export const PRODUCTION_POLICY_CONTRACT_REPORT_VERSION =
  'rag-production-policy-contract-report/v1' as const;
export const DEFAULT_PRODUCTION_POLICY_CONTRACT_CASE_TIMEOUT_MS = 5_000;
const MAX_PRODUCTION_POLICY_CONTRACT_CASE_TIMEOUT_MS = 300_000;

export type ContractJsonPrimitive = string | number | boolean | null;
export type ContractJsonValue =
  | ContractJsonPrimitive
  | ContractJsonValue[]
  | { [key: string]: ContractJsonValue };
export type ContractJsonObject = { [key: string]: ContractJsonValue };

export interface ProductionPolicyContractCase {
  id: string;
  input: ContractJsonObject;
  expected: ContractJsonValue;
}

export interface ProductionPolicyContractFixture {
  schemaVersion: typeof PRODUCTION_POLICY_CONTRACT_SCHEMA_VERSION;
  suiteId: string;
  suiteVersion: string;
  cases: ProductionPolicyContractCase[];
}

export interface ProductionPolicyContractTarget {
  readonly id: string;
  readonly executionProfile: {
    executionMode: 'hermetic-in-process';
    externalServicePolicy: 'disabled';
    qualityScope: 'control-plane-contract-only';
    productionQualityMeasured: false;
  };
  run(input: ContractJsonObject): Promise<ContractJsonValue>;
}

export interface ProductionPolicyContractEvalOptions {
  caseTimeoutMs?: number;
}

export interface ProductionPolicyContractCaseResult {
  caseId: string;
  status: 'passed' | 'mismatch' | 'non-deterministic' | 'error';
  actual?: ContractJsonValue;
  expected?: ContractJsonValue;
  repeatedActual?: ContractJsonValue;
  error?: string;
}

export interface ProductionPolicyContractReport {
  schemaVersion: typeof PRODUCTION_POLICY_CONTRACT_REPORT_VERSION;
  suite: {
    id: string;
    version: string;
    sha256: string;
  };
  target: {
    id: string;
    executionMode: 'hermetic-in-process';
    externalServicePolicy: 'disabled';
    qualityScope: 'control-plane-contract-only';
    productionQualityMeasured: false;
  };
  passed: boolean;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  cases: ProductionPolicyContractCaseResult[];
}

/**
 * Runs a deterministic, label-blind control-plane contract gate.
 *
 * The target receives only a cloned `input`. Expectations and case labels stay
 * in the evaluator, so this gate cannot be passed by reading the answer key.
 * Every input is executed twice to expose accidental time, randomness, or
 * mutable shared-state dependencies.
 */
export async function runProductionPolicyContractEval(
  fixtureInput: ProductionPolicyContractFixture | unknown,
  target: ProductionPolicyContractTarget,
  options: ProductionPolicyContractEvalOptions = {}
): Promise<ProductionPolicyContractReport> {
  const fixture = parseProductionPolicyContractFixture(fixtureInput);
  const targetId = expectNonEmptyString(target.id, 'target.id');
  validateExecutionProfile(target.executionProfile);
  const caseTimeoutMs = parseCaseTimeoutMs(options.caseTimeoutMs);
  const results: ProductionPolicyContractCaseResult[] = [];

  for (const contractCase of fixture.cases) {
    try {
      const first = await runTargetWithTimeout(
        target,
        cloneJson(contractCase.input),
        caseTimeoutMs,
        'initial'
      );
      assertJsonValue(first, `target result for ${contractCase.id}`);
      const second = await runTargetWithTimeout(
        target,
        cloneJson(contractCase.input),
        caseTimeoutMs,
        'repeated'
      );
      assertJsonValue(second, `repeated target result for ${contractCase.id}`);
      const firstEncoded = stableStringify(first);
      const secondEncoded = stableStringify(second);
      if (firstEncoded !== secondEncoded) {
        results.push({
          caseId: contractCase.id,
          status: 'non-deterministic',
          actual: first,
          repeatedActual: second,
        });
        continue;
      }
      if (firstEncoded !== stableStringify(contractCase.expected)) {
        results.push({
          caseId: contractCase.id,
          status: 'mismatch',
          actual: first,
          expected: cloneJson(contractCase.expected),
        });
        continue;
      }
      results.push({
        caseId: contractCase.id,
        status: 'passed',
      });
    } catch (error) {
      results.push({
        caseId: contractCase.id,
        status: 'error',
        error: formatError(error),
      });
    }
  }

  const passedCases = results.filter(result => result.status === 'passed').length;
  return {
    schemaVersion: PRODUCTION_POLICY_CONTRACT_REPORT_VERSION,
    suite: {
      id: fixture.suiteId,
      version: fixture.suiteVersion,
      sha256: createHash('sha256')
        .update(stableStringify(fixture))
        .digest('hex'),
    },
    target: {
      id: targetId,
      ...target.executionProfile,
    },
    passed: passedCases === results.length,
    totalCases: results.length,
    passedCases,
    failedCases: results.length - passedCases,
    cases: results,
  };
}

async function runTargetWithTimeout(
  target: ProductionPolicyContractTarget,
  input: ContractJsonObject,
  timeoutMs: number,
  attempt: 'initial' | 'repeated'
): Promise<ContractJsonValue> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(
        new Error(
          `[rag production contract] target ${attempt} execution timed out after ${timeoutMs}ms.`
        )
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => target.run(input)),
      timeoutPromise,
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function parseCaseTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_PRODUCTION_POLICY_CONTRACT_CASE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > MAX_PRODUCTION_POLICY_CONTRACT_CASE_TIMEOUT_MS
  ) {
    throw new Error(
      `[rag production contract] options.caseTimeoutMs must be an integer between 1 and ${MAX_PRODUCTION_POLICY_CONTRACT_CASE_TIMEOUT_MS}.`
    );
  }
  return timeoutMs;
}

function validateExecutionProfile(
  profile: ProductionPolicyContractTarget['executionProfile']
): void {
  if (
    profile?.executionMode !== 'hermetic-in-process'
    || profile.externalServicePolicy !== 'disabled'
    || profile.qualityScope !== 'control-plane-contract-only'
    || profile.productionQualityMeasured !== false
  ) {
    throw new Error(
      '[rag production contract] target must declare the hermetic contract-only execution profile.'
    );
  }
}

export function parseProductionPolicyContractFixture(
  input: unknown
): ProductionPolicyContractFixture {
  const root = expectRecord(input, '$');
  if (root.schemaVersion !== PRODUCTION_POLICY_CONTRACT_SCHEMA_VERSION) {
    throw new Error(
      `[rag production contract] $.schemaVersion must be ${PRODUCTION_POLICY_CONTRACT_SCHEMA_VERSION}.`
    );
  }
  const casesInput = expectArray(root.cases, '$.cases');
  if (casesInput.length === 0) {
    throw new Error('[rag production contract] $.cases must not be empty.');
  }
  const seen = new Set<string>();
  const cases = casesInput.map((value, index): ProductionPolicyContractCase => {
    const path = `$.cases[${index}]`;
    const item = expectRecord(value, path);
    const id = expectNonEmptyString(item.id, `${path}.id`);
    if (seen.has(id)) {
      throw new Error(`[rag production contract] ${path}.id is duplicated: ${id}.`);
    }
    seen.add(id);
    const contractInput = expectRecord(item.input, `${path}.input`);
    expectNonEmptyString(contractInput.kind, `${path}.input.kind`);
    assertLabelBlindInput(contractInput, `${path}.input`);
    assertJsonValue(contractInput, `${path}.input`);
    assertJsonValue(item.expected, `${path}.expected`);
    return {
      id,
      input: cloneJson(contractInput),
      expected: cloneJson(item.expected as ContractJsonValue),
    };
  });
  return {
    schemaVersion: PRODUCTION_POLICY_CONTRACT_SCHEMA_VERSION,
    suiteId: expectNonEmptyString(root.suiteId, '$.suiteId'),
    suiteVersion: expectNonEmptyString(root.suiteVersion, '$.suiteVersion'),
    cases,
  };
}

function assertLabelBlindInput(
  value: Record<string, unknown>,
  path: string,
  depth = 0
): void {
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const isRootCaseLabel =
      depth === 0 && ['id', 'caseid', 'tags'].includes(normalizedKey);
    const isOracleField =
      /expected|gold|answerkey|groundtruth|oracle|label/.test(normalizedKey);
    if (isRootCaseLabel || isOracleField) {
      throw new Error(
        `[rag production contract] ${path}.${key} is a reserved evaluator-only field.`
      );
    }
    if (Array.isArray(item)) {
      item.forEach((child, index) => {
        if (child && typeof child === 'object' && !Array.isArray(child)) {
          assertLabelBlindInput(
            child as Record<string, unknown>,
            `${path}.${key}[${index}]`,
            depth + 1
          );
        }
      });
    } else if (item && typeof item === 'object') {
      assertLabelBlindInput(
        item as Record<string, unknown>,
        `${path}.${key}`,
        depth + 1
      );
    }
  }
}

function assertJsonValue(value: unknown, label: string): asserts value is ContractJsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${label}[${index}]`));
    return;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, `${label}.${key}`);
    }
    return;
  }
  throw new Error(`[rag production contract] ${label} must be finite plain JSON.`);
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`[rag production contract] ${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`[rag production contract] ${path} must be an array.`);
  }
  return value;
}

function expectNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`[rag production contract] ${path} must be a non-empty string.`);
  }
  return value.trim();
}

function cloneJson<T extends ContractJsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

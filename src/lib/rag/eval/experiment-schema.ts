import { z } from 'zod';
const text = z.string().trim().min(1).max(1024);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const knownVersion = text.refine(value => !/^(unknown|unversioned|latest)$/i.test(value), 'an immutable version is required');
const model = z.object({ provider: text, name: text, revision: knownVersion }).strict();
export const configurationSchema = z.object({
  implementationSha256: digest, promptSha256: digest,
  model: model.extend({ parameters: z.record(z.string(), z.unknown()) }).strict(),
  embedding: model.extend({ dimensions: z.number().int().positive() }).strict(),
  index: z.object({ id: text, revision: knownVersion }).strict(),
  retrieval: z.object({ topK: z.number().int().positive().max(1000), similarityThreshold: z.number().min(0).max(1) }).strict(),
  rerank: z.object({ enabled: z.boolean(), provider: text, model: text, revision: knownVersion, topN: z.number().int().positive() }).strict(),
  context: z.object({ maxTokens: z.number().int().positive() }).strict(),
  cache: z.object({ mode: z.enum(['disabled', 'bypass', 'cold', 'warm']), identity: text }).strict(),
}).strict();
export const factors = ['implementationSha256', 'promptSha256', 'model', 'embedding', 'index', 'retrieval', 'rerank', 'context', 'cache'] as const;
const reviewSchema = z.object({ reviewer: text, reviewedAt: z.string().datetime({ offset: true }) }).strict();
export const optionsSchema = z.object({ review: reviewSchema, configuration: configurationSchema,
  variablePaths: z.array(z.enum(factors)).max(factors.length - 1).default([]) }).strict();
export const contractSchema = optionsSchema.extend({ schemaVersion: z.literal('rag-eval-experiment/v1'),
  datasetSha256: digest, corpusSha256: digest, configurationHash: digest, comparisonHash: digest }).strict();

/** Recompute comparison from actual fields, not a possibly forged imported hash. Browser-safe. */
export function experimentComparisonIssues(baseline: z.infer<typeof contractSchema>, candidate: z.infer<typeof contractSchema>): string[] {
  const issues: string[] = [];
  if (baseline.datasetSha256 !== candidate.datasetSha256 || baseline.corpusSha256 !== candidate.corpusSha256) issues.push('评测集或知识库快照不同。');
  const stable = (value: unknown): string => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
    : value !== null && typeof value === 'object' ? '{' + Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => JSON.stringify(k) + ':' + stable(v)).join(',') + '}' : JSON.stringify(value);
  const fixed = (input: z.infer<typeof contractSchema>) => ({ variablePaths: [...input.variablePaths].sort(),
    configuration: Object.fromEntries(Object.entries(input.configuration).filter(([key]) => !input.variablePaths.includes(key as typeof factors[number]))) });
  if (stable(fixed(baseline)) !== stable(fixed(candidate))) issues.push('非实验变量的配置发生变化，无法比较优化收益。');
  return issues;
}

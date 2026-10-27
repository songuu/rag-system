import { parseRagEvalDataset } from './dataset-parser';
import type { RagEvalCase, RagEvalDataset } from './types';

/** Drafts require all answer and evidence annotations before review or export. */
export function validateDatasetDraft(dataset: RagEvalDataset): string[] {
  try {
    const parsed = parseRagEvalDataset(dataset);
    const errors: string[] = [];
    const queries = new Set<string>();
    for (const [index, item] of parsed.cases.entries()) {
      const label = `第 ${index + 1} 题`;
      const normalizedQuery = item.query.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
      if (queries.has(normalizedQuery)) errors.push(`${label}：问题与其他题目重复。`);
      queries.add(normalizedQuery);
      if (item.expectedAbstain) {
        errors.push(`${label}：当前生成器只支持有资料依据的可回答题。`);
        continue;
      }
      if (!item.expectedAnswer?.referenceAnswer?.trim()) errors.push(`${label}：请填写参考答案。`);
      if (!item.expectedAnswer?.requiredFacts.length) errors.push(`${label}：请填写答案要点。`);
      if (!item.goldEvidence.length || item.goldEvidence.some(gold => !gold.spans?.length)) {
        errors.push(`${label}：请保留至少一条含原文区间的相关资料标注。`);
      }
    }
    return errors;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const caseMatch = /\$\.cases\[(\d+)\]/.exec(message);
    const label = caseMatch ? `第 ${Number(caseMatch[1]) + 1} 题：` : '';
    if (/\.query:/.test(message)) return [label + '请填写问题。'];
    if (/\.referenceAnswer:/.test(message)) return [label + '请填写参考答案。'];
    if (/\.requiredFacts/.test(message)) return [label + '请填写答案要点，每项至少包含一种有效表达。'];
    if (/\.goldEvidence/.test(message)) return [label + '资料标注无效，请检查来源、相关度和原文区间。'];
    if (message.includes('$.cases:')) return ['请至少保留一道完整的题目后再导出。'];
    return [label + '测试集格式不完整，请检查题目和资料标注。'];
  }
}

export function updateDraftCase(dataset: RagEvalDataset, caseId: string, patch: Partial<RagEvalCase>): RagEvalDataset {
  return {
    ...dataset,
    cases: dataset.cases.map(item => item.id === caseId ? {
      ...item, ...patch, id: item.id,
      tags: [...item.tags.filter(tag => tag !== 'human-reviewed' && tag !== 'needs-review'), 'needs-review'],
    } : item),
  };
}

export function reviewDraftCase(dataset: RagEvalDataset, caseId: string): RagEvalDataset {
  const index = dataset.cases.findIndex(value => value.id === caseId);
  const item = dataset.cases[index];
  if (!item) throw new Error('要审核的题目已不存在。');
  const errors = validateDatasetDraft({ ...dataset, cases: [item] });
  if (errors.length) throw new Error(errors.map(message => message.replace(/^第 1 题：/, `第 ${index + 1} 题：`)).join('\n'));
  return {
    ...dataset,
    cases: dataset.cases.map(value => value.id === caseId ? {
      ...value,
      tags: [...value.tags.filter(tag => tag !== 'needs-review' && tag !== 'human-reviewed'), 'human-reviewed'],
    } : value),
  };
}

export function serializeDatasetDraft(dataset: RagEvalDataset): string {
  const errors = validateDatasetDraft(dataset);
  if (errors.length) throw new Error(errors.join('\n'));
  return JSON.stringify(parseRagEvalDataset(dataset), null, 2);
}

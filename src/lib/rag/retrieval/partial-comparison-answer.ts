import type { RagEvidence } from '../core/types';

export const COMPARISON_RERANK_SCORE_FLOOR = 0.001;

export const PARTIAL_COMPARISON_SOURCE_SCHEMA = {
  type: 'object', properties: {
    coverage: { type: 'string', enum: ['complete', 'partial', 'none'] },
    evidenceNumbers: { type: 'array', maxItems: 3, items: { type: 'integer', minimum: 1 } },
  }, required: ['coverage', 'evidenceNumbers'], additionalProperties: false,
};

export async function resolvePartialComparisonAnswer(input: {
  question: string;
  evidence: readonly Pick<RagEvidence, 'content' | 'rerankScore'>[];
  selectEvidence: (allowedNumbers: readonly number[]) => Promise<unknown>;
  generateAnswer: () => Promise<string>;
}): Promise<string> {
  if (!/(比较|对比|差异|不同|区别|compare|difference|versus|\bvs\b)/i.test(input.question)
    || input.evidence.length === 0) return input.generateAnswer();
  // Only apply this near-zero floor when every score uses the bounded scale.
  // Out-of-range raw scores and absent scores retain the original selection path.
  const boundedScores = input.evidence.every(item => typeof item.rerankScore === 'number'
    && Number.isFinite(item.rerankScore) && item.rerankScore >= 0 && item.rerankScore <= 1);
  const allowedNumbers = input.evidence.flatMap((item, index) =>
    boundedScores && item.rerankScore! < COMPARISON_RERANK_SCORE_FLOOR ? [] : [index + 1]);
  if (allowedNumbers.length === 0) return '当前知识库缺少与这个比较问题相关的资料，无法确认差异。';
  const selection = await input.selectEvidence(allowedNumbers);
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    throw new Error('Comparison source selection returned an invalid coverage decision.');
  }
  const { coverage, evidenceNumbers } = selection as Record<string, unknown>;
  if (typeof coverage !== 'string' || !['complete', 'partial', 'none'].includes(coverage)
    || !Array.isArray(evidenceNumbers) || evidenceNumbers.length > 3
    || evidenceNumbers.some(number => !Number.isSafeInteger(number) || !allowedNumbers.includes(number))
    || (coverage === 'none' ? evidenceNumbers.length !== 0 : evidenceNumbers.length === 0)) {
    throw new Error('Comparison source selection returned an invalid evidence reference or coverage decision.');
  }
  if (coverage === 'complete') return input.generateAnswer();
  if (coverage === 'none') return '当前知识库缺少与这个比较问题相关的资料，无法确认差异。';
  // Partial coverage uses exact source text: the generator must not turn a
  // general fact into an unsupported claim about one comparison subject.
  const excerpts = [...new Set<number>(evidenceNumbers)].map(number => {
    const characters = Array.from(input.evidence[number - 1].content.trim());
    if (characters.length === 0) throw new Error('Comparison source selection referenced an empty passage.');
    const excerpt = characters.slice(0, 400).join('').replace(/\[(\d[\d\s,，\-–—]*)\]/g, '［$1］');
    return '[' + number + '] 原文：' + excerpt + (characters.length > 400 ? '…' : '');
  });
  return '现有材料无法支持完整比较。\n\n有依据的事实：\n' + excerpts.join('\n\n')
    + '\n\n无法确认的部分：当前材料缺少完整比较所需的各方依据，无法确认比较对象之间的差异。';
}

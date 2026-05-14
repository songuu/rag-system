import type { RagEvidence } from './types';

export interface ContextComposerOptions {
  maxCharacters?: number;
  includeScores?: boolean;
}

export function composeEvidenceContext(
  evidence: RagEvidence[],
  options: ContextComposerOptions = {}
): string {
  const maxCharacters = options.maxCharacters ?? 12000;
  const includeScores = options.includeScores ?? true;
  let used = 0;
  const parts: string[] = [];

  for (let index = 0; index < evidence.length; index++) {
    const item = evidence[index];
    const scoreText =
      includeScores && typeof item.score === 'number'
        ? ` (score: ${item.score.toFixed(4)})`
        : '';
    const sourceText = item.source ? ` (source: ${item.source})` : '';
    const block = `[${index + 1}]${scoreText}${sourceText}\n${item.content}`;

    if (used + block.length > maxCharacters) {
      break;
    }

    parts.push(block);
    used += block.length;
  }

  return parts.join('\n\n');
}


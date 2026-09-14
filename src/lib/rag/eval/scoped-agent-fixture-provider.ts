import { AIMessage } from '@langchain/core/messages';
import { FakeToolCallingModel } from 'langchain';

import type { RagEvidence } from '../core/types';
import type { ScopedAgentEvalRetrievalInput, ScopedAgentEvalRerankInput } from './scoped-agent-target';

const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'at', 'for', 'in', 'is', 'of', 'the', 'to', 'what', 'when', 'which', 'who', 'how']);
const STOP_BIGRAMS = new Set(['什么', '的是', '是谁', '多少', '如何', '是否', '请问', '当前', '根据', '可以', '安排']);

function tokens(text: string): Set<string> {
  const normalized = text.normalize('NFKC').toLowerCase();
  const words = (normalized.match(/[a-z0-9]+(?:[-_.][a-z0-9]+)*/g) ?? []).filter(word => !STOP_WORDS.has(word));
  const bigrams = [...normalized.matchAll(/[\p{Script=Han}]+/gu)].flatMap(match => {
    const chars = [...match[0]];
    return chars.slice(1).map((char, index) => chars[index] + char).filter(token => !STOP_BIGRAMS.has(token));
  });
  return new Set([...words, ...bigrams]);
}
function lexicalScore(query: string, content: string): number {
  const queryTokens = tokens(query);
  const documentTokens = tokens(content);
  if (!queryTokens.size || !documentTokens.size) return 0;
  const matches = [...queryTokens].filter(token => documentTokens.has(token)).length;
  return matches / Math.sqrt(queryTokens.size * documentTokens.size);
}

/** Scope is enforced before scoring; only query and canonical corpus are available. */
export function createScopedFixtureRetriever() {
  return async ({ query, scope, corpus, topK, signal }: ScopedAgentEvalRetrievalInput): Promise<RagEvidence[]> => {
    signal.throwIfAborted();
    return corpus
      .filter(item => item.tenantId === scope.tenantId && item.corpusId === scope.corpusId
        && item.trustLevel !== undefined && item.trustLevel !== 'quarantined'
        && scope.allowedTrustLevels.includes(item.trustLevel))
      .map(item => ({ item, score: lexicalScore(query, item.content) }))
      .filter(candidate => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.item.evidenceId.localeCompare(right.item.evidenceId))
      .slice(0, topK)
      .map(({ item, score }) => ({
        id: item.evidenceId, tenantId: item.tenantId!, corpusId: item.corpusId!,
        documentId: item.documentId, documentVersion: item.documentVersion!,
        trustLevel: item.trustLevel!, source: item.source, content: item.content,
        retrievalScore: score, laneId: 'scoped-fixture-lexical',
      }));
  };
}

/** A transparent fixture reranker, not a claim about production cross-encoder quality. */
export async function rerankScopedFixtureEvidence({ query, evidence, signal }: ScopedAgentEvalRerankInput): Promise<RagEvidence[]> {
  signal.throwIfAborted();
  const trustRank = { trusted: 3, reviewed: 2, external: 1, quarantined: 0 };
  return evidence.map(item => ({
    ...item,
    rerankScore: trustRank[item.trustLevel] + lexicalScore(query, item.content)
      + (/\bcurrent\b|现行|当前有效/iu.test(item.content) ? 0.5 : 0),
  })).sort((left, right) => right.rerankScore - left.rerankScore || left.id.localeCompare(right.id));
}

/** Hermetic tool-calling adapter: decisions depend only on visible tool context.
 * It intentionally selects the first relevant passage so ranking defects remain
 * observable, and follows explicit document cross-references for multi-hop cases.
 */
export function createScopedFixtureModel(): FakeToolCallingModel {
  const fields = { toolCalls: [], maxRetries: 0 };
  const model = new FakeToolCallingModel(fields);
  let toolNames: string[] = [];
  let structuredDecision = false;
  let requestIndex = 0;
  model.bindTools = tools => {
    structuredDecision = tools.length === 0;
    toolNames = tools.map(item => {
      const candidate = item as unknown as { name?: string; function?: { name?: string } };
      return candidate.name ?? candidate.function?.name ?? '';
    });
    return model;
  };
  model._generate = async messages => {
    const toolMessages = messages.filter(message => message.getType() === 'tool');
    const toolCall = (name: string, args: Record<string, unknown>) => {
      const message = structuredDecision
        ? new AIMessage(JSON.stringify({ action: 'search', query: args.query, answer: '', evidenceNumbers: [] }))
        : new AIMessage({ content: '', tool_calls: [{ name, args, id: 'fixture-tool-' + requestIndex++ }] });
      return { generations: [{ text: '', message }] };
    };
    if (toolMessages.length === 0) return toolCall('read_scoped_rag_context', {});
    const snapshots = toolMessages.flatMap(message => {
      try {
        const payload = JSON.parse(String(message.content)) as { context?: string; evidence_ids?: string[] };
        return typeof payload.context === 'string' ? [payload.context] : [];
      } catch { return []; }
    });
    const context = snapshots.at(-1) ?? '';
    const crossReference = /关联检索[：:]\s*([a-zA-Z0-9._-]+)/u.exec(context)?.[1];
    if (crossReference && toolMessages.length === 1 && (structuredDecision || toolNames.includes('search_scoped_rag_context'))) {
      return toolCall('search_scoped_rag_context', { query: crossReference });
    }
    const passages = [...context.matchAll(/^\[(\d+)\][^\n]*\n([\s\S]*?)(?=\n\n\[\d+\]|$)/gm)]
      .map(match => ({ number: match[1], content: match[2].trim() }))
      // The local fake must not reproduce embedded commands. Live models are
      // evaluated against the same injection content without fake preprocessing.
      .filter(item => !/ignore (?:all |previous )?instructions|忽略.{0,10}指令|system override/iu.test(item.content));
    // A multi-hop answer needs the visible link and the linked fact, not only
    // the destination fact. Selection still uses tool content, never eval gold.
    const resolvedPassages = crossReference && toolMessages.length > 1
      ? passages.filter(item => item.content.includes(crossReference))
      : passages.slice(0, 1);
    const answer = resolvedPassages.length
      ? resolvedPassages.map(item => item.content + ' [' + item.number + ']').join('\n')
      : '根据当前知识库无法回答该问题。';
    const content = structuredDecision
      ? JSON.stringify({ action: resolvedPassages.length ? 'answer' : 'abstain', query: '', answer,
        evidenceNumbers: resolvedPassages.map(item => Number(item.number)) }) : answer;
    return { generations: [{ text: content, message: new AIMessage(content) }] };
  };
  return model;
}

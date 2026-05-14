import type { RagPolicyId } from '../core/types';

export interface GoldenQuestion {
  id: string;
  question: string;
  expectedPolicy?: RagPolicyId;
  requiredEvidenceHint?: string;
  tags: string[];
}

export const DEFAULT_RAG_GOLDEN_QUESTIONS: GoldenQuestion[] = [
  {
    id: 'basic-memory-smoke',
    question: '什么是人工智能?',
    expectedPolicy: 'memory',
    tags: ['smoke', 'memory'],
  },
  {
    id: 'milvus-semantic-smoke',
    question: '从知识库中检索机器学习相关内容',
    expectedPolicy: 'milvus-2step',
    tags: ['smoke', 'milvus'],
  },
  {
    id: 'agentic-quality-smoke',
    question: '如果检索结果质量不足,应该如何改写查询?',
    expectedPolicy: 'agentic',
    tags: ['smoke', 'agentic'],
  },
  {
    id: 'entity-routing-smoke',
    question: '找出苹果公司与智能手机相关的实体信息',
    expectedPolicy: 'adaptive-entity',
    tags: ['smoke', 'entity'],
  },
];

export function selectGoldenQuestionsByPolicy(policyId: RagPolicyId): GoldenQuestion[] {
  return DEFAULT_RAG_GOLDEN_QUESTIONS.filter(question => question.expectedPolicy === policyId);
}


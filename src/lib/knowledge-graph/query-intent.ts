import { classifyRetrievalQuery } from '../rag/retrieval/retrieval-router';

export type GraphQueryIntent = 'entity' | 'relationship' | 'global' | 'none';

/** A graph is an optional capability; recognizing intent never grants access. */
export function classifyGraphQueryIntent(question: string): GraphQueryIntent {
  const query = question.normalize('NFKC').trim();
  const kind = classifyRetrievalQuery(query).queryKind;
  if (kind === 'global') return 'global';
  if (kind === 'multi-hop' || /(?:什么关系|何种关系|有何关联|之间.{0,12}(?:关系|关联)|(?:与|和|及).{1,40}(?:的关系|关联)|通过.{0,16}(?:联系|关联)|relations?hips?\s+between|connected\s+to)/iu.test(query)) {
    return 'relationship';
  }
  // Identifier lookups retain lexical routing, including error-code questions.
  // Quoted entity names remain eligible through the explicit entity signals.
  if (/(?:是谁|谁是|谁负责|负责人|负责哪些|参与哪些|担任|任职|职位|职责|介绍一下|介绍.{1,40}|哪些项目|\bwho\s+(?:is|are)\b|\bwhat\s+projects\b)/iu.test(query)) {
    return 'entity';
  }
  return 'none';
}

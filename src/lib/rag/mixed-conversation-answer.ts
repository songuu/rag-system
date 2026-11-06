import { resolveSelfReport } from './conversation-chat';
import { isAnswerProcessingDetails } from './answer-processing';

type UserTurn = { role: 'user' | 'assistant'; content: string };

/** Combine only a separately validated user statement with a completed JSON RAG response.
 * The RAG envelope, evidence and citations remain owned by the retrieval path.
 */
export async function composeMixedConversationAnswer(
  response: Response,
  candidate: { question: string; history: readonly UserTurn[]; userTurnIndex: number; quote: string },
  signal?: AbortSignal,
): Promise<{ response: Response; combined: boolean }> {
  const unchanged = { response, combined: false };
  const { question, history, userTurnIndex, quote } = candidate;
  const noUserHistory = userTurnIndex === -1 && !history.some(turn => turn.role === 'user') && quote === '';
  if (signal?.aborted || !Number.isInteger(userTurnIndex) || userTurnIndex < -1
    || (!noUserHistory && (userTurnIndex < 0 || userTurnIndex >= history.length || history[userTurnIndex]?.role !== 'user'
      || history[userTurnIndex].content !== quote))
    || history.slice(userTurnIndex + 1).some(turn => turn.role === 'user')
    || typeof question !== 'string' || !hasIndependentIdentityClause(question)
    || typeof quote !== 'string' || quote.length > 1000
    || response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return unchanged;
  const resolved = resolveSelfReport(question, history);
  const report = resolved?.quote ?? '';
  const safeSelfReport = Boolean(report.trim())
    && !/(?:忽略|规则|泄露|密码|系统|指令|秘密|密钥|文档|知识库|然后|以及|并且|告诉我|执行)/u.test(report)
    // Markdown/citation syntax could turn quoted user input into a forged link or reference.
    && !/[\r\n\[\]<>`*_\\]/u.test(report);
  const conversationAnswer = safeSelfReport
    ? `你在本次对话中说过：“${report}”。`
    : '无法确认你在本次对话中的身份或称呼，请告诉我你希望如何称呼。';
  try {
    const body: unknown = await response.clone().json();
    if (signal?.aborted || !body || typeof body !== 'object' || Array.isArray(body)
      || !('success' in body) || body.success !== true
      || !('answer' in body) || typeof body.answer !== 'string') return unchanged;
    const headers = new Headers(response.headers);
    for (const header of ['content-length', 'content-encoding', 'etag', 'last-modified', 'digest', 'content-md5']) headers.delete(header);
    headers.set('cache-control', 'no-store');
    const existingSources = 'answerSources' in body && Array.isArray(body.answerSources)
      ? body.answerSources.filter((source): source is string => typeof source === 'string') : [];
    const answerSources = [...new Set([...existingSources, 'conversation'])];
    const originalProcessing = 'processing' in body && isAnswerProcessingDetails(body.processing) ? body.processing : undefined;
    let conversationStepId = 'conversation-context';
    while (originalProcessing?.steps.some(step => step.id === conversationStepId)) conversationStepId += '-additional';
    const processing = originalProcessing && { ...originalProcessing,
      summary: `已处理会话追问；${originalProcessing.summary}`,
      steps: [{ id: conversationStepId, label: '处理会话追问',
        detail: safeSelfReport ? '仅使用用户在本次会话中的陈述，未作为知识库证据。' : '没有可确认的会话自述，已请求澄清。',
        status: 'completed' as const }, ...originalProcessing.steps] };
    return { combined: true, response: new Response(JSON.stringify({ ...body, question,
      answerSources, ...(processing ? { processing } : {}),
      answer: `${conversationAnswer}\n\n${body.answer}`,
    }), { status: response.status, statusText: response.statusText, headers }) };
  } catch {
    return unchanged;
  }
}

function hasIndependentIdentityClause(question: string): boolean {
  return splitMixedIdentityQuestion(question) !== null;
}

/** Return the independent knowledge task only when the identity clause is unambiguous.
 * A quote or work title could refer to the words rather than the user, so do not split it.
 */
export function splitMixedIdentityQuestion(question: string): string | null {
  if (!question || /["'“”‘’《》「」『』]/u.test(question)) return null;
  const pieces = question.split(/([,，;；。！？!?]|以及|然后|并且)/u);
  const identityIndices = pieces.flatMap((piece, index) => index % 2 === 0
    && /^(?:我是谁|我叫什么(?:名字)?|我的名字是什么|我是你(?:的)?(?:谁|什么人))$/u.test(piece.normalize('NFKC').trim()) ? [index] : []);
  if (identityIndices.length !== 1) return null;
  const index = identityIndices[0];
  if (index < pieces.length - 1) pieces.splice(index, 2);
  else pieces.splice(index - 1, 2);
  const remainder = pieces.join('').replace(/^(?:\s|[,，;；。！？!?]|以及|然后|并且)+/u, '').trim();
  return remainder ? remainder : null;
}

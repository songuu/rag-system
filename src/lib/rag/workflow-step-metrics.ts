/** Public execution counters, shared by live responses, durable replay and the viewer. */
const COUNTERS = ['evidenceCount', 'laneCount', 'modelCallIndex', 'toolCallCount', 'answerCharacterCount', 'searchCallCount'] as const;
const STOP_REASONS = ['sufficient', 'budget', 'max_steps', 'no_gain', 'failed', 'capability_unavailable'] as const;
type Counter = typeof COUNTERS[number];
export type WorkflowStepMetrics = Partial<Record<Counter, number>> & { stopReason?: typeof STOP_REASONS[number] };

/** Never forward arbitrary provider metadata, prompts, tool arguments or document text. */
export function parseWorkflowStepMetrics(value: unknown): WorkflowStepMetrics | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const metrics: WorkflowStepMetrics = {};
  for (const key of COUNTERS) {
    if (typeof input[key] === 'number' && Number.isSafeInteger(input[key]) && input[key] >= 0) metrics[key] = input[key];
  }
  if (STOP_REASONS.some(reason => reason === input.stopReason)) metrics.stopReason = input.stopReason as WorkflowStepMetrics['stopReason'];
  return Object.keys(metrics).length ? metrics : undefined;
}

export function workflowStepMetricEntries(value: unknown): Array<[string, string]> {
  const metrics = parseWorkflowStepMetrics(value);
  if (!metrics) return [];
  const fields: Array<[Counter, string, string]> = [
    ['evidenceCount', '证据数量', '条'], ['laneCount', '检索通道', '个'],
    ['modelCallIndex', '模型调用序号', ''], ['toolCallCount', '工具调用', '次'],
    ['answerCharacterCount', '回答长度', '字符'], ['searchCallCount', '补充检索', '次'],
  ];
  const entries: Array<[string, string]> = fields.flatMap<[string, string]>(([key, label, unit]) => (
    metrics[key] !== undefined ? [[label, `${metrics[key].toLocaleString('zh-CN')}${unit ? ' ' + unit : ''}`]] : []
  ));
  const stopLabels = { sufficient: '满足停止条件', budget: '达到预算', max_steps: '达到步骤上限', no_gain: '没有新增证据', failed: '执行失败', capability_unavailable: '依赖不可用' };
  if (metrics.stopReason) entries.push(['停止原因', stopLabels[metrics.stopReason]]);
  return entries;
}

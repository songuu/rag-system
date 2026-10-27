/** Server workflow budgets and the browser allowance derived from them. */
export const RAG_RETRIEVAL_EXECUTION_BUDGET_MS = 30_000;
// Model weights can take longer to load than retrieval itself. Preparation is
// bounded separately so cold starts do not consume the useful search budget.
export const RAG_EMBEDDING_WARMUP_BUDGET_MS = 90_000;
const OLLAMA_GENERATION_EXECUTION_BUDGET_MS = 240_000;
const REMOTE_GENERATION_EXECUTION_BUDGET_MS = 90_000;

export function resolveRagGenerationExecutionBudgetMs(provider?: string): number {
  // Cold loading a local GLM model took 173s, before any answer tokens arrived.
  // Leave room for that startup and generation while keeping a finite deadline.
  return !provider || provider === 'ollama'
    ? OLLAMA_GENERATION_EXECUTION_BUDGET_MS
    : REMOTE_GENERATION_EXECUTION_BUDGET_MS;
}

export const RAG_GENERATION_EXECUTION_BUDGET_MS = resolveRagGenerationExecutionBudgetMs(
  process.env.MODEL_PROVIDER
);
export function resolveRagAgenticExecutionBudgetMs(provider?: string): number {
  // Agentic final answers use the selected model too. Their whole-workflow
  // deadline must allow the same cold startup as an ordinary answer.
  return RAG_RETRIEVAL_EXECUTION_BUDGET_MS + resolveRagGenerationExecutionBudgetMs(provider);
}
export const RAG_AGENTIC_EXECUTION_BUDGET_MS = resolveRagAgenticExecutionBudgetMs(process.env.MODEL_PROVIDER);
export const RAG_CLIENT_NETWORK_ALLOWANCE_MS = 15_000;

export const RAG_CLIENT_REQUEST_TIMEOUT_MS = Math.max(
  // The browser cannot read the server's private MODEL_PROVIDER setting, so it
  // must cover the longest supported server budget even for remote providers.
  RAG_RETRIEVAL_EXECUTION_BUDGET_MS + OLLAMA_GENERATION_EXECUTION_BUDGET_MS,
  RAG_AGENTIC_EXECUTION_BUDGET_MS
) + RAG_EMBEDDING_WARMUP_BUDGET_MS + RAG_CLIENT_NETWORK_ALLOWANCE_MS;


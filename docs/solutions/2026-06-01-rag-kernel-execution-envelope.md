# RAG Kernel Execution Envelope

## Problem

`RagKernel` produced a useful envelope only on successful policy execution. If a policy adapter threw an unhandled exception, `/api/ask` fell back to the top-level route catch with a raw error message and no kernel trace header. That broke the workflow discipline from the latest Claude Code guidance: autonomous execution needs a stable plan/execute/verify/review trail even when the execution fails.

## Solution

- Add `status: completed | failed` to `RagKernelEnvelope`.
- Add `RagKernelErrorSummary` and `RagKernelExecutionError`.
- Wrap policy exceptions inside `RagKernel.execute()` with a failed envelope containing trace id, policy id, duration, default retrieval plan, policy description, and error summary.
- Let `/api/ask` attach `x-rag-policy` and `x-rag-trace-id` to top-level 500 responses when the failure came from the kernel.
- Preserve legacy response JSON behavior; this sprint improves observability, not answer semantics.

## Validation

- `node --experimental-strip-types --test src/lib/rag/core/kernel.test.mjs` -> pass
- `node --experimental-strip-types --test src/lib/maic/pipeline/prepare-runner.test.mjs` -> pass
- `node --experimental-strip-types --test src/lib/maic/pipeline/page-order.test.mjs` -> pass
- `pnpm exec eslint src/lib/rag/core/kernel.ts src/lib/rag/core/types.ts src/app/api/ask/route.ts` -> pass
- `pnpm exec tsc --noEmit --pretty false` -> pass

## Prevention

Future RAG policies should not throw raw exceptions past the kernel boundary. If a policy can recover into a domain-level 500 response, it may still return a `NextResponse`; if it cannot, the kernel should be the place where the failure becomes traceable.

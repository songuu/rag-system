# Performance Rules

## Cache LLM Prepared Artifacts By Source And Model

For MAIC-style initialization, cache the full prepared artifact (`pages`, knowledge tree, lecture script, questions, stage, scenes) after a successful run. The cache key must include source content, page boundaries, LLM provider/model/base URL, temperature, and a cache version so repeated uploads are fast without reusing stale output after model or prompt changes.

## Cache Before The First Expensive Stage

If a workflow has multiple deterministic expensive stages, cache the earliest reusable artifact, not only the final output. For MAIC uploads, the parsed slide text/page split should be cached by file hash before checking the LLM prepared-artifact cache, otherwise repeated uploads still pay the PDF extraction cost.

## Cache LLM Artifacts With Shared Identity

For MiroFish/OpenMAIC model-derived artifacts, use a shared cache identity: stable source hash + artifact type + model provider/model/base URL + temperature + cache/prompt version. Do not cache by project id or wall-clock time alone; those keys cannot safely distinguish regenerated ontology, profile, PPT focus, or classroom prepared outputs.

## Redraw LLM Pipeline Dependency Graph Before Optimizing

Multi-stage LLM pipelines drift toward "naturally serial" code (write describe, await, write tree, await, write script, await...). The real **data** dependency graph is almost always sparser than the code order. Before tuning concurrency or batch sizes:

1. For each stage, list what upstream artifact it truly needs.
2. Find sibling stages with the same upstream — they are parallel branches.
3. Wrap branches in `Promise.all` after the shared gate; only serial-link nodes that pass artifacts down.

OpenMAIC `prepare-runner`: 5-stage serial collapsed to `describe → Promise.all([script, tree → Promise.all([questions, focus])])` and shed ~35% wall time without changing any prompt or LLM call count.

## Sliding Window Beats Batch Barrier For LLM Concurrency

Any worker pool over LLM calls should be a sliding window (maintain `concurrency` in-flight workers, each grabs next task on completion), not a batch barrier (`for (start += concurrency) { Promise.all(batch) }`). LLM latency variance is high; batch barriers always wait for the slowest call in the batch. Implementation: separate `nextSlot` (atomic-ish increment for task claim) from `emitCursor + completed Set` (guards monotonic callback order). See `src/lib/maic/pipeline/page-order.ts`.

## Audit Progress UI When Serializing Stages Into Parallel Branches

Parallelizing previously serial pipeline stages breaks the implicit "progress monotonically increases" assumption that consumer UIs rely on. Whenever a previously serial step becomes one of several parallel branches whose progress events interleave, change every progress consumer to `setProgress(prev => Math.max(prev, next))`. Forgetting this turns a backend speedup into a visible UX regression (progress bar appears to jump backward).

## Retrieval Budgets Must Wrap Each Lane

Checking elapsed time only before a retrieval lane starts does not enforce a deadline on embedding or
provider calls. Race each lane against its remaining budget, abort cooperatively, classify abort-aware
rejections as timeout/budget, and check the signal after every non-cancellable provider stage. Record
that SDK calls without signal support are soft cancellation: the request stops, but the in-flight call
may finish in the background and needs provider timeout/concurrency limits.

## Provider Orphans Are Sets, Not One Slot

Several concurrent calls can time out or be cancelled before any underlying provider call settles.
Track every orphan promise per provider/model in a set, admission-block new work while the set is
non-empty, and remove each reservation only from that operation's settlement callback. A single map
value is overwritten by later failures and can reopen capacity while older work is still running.

## Graph Budgets Cover The Whole Read Path

Graph traversal limits must include adjacency construction, seed selection, BFS state/edge expansion,
community joins, passage selection, and evidence projection—not only the BFS queue. Enforce aggregate
reference limits when loading artifacts and yield in bounded batches so request timeout/abort can run.

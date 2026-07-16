# Debugging Gotchas

## Agent Interjection Must Not Re-trigger Forever

If a manager injects a classmate `Idle` action without advancing the script cursor, the next decision can hit the same cursor again and repeat the same interjection forever. Guard on recent speaker or track `last_interjection_cursor` so non-progress actions do not create an infinite classroom loop.

## Page Preparation Progress Must Be Monotonic

Batching LLM calls with `Promise.all` makes completion order nondeterministic. For classroom preparation, do not emit `prepare:describe` or `prepare:script` directly inside each concurrent worker. Collect batch results first, then publish callbacks in slide order so the UI never shows page 3 followed by page 1.

## Browser TTS Must Not Cancel On Every Event

`speechSynthesis.cancel()` is a hard stop, not a smooth handoff. In an SSE-driven classroom, do not call it whenever the latest utterance changes. Queue non-student utterances, speak them sequentially, and only cancel on explicit user takeover such as disabling TTS, pausing, navigating, or restarting.

## Next Standalone Builds Expose Startup Drift

When enabling `output: 'standalone'`, `next start` may still boot but Next warns that it is no longer the right production entrypoint. Align Docker `CMD`, `package.json` start scripts, and docs on `node .next/standalone/server.js`. Also watch for `next/font/google`: it can fail builds in restricted networks because it fetches fonts at build time.

## Metadata Alias Order Can Become Trust Escalation

If a vector result merges authoritative scalar fields into only snake_case keys while a downstream
adapter reads camelCase first, attacker-controlled metadata can override trust or document identity.
Write both aliases from the scalar value or read authoritative keys first, then add a conflict regression.

## First-Fit Context Must Handle An Oversized First Block

A context composer that simply breaks when the next block exceeds the budget returns an empty context
when the first evidence is oversized. Truncate the selected block within the remaining budget, preserve
UTF-16 boundaries, and make the no-evidence path abstain without calling the LLM.

## Low-Dimensional Hash Baselines Can Fake Relevance

A hermetic hashing embedding can map an isolation-canary token onto an unrelated corpus token and make an
unanswerable probe look answerable. Keep the dimension high enough for the fixture, inspect unexpected
non-zero similarities, and make unanswerable TPR part of the default CLI gate.

## Abort Timers Cannot Preempt A Synchronous Hot Loop

Checking `signal.aborted` inside a long synchronous graph or parsing loop is not enough: the timer that
aborts the signal cannot run until JavaScript yields to the event loop. Bound total preprocessing and
postprocessing operations, and yield in deterministic batches when legal inputs can still be large.

## Cancellation Ownership Must Be Fenced

A pre-aborted contender must not cancel or release another invocation's active lease. Distinguish
request abort, internal timeout, and explicit management recovery; every lease mutation and terminal
delete must compare owner and revision. Treat expired takeover as at-least-once and reuse a stable
step execution ID for downstream idempotency.

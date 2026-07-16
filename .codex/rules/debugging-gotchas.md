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

## Persisted Model Configuration Can Outlive Its Validator

Validating only the request that writes a model selector does not protect rows created by older code.
Revalidate persisted provider/model data on every read/use boundary, keep credentials and custom base
URLs server-owned, and shape public project/config responses from an allowlist instead of returning the
stored object.

## Graph Build Success Must Be All-Or-Nothing

A task can finish extraction while embedding, budget accounting, or artifact persistence still fails.
Do not expose a result merely because an early stage completed. Publish the artifact/result only after
all required stages pass; otherwise retain a stable failed task state with no partial result. Exact graph
chunk offsets must come from slicing the original source, not from searching normalized chunk text.

## Embedding Admission Identity Is Not The LLM Selector

If an embedding orphan is keyed by the client-selectable generation model, a caller can rotate to another
valid LLM selector and reopen capacity while the same embedding backend is still busy. Build the admission
key from the effective server embedding provider/model/base URL hash and never expose the raw endpoint.

## Bounded JSON Size Does Not Bound Graph CPU

A provider response can fit under a text-size cap yet amplify into quadratic entity merging, relation
endpoint scans, or pairwise vector math. Count raw observations, reserve `E² + RE` lookup work before
the first scan, cap pair/vector operations, and validate community vectors before artifact assignment.

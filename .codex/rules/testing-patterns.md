# Testing Patterns

## Scoped Verification When Repo Has Existing Debt

If full `tsc` or `eslint` fails because of unrelated historical errors, run scoped checks against the files changed in the sprint and record the full-suite blocker separately. For MAIC changes, filter TypeScript output with `src\\(components\\maic|lib\\maic|app\\maic|app\\api\\maic)` and run ESLint on the exact changed files.

## Contract Tests Before UI Wiring

When a feature changes route/UI orchestration around a shared workflow, first extract pure lib-layer contracts and test those directly. For MiroFish, config normalization, prepare idempotence, round context, and snapshot summaries can be covered with `node --experimental-strip-types --test` before touching React components.

## Upstream Parity Verification

For upstream parity work that only maps metadata or pure transforms, prefer targeted Node tests for env defaults, catalog classification, and malformed input tolerance. If full TypeScript remains blocked by unrelated repo debt, run `tsc --noEmit --pretty false --incremental false`, filter the touched paths, and record the full-suite blockers in the sprint doc.

## Node Test Runner on Windows Sandbox

If `node --test file1 file2` fails with `spawn EPERM`, rerun the same test files one by one with `node path\\to\\test.mjs`. The multi-file test runner may spawn child processes that the sandbox blocks, while direct execution still exercises `node:test` cases in-process.

## Security Boundary Changes Are L4

Auth mode, tenant/corpus scope, vector filters, admin routes, URL ingestion, body limits, and credential redaction require L4 coverage. Keep most cases hermetic at pure seams: role/capability matrix, split Supabase headers, RLS-visible scope resolution, strict numeric/model validation, scalar filter construction, private IPv4/IPv6 and mixed DNS rejection, pinned redirects, streamed byte caps, and public config/error DTO redaction. Add route/integration checks when infrastructure is available, but never weaken fail-closed behavior because live Supabase or Milvus is unavailable in CI.

## Eval Targets Are Label-Blind And Corpus-Checked

An eval target receives only query, required scope, corpus, and runtime configuration—never case id,
tags, gold evidence, expected answer, or expected abstain. For security/citation gates, compare every
returned evidence field to the fixed canonical corpus before scoring. V2 answerable cases require
expected facts; hard gates cover retrieval, facts, citation/span, selective accuracy, abstention, and
independent tenant/corpus/trust canaries. Canary keys may appear in queries, but secret payloads may not.

## Security Guards Prove Expensive Call Count Is Zero

For evidence-scope, quarantine, forged routing, and active-abstention regressions, asserting only a
public error is insufficient. Inject a passage containing a unique private marker, spy on every
passage-bearing provider callback, and assert invocation count is exactly zero. Also assert the marker
is absent from prompt, context, cache dimensions, logs, and public failure envelopes.

## Concurrency Limits Need Barrier Tests

Serially pre-filling a limit does not test admission races. Hold accepted operations behind a barrier,
launch `limit + 1` requests with `Promise.all`, and assert exactly `limit` reservations plus one stable
rejection. For timeout/cancellation, keep non-cooperative operations unresolved and verify admission
stays blocked until every orphan settles, not merely the most recent promise.

## Durable Integrity Tests Include Key Configuration

Checkpoint corruption tests must cover payload mutation, a process-persistent store without a key,
and a valid HMAC produced under the wrong key. Lease tests must include a pre-aborted non-owner,
revision-fenced terminal deletion, renewal, and explicit expired-lease recovery.

Also hold a non-cooperative step unresolved, abort the invocation, and assert immediate terminal
cancellation without replay or late state commit. Consuming the provider's late rejection is part of
the regression; merely checking the cooperative-signal path is insufficient.

## Source Alignment And Ordered Context Need Adversarial Fixtures

For graph chunks, assert every `content` equals the original source slice at its exact start/end offsets,
every chunk stays within the requested size, and adjacent chunks have the exact configured overlap. For
context composition, use `RagEvidence.page` and deliberately make page order disagree with offset order;
assert the output follows document/page order while preserving source, page, and span metadata.

## Persisted Configuration Is Revalidated At Read Time

Model-selector tests must seed invalid historical provider/model/base-URL/credential combinations, then
exercise project read, list, and execution paths. Assert fail-closed revalidation, server-owned provider
configuration, and a public projection with no credential or private endpoint. Graph task tests must also
assert UUID identifiers and that a failed required stage publishes no artifact/result.

Embedding orphan tests must keep the server embedding provider/model/base URL constant while rotating
through multiple valid LLM selectors. Every attempt must remain admission-blocked until the original
embedding operation settles, proving the orphan key cannot be bypassed through client model choice.

## Untrusted Structured Output Tests Must Cover Work Amplification

For graph/entity providers, test raw response characters before parsing, invalid raw array entries,
cross-chunk and gleaning accumulation, overlong fields, pre-embedding aggregation/pair rejection,
embedding count/dimension/finite/vector-operation failures, and a legal workload large enough to prove
event-loop yield. The background task assertion must use a stable code and require no `result/graphData`.

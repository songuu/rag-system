# Testing Patterns

## Scoped Verification When Repo Has Existing Debt

If full `tsc` or `eslint` fails because of unrelated historical errors, run scoped checks against the files changed in the sprint and record the full-suite blocker separately. For MAIC changes, filter TypeScript output with `src\\(components\\maic|lib\\maic|app\\maic|app\\api\\maic)` and run ESLint on the exact changed files.

## Contract Tests Before UI Wiring

When a feature changes route/UI orchestration around a shared workflow, first extract pure lib-layer contracts and test those directly. For MiroFish, config normalization, prepare idempotence, round context, and snapshot summaries can be covered with `node --experimental-strip-types --test` before touching React components.

## Upstream Parity Verification

For upstream parity work that only maps metadata or pure transforms, prefer targeted Node tests for env defaults, catalog classification, and malformed input tolerance. If full TypeScript remains blocked by unrelated repo debt, run `tsc --noEmit --pretty false --incremental false`, filter the touched paths, and record the full-suite blockers in the sprint doc.

## Node Test Runner on Windows Sandbox

If `node --test file1 file2` fails with `spawn EPERM`, rerun the same test files one by one with `node path\\to\\test.mjs`. The multi-file test runner may spawn child processes that the sandbox blocks, while direct execution still exercises `node:test` cases in-process.

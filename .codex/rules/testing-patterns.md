# Testing Patterns

## Scoped Verification When Repo Has Existing Debt

If full `tsc` or `eslint` fails because of unrelated historical errors, run scoped checks against the files changed in the sprint and record the full-suite blocker separately. For MAIC changes, filter TypeScript output with `src\\(components\\maic|lib\\maic|app\\maic|app\\api\\maic)` and run ESLint on the exact changed files.

## Node Test Runner on Windows Sandbox

If `node --test file1 file2` fails with `spawn EPERM`, rerun the same test files one by one with `node path\\to\\test.mjs`. The multi-file test runner may spawn child processes that the sandbox blocks, while direct execution still exercises `node:test` cases in-process.

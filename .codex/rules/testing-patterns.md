# Testing Patterns

## Scoped Verification When Repo Has Existing Debt

If full `tsc` or `eslint` fails because of unrelated historical errors, run scoped checks against the files changed in the sprint and record the full-suite blocker separately. For MAIC changes, filter TypeScript output with `src\\(components\\maic|lib\\maic|app\\maic|app\\api\\maic)` and run ESLint on the exact changed files.

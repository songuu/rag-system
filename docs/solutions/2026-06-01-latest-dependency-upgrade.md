# Latest Dependency Upgrade - 2026-06-01

## Goal

Upgrade all direct project dependencies to the npm registry latest versions available on 2026-06-01, keep the lockfile in sync, and verify the application still type-checks, tests, and builds.

## Upgraded Direct Dependencies

- LangChain / LangGraph: `@langchain/community@1.1.29`, `@langchain/core@1.1.48`, `@langchain/langgraph@1.3.2`, `@langchain/openai@1.4.7`
- LiteParse / Notion / Milvus: `@llamaindex/liteparse@2.0.4`, `@notionhq/client@5.22.0`, `@zilliz/milvus2-sdk-node@3.0.1`
- UI / runtime: `echarts@6.1.0`, `lucide-react@1.17.0`, `ws@8.21.0`, `langsmith@0.7.3`
- Tooling / types: `eslint@10.4.1`, `@types/node@25.9.1`, `@types/react@19.2.15`

`pnpm-lock.yaml` was refreshed by `pnpm update --latest`.

## Peer Dependency Decisions

`pnpm peers check` initially reported ecosystem peer ranges that lag behind the newest direct dependency versions. The project keeps the latest direct packages and documents the intentional peer allowances in `pnpm-workspace.yaml`.

- `eslint-plugin-import`, `eslint-plugin-jsx-a11y`, and `eslint-plugin-react` have not published ESLint 10 peer ranges yet. This repository already uses scoped ESLint 10 compatibility overrides, so the peer range is allowed for `eslint@10`.
- `@browserbasehq/stagehand` is a transitive dependency of `@langchain/community`; this project does not directly call Stagehand APIs. Its `openai` and `zod` peer ranges are allowed for the currently installed major versions.
- `@tailwindcss/typography` and `tailwindcss-animate` peer ranges lag behind Tailwind CSS 4, but the packages are already used with Tailwind 4 in this app.

After adding the peer rules, `pnpm peers check` passed.

## Current Deprecated Package

`pnpm outdated --format json` has no newer direct dependency versions left. It still reports `@langchain/community@1.1.29` as deprecated even though `1.1.29` is also the latest release. This is not fixable by upgrading in place; replacing it would require a LangChain package split or migration plan.

## Verification

- `pnpm outdated --format json` - only `@langchain/community@1.1.29` deprecation remains, with no newer version.
- `pnpm peers check` - pass.
- `pnpm exec tsc --noEmit --pretty false` - pass.
- Targeted ESLint for touched MAIC/model files - pass.
- All tracked `*.test.mjs` with `node --experimental-strip-types --test` - 112/113 passed on the first full run; the only failure was a timing threshold in `src/lib/maic/pipeline/prepare-runner.test.mjs`, and that file passed when rerun alone.
- `pnpm build` - pass. Next.js 16.2.6 / Turbopack compiled successfully and generated 87 static pages.

## Known Non-Blocking Signals

- Full `pnpm exec eslint .` still fails on existing repository lint debt outside this dependency upgrade, mainly `no-explicit-any`, React compiler rules, `prefer-const`, and related historical issues.
- `pnpm build` invokes `scripts/generate-articles.mjs`, which attempts Notion sync before building. The build succeeded, but Notion rejected three generated articles because of existing content validation issues: invalid Markdown link URLs in two guides and a table width mismatch in one guide.


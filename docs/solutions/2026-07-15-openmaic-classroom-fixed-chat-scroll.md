---
title: "OpenMAIC classroom fixed-viewport chat layout"
date: 2026-07-15
tags: [solution, openmaic, maic, classroom, layout]
related_instincts: []
aliases: ["OpenMAIC discussion panel scroll", "MAIC fixed chat input"]
---

# OpenMAIC classroom fixed-viewport chat layout

## Problem

Long multi-agent discussions made the full OpenMAIC classroom page scroll. The message composer moved below the viewport instead of remaining available at the bottom of the discussion panel.

## Root Cause

The classroom shell used a minimum height rather than a bounded viewport height. Its nested flex and grid containers could expand with message content, so the chat scroller had no constrained height.

## Solution

- Bound the classroom shell to the available dynamic viewport height, including the MAIC header and page padding.
- Added min-h-0 and overflow-hidden to every parent between the classroom shell and the main grid, so child content can shrink.
- Made the discussion panel fill its grid cell; only its message list uses overflow-y-auto.
- Marked the discussion header, composer, and scene sidebar header as non-shrinking so they remain visible while their respective lists scroll.
- Pause automatic classroom playback when the pointer enters the stage, then resume only when that same hover pause ends; manual pauses and completed courses are never overridden.
- Added a bounded two-row layout below the desktop breakpoint to prevent mobile/tablet stacking from creating page-level overflow.

## Verification

- pnpm exec tsc --noEmit --pretty false passed.
- Scoped ESLint still reports seven pre-existing React Hooks rules in untouched logic within OpenMaicClassroom.tsx.
- git diff --check -- src/components/maic/OpenMaicClassroom.tsx passed.
- Browser automation could not start because its local session socket failed to initialize.

## Prevention

When a panel contains a scrolling list and fixed controls, give the entire flex/grid ancestor chain a definite height and min-h-0; keep overflow-y-auto only on the list, with fixed siblings marked shrink-0.

## Related

- [[2026-06-26-openmaic-latest-sync]]

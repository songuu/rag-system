---
title: "MiroFish ontology cache tolerates incomplete model fields"
type: solution
status: accepted
date: "2026-07-15"
tags: [solution, mirofish, ontology, cache, debugging]
related_instincts: []
aliases: ["undefined.replace during graph build"]
---

# MiroFish ontology cache tolerates incomplete model fields

## Problem

Building a graph after ontology generation could fail with `Cannot read properties of undefined (reading 'replace')`.

## Root Cause

LLM-generated attribute objects may omit optional metadata such as `type` or `description`. Cache-key normalization treated all fields as strings and invoked `replace` directly.

## Solution

- Normalize non-string cache inputs to an empty string.
- Normalize generated attribute metadata to `type: 'text'` and an empty description when it is absent.

## Prevention

Treat model output as untrusted at every serialization and cache boundary, even after schema-oriented post-processing.

## Verification

- Targeted cache and ontology tests cover an attribute that has only a name.

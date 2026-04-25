# Performance Rules

## Cache LLM Prepared Artifacts By Source And Model

For MAIC-style initialization, cache the full prepared artifact (`pages`, knowledge tree, lecture script, questions, stage, scenes) after a successful run. The cache key must include source content, page boundaries, LLM provider/model/base URL, temperature, and a cache version so repeated uploads are fast without reusing stale output after model or prompt changes.

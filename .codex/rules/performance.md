# Performance Rules

## Cache LLM Prepared Artifacts By Source And Model

For MAIC-style initialization, cache the full prepared artifact (`pages`, knowledge tree, lecture script, questions, stage, scenes) after a successful run. The cache key must include source content, page boundaries, LLM provider/model/base URL, temperature, and a cache version so repeated uploads are fast without reusing stale output after model or prompt changes.

## Cache Before The First Expensive Stage

If a workflow has multiple deterministic expensive stages, cache the earliest reusable artifact, not only the final output. For MAIC uploads, the parsed slide text/page split should be cached by file hash before checking the LLM prepared-artifact cache, otherwise repeated uploads still pay the PDF extraction cost.

## Cache LLM Artifacts With Shared Identity

For MiroFish/OpenMAIC model-derived artifacts, use a shared cache identity: stable source hash + artifact type + model provider/model/base URL + temperature + cache/prompt version. Do not cache by project id or wall-clock time alone; those keys cannot safely distinguish regenerated ontology, profile, PPT focus, or classroom prepared outputs.

# Architecture Rules

## OpenMAIC Parity: Stage First

When aligning this project with OpenMAIC-like classroom products, model the runtime as `Stage -> Scene -> Action -> Playback Control` before designing the React page. A chat-only classroom will underfit the product: slides, quizzes, simulations, PBL, whiteboard, TTS, spotlight/laser effects, and multi-agent discussion all need scene/action data to stay coherent.

## MAIC/RAG: One Canonical Course Corpus

When MAIC ingests course material, mirror the parsed text into the existing RAG `uploads/*_parsed.txt` corpus instead of keeping a MAIC-only private text source. MAIC can keep its own prepared classroom artifact cache, but the raw/parsed course text should remain discoverable by the shared RAG reinitialize and sync flows.

## OpenMAIC Parity: Keep User-Approved Chrome Stable

When a user says the current MAIC header/chrome is acceptable, constrain OpenMAIC visual parity work to the classroom body below that header. Preserve the existing navigation/header contract and focus on stage composition, slide canvas, bottom transcript controls, and participant rails.

## MiroFish: Prepare and Snapshot Boundaries

For MiroFish-style multi-agent simulations, keep environment preparation and runtime observation as explicit lib-layer contracts. A prepare layer should normalize config, reuse or regenerate profiles by fingerprint, and return a `prepare_id`; the simulation runner should expose a snapshot consumed by reports, interaction APIs, and SSE reconnects. Do not let React steps or route handlers independently reconstruct these states.

## OpenAI-Compatible Provider Boundaries

When adding providers inspired by OpenMAIC, only share the generic OpenAI-compatible helper for providers that actually expose the OpenAI chat completions shape, such as OpenRouter, Lemonade, and custom local endpoints. Keep provider-specific SDK classes for special cases like Azure OpenAI; treating Azure as a plain `baseURL` can pass types while producing an invalid deployment URL.

## External Product Parity: Optional Compatibility Layer

When tracking fast-moving upstream products such as MiroFish and OpenMAIC, absorb latest capabilities through optional fields, default-on capability flags, prompt-layer refinements, and post-processing guards before considering a wholesale upstream migration. Existing routes, persisted artifacts, and fallback render paths are the source of truth for functional parity.

## OpenMAIC PPT Animation Parity

For OpenMAIC PPT/slide parity, keep the local runtime on the existing `Course -> Prepared -> Scene -> Action` model and add official animation semantics as metadata: `PPTAnimation`, `TurningMode`, stable slide element ids, and optional scene action timing/effect fields. Prefer a lightweight parser and renderer bridge over importing the full upstream PPTist editor unless the product explicitly needs editable canvas parity.

## OpenMAIC PPT Focus Hover Is Sticky

Treat PPT focus hover as a playback semantic, not a disposable visual flourish. `spotlight` actions should persist as held focus until the next focus target or slide/scene change; non-focus actions such as speech, discussion, whiteboard, and laser must not clear the held focus unless they explicitly carry a focus target.

## OpenMAIC PPT Focus Is Model-Derived

Do not choose PPT spotlight targets by fixed key-point order except as a fallback. The prepare pipeline should ask the model to produce a validated `SlideFocusPlan` from the slide description, raw text, key points, and course context, then map that plan to stable slide element ids for playback.

## RAG Evolves Through A Kernel, Not More API Branches

For this project, future RAG capability should be expressed as a `RAG Kernel` policy, retrieval lane, corpus adapter, evaluator, or cache layer before adding another top-level `/api/ask` branch. The current system already has many modes; the next architecture step is a shared kernel plus retrieval control plane that unifies dense/sparse/graph retrieval, fusion, reranking, context packing, trace, and evaluation while preserving existing MiroFish/OpenMAIC product behavior.

## RAG Kernel Failures Need Envelopes

RAG policy failures should be wrapped at the `RagKernel` boundary with the same observability contract as successful executions: trace id, policy id, status, duration, retrieval plan, policy description, and a small error summary. Route handlers may still preserve legacy JSON error bodies, but they should attach `x-rag-policy` and `x-rag-trace-id` when a kernel failure envelope exists. Do not let raw policy exceptions cross the kernel boundary without execution context.

## RAG Plans Exist Before Policy Execution

Build the retrieval plan before invoking a policy and pass that exact plan through the policy context.
The lane executor, evidence, transitions, budget, stop reason, response body, and Kernel envelope must
all describe the same execution. A resolved non-2xx response or `execution.state=failed` is a failed
Kernel execution; required-lane throws must retain their partial execution snapshot.

## Canonical Evidence Uses Authoritative Scalar Provenance

Tenant, corpus, document, version, and trust fields from vector-store scalar columns outrank JSON
metadata aliases. Normalize conflicting camel/snake aliases at the adapter boundary, then validate
canonical evidence against the server-owned retrieval scope before fusion, context, generation,
citation, eval, or cache identity. Never calculate security metrics from target-reported provenance
without comparing it to the fixed corpus record.

## RAG Cache Identity Binds The Final Context

Answer and context cache identity must include scope, corpus/schema/index versions, models, prompt,
policy/fusion, ordered evidence/span identity, and a digest of the final prompt-visible composed
context. Recompute the key from components at the cache consumer; a caller-supplied `rag:` prefix is
not integrity proof.

## RAG Capability Changes Are Evaluation-Gated

Do not make a new retrieval lane, index schema, embedding, rerank/fusion policy, context prompt, router, GraphRAG path, or visual retrieval path the default because a public benchmark or dependency release looks better. First run a versioned corpus-native evaluation that separates retrieval, answer, citation, abstention, tenant/security, latency, and cost gates. Roll out through shadow, opt-in, and limited stages while retaining the dense 2-step control with the same tenant/corpus/ACL filters. Auth, tenant, corpus, ACL, and trust failures must fail closed; quarantined evidence may enter audit/eval only and must never enter fusion, context composition, or generation. Version answer/context cache identity with every behavior-changing corpus, index, model, prompt, policy, rerank, or fusion input.

## Request Identity And Retrieval Scope Are Server-Owned

Never authorize RAG work from body-supplied user, tenant, role, corpus ownership, or raw Milvus filters. Resolve one request-scoped security context on the server, validate the selected corpus through fixed scope or RLS, and pass one immutable retrieval scope through ingestion and query adapters. Production modes must fail closed when the active vector schema cannot enforce tenant/corpus/trust scalar filters. Service-role clients remain background-only; user request clients use a publishable project key plus the real user JWT and may not fall back to admin credentials.

## External Ingestion Uses A Pinned Egress Boundary

Every user-supplied or remotely derived URL must pass through the shared Node safe-fetch boundary: protocol/host/port validation, all-address A/AAAA checks, pinned socket lookup, manual per-hop redirect validation, timeout, MIME policy, identity encoding, and both declared and streamed byte caps. A route-level hostname check followed by ordinary fetch is not an SSRF defense because it leaves redirect and DNS-rebinding gaps.

## Legacy RAG Routes Fail Closed In Authenticated Modes

Routes that have not adopted the canonical request security context and server-derived retrieval scope are local development surfaces, not production APIs. They must return a stable unavailable response in production or whenever an authenticated access mode is selected. A reverse-proxy allowlist is defense in depth, not the only control. Shared bearer credentials must never be shipped to the browser; production browser access requires a same-origin session/BFF boundary.

## Archive Ingestion Is Bounded Before Parsing

Treat OOXML and other archive-backed uploads as compressed adversarial input. Inspect the ZIP central directory before parser allocation, reject encrypted, ZIP64, multi-disk, unsupported-compression, ambiguous, high-ratio, high-entry-count, or oversized archives, and keep spreadsheet and extracted-text budgets after decompression. Compressed upload size alone is not a resource-safety boundary.

## Runtime Configuration Has One Source

Model, embedding, reasoning, Milvus, and retrieval feature choices should be resolved from a shared runtime configuration snapshot before any page-level fallback is used. UI model selectors may display Ollama installation status, but they must not use Ollama availability as the source of truth for the selected model when `MODEL_PROVIDER`, `EMBEDDING_PROVIDER`, or `REASONING_PROVIDER` already define the runtime model.

## LangChain v1 For Leaf Agents, LangGraph v1 For Stateful Workflows

For this project, adopt LangChain v1 `createAgent`, middleware, model profiles, and structured output for leaf-level agent tasks such as query analysis, entity extraction, reranking, hallucination checks, prompt guardrails, and model retry policy. Keep custom RAG orchestration, constraint relaxation, MAIC prepare/classroom flows, and MiroFish simulations on explicit LangGraph-style state machines. Do not replace an observable `StateGraph` workflow with one opaque agent loop when the workflow semantics are part of the product.

## Milvus Search Policy Belongs In The Adapter

Milvus tuning should enter the project through `milvus-config` and `milvus-client`, not through new page or route branches. Keep consistency level, filter templating values, grouping, `ignore_growing`, and index search params as adapter-level policy so future dense, sparse, hybrid, and multi-vector retrieval lanes can share the same collection lifecycle and search contract.

## Milvus Query Hot Paths Stay Warm

Milvus search handlers should not call collection stats, schema description, or load checks on every query once the singleton vector store is initialized. Keep query-time work to embedding generation, vector search, and result shaping; use explicit maintenance actions for schema checks, stats refreshes, collection reloads, and index rebuilds.

## Supabase Is The Persistence Plane, Not The Milvus Replacement

When adding Supabase to this project, use it first for Auth/RLS, tenant ownership, Postgres metadata, Storage-backed files, index jobs, traces, feedback, conversations, MiroFish/MAIC product state, and Realtime progress. Keep Milvus/Zilliz as the default production vector hot path. Supabase pgvector can be added as an optional retrieval lane for small corpora, entity/cache embeddings, eval datasets, or metadata-heavy filtering, but it should enter through the RAG Kernel retrieval adapter instead of replacing `milvus-client`.

## PDF Parser Changes Go Through A Shared Adapter

When changing PDF parsing providers, first route `document-parser`, `document-pipeline`, product-specific upload routes, and MAIC slide parsing through one shared PDF adapter. Parser swaps affect chunk boundaries, page counts, OCR behavior, resource cleanup, native packaging, and RAG cache semantics, so keep provider choice behind configuration and validate with PDF fixtures before changing the default.

## Container Deployment Separates Liveness, Readiness, And Runtime Secrets

For this project, container support should keep Next server startup, local Milvus dependencies, and cloud provider credentials as separate layers. Use Next standalone output for non-static container deployments and make `pnpm start` run the same standalone server contract. Keep liveness routes dependency-free, reserve external checks for readiness, and inject all LLM, Zilliz, Supabase, and LangSmith secrets through runtime environment variables rather than image layers.

## MAIC Structured Output Has One Reasoning-Aware Parser

Route MAIC read, plan, and manager structured model responses through one shared parser. Attempt exact JSON first, treat reasoning closing tags as delimiters only outside valid JSON ranges, and preserve each stage's existing malformed-output fallback. Never log the raw model response from this parsing boundary; it can contain course content or provider-adjacent context.

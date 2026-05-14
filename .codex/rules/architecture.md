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

## Runtime Configuration Has One Source

Model, embedding, reasoning, Milvus, and retrieval feature choices should be resolved from a shared runtime configuration snapshot before any page-level fallback is used. UI model selectors may display Ollama installation status, but they must not use Ollama availability as the source of truth for the selected model when `MODEL_PROVIDER`, `EMBEDDING_PROVIDER`, or `REASONING_PROVIDER` already define the runtime model.

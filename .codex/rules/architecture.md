# Architecture Rules

## OpenMAIC Parity: Stage First

When aligning this project with OpenMAIC-like classroom products, model the runtime as `Stage -> Scene -> Action -> Playback Control` before designing the React page. A chat-only classroom will underfit the product: slides, quizzes, simulations, PBL, whiteboard, TTS, spotlight/laser effects, and multi-agent discussion all need scene/action data to stay coherent.

## MAIC/RAG: One Canonical Course Corpus

When MAIC ingests course material, mirror the parsed text into the existing RAG `uploads/*_parsed.txt` corpus instead of keeping a MAIC-only private text source. MAIC can keep its own prepared classroom artifact cache, but the raw/parsed course text should remain discoverable by the shared RAG reinitialize and sync flows.

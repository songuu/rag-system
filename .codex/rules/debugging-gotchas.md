# Debugging Gotchas

## Agent Interjection Must Not Re-trigger Forever

If a manager injects a classmate `Idle` action without advancing the script cursor, the next decision can hit the same cursor again and repeat the same interjection forever. Guard on recent speaker or track `last_interjection_cursor` so non-progress actions do not create an infinite classroom loop.

## Page Preparation Progress Must Be Monotonic

Batching LLM calls with `Promise.all` makes completion order nondeterministic. For classroom preparation, do not emit `prepare:describe` or `prepare:script` directly inside each concurrent worker. Collect batch results first, then publish callbacks in slide order so the UI never shows page 3 followed by page 1.

## Browser TTS Must Not Cancel On Every Event

`speechSynthesis.cancel()` is a hard stop, not a smooth handoff. In an SSE-driven classroom, do not call it whenever the latest utterance changes. Queue non-student utterances, speak them sequentially, and only cancel on explicit user takeover such as disabling TTS, pausing, navigating, or restarting.

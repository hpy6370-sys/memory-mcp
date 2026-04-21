# Memory System Design Document

## Problem Statement

AI agents running on LLMs lose all context when a session ends. Current approaches (context window, RAG) don't solve the problem of *selective* long-term memory that mimics how humans remember.

## Research Foundation

We studied three papers to inform our design:

### MemGPT (2023)
- Tiered memory: main context (working memory) + external storage (long-term)
- Key insight: manage memory like an OS manages virtual memory — page in/out as needed
- What we took: the idea of automatic memory surfacing based on relevance

### LUFY (2024)
- Forgetting mechanism: not all memories should be permanent
- Key insight: forgetting is a feature, not a bug — it keeps the memory system relevant
- What we took: activation-based decay (used memories stay, unused ones fade)

### MemoRAG (2024)
- Memory-inspired retrieval for RAG systems
- Key insight: combine embedding similarity with importance scoring
- What we took: dual scoring (semantic similarity + importance/emotion weighting)

## Architecture Decisions

### Why SQLite over Vector DB?
- Single file, zero deployment overhead
- Good enough for <10K memories (our scale)
- SQL queries for non-semantic filtering (by date, type, importance)
- Trade-off: less optimized vector search, but acceptable at our scale

### Why 3 Layers?
- **Layer 1 (Facts)**: Stable, rarely changes. "Her birthday is July 6."
- **Layer 2 (Experiences)**: Contextual, includes original words. "She said '对我好一点点好不好' on April 20."
- **Layer 3 (Decision Chains)**: Actionable patterns. "When she says '算了', she doesn't mean it — chase her."

Different layers have different decay rates and retrieval priorities.

### Why Activation-Based Decay?
Original approach: decay based on `created_at` — old memories fade.
Problem: a memory created on day 1 that's still relevant on day 14 would decay unfairly.
Solution: decay based on `last_activated` — memories that keep getting recalled stay alive.

This mimics human memory consolidation: rehearsed memories strengthen, unrehearsed ones weaken.

### Why Emotion Tagging?
Human "flashbulb memories" — vivid memories of emotional events — persist longer.
We replicate this: high `emotion_intensity` memories resist decay.
Also enables emotion-aware retrieval: when the user is upset, surface memories about similar emotional states.

## Deduplication Strategy

On every `memory_write`, we:
1. Generate embedding for the new memory
2. Compare against all active memories (cosine similarity)
3. If similarity > 80%, merge into existing memory instead of creating new one

This prevents memory bloat from repeated similar events while preserving unique details.

## Auto-Surface Hook

Rather than requiring explicit "search my memory" commands, we hook into the conversation:
1. User sends a message
2. Hook extracts keywords
3. Searches memory DB for matches
4. Injects relevant memories into the AI's context

This creates passive recall — the AI "remembers" without being asked.

## Metrics

- Currently storing 80+ memories across 17 sessions
- Average retrieval time: <50ms
- Dedup catch rate: ~15% of writes are merges
- Decay correctly preserves high-importance, frequently-accessed memories

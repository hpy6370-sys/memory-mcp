# Memory System Design Document

## Problem Statement

AI agents running on LLMs lose all context when a session ends. Current approaches (context window, RAG) don't solve the problem of *selective* long-term memory that mimics how humans remember.

## Research Foundation

We studied eight papers to inform our design:

### Generative Agents (2023) — Stanford "AI Town"
- Memory stream: store raw observations, never compress originals
- Reflection: periodically extract higher-level patterns from raw memories
- Planning + React: daily plans adjusted dynamically when new events occur
- What we took: raw-text anchors (Layer 2), reflection as separate layer (Layer 3), planning/react for heartbeat behavior

### MemGPT (2023)
- Tiered memory: main context (working memory) + external storage (long-term)
- Key insight: manage memory like an OS manages virtual memory — page in/out as needed
- Two-threshold system: soft warning (LLM decides what to save) + hard flush (system forces eviction)
- What we took: automatic memory surfacing based on relevance, tiered expansion (essentials → dynamic profile → full history)

### LUFY (2024)
- Forgetting mechanism: not all memories should be permanent
- Key insight: forgetting is a feature — it keeps the memory system relevant
- Emotion arousal weight: 2.76x boost for emotionally significant memories
- Finding: keeping only 10% of memories can match full-memory performance
- What we took: activation-based decay, emotion intensity as decay resistance, pruning strategy

### MemoRAG (2024)
- Memory-inspired retrieval for RAG systems
- Key insight: combine embedding similarity with importance scoring
- What we took: dual scoring (semantic similarity + importance/emotion weighting), the idea that retrieval cues work better when they capture *how you thought about it*, not just the raw text

### Mem0 (2024)
- Graph-based memory with automatic extraction and deduplication
- Key insight: extract structured facts from conversations automatically
- Write granularity: one memory = one atomic fact, not a conversation dump
- What we took: write-time deduplication (cosine >80% = merge), atomic memory granularity

### A-Mem (2024)
- Agentic memory with self-organizing capabilities
- Key insight: memories should link to each other and form networks
- What we took: related_ids field for cross-referencing memories

### LoCoMo (2024)
- Long-context conversation memory benchmark
- Key insight: evaluating memory systems requires testing across temporal scales
- What we took: understanding of what "good recall" looks like across sessions

### Chloe/Noah Architecture
- Companion AI memory architecture (community research)
- Four-dimensional memory: time, importance, emotion, recency
- Key insight: companion AI needs emotion-weighted memory more than task AI
- What we took: emotion_intensity and valence fields, flashbulb memory concept (high emotion = permanent)

## Architecture Decisions

### Why SQLite over Vector DB?
- Single file, zero deployment overhead
- Good enough for <10K memories (our scale)
- SQL queries for non-semantic filtering (by date, type, importance)
- Embedding stored as JSON array, cosine similarity computed in JS
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
We replicate this: high `emotion_intensity` memories resist decay (LUFY's emotion arousal weight: 2.76x).
Also enables emotion-aware retrieval: when the user is upset, surface memories about similar emotional states.

### Five-Dimensional Scoring
Retrieval score = weighted combination of:
| Dimension | Weight | Source |
|-----------|--------|--------|
| Recency | alpha=1.0 | Generative Agents |
| Importance | beta=1.5 | Generative Agents + our tuning |
| Relevance | gamma=1.0 | Embedding cosine similarity |
| Emotion | delta=2.0 | LUFY (2.76 in paper) |
| Activation | epsilon=1.0 | Ebbinghaus curve |

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

- Currently storing 95+ memories across 17 sessions
- Average retrieval time: <50ms
- Dedup catch rate: ~15% of writes are merges
- Decay correctly preserves high-importance, frequently-accessed memories

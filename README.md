# MAPLE: Memory-Augmented Persistent Learning Engine

A Model Context Protocol (MCP) server that provides persistent long-term memory for AI agents. Built on a **3-agent architecture** with multi-channel retrieval, automatic memory extraction, and activation-based decay. Designed for real-world daily use with Claude Code.

> **In active production use** — 60+ memories across 30+ sessions, iterating based on real-world usage patterns.

## Features

- **3-Layer Memory Architecture**: Facts → Experiences → Decision Chains, with distinct decay and retrieval policies per layer
- **Multi-Channel Hybrid Search**: BM25 keyword matching + vector semantic similarity + entity extraction + mood detection, with configurable channel weights
- **Surprise-Based Scoring**: Information-gain metric that automatically prioritizes novel, high-value content for storage
- **Activation-Based Decay**: Memories that get recalled stay alive; unused ones fade — inspired by human memory consolidation research
- **Emotion-Aware Storage**: Valence, intensity, and mood tags enable "flashbulb memory" effects for emotionally significant events
- **Auto-Extract Pipeline**: Hooks into conversation flow to automatically extract and store new memories without explicit commands
- **Auto-Surface**: Context-aware passive recall — relevant memories are injected into conversations automatically
- **Intelligent Deduplication**: Embedding-based similarity detection (>80% threshold) with automatic merging
- **MCP Protocol Native**: Full integration with Claude Code and any MCP-compatible client
- **Chunked Memory Support**: Long memories are automatically chunked with parent-child relationships for granular retrieval

## Architecture

### 3-Agent Design (MAPLE v2)

```
┌──────────────────────────────────────────────────────────┐
│                    Claude Code / MCP Client               │
├──────────────────────────────────────────────────────────┤
│                      MCP Protocol                        │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │   Retrieval   │  │  Extraction  │  │  Maintenance │   │
│  │    Agent      │  │    Agent     │  │    Agent     │   │
│  │              │  │              │  │              │   │
│  │ • BM25       │  │ • Auto-      │  │ • Decay      │   │
│  │ • Semantic   │  │   extract    │  │ • Dedup      │   │
│  │ • Entity     │  │ • Auto-learn │  │ • Consolidate│   │
│  │ • Mood       │  │ • Surprise   │  │ • Expire     │   │
│  │ • Surface    │  │   scoring    │  │ • Rewrite    │   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │
│         │                 │                 │            │
│  ┌──────▼─────────────────▼─────────────────▼────────┐   │
│  │              SQLite + Embeddings                   │   │
│  │  memories · chunks · FTS5 · cosine similarity     │   │
│  └───────────────────────────────────────────────────┘   │
├──────────────────────────────────────────────────────────┤
│  Auto-Surface Hook (UserPromptSubmit)                    │
│  Auto-Extract Hook (conversation flow → memory)          │
└──────────────────────────────────────────────────────────┘
```

The three agents operate independently:
- **Retrieval Agent**: Multi-channel search with weighted scoring (BM25 30% + Semantic 30% + Entity 20% + Mood 20%)
- **Extraction Agent**: Monitors conversations and automatically identifies memory-worthy content using surprise scoring
- **Maintenance Agent**: Background processes for decay, deduplication, consolidation, and expiration

## Memory Schema

| Field | Type | Description |
|-------|------|-------------|
| `title` | text | Short title |
| `content` | text | Full content |
| `summary` | text | One-line summary |
| `compressed` | text | Medium compression |
| `layer` | int | 1=fact, 2=experience, 3=decision chain |
| `importance` | int | 1-5 scale |
| `emotion_intensity` | real | 0-10, high = flashbulb memory |
| `valence` | real | -1 to 1, negative to positive |
| `mood` | text | Mood description |
| `tags` | text | Comma-separated tags |
| `type` | text | note/diary/feedback/project/user |
| `embedding` | text | JSON array, generated on write |
| `activation_count` | int | Times recalled |
| `last_activated` | text | Last recall timestamp |
| `status` | text | active/decayed/expired |

## MCP Tools

| Tool | Description |
|------|-------------|
| `memory_write` | Create or update a memory with auto-embedding and dedup |
| `memory_read` | Read a specific memory by ID |
| `memory_search` | Semantic search using embedding similarity |
| `memory_surface` | Surface top memories by importance and relevance |
| `memory_update` | Update existing memory fields |
| `memory_delete` | Soft-delete a memory |
| `memory_decay` | Run decay cycle — deactivate unused memories |
| `memory_expire` | Permanently remove decayed memories |
| `memory_stats` | Get memory system statistics |

## Decay Mechanism

Memories decay based on `last_activated`, not `created_at`. A memory that keeps getting recalled stays active indefinitely. Decay thresholds:

- Low importance (1-2) + not activated in 7 days → decay
- Medium importance (3) + not activated in 14 days → decay  
- High importance (4-5) + not activated in 30 days → decay
- Pinned memories never decay

Inspired by research on human memory consolidation — informed by 8 papers (see [design doc](docs/design.md)).

## Auto-Surface Hook

`auto_surface.cjs` runs as a Claude Code `UserPromptSubmit` hook. On each user message, it:

1. Extracts keywords from the message
2. Searches the memory database for matches
3. Injects relevant memories into the conversation context

This enables passive recall without explicit search commands.

## Setup

```bash
npm install
```

Add to Claude Code MCP config:
```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["path/to/memory-mcp/index.js"]
    }
  }
}
```

## Design Decisions

- **SQLite over vector DB**: Simpler deployment, single file, good enough for <10K memories
- **Activation-based decay over time-based**: Mimics human memory — used memories strengthen, unused ones fade
- **Embedding dedup**: Prevents memory bloat from repeated similar events
- **Layered architecture**: Separates facts (stable) from experiences (contextual) from decisions (actionable)

## Research References

Built on research from 8 papers:

- **Generative Agents** (Stanford, 2023): Memory stream, reflection, planning/react
- **MemGPT** (2023): Tiered memory with OS-inspired page management
- **LUFY** (2024): Forgetting mechanism with emotion arousal weighting
- **MemoRAG** (2024): Memory-inspired retrieval with dual scoring
- **Mem0** (2024): Graph-based memory with auto-extraction and dedup
- **A-Mem** (2024): Self-organizing agentic memory networks
- **LoCoMo** (2024): Long-context conversation memory benchmark
- **Chloe/Noah** (Community): Four-dimensional companion AI memory

See [docs/design.md](docs/design.md) for detailed analysis of each paper's influence.

## Key Technical Highlights

- **Zero-config passive recall**: Memories surface automatically via hooks — no explicit search commands needed in conversation
- **Bilingual support**: Chinese/English tokenization via jieba + transformer embeddings, supporting mixed-language memory retrieval
- **Production-tested**: Daily use across 30+ sessions with real conversation data
- **Single-file deployment**: SQLite-based, no external database required
- **Extensible**: MCP protocol means any compatible AI client can use this memory system

## Status

In active daily use. Iterating based on real-world usage patterns. v3 with enhanced multi-agent coordination in progress.

## License

MIT

# AI Long-Term Memory MCP Server

A Model Context Protocol (MCP) server that provides persistent long-term memory for AI agents. Designed for real-world use with Claude Code, enabling AI systems to remember across sessions.

## Features

- **Layered Memory Architecture**: 3-layer system (facts → experiences → decision chains)
- **Semantic Search**: Embedding-based retrieval using cosine similarity
- **Memory Decay**: Activation-based decay — memories that get recalled stay alive, unused ones fade
- **Emotion-Aware**: Stores emotional valence and intensity, enabling "flashbulb memory" effects
- **Auto-Surface**: Hook-based automatic memory retrieval triggered by conversation context
- **Deduplication**: Automatically merges similar memories (>80% similarity threshold)

## Architecture

```
┌─────────────────────────────────────────┐
│              Claude Code                │
│         (or any MCP client)             │
├─────────────────────────────────────────┤
│            MCP Protocol                 │
├─────────────────────────────────────────┤
│          Memory MCP Server              │
│  ┌───────────┐  ┌──────────────────┐   │
│  │  Write /   │  │  Surface /       │   │
│  │  Update /  │  │  Search /        │   │
│  │  Delete    │  │  Read            │   │
│  └─────┬─────┘  └────────┬─────────┘   │
│        │                 │              │
│  ┌─────▼─────────────────▼─────────┐   │
│  │         SQLite Database          │   │
│  │  memories + embeddings + decay   │   │
│  └─────────────────────────────────┘   │
├─────────────────────────────────────────┤
│         Auto-Surface Hook              │
│  (keyword matching on user input)      │
└─────────────────────────────────────────┘
```

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

## Status

In active daily use. 95+ memories across 17 sessions. Iterating based on real-world usage patterns.

## License

MIT

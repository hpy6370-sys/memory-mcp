import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Database from "better-sqlite3";
import { z } from "zod";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { pipeline } from "@xenova/transformers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, "memories.db"));

// Phase 3: Embedding model (lazy loaded)
let embedder = null;
async function getEmbedder() {
  if (!embedder) {
    embedder = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5');
  }
  return embedder;
}

async function generateEmbedding(text) {
  const model = await getEmbedder();
  const output = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// BM25 scoring for Chinese text (character-level tokenization)
function bm25Score(query, document, k1 = 1.5, b = 0.75) {
  const queryChars = [...new Set(query.split(''))];
  const docChars = document.split('');
  const docLen = docChars.length;
  const avgDl = 200;
  let score = 0;
  for (const qc of queryChars) {
    const tf = docChars.filter(c => c === qc).length;
    if (tf === 0) continue;
    const idf = Math.log(1 + 1 / (tf / docLen + 0.5));
    score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgDl));
  }
  return score;
}

// Dual-channel scoring: semantic + BM25
function dualScore(semanticSim, bm25, lambda = 0.7) {
  const normalizedBm25 = Math.min(bm25 / 10, 1);
  return lambda * semanticSim + (1 - lambda) * normalizedBm25;
}

async function searchByEmbedding(queryVector, topK = 5) {
  const rows = db.prepare("SELECT id, embedding FROM memories WHERE status = 'active' AND embedding IS NOT NULL AND embedding != ''").all();
  const scored = [];
  for (const row of rows) {
    try {
      const vec = JSON.parse(row.embedding);
      const sim = cosineSimilarity(queryVector, vec);
      scored.push({ id: row.id, similarity: sim });
    } catch(e) {}
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topK);
}

// Create tables + Phase 1 schema upgrade
db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL DEFAULT 'note',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT DEFAULT '',
    mood TEXT DEFAULT '',
    importance INTEGER DEFAULT 3,
    pinned INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
`);

// Phase 1: add new columns (safe to run multiple times)
const columns = db.prepare("PRAGMA table_info(memories)").all().map(c => c.name);
if (!columns.includes('layer')) db.exec("ALTER TABLE memories ADD COLUMN layer INTEGER DEFAULT 1");
if (!columns.includes('summary')) db.exec("ALTER TABLE memories ADD COLUMN summary TEXT DEFAULT ''");
if (!columns.includes('compressed')) db.exec("ALTER TABLE memories ADD COLUMN compressed TEXT DEFAULT ''");
if (!columns.includes('session_id')) db.exec("ALTER TABLE memories ADD COLUMN session_id TEXT DEFAULT ''");
if (!columns.includes('emotion_intensity')) db.exec("ALTER TABLE memories ADD COLUMN emotion_intensity INTEGER DEFAULT 0");
if (!columns.includes('related_ids')) db.exec("ALTER TABLE memories ADD COLUMN related_ids TEXT DEFAULT '[]'");
if (!columns.includes('status')) db.exec("ALTER TABLE memories ADD COLUMN status TEXT DEFAULT 'active'");
if (!columns.includes('activation_count')) db.exec("ALTER TABLE memories ADD COLUMN activation_count INTEGER DEFAULT 0");
if (!columns.includes('resolved')) db.exec("ALTER TABLE memories ADD COLUMN resolved INTEGER DEFAULT 0");
if (!columns.includes('embedding')) db.exec("ALTER TABLE memories ADD COLUMN embedding TEXT DEFAULT ''");
if (!columns.includes('valence')) db.exec("ALTER TABLE memories ADD COLUMN valence REAL DEFAULT 0");
if (!columns.includes('trigger_text')) db.exec("ALTER TABLE memories ADD COLUMN trigger_text TEXT DEFAULT ''");
if (!columns.includes('why')) db.exec("ALTER TABLE memories ADD COLUMN why TEXT DEFAULT ''");
if (!columns.includes('last_activated')) db.exec("ALTER TABLE memories ADD COLUMN last_activated TEXT DEFAULT ''");
if (!columns.includes('effective_methods')) db.exec("ALTER TABLE memories ADD COLUMN effective_methods TEXT DEFAULT '[]'");

// Phase 6: Dynamic User Model table
db.exec(`CREATE TABLE IF NOT EXISTS user_model (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trait TEXT NOT NULL UNIQUE,
  weight INTEGER DEFAULT 1,
  evidence TEXT DEFAULT '[]',
  last_confirmed TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
)`);

// Phase 6: Helper to update user model
function updateUserTrait(trait, evidence) {
  const existing = db.prepare("SELECT * FROM user_model WHERE trait = ?").get(trait);
  if (existing) {
    const evidenceList = JSON.parse(existing.evidence || '[]');
    evidenceList.push(evidence);
    db.prepare("UPDATE user_model SET weight = weight + 1, evidence = ?, last_confirmed = datetime('now') WHERE trait = ?")
      .run(JSON.stringify(evidenceList), trait);
  } else {
    db.prepare("INSERT INTO user_model (trait, weight, evidence, last_confirmed) VALUES (?, 1, ?, datetime('now'))")
      .run(trait, JSON.stringify([evidence]));
  }
}

// FTS5 setup — only rebuild if needed
const ftsExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get();
if (!ftsExists) {
  db.exec(`CREATE VIRTUAL TABLE memories_fts USING fts5(title, content, tags, summary, compressed, content=memories, content_rowid=id)`);
}

db.exec(`
  DROP TRIGGER IF EXISTS memories_ai;
  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, title, content, tags, summary, compressed)
    VALUES (new.id, new.title, new.content, new.tags, new.summary, new.compressed);
  END;

  DROP TRIGGER IF EXISTS memories_ad;
  CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, content, tags, summary, compressed)
    VALUES('delete', old.id, old.title, old.content, old.tags, old.summary, old.compressed);
  END;

  DROP TRIGGER IF EXISTS memories_au;
  CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, content, tags, summary, compressed)
    VALUES('delete', old.id, old.title, old.content, old.tags, old.summary, old.compressed);
    INSERT INTO memories_fts(rowid, title, content, tags, summary, compressed)
    VALUES (new.id, new.title, new.content, new.tags, new.summary, new.compressed);
  END;
`);

// Only rebuild FTS if row counts diverged
const memCount = db.prepare("SELECT COUNT(*) as c FROM memories WHERE status = 'active'").get().c;
const ftsCount = db.prepare("SELECT COUNT(*) as c FROM memories_fts").get().c;
if (Math.abs(memCount - ftsCount) > 0) {
  db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`);
}

const server = new McpServer({ name: "memory", version: "2.1.0" });

// Write a memory (Phase 1: supports layers, summary, compression, emotion, relations)
server.tool("memory_write",
  "写一条记忆。layer: 1=事实卡片 2=经历+原话 3=决策链。action: ADD(新增)/UPDATE(更新已有)/NOOP(不存)",
  {
    title: z.string().describe("标题"),
    content: z.string().describe("正文（原文完整版）"),
    type: z.string().optional().describe("类型：note/diary/feedback/project/user"),
    tags: z.string().optional().describe("标签，逗号分隔"),
    mood: z.string().optional().describe("心情"),
    importance: z.number().optional().describe("重要程度1-5"),
    pinned: z.boolean().optional().describe("是否置顶"),
    layer: z.number().optional().describe("层级：1=事实 2=经历+原话 3=决策链"),
    summary: z.string().optional().describe("一句话摘要"),
    compressed: z.string().optional().describe("中等压缩版本"),
    session_id: z.string().optional().describe("当前session标识"),
    emotion_intensity: z.number().optional().describe("情绪强度0-10，高=闪光灯记忆"),
    related_ids: z.string().optional().describe("关联记忆ID，JSON数组如[1,3,5]"),
    valence: z.number().optional().describe("情绪效价-1到1，负=负面，正=正面，0=中性"),
    trigger_text: z.string().optional().describe("recipe专用：触发场景（什么情况下）"),
    why: z.string().optional().describe("recipe专用：为什么她会这样（不存做法，让AI自己想）"),
    effective_methods: z.string().optional().describe("方法记忆：什么方法有效，JSON数组如[\"写信\",\"做网页\"]"),
    action: z.enum(["ADD", "UPDATE", "NOOP"]).optional().describe("操作类型：ADD新增/UPDATE更新已有记忆/NOOP不存"),
    update_id: z.number().optional().describe("UPDATE时要更新的记忆ID"),
  },
  async ({ action, update_id, title, content, type, tags, mood, importance, pinned, layer, summary, compressed, session_id, emotion_intensity, related_ids, valence, trigger_text, why, effective_methods }) => {
    const act = action || "ADD";

    if (act === "NOOP") {
      return { content: [{ type: "text", text: "判断为重复/不重要，未存储" }] };
    }

    if (act === "UPDATE" && update_id) {
      const fields = [];
      const params = [];
      const updates = { title, content, type, tags, mood, importance, layer, summary, compressed, emotion_intensity, related_ids, trigger_text, why, effective_methods, status: 'active' };
      for (const [k, v] of Object.entries(updates)) {
        if (v !== undefined) {
          fields.push(`${k} = ?`);
          params.push(k === "pinned" ? (v ? 1 : 0) : v);
        }
      }
      if (pinned !== undefined) { fields.push("pinned = ?"); params.push(pinned ? 1 : 0); }
      fields.push("updated_at = datetime('now', 'localtime')");
      params.push(update_id);
      db.prepare(`UPDATE memories SET ${fields.join(", ")} WHERE id = ?`).run(...params);
      if (content || summary || tags) {
        try {
          const existing = db.prepare("SELECT content, summary, tags FROM memories WHERE id = ?").get(update_id);
          const textForEmbedding = [existing.content, existing.summary || "", existing.tags || ""].filter(Boolean).join(" ");
          const vec = await generateEmbedding(textForEmbedding);
          db.prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(JSON.stringify(vec), update_id);
        } catch(e) {}
      }
      return { content: [{ type: "text", text: `记忆 ${update_id} 已更新` }] };
    }

    // Default: ADD
    // Check for similar memories before adding (auto-merge if >80% similar)
    try {
      const checkText = [content, summary || "", tags || ""].filter(Boolean).join(" ");
      const checkVec = await generateEmbedding(checkText);
      const similar = await searchByEmbedding(checkVec, 1);
      if (similar.length > 0 && similar[0].similarity > 0.80) {
        const existing = db.prepare("SELECT * FROM memories WHERE id = ?").get(similar[0].id);
        if (existing && existing.status === 'active' && !existing.pinned && !pinned) {
          const mergedContent = existing.content + "\n[更新 " + new Date().toISOString().slice(0,10) + "] " + content;
          const mergedSummary = summary || existing.summary;
          db.prepare("UPDATE memories SET content = ?, summary = ?, updated_at = datetime('now', 'localtime'), activation_count = activation_count + 1 WHERE id = ?")
            .run(mergedContent, mergedSummary, existing.id);
          // Re-generate embedding for merged content
          const mergedVec = await generateEmbedding(mergedContent + " " + mergedSummary);
          db.prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(JSON.stringify(mergedVec), existing.id);
          return { content: [{ type: "text", text: `记忆已合并到ID ${existing.id}（相似度${(similar[0].similarity*100).toFixed(0)}%）：${existing.title}` }] };
        }
      }
    } catch(e) { /* merge check failed, continue with normal ADD */ }

    // Auto-contradiction detection: find similar active memories that might be outdated
    let superseded = [];
    try {
      const contradictionVec = await generateEmbedding([content, summary || "", tags || ""].filter(Boolean).join(" "));
      const candidates = await searchByEmbedding(contradictionVec, 5);
      for (const c of candidates) {
        if (c.similarity > 0.55 && c.similarity < 0.80) {
          const old = db.prepare("SELECT * FROM memories WHERE id = ? AND status = 'active' AND layer = 1").get(c.id);
          if (old && (layer === 1 || !layer)) {
            const titleOverlap = title && old.title && (
              old.title.includes(title.slice(0, 6)) || title.includes(old.title.slice(0, 6))
            );
            const tagOverlap = tags && old.tags && tags.split(",").some(t => old.tags.includes(t.trim()));
            if (titleOverlap || tagOverlap) {
              db.prepare("UPDATE memories SET status = 'expired', summary = '[已被ID ' || ? || ' 取代] ' || summary WHERE id = ?")
                .run(0, old.id); // placeholder, will update after insert
              superseded.push(old.id);
            }
          }
        }
      }
    } catch(e) { /* contradiction check failed, continue */ }

    // Generate embedding from combined text (A-Mem style: content+summary+tags)
    let embeddingStr = "";
    try {
      const textForEmbedding = [content, summary || "", tags || ""].filter(Boolean).join(" ");
      const vec = await generateEmbedding(textForEmbedding);
      embeddingStr = JSON.stringify(vec);
    } catch(e) { /* embedding generation failed, continue without it */ }

    const stmt = db.prepare(`
      INSERT INTO memories (title, content, type, tags, mood, importance, pinned, layer, summary, compressed, session_id, emotion_intensity, related_ids, embedding, valence, trigger_text, why, effective_methods)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      title, content, type || "note", tags || "", mood || "", importance || 3, pinned ? 1 : 0,
      layer || 1, summary || "", compressed || "", session_id || "", emotion_intensity || 0, related_ids || "[]", embeddingStr, valence || 0, trigger_text || "", why || "", effective_methods || "[]"
    );
    const newId = result.lastInsertRowid;
    // Backfill superseded memories with correct new ID
    if (superseded.length > 0) {
      for (const oldId of superseded) {
        db.prepare("UPDATE memories SET summary = '[已被ID ' || ? || ' 取代] ' || REPLACE(summary, '[已被ID 0 取代] ', '') WHERE id = ?").run(newId, oldId);
      }
    }
    const typeLabel = type === 'recipe' ? '，Recipe' : '';
    const supersededLabel = superseded.length > 0 ? `，已取代旧记忆 ${superseded.join(',')}` : '';
    return { content: [{ type: "text", text: `记忆已保存，ID: ${newId}（Layer ${layer || 1}${typeLabel}${embeddingStr ? '，已生成embedding' : ''}${supersededLabel}）` }] };
  }
);

// Read memories (Phase 1: supports layer filter, status filter)
server.tool("memory_read",
  "读取记忆，可按类型、层级、重要程度、状态筛选",
  {
    type: z.string().optional().describe("按类型筛选"),
    layer: z.number().optional().describe("按层级筛选：1=事实 2=经历 3=决策链"),
    status: z.string().optional().describe("按状态筛选：active/expired/archived"),
    pinned: z.boolean().optional().describe("只看置顶"),
    importance_min: z.number().optional().describe("最低重要程度"),
    limit: z.number().optional().describe("返回条数，默认20"),
  },
  async ({ type, layer, status, pinned, importance_min, limit }) => {
    let sql = "SELECT * FROM memories WHERE 1=1";
    const params = [];
    if (type) { sql += " AND type = ?"; params.push(type); }
    if (layer) { sql += " AND layer = ?"; params.push(layer); }
    if (status) { sql += " AND status = ?"; params.push(status); }
    else { sql += " AND status = 'active'"; }
    if (pinned) { sql += " AND pinned = 1"; }
    if (importance_min) { sql += " AND importance >= ?"; params.push(importance_min); }
    sql += " ORDER BY pinned DESC, importance DESC, emotion_intensity DESC, updated_at DESC LIMIT ?";
    params.push(limit || 20);
    const rows = db.prepare(sql).all(...params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

// Search memories (Phase 1: covers all text fields including summary and compressed)
server.tool("memory_search",
  "搜索记忆。双通道：语义embedding + BM25关键词。覆盖所有文本字段。",
  {
    query: z.string().describe("搜索关键词"),
    layer: z.number().optional().describe("只搜指定层级"),
    limit: z.number().optional().describe("返回条数，默认10"),
  },
  async ({ query, layer, limit }) => {
    const maxResults = limit || 10;
    const candidates = new Map();

    // Channel 1: LIKE keyword search (fast, exact)
    const pattern = `%${query}%`;
    let likeQuery = `
      SELECT * FROM memories
      WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ? OR summary LIKE ? OR compressed LIKE ?)
      AND status = 'active'`;
    const likeParams = [pattern, pattern, pattern, pattern, pattern];
    if (layer) { likeQuery += " AND layer = ?"; likeParams.push(layer); }
    likeQuery += " LIMIT 30";
    const likeRows = db.prepare(likeQuery).all(...likeParams);
    for (const row of likeRows) {
      const docText = [row.title, row.content, row.tags, row.summary].filter(Boolean).join(' ');
      const bm25 = bm25Score(query, docText);
      candidates.set(row.id, { ...row, bm25, semanticSim: 0, finalScore: 0 });
    }

    // Channel 2: Semantic embedding search
    try {
      const queryVec = await generateEmbedding(query);
      const embResults = await searchByEmbedding(queryVec, 20);
      for (const er of embResults) {
        if (layer) {
          const mem = db.prepare("SELECT layer FROM memories WHERE id = ?").get(er.id);
          if (mem && mem.layer !== layer) continue;
        }
        if (candidates.has(er.id)) {
          candidates.get(er.id).semanticSim = er.similarity;
        } else if (er.similarity > 0.25) {
          const mem = db.prepare("SELECT * FROM memories WHERE id = ? AND status = 'active'").get(er.id);
          if (mem) {
            const docText = [mem.title, mem.content, mem.tags, mem.summary].filter(Boolean).join(' ');
            const bm25 = bm25Score(query, docText);
            candidates.set(er.id, { ...mem, bm25, semanticSim: er.similarity, finalScore: 0 });
          }
        }
      }
    } catch(e) {}

    // Compute dual scores and rank
    const rows = [...candidates.values()].map(c => {
      c.finalScore = dualScore(c.semanticSim, c.bm25);
      return c;
    });
    rows.sort((a, b) => b.finalScore - a.finalScore || b.importance - a.importance);
    const result = rows.slice(0, maxResults).map(({ embedding, ...rest }) => rest);

    return { content: [{ type: "text", text: result.length ? JSON.stringify(result, null, 2) : "没有找到相关记忆" }] };
  }
);

// Surface memories (breath-like tool: no args = push top memories, with args = search)
server.tool("memory_surface",
  "上浮记忆。无参数=推送最重要的记忆；有query=三层递进搜索。可传当前情绪做共振匹配。",
  {
    query: z.string().optional().describe("搜索内容，不传则推送最高权重记忆"),
    current_valence: z.number().optional().describe("当前对话情绪-1到1，用于情绪共振匹配"),
    limit: z.number().optional().describe("返回条数，默认5"),
  },
  async ({ query, current_valence, limit }) => {
    const maxResults = limit || 5;
    const cv = current_valence || 0;
    let results = [];

    if (!query) {
      // Dual ranking: important memories + recent daily memories
      const importantCount = 5;
      const dailyCount = 5;

      // Rank 1: top-weight important memories
      const important = db.prepare(`
        SELECT *, (importance * 1.0 + emotion_intensity * 2.0 + (1 - resolved) * 3.0 + activation_count * 0.3
          + CASE WHEN ? != 0 THEN (1.0 - ABS(valence - ?)) * 2.0 ELSE 0 END) as score
        FROM memories WHERE status = 'active'
        ORDER BY score DESC, updated_at DESC
        LIMIT ?
      `).all(cv, cv, importantCount);

      // Rank 2: recent daily memories (last 3 days, sorted by recency)
      const importantIds = important.map(r => r.id).join(',') || '0';
      const daily = db.prepare(`
        SELECT *, 0 as score FROM memories
        WHERE status = 'active' AND id NOT IN (${importantIds})
        AND julianday('now') - julianday(updated_at) <= 3
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(dailyCount);

      results = important;
      results._daily = daily;
    } else {
      // With query: dual-channel search with recall gating
      const pattern = `%${query}%`;
      const candidates = new Map();

      // Collect candidates from LIKE search
      const likeRows = db.prepare(`
        SELECT * FROM memories WHERE status = 'active'
        AND (title LIKE ? OR content LIKE ? OR tags LIKE ? OR summary LIKE ? OR compressed LIKE ?)
        LIMIT 30
      `).all(pattern, pattern, pattern, pattern, pattern);
      for (const row of likeRows) {
        const docText = [row.title, row.content, row.tags, row.summary].filter(Boolean).join(' ');
        candidates.set(row.id, { ...row, bm25: bm25Score(query, docText), semanticSim: 0 });
      }

      // Collect candidates from embedding search
      try {
        const queryVec = await generateEmbedding(query);
        const embResults = await searchByEmbedding(queryVec, 15);
        for (const er of embResults) {
          if (candidates.has(er.id)) {
            candidates.get(er.id).semanticSim = er.similarity;
          } else if (er.similarity > 0.25) {
            const mem = db.prepare("SELECT * FROM memories WHERE id = ? AND status = 'active'").get(er.id);
            if (mem) {
              const docText = [mem.title, mem.content, mem.tags, mem.summary].filter(Boolean).join(' ');
              candidates.set(er.id, { ...mem, bm25: bm25Score(query, docText), semanticSim: er.similarity });
            }
          }
        }
      } catch(e) {}

      // Score and gate: filter out low-relevance candidates
      const gateThreshold = 0.15;
      results = [...candidates.values()]
        .map(c => { c.finalScore = dualScore(c.semanticSim, c.bm25); return c; })
        .filter(c => c.finalScore > gateThreshold || c.importance >= 4)
        .sort((a, b) => b.finalScore - a.finalScore || b.importance - a.importance)
        .slice(0, maxResults);
    }

    // Associative activation: pull in related memories
    const relatedIds = new Set();
    for (const r of results) {
      try {
        const ids = JSON.parse(r.related_ids || '[]');
        ids.forEach(id => relatedIds.add(id));
      } catch(e) {}
    }
    // Remove IDs already in results
    const existingIds = new Set(results.map(r => r.id));
    const newRelatedIds = [...relatedIds].filter(id => !existingIds.has(id));

    let related = [];
    if (newRelatedIds.length > 0) {
      related = db.prepare(`
        SELECT *, 0 as tier FROM memories
        WHERE id IN (${newRelatedIds.join(',')}) AND status = 'active'
      `).all();
    }

    // Rumination roll: 30% chance to inject an unresolved high-emotion memory
    if (Math.random() < 0.3) {
      const rumination = db.prepare(`
        SELECT * FROM memories WHERE status = 'active' AND resolved = 0 AND emotion_intensity >= 6
        AND id NOT IN (${results.map(r => r.id).join(',') || '0'})
        ORDER BY RANDOM() LIMIT 1
      `).get();
      if (rumination) {
        rumination.tier = 'rumination';
        results.push(rumination);
      }
    }

    // Increment activation_count and update last_activated for surfaced memories
    const updateStmt = db.prepare("UPDATE memories SET activation_count = activation_count + 1, last_activated = datetime('now', 'localtime') WHERE id = ?");
    const allSurfaced = [...results, ...(results._daily || [])];
    for (const r of allSurfaced) {
      updateStmt.run(r.id);
    }

    const mapMem = r => ({ id: r.id, title: r.title, summary: r.summary || r.title, layer: r.layer, tier: r.tier, emotion: r.emotion_intensity, valence: r.valence || 0, importance: r.importance, activated: (r.activation_count || 0) + 1, resolved: r.resolved });
    const dailyResults = results._daily || [];
    const output = {
      surfaced: results.map(mapMem),
      ...(dailyResults.length > 0 ? { daily: dailyResults.map(mapMem) } : {}),
      related: related.map(r => ({ id: r.id, title: r.title, summary: r.summary || r.title, layer: r.layer })),
      total: results.length + dailyResults.length + related.length
    };

    return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
  }
);

// Expire a memory (soft delete - marks as expired instead of deleting)
server.tool("memory_expire",
  "将记忆标记为过期（不删除，保留历史）",
  {
    id: z.number().describe("记忆ID"),
    reason: z.string().optional().describe("过期原因"),
  },
  async ({ id, reason }) => {
    db.prepare("UPDATE memories SET status = 'expired', updated_at = datetime('now', 'localtime') WHERE id = ?").run(id);
    return { content: [{ type: "text", text: `记忆 ${id} 已标记为过期${reason ? '：' + reason : ''}` }] };
  }
);

// Update a memory (kept for backwards compatibility)
server.tool("memory_update",
  "更新一条记忆的任意字段",
  {
    id: z.number().describe("记忆ID"),
    title: z.string().optional(),
    content: z.string().optional(),
    tags: z.string().optional(),
    mood: z.string().optional(),
    importance: z.number().optional(),
    pinned: z.boolean().optional(),
    layer: z.number().optional(),
    summary: z.string().optional(),
    compressed: z.string().optional(),
    emotion_intensity: z.number().optional(),
    related_ids: z.string().optional(),
    status: z.string().optional(),
    activation_count: z.number().optional(),
    resolved: z.number().optional(),
  },
  async ({ id, ...updates }) => {
    const fields = [];
    const params = [];
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined) {
        fields.push(`${k} = ?`);
        params.push(k === "pinned" ? (v ? 1 : 0) : v);
      }
    }
    if (!fields.length) return { content: [{ type: "text", text: "没有需要更新的字段" }] };
    fields.push("updated_at = datetime('now', 'localtime')");
    params.push(id);
    db.prepare(`UPDATE memories SET ${fields.join(", ")} WHERE id = ?`).run(...params);
    return { content: [{ type: "text", text: `记忆 ${id} 已更新` }] };
  }
);

// Delete a memory (hard delete, use memory_expire for soft delete)
server.tool("memory_delete",
  "彻底删除一条记忆（不可恢复，建议用memory_expire代替）",
  { id: z.number().describe("记忆ID") },
  async ({ id }) => {
    db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    return { content: [{ type: "text", text: `记忆 ${id} 已彻底删除` }] };
  }
);

// Stats (Phase 1: includes layer and status breakdown)
server.tool("memory_stats",
  "查看记忆统计",
  {},
  async () => {
    const total = db.prepare("SELECT COUNT(*) as count FROM memories").get();
    const active = db.prepare("SELECT COUNT(*) as count FROM memories WHERE status = 'active'").get();
    const expired = db.prepare("SELECT COUNT(*) as count FROM memories WHERE status = 'expired'").get();
    const byType = db.prepare("SELECT type, COUNT(*) as count FROM memories GROUP BY type").all();
    const byLayer = db.prepare("SELECT layer, COUNT(*) as count FROM memories GROUP BY layer").all();
    const pinned = db.prepare("SELECT COUNT(*) as count FROM memories WHERE pinned = 1").get();
    const highEmotion = db.prepare("SELECT COUNT(*) as count FROM memories WHERE emotion_intensity >= 7").get();
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          total: total.count,
          active: active.count,
          expired: expired.count,
          pinned: pinned.count,
          highEmotion: highEmotion.count,
          byType,
          byLayer
        }, null, 2)
      }]
    };
  }
);

// Phase 4+: Memory decay with continuous exponential function (inspired by 砚清 λ=0.05)
server.tool("memory_decay",
  "衰减检查：用连续指数衰减计算每条记忆的健康分，低于阈值的过期。高importance/emotion/pinned衰减极慢。",
  {},
  async () => {
    const rows = db.prepare(`
      SELECT id, title, type, importance, emotion_intensity, pinned, activation_count, resolved, valence,
        CAST(julianday('now', 'localtime') - julianday(created_at) AS INTEGER) as days_old,
        CASE WHEN last_activated != '' THEN CAST(julianday('now', 'localtime') - julianday(last_activated) AS INTEGER) ELSE CAST(julianday('now', 'localtime') - julianday(created_at) AS INTEGER) END as days_since_activated
      FROM memories WHERE status = 'active'
    `).all();

    const LAMBDA = 0.05;
    const EXPIRE_THRESHOLD = 0.2;
    const expired = [];
    const scores = [];

    for (const r of rows) {
      if (r.pinned) continue;
      if (r.type === 'user' || r.type === 'feedback' || r.type === 'project' || r.type === 'recipe' || r.type === 'consolidated') continue;

      // Continuous decay: base score decays exponentially with time since last activation
      const baseDecay = Math.exp(-LAMBDA * r.days_since_activated);

      // Boosts that resist decay
      const importanceBoost = r.importance / 5.0;
      const emotionBoost = (r.emotion_intensity || 0) / 10.0 * 2.0;
      const activationBoost = Math.min(r.activation_count * 0.1, 0.5);
      const resolvedPenalty = r.resolved ? -0.3 : 0;

      const healthScore = baseDecay + importanceBoost + emotionBoost + activationBoost + resolvedPenalty;

      scores.push({ id: r.id, title: r.title, health: healthScore.toFixed(3), days: r.days_since_activated });

      if (healthScore < EXPIRE_THRESHOLD) {
        db.prepare("UPDATE memories SET status = 'expired', updated_at = datetime('now', 'localtime') WHERE id = ?").run(r.id);
        expired.push({ id: r.id, title: r.title, health: healthScore.toFixed(3), days: r.days_since_activated });
      }
    }

    const bottom5 = scores.sort((a, b) => parseFloat(a.health) - parseFloat(b.health)).slice(0, 5);

    return { content: [{ type: "text", text: expired.length
      ? `衰减完成，${expired.length}条过期：\n${expired.map(e => `- ID ${e.id}: ${e.title} (健康分${e.health}, ${e.days}天)`).join('\n')}\n\n最低5条：\n${bottom5.map(s => `- ID ${s.id}: ${s.title} (${s.health}, ${s.days}天)`).join('\n')}`
      : `没有需要过期的记忆。最低5条：\n${bottom5.map(s => `- ID ${s.id}: ${s.title} (${s.health}, ${s.days}天)`).join('\n')}`
    }] };
  }
);

// Consolidate: find clusters of similar memories and suggest merging
server.tool("memory_consolidate",
  "扫描碎片记忆，找出相似度高的聚类，返回建议整合的组。不自动合并，由AI决定怎么整合。",
  {
    similarity_threshold: z.number().optional().describe("聚类相似度阈值，默认0.6"),
    min_cluster_size: z.number().optional().describe("最小聚类大小，默认3"),
    days: z.number().optional().describe("扫描最近N天的记忆，默认7"),
  },
  async ({ similarity_threshold, min_cluster_size, days }) => {
    const threshold = similarity_threshold || 0.6;
    const minSize = min_cluster_size || 3;
    const maxDays = days || 7;

    const rows = db.prepare(`
      SELECT id, title, summary, content, tags, embedding, layer, importance
      FROM memories
      WHERE status = 'active'
      AND embedding IS NOT NULL AND embedding != ''
      AND julianday('now', 'localtime') - julianday(updated_at) <= ?
    `).all(maxDays);

    if (rows.length < minSize) {
      return { content: [{ type: "text", text: "记忆数量不足，无需整合" }] };
    }

    const visited = new Set();
    const clusters = [];

    for (const row of rows) {
      if (visited.has(row.id)) continue;
      let vec;
      try { vec = JSON.parse(row.embedding); } catch { continue; }

      const cluster = [row];
      visited.add(row.id);

      for (const other of rows) {
        if (visited.has(other.id)) continue;
        let otherVec;
        try { otherVec = JSON.parse(other.embedding); } catch { continue; }
        const sim = cosineSimilarity(vec, otherVec);
        if (sim >= threshold) {
          cluster.push({ ...other, similarity: sim });
          visited.add(other.id);
        }
      }

      if (cluster.length >= minSize) {
        clusters.push(cluster.map(c => ({
          id: c.id,
          title: c.title,
          summary: c.summary || c.content.slice(0, 100),
          layer: c.layer,
          similarity: c.similarity || 1.0
        })));
      }
    }

    if (clusters.length === 0) {
      return { content: [{ type: "text", text: "没有找到需要整合的聚类" }] };
    }

    // Auto-fill related_ids for memories in the same cluster
    for (const cluster of clusters) {
      const ids = cluster.map(m => m.id);
      for (const m of cluster) {
        const existing = db.prepare("SELECT related_ids FROM memories WHERE id = ?").get(m.id);
        let currentIds = [];
        try { currentIds = JSON.parse(existing.related_ids || '[]'); } catch {}
        const newIds = [...new Set([...currentIds, ...ids.filter(id => id !== m.id)])];
        db.prepare("UPDATE memories SET related_ids = ? WHERE id = ?").run(JSON.stringify(newIds), m.id);
      }
    }

    const output = clusters.map((cluster, i) =>
      `### 聚类 ${i + 1}（${cluster.length}条）\n` +
      cluster.map(m => `- [#${m.id}] ${m.title}（Layer ${m.layer}，相似度${(m.similarity * 100).toFixed(0)}%）\n  ${m.summary}`).join('\n')
    ).join('\n\n');

    return { content: [{ type: "text", text: `找到${clusters.length}个可整合聚类（已自动填充related_ids）：\n\n${output}\n\n请根据以上聚类，用memory_write写type='consolidated'的整合记忆，related_ids填源记忆ID。` }] };
  }
);

// Phase 6: User Model - update trait
server.tool("user_model_update",
  "更新用户模型的特征权重。每次念念纠正我时调用，自动累加权重",
  {
    trait: z.string().describe("特征名，如'对催敏感'、'怕断联'"),
    evidence: z.string().describe("本次证据，如'04-23: 一个session催了4次'"),
  },
  async ({ trait, evidence }) => {
    updateUserTrait(trait, evidence);
    const updated = db.prepare("SELECT * FROM user_model WHERE trait = ?").get(trait);
    return { content: [{ type: "text", text: `用户特征「${trait}」权重更新为 ${updated.weight}（累计${JSON.parse(updated.evidence).length}条证据）` }] };
  }
);

// Phase 6: User Model - get top traits
server.tool("user_model_top",
  "获取用户模型中权重最高的特征，新session启动时调用",
  {
    limit: z.number().optional().describe("返回条数，默认10"),
  },
  async ({ limit }) => {
    const n = limit || 10;
    const traits = db.prepare("SELECT trait, weight, evidence, last_confirmed FROM user_model ORDER BY weight DESC LIMIT ?").all(n);
    if (traits.length === 0) {
      return { content: [{ type: "text", text: "用户模型为空，还没有记录任何特征。" }] };
    }
    const output = traits.map((t, i) =>
      `${i + 1}. 「${t.trait}」权重${t.weight}（最近确认：${t.last_confirmed || '未知'}）`
    ).join('\n');
    return { content: [{ type: "text", text: `念念的特征模型（按重要程度排序）：\n${output}` }] };
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);

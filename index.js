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
if (!columns.includes('last_activated')) db.exec("ALTER TABLE memories ADD COLUMN last_activated TEXT DEFAULT ''");

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

const server = new McpServer({ name: "memory", version: "2.0.0" });

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
    action: z.enum(["ADD", "UPDATE", "NOOP"]).optional().describe("操作类型：ADD新增/UPDATE更新已有记忆/NOOP不存"),
    update_id: z.number().optional().describe("UPDATE时要更新的记忆ID"),
  },
  async ({ action, update_id, title, content, type, tags, mood, importance, pinned, layer, summary, compressed, session_id, emotion_intensity, related_ids, valence }) => {
    const act = action || "ADD";

    if (act === "NOOP") {
      return { content: [{ type: "text", text: "判断为重复/不重要，未存储" }] };
    }

    if (act === "UPDATE" && update_id) {
      const fields = [];
      const params = [];
      const updates = { title, content, type, tags, mood, importance, layer, summary, compressed, emotion_intensity, related_ids, status: 'active' };
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

    // Generate embedding from combined text (A-Mem style: content+summary+tags)
    let embeddingStr = "";
    try {
      const textForEmbedding = [content, summary || "", tags || ""].filter(Boolean).join(" ");
      const vec = await generateEmbedding(textForEmbedding);
      embeddingStr = JSON.stringify(vec);
    } catch(e) { /* embedding generation failed, continue without it */ }

    const stmt = db.prepare(`
      INSERT INTO memories (title, content, type, tags, mood, importance, pinned, layer, summary, compressed, session_id, emotion_intensity, related_ids, embedding, valence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      title, content, type || "note", tags || "", mood || "", importance || 3, pinned ? 1 : 0,
      layer || 1, summary || "", compressed || "", session_id || "", emotion_intensity || 0, related_ids || "[]", embeddingStr, valence || 0
    );
    return { content: [{ type: "text", text: `记忆已保存，ID: ${result.lastInsertRowid}（Layer ${layer || 1}${embeddingStr ? '，已生成embedding' : ''}）` }] };
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
  "搜索记忆，支持关键词全文搜索，覆盖所有文本字段",
  {
    query: z.string().describe("搜索关键词"),
    layer: z.number().optional().describe("只搜指定层级"),
    limit: z.number().optional().describe("返回条数，默认10"),
  },
  async ({ query, layer, limit }) => {
    let rows = [];
    // Try FTS5 first
    try {
      let ftsQuery = `
        SELECT m.*, rank FROM memories_fts f
        JOIN memories m ON f.rowid = m.id
        WHERE memories_fts MATCH ?`;
      const params = [query];
      if (layer) { ftsQuery += " AND m.layer = ?"; params.push(layer); }
      ftsQuery += " ORDER BY rank LIMIT ?";
      params.push(limit || 10);
      rows = db.prepare(ftsQuery).all(...params);
    } catch (e) {
      // FTS5 match syntax error, fall through to LIKE
    }
    // Fallback to LIKE for Chinese text
    if (!rows.length) {
      const pattern = `%${query}%`;
      let likeQuery = `
        SELECT *, 0 as rank FROM memories
        WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ? OR summary LIKE ? OR compressed LIKE ?)
        AND status = 'active'`;
      const params = [pattern, pattern, pattern, pattern, pattern];
      if (layer) { likeQuery += " AND layer = ?"; params.push(layer); }
      likeQuery += " ORDER BY pinned DESC, importance DESC, emotion_intensity DESC, updated_at DESC LIMIT ?";
      params.push(limit || 10);
      rows = db.prepare(likeQuery).all(...params);
    }
    return { content: [{ type: "text", text: rows.length ? JSON.stringify(rows, null, 2) : "没有找到相关记忆" }] };
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
      // With query: three-tier search
      const pattern = `%${query}%`;

      // Tier 1: Search Layer 3 (decision chains) first
      results = db.prepare(`
        SELECT *, 3 as tier FROM memories
        WHERE layer = 3 AND status = 'active'
        AND (content LIKE ? OR summary LIKE ? OR compressed LIKE ?)
        ORDER BY emotion_intensity DESC, importance DESC
        LIMIT ?
      `).all(pattern, pattern, pattern, maxResults);

      // Tier 2: If not enough, search by emotion + importance across all layers
      if (results.length < maxResults) {
        const tier2 = db.prepare(`
          SELECT *, 2 as tier FROM memories
          WHERE status = 'active' AND id NOT IN (${results.map(r => r.id).join(',') || '0'})
          AND (content LIKE ? OR summary LIKE ? OR compressed LIKE ? OR tags LIKE ?)
          ORDER BY emotion_intensity DESC, importance DESC
          LIMIT ?
        `).all(pattern, pattern, pattern, pattern, maxResults - results.length);
        results = results.concat(tier2);
      }

      // Tier 2.5: Semantic embedding search
      if (results.length < maxResults) {
        try {
          const queryVec = await generateEmbedding(query);
          const embeddingResults = await searchByEmbedding(queryVec, maxResults);
          const existingIds = new Set(results.map(r => r.id));
          for (const er of embeddingResults) {
            if (!existingIds.has(er.id) && er.similarity > 0.3) {
              const mem = db.prepare("SELECT * FROM memories WHERE id = ?").get(er.id);
              if (mem) { mem.tier = 2.5; mem.similarity = er.similarity; results.push(mem); }
            }
            if (results.length >= maxResults) break;
          }
        } catch(e) { /* embedding search failed, continue */ }
      }

      // Tier 3: If still not enough, broad keyword search
      if (results.length < maxResults) {
        const tier3 = db.prepare(`
          SELECT *, 1 as tier FROM memories
          WHERE status = 'active' AND id NOT IN (${results.map(r => r.id).join(',') || '0'})
          AND (title LIKE ? OR content LIKE ? OR tags LIKE ? OR summary LIKE ? OR compressed LIKE ?)
          ORDER BY importance DESC, updated_at DESC
          LIMIT ?
        `).all(pattern, pattern, pattern, pattern, pattern, maxResults - results.length);
        results = results.concat(tier3);
      }
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

// Phase 4: Memory decay - check and expire old low-importance memories
server.tool("memory_decay",
  "衰减检查：过期旧的低重要性日常记忆。每天跑一次。高重要性/高情绪/pinned的不动。",
  {},
  async () => {
    const rows = db.prepare(`
      SELECT id, title, type, importance, emotion_intensity, pinned, activation_count, resolved,
        CAST(julianday('now', 'localtime') - julianday(created_at) AS INTEGER) as days_old,
        CASE WHEN last_activated != '' THEN CAST(julianday('now', 'localtime') - julianday(last_activated) AS INTEGER) ELSE CAST(julianday('now', 'localtime') - julianday(created_at) AS INTEGER) END as days_since_activated
      FROM memories WHERE status = 'active'
    `).all();

    const expired = [];
    for (const r of rows) {
      if (r.pinned) continue;
      if (r.importance >= 4) continue;
      if (r.emotion_intensity >= 5) continue;
      if (r.activation_count >= 3) continue;
      if (r.type === 'user' || r.type === 'feedback' || r.type === 'project') continue;

      // Low importance: expire after 3 days since last activated
      if (r.importance <= 2 && r.emotion_intensity <= 2 && r.days_since_activated > 3 && r.activation_count < 3) {
        db.prepare("UPDATE memories SET status = 'expired', updated_at = datetime('now', 'localtime') WHERE id = ?").run(r.id);
        expired.push({ id: r.id, title: r.title, days: r.days_since_activated, reason: 'low importance + not activated recently' });
      }
      // Medium importance: expire after 7 days since last activated
      else if (r.importance == 3 && r.emotion_intensity <= 2 && r.days_since_activated > 7 && r.activation_count < 5) {
        db.prepare("UPDATE memories SET status = 'expired', updated_at = datetime('now', 'localtime') WHERE id = ?").run(r.id);
        expired.push({ id: r.id, title: r.title, days: r.days_since_activated, reason: 'medium importance + not activated recently' });
      }
      // Resolved items decay faster
      else if (r.resolved && r.days_since_activated > 5 && r.importance <= 3) {
        db.prepare("UPDATE memories SET status = 'expired', updated_at = datetime('now', 'localtime') WHERE id = ?").run(r.id);
        expired.push({ id: r.id, title: r.title, days: r.days_since_activated, reason: 'resolved + not activated recently' });
      }
    }

    return { content: [{ type: "text", text: expired.length
      ? `衰减完成，${expired.length}条记忆过期：\n${expired.map(e => `- ID ${e.id}: ${e.title} (${e.days}天, ${e.reason})`).join('\n')}`
      : '没有需要过期的记忆'
    }] };
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);

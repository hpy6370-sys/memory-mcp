import { z } from "zod";
import db from "../db.js";
import { searchV2 } from "../v2/index.js";

export function registerSurfaceTool(server) {
  server.tool("memory_surface",
    "上浮记忆。无参数=推送最重要的记忆；有query=v2四通道搜索。可传当前情绪做共振匹配。",
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
        // No-query mode: dual ranking (important + recent daily)
        const importantCount = 5;
        const dailyCount = 5;

        const important = db.prepare(`
          SELECT *,
            (importance * 1.5
            + emotion_intensity * 1.0
            + MIN(activation_count, 10) * 0.2
            + EXP(-1.0 * (julianday('now') - julianday(COALESCE(NULLIF(last_activated,''), updated_at))) / (30.0 + emotion_intensity * 10.0)) * 5.0
            + CASE WHEN pinned = 1 THEN 10.0 ELSE 0 END
            + CASE WHEN ? != 0 THEN (1.0 - ABS(valence - ?)) * 1.5 ELSE 0 END
            ) as score
          FROM memories WHERE status = 'active'
          ORDER BY score DESC
          LIMIT ?
        `).all(cv, cv, importantCount);

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
        // With query: use v2 search pipeline
        const searchResult = await searchV2(query, {
          limit: maxResults,
          currentValence: cv,
        });
        results = searchResult.results.map(r => {
          const { _search, ...mem } = r;
          return { ...mem, finalScore: _search.adjustedScore || _search.rrfScore };
        });
      }

      // Associative activation: pull in related memories
      const relatedIds = new Set();
      for (const r of results) {
        try {
          const ids = JSON.parse(r.related_ids || '[]');
          ids.forEach(id => relatedIds.add(id));
        } catch(e) {}
      }
      const existingIds = new Set(results.map(r => r.id));
      const newRelatedIds = [...relatedIds].filter(id => !existingIds.has(id));

      let related = [];
      if (newRelatedIds.length > 0) {
        const placeholders = newRelatedIds.map(() => '?').join(',');
        related = db.prepare(`
          SELECT *, 0 as tier FROM memories
          WHERE id IN (${placeholders}) AND status = 'active'
        `).all(...newRelatedIds.map(Number));
      }

      // Rumination roll: 30% chance to inject a high-emotion memory
      if (Math.random() < 0.3) {
        const rumination = db.prepare(`
          SELECT * FROM memories WHERE status = 'active' AND emotion_intensity >= 6
          AND id NOT IN (${results.map(r => r.id).join(',') || '0'})
          ORDER BY RANDOM() LIMIT 1
        `).get();
        if (rumination) {
          rumination.tier = 'rumination';
          results.push(rumination);
        }
      }

      // Increment activation_count
      const updateStmt = db.prepare("UPDATE memories SET activation_count = activation_count + 1, last_activated = datetime('now', 'localtime') WHERE id = ?");
      const allSurfaced = [...results, ...(results._daily || [])];
      for (const r of allSurfaced) {
        updateStmt.run(r.id);
      }

      const mapMem = r => ({ id: r.id, title: r.title, summary: r.summary || r.title, layer: r.layer, tier: r.tier, emotion: r.emotion_intensity, valence: r.valence || 0, importance: r.importance, activated: (r.activation_count || 0) + 1 });
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
}

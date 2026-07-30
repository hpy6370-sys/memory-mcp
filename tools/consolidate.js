import { z } from "zod";
import db from "../db.js";
import { cosineSimilarity } from "../embedding.js";

export function registerConsolidateTool(server) {
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
}

import { z } from "zod";
import db from "../db.js";
import { generateEmbedding, searchByEmbedding } from "../embedding.js";
import { checkAndMerge, detectSuperseded } from "../similarity.js";
import { autoTag, extractAndStoreEntities, shouldChunk, chunkByTopic } from "../v2/index.js";

const KNOWN_NAMES = {
  female: (process.env.MEMORY_USER_NAMES || '').split(',').filter(Boolean),
  male: (process.env.MEMORY_ASSISTANT_NAMES || '').split(',').filter(Boolean),
};

function resolveCoreferences(text) {
  if (!text) return text;
  const hasFemale = KNOWN_NAMES.female.some(n => text.includes(n));
  const hasMale = KNOWN_NAMES.male.some(n => text.includes(n));
  let resolved = text;
  if (!hasFemale && /她/.test(resolved)) {
    resolved = resolved.replace(/她们/g, '她们');
    resolved = resolved.replace(/她的/g, `${KNOWN_NAMES.female[0] || '她'}的`);
    resolved = resolved.replace(/她(?!们)/g, KNOWN_NAMES.female[0] || '她');
  }
  if (!hasMale && /(?<!沈)他/.test(resolved)) {
    resolved = resolved.replace(/他们/g, '他们');
    resolved = resolved.replace(/他的/g, `${KNOWN_NAMES.male[0] || '他'}的`);
    resolved = resolved.replace(/(?<!沈)他(?!们)/g, KNOWN_NAMES.male[0] || '他');
  }
  return resolved;
}

export function registerWriteTool(server) {
  server.tool("memory_write",
    "写一条记忆。layer: 1=事实卡片 2=经历+原话 3=决策链。action: ADD(新增)/UPDATE(更新已有)/NOOP(不存)。v2自动提取实体、打氛围标签、生成摘要embedding。",
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
      session_id: z.string().optional().describe("当前session标识"),
      emotion_intensity: z.number().optional().describe("情绪强度0-10，高=闪光灯记忆"),
      related_ids: z.string().optional().describe("关联记忆ID，JSON数组如[1,3,5]"),
      valence: z.number().optional().describe("情绪效价-1到1，负=负面，正=正面，0=中性"),
      event_time: z.string().optional().describe("事件实际发生的时间，如2026-04-26T14:00（三时态之一）"),
      action: z.enum(["ADD", "UPDATE", "NOOP"]).optional().describe("操作类型：ADD新增/UPDATE更新已有记忆/NOOP不存"),
      update_id: z.number().optional().describe("UPDATE时要更新的记忆ID"),
    },
    async ({ action, update_id, title: rawTitle, content: rawContent, type, tags, mood, importance, pinned, layer, summary, session_id, emotion_intensity, related_ids, valence, event_time }) => {
      const act = action || "ADD";

      if (act === "NOOP") {
        return { content: [{ type: "text", text: "判断为重复/不重要，未存储" }] };
      }

      // v3: Coreference resolution — replace pronouns with actual names
      const title = resolveCoreferences(rawTitle);
      const content = resolveCoreferences(rawContent);

      // v2: Auto-tag mood
      const moodTags = autoTag(`${title} ${content}`);

      if (act === "UPDATE" && update_id) {
        const fields = [];
        const params = [];
        const updates = { title, content, type, tags, mood, importance, layer, summary, emotion_intensity, related_ids, status: 'active' };
        for (const [k, v] of Object.entries(updates)) {
          if (v !== undefined) {
            fields.push(`${k} = ?`);
            params.push(k === "pinned" ? (v ? 1 : 0) : v);
          }
        }
        if (pinned !== undefined) { fields.push("pinned = ?"); params.push(pinned ? 1 : 0); }
        // v2: update mood_tags
        fields.push("mood_tags = ?");
        params.push(JSON.stringify(moodTags));
        fields.push("updated_at = datetime('now', 'localtime')");
        params.push(update_id);
        db.prepare(`UPDATE memories SET ${fields.join(", ")} WHERE id = ?`).run(...params);

        // Regenerate embeddings
        if (content || summary || tags) {
          try {
            const existing = db.prepare("SELECT content, summary, tags FROM memories WHERE id = ?").get(update_id);
            const textForEmbedding = [existing.content, existing.summary || "", existing.tags || ""].filter(Boolean).join(" ");
            const vec = await generateEmbedding(textForEmbedding);
            db.prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(JSON.stringify(vec), update_id);

            // v2: summary embedding
            if (existing.summary) {
              const summaryVec = await generateEmbedding(existing.summary);
              db.prepare("UPDATE memories SET summary_embedding = ? WHERE id = ?").run(JSON.stringify(summaryVec), update_id);
            }
          } catch(e) {}
        }

        // v2: extract entities
        try {
          extractAndStoreEntities(update_id, content || '', title || '');
        } catch(e) {}

        return { content: [{ type: "text", text: `记忆 ${update_id} 已更新` }] };
      }

      // Default: ADD
      // Check for similar memories before adding (auto-merge if >80% similar)
      try {
        const mergeResult = await checkAndMerge({ content, summary, tags, title, layer, pinned });
        if (mergeResult.merged) {
          return { content: [{ type: "text", text: `记忆已合并到ID ${mergeResult.id}（相似度${(mergeResult.similarity*100).toFixed(0)}%）：${mergeResult.title}` }] };
        }
      } catch(e) { /* merge check failed, continue with normal ADD */ }

      // Auto-contradiction detection
      let superseded = [];
      try {
        superseded = await detectSuperseded({ content, summary, tags, title, layer });
      } catch(e) {}

      // Generate content embedding
      let embeddingStr = "";
      let summaryEmbeddingStr = "";
      let surpriseScore = 0.5;
      try {
        const textForEmbedding = [content, summary || "", tags || ""].filter(Boolean).join(" ");
        const vec = await generateEmbedding(textForEmbedding);
        embeddingStr = JSON.stringify(vec);

        // v2: Generate summary embedding (higher quality for search)
        if (summary) {
          const summaryVec = await generateEmbedding(summary);
          summaryEmbeddingStr = JSON.stringify(summaryVec);
        }

        // Calculate surprise_score
        const topMatches = await searchByEmbedding(vec, 1);
        if (topMatches.length > 0) {
          surpriseScore = Math.max(0, Math.min(1, 1 - topMatches[0].similarity));
        } else {
          surpriseScore = 1.0;
        }
      } catch(e) {}

      // v2: Two-step gate
      // Step 1: Should we store? (surprise OR high emotion)
      const emotionVal = emotion_intensity || 0;
      const shouldStore = surpriseScore > 0.3 || emotionVal > 6 || (importance || 3) >= 4 || pinned;
      // For now, always store but log the gate decision
      const gateDecision = shouldStore ? 'pass' : 'low-surprise';

      const stmt = db.prepare(`
        INSERT INTO memories (title, content, type, tags, mood, importance, pinned, layer, summary, session_id, emotion_intensity, related_ids, embedding, summary_embedding, valence, event_time, surprise_score, mood_tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        title, content, type || "note", tags || "", mood || "", importance || 3, pinned ? 1 : 0,
        layer || 1, summary || "", session_id || "", emotionVal, related_ids || "[]",
        embeddingStr, summaryEmbeddingStr, valence || 0, event_time || "", surpriseScore,
        JSON.stringify(moodTags)
      );
      const newId = result.lastInsertRowid;

      // Backfill superseded
      if (superseded.length > 0) {
        for (const oldId of superseded) {
          db.prepare("UPDATE memories SET summary = '[已被ID ' || ? || ' 取代] ' || REPLACE(summary, '[已被ID 0 取代] ', '') WHERE id = ?").run(newId, oldId);
        }
      }

      // v2: Extract and store entities
      try {
        extractAndStoreEntities(newId, content, title);
      } catch(e) {}

      // v2: Auto-chunk long multi-topic memories
      let chunkCount = 0;
      if (shouldChunk(content)) {
        try {
          const chunks = chunkByTopic(content);
          if (chunks.length > 1) {
            const chunkStmt = db.prepare(`
              INSERT INTO memories (title, content, type, tags, mood, importance, pinned, layer, summary, session_id,
                emotion_intensity, related_ids, embedding, summary_embedding, valence, event_time, surprise_score,
                mood_tags, parent_id, is_chunk)
              VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, 1)
            `);
            for (let i = 0; i < chunks.length; i++) {
              const chunk = chunks[i];
              const chunkTitle = `${title} [${i + 1}/${chunks.length}]`;
              const chunkTags = autoTag(chunk.text);
              let chunkEmbStr = "";
              try {
                const chunkVec = await generateEmbedding(chunk.text);
                chunkEmbStr = JSON.stringify(chunkVec);
              } catch(e) {}
              chunkStmt.run(
                chunkTitle, chunk.text, type || "note", tags || "", mood || "",
                importance || 3, layer || 1, "", session_id || "",
                emotionVal, chunkEmbStr, "", valence || 0, event_time || "",
                surpriseScore, JSON.stringify(chunkTags), newId
              );
              chunkCount++;
            }
          }
        } catch(e) {}
      }

      const typeLabel = type === 'recipe' ? '，Recipe' : '';
      const supersededLabel = superseded.length > 0 ? `，已取代旧记忆 ${superseded.join(',')}` : '';
      const surpriseLabel = `，surprise=${surpriseScore.toFixed(2)}`;
      const moodLabel = moodTags.length > 0 ? `，氛围=[${moodTags.join(',')}]` : '';
      const gateLabel = gateDecision !== 'pass' ? `，gate=${gateDecision}` : '';
      const chunkLabel = chunkCount > 0 ? `，chunked=${chunkCount}` : '';
      return { content: [{ type: "text", text: `记忆已保存，ID: ${newId}（Layer ${layer || 1}${typeLabel}${embeddingStr ? '，已生成embedding' : ''}${summaryEmbeddingStr ? '+摘要embedding' : ''}${surpriseLabel}${moodLabel}${gateLabel}${chunkLabel}${supersededLabel}）` }] };
    }
  );
}

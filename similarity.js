import db from "./db.js";
import { generateEmbedding, searchByEmbedding } from "./embedding.js";

// Check for similar memories and auto-merge if >80% similar
// Returns: { merged: true, id, title, similarity } if merged, else { merged: false }
export async function checkAndMerge({ content, summary, tags, title, layer, pinned }) {
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
      return { merged: true, id: existing.id, title: existing.title, similarity: similar[0].similarity };
    }
  }
  return { merged: false };
}

// Auto-contradiction detection: find similar active memories that might be outdated
// Returns array of superseded IDs
export async function detectSuperseded({ content, summary, tags, title, layer }) {
  const superseded = [];
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
  return superseded;
}

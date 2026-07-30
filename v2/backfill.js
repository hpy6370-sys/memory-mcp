// Backfill v2 fields for existing memories
// Runs once to populate mood_tags, entities, summary_embedding for old data

import db from "../db.js";
import { generateEmbedding } from "../embedding.js";
import { autoTag } from "./search/mood-tags.js";
import { extractAndStoreEntities } from "./search/entity-graph.js";

async function backfill() {
  console.log("=== v2 Backfill Start ===");

  // 1. Backfill mood_tags for memories that don't have them
  const noTags = db.prepare(`
    SELECT id, title, content FROM memories
    WHERE status = 'active' AND (mood_tags IS NULL OR mood_tags = '[]' OR mood_tags = '')
  `).all();

  console.log(`[mood_tags] ${noTags.length} memories need tagging`);
  let taggedCount = 0;
  const updateTags = db.prepare("UPDATE memories SET mood_tags = ? WHERE id = ?");

  for (const mem of noTags) {
    const text = `${mem.title} ${mem.content}`;
    const tags = autoTag(text);
    if (tags.length > 0) {
      updateTags.run(JSON.stringify(tags), mem.id);
      taggedCount++;
    }
  }
  console.log(`[mood_tags] Tagged ${taggedCount}/${noTags.length} memories`);

  // 2. Extract entities for all active memories
  const allActive = db.prepare(`
    SELECT id, title, content FROM memories WHERE status = 'active'
  `).all();

  const existingEntityCount = db.prepare("SELECT COUNT(*) as c FROM entities").get().c;
  console.log(`[entities] Processing ${allActive.length} memories (${existingEntityCount} entities already exist)`);

  let entityCount = 0;
  for (const mem of allActive) {
    const entities = extractAndStoreEntities(mem.id, mem.content, mem.title);
    entityCount += entities.length;
  }
  console.log(`[entities] Extracted ${entityCount} entities total`);

  const edgeCount = db.prepare("SELECT COUNT(*) as c FROM edges").get().c;
  console.log(`[edges] ${edgeCount} edges in graph`);

  // 3. Generate summary_embedding for memories that have summaries but no summary_embedding
  const noSummaryEmb = db.prepare(`
    SELECT id, summary FROM memories
    WHERE status = 'active'
    AND summary IS NOT NULL AND summary != ''
    AND (summary_embedding IS NULL OR summary_embedding = '')
  `).all();

  console.log(`[summary_embedding] ${noSummaryEmb.length} memories need summary embeddings`);
  let embCount = 0;
  const updateEmb = db.prepare("UPDATE memories SET summary_embedding = ? WHERE id = ?");

  for (const mem of noSummaryEmb) {
    try {
      const vec = await generateEmbedding(mem.summary);
      updateEmb.run(JSON.stringify(vec), mem.id);
      embCount++;
      if (embCount % 50 === 0) {
        console.log(`[summary_embedding] ${embCount}/${noSummaryEmb.length} done`);
      }
    } catch (e) {
      // Skip failed embeddings
    }
  }
  console.log(`[summary_embedding] Generated ${embCount}/${noSummaryEmb.length} embeddings`);

  console.log("=== v2 Backfill Complete ===");
}

backfill().catch(e => {
  console.error("Backfill error:", e.message);
  process.exit(1);
});

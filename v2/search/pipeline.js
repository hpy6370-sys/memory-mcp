import db from "../../db.js";
import { generateEmbedding, searchByEmbedding, cosineSimilarity } from "../../embedding.js";
import { tokenize, bm25Score } from "./bm25.js";
import { rrfFuse, applyWeightAdjustments } from "./rrf.js";
import { analyzeQuery } from "./sentinel.js";
import { searchByEntities } from "./entity-graph.js";
import { searchByMoodTags } from "./mood-tags.js";
import { rerank } from "./rerank.js";

// v2 Search Pipeline
// sentinel → 4-channel parallel → RRF fusion → weight adjustment → rerank → results

export async function searchV2(query, { layer, limit = 10, currentValence, recentMessages = [] } = {}) {
  const maxResults = limit;

  // Step 0: Sentinel — understand the query
  const analyzed = analyzeQuery(query, recentMessages);

  // Step 1: Four-channel parallel search

  // Channel A: BM25 with jieba tokenization
  const bm25Results = channelBM25(analyzed, layer);

  // Channel B: Semantic embedding search
  const semanticResults = await channelSemantic(query, layer);

  // Channel C: Entity graph search
  const entityResults = channelEntity(analyzed.entities);

  // Channel D: Mood tag search
  const moodResults = channelMood(analyzed.moodTags);

  // Step 2: RRF Fusion
  const rankedLists = {};
  if (bm25Results.length > 0) rankedLists.bm25 = bm25Results;
  if (semanticResults.length > 0) rankedLists.semantic = semanticResults;
  if (entityResults.length > 0) rankedLists.entity = entityResults;
  if (moodResults.length > 0) rankedLists.mood = moodResults;

  if (Object.keys(rankedLists).length === 0) {
    return { results: [], analyzed, channels: {} };
  }

  const fused = rrfFuse(rankedLists);

  // Step 3: Load full memory data for weight adjustment
  const memoryMap = new Map();
  const ids = fused.map(r => r.id).filter(id => id > 0);
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const memories = db.prepare(`
      SELECT * FROM memories WHERE id IN (${placeholders})
    `).all(...ids);
    for (const m of memories) {
      if (currentValence !== undefined) m._currentValence = currentValence;
      memoryMap.set(m.id, m);
    }
  }

  // Step 4: Apply weight adjustments (surprise, importance, emotion, time)
  const adjusted = applyWeightAdjustments(fused, memoryMap);

  // Step 5: Rerank — diversity filter + multi-channel bonus + token budget
  const rerankInput = adjusted.map(r => {
    const mem = memoryMap.get(r.id);
    return { ...r, _mem: mem, _eventTime: mem?.event_time };
  });
  const topResults = rerank(rerankInput, {
    hasTemporal: analyzed.hasTemporal,
    maxResults,
  });

  // Build output with full memory data
  const results = topResults
    .map(r => {
      const mem = memoryMap.get(r.id);
      if (!mem) return null;
      const { embedding, summary_embedding, ...rest } = mem;
      return {
        ...rest,
        _search: {
          rrfScore: r.rrfScore,
          adjustedScore: r.adjustedScore,
          channels: r.channels,
        },
      };
    })
    .filter(Boolean);

  return {
    results,
    analyzed,
    channels: {
      bm25: bm25Results.length,
      semantic: semanticResults.length,
      entity: entityResults.length,
      mood: moodResults.length,
    },
  };
}

// Channel A: BM25 with jieba
function channelBM25(analyzed, layer) {
  const queryTokens = analyzed.keywords;
  if (queryTokens.length === 0) return [];

  let sql = `SELECT id, title, content, tags, summary FROM memories WHERE status = 'active'`;
  const params = [];
  if (layer) {
    sql += " AND layer = ?";
    params.push(layer);
  }

  const rows = db.prepare(sql).all(...params);

  const scored = [];
  for (const row of rows) {
    const docText = [row.title, row.content, row.tags, row.summary].filter(Boolean).join(' ');
    const docTokens = tokenize(docText);
    const score = bm25Score(queryTokens, docTokens);
    if (score > 0) {
      scored.push({ id: row.id, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 30);
}

// Channel B: Semantic embedding
async function channelSemantic(query, layer) {
  try {
    const queryVec = await generateEmbedding(query);

    // Prefer summary_embedding if available, fall back to embedding
    const rows = db.prepare(`
      SELECT id, embedding, summary_embedding
      FROM memories
      WHERE status = 'active'
      AND (embedding IS NOT NULL AND embedding != '' OR summary_embedding IS NOT NULL AND summary_embedding != '')
      ${layer ? 'AND layer = ?' : ''}
    `).all(...(layer ? [layer] : []));

    const scored = [];
    for (const row of rows) {
      try {
        // Use summary_embedding first (higher quality), fall back to content embedding
        const vecStr = (row.summary_embedding && row.summary_embedding !== '')
          ? row.summary_embedding
          : row.embedding;
        if (!vecStr) continue;
        const vec = JSON.parse(vecStr);
        const sim = cosineSimilarity(queryVec, vec);
        if (sim > 0.2) {
          scored.push({ id: row.id, score: sim });
        }
      } catch (e) {}
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 30);
  } catch (e) {
    return [];
  }
}

// Channel C: Entity graph
function channelEntity(entities) {
  if (!entities || entities.length === 0) return [];
  try {
    return searchByEntities(entities, 20);
  } catch {
    return [];
  }
}

// Channel D: Mood tags
function channelMood(moodTags) {
  if (!moodTags || moodTags.length === 0) return [];
  try {
    return searchByMoodTags(moodTags, 20);
  } catch {
    return [];
  }
}

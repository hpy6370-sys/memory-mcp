import db from "../../db.js";

// Reranker module
// Takes RRF-fused candidates and selects the most relevant ones
// Controls token budget: max 4 results, min 1
// Phase 3 will add a small model reranker; this version uses heuristics

const MAX_RESULTS = 4;
const MIN_RESULTS = 1;

// Rerank candidates based on:
// 1. Multi-channel coverage (appeared in more channels = more confident)
// 2. Recency boost for time-sensitive queries
// 3. Diversity penalty (avoid returning 5 memories about the same thing)
// 4. Token budget (cap at MAX_RESULTS)
export function rerank(candidates, { hasTemporal = false, maxResults = MAX_RESULTS } = {}) {
  if (candidates.length === 0) return [];

  const cap = Math.min(maxResults, MAX_RESULTS);

  const scored = candidates.map(c => {
    let score = c.adjustedScore || c.rrfScore || 0;

    // Multi-channel bonus: appeared in 3+ channels = more trustworthy
    const channelCount = Object.keys(c.channels || {}).length;
    if (channelCount >= 3) score *= 1.2;
    else if (channelCount >= 2) score *= 1.1;

    // Temporal boost for time-related queries
    if (hasTemporal && c._eventTime) {
      score *= 1.15;
    }

    return { ...c, rerankScore: score };
  });

  scored.sort((a, b) => b.rerankScore - a.rerankScore);

  // Diversity filter: if two results are from the same "cluster" (same title prefix),
  // keep only the higher-scored one
  const selected = [];
  const seenPrefixes = new Set();

  for (const item of scored) {
    if (selected.length >= cap) break;

    // Simple diversity: check if title prefix (first 6 chars) already seen
    const mem = item._mem;
    if (mem) {
      const prefix = (mem.title || '').slice(0, 8);
      if (prefix && seenPrefixes.has(prefix) && selected.length >= MIN_RESULTS) {
        continue;
      }
      if (prefix) seenPrefixes.add(prefix);
    }

    selected.push(item);
  }

  // Ensure minimum results
  if (selected.length < MIN_RESULTS && scored.length > 0) {
    return scored.slice(0, MIN_RESULTS);
  }

  return selected;
}

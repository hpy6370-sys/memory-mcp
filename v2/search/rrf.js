// Reciprocal Rank Fusion (RRF)
// Merges ranked lists from multiple channels by rank position, not raw score
// This solves the scale-incompatibility problem between BM25, cosine similarity, etc.

const DEFAULT_K = {
  bm25: 60,
  semantic: 40,
  entity: 80,
  mood: 70,
};

// Compute RRF score for a document across multiple ranked lists
// rankedLists: { channelName: [{ id, score }] } — each list sorted desc by score
// k: { channelName: number } — k parameter per channel (higher = less top-heavy)
export function rrfFuse(rankedLists, k = DEFAULT_K) {
  const scores = new Map();

  for (const [channel, ranked] of Object.entries(rankedLists)) {
    const kVal = k[channel] || 60;
    for (let rank = 0; rank < ranked.length; rank++) {
      const item = ranked[rank];
      const rrfScore = 1 / (kVal + rank + 1);
      const current = scores.get(item.id) || { id: item.id, rrfScore: 0, channels: {} };
      current.rrfScore += rrfScore;
      current.channels[channel] = { rank: rank + 1, rawScore: item.score };
      scores.set(item.id, current);
    }
  }

  return [...scores.values()].sort((a, b) => b.rrfScore - a.rrfScore);
}

// Apply post-RRF weight adjustments (surprise, importance, time decay, emotion)
export function applyWeightAdjustments(rrfResults, memoryMap) {
  return rrfResults.map(r => {
    const mem = memoryMap.get(r.id);
    if (!mem) return r;

    let adjusted = r.rrfScore;

    // Surprise boost: novel memories get a bump
    const surprise = mem.surprise_score || 0.5;
    adjusted *= (1 + surprise * 0.3);

    // Importance boost
    const importance = (mem.importance || 3) / 5;
    adjusted *= (1 + importance * 0.1);

    // Emotion resonance (if current valence provided)
    if (mem._currentValence !== undefined && mem.valence) {
      const resonance = 1 - Math.abs(mem.valence - mem._currentValence);
      adjusted *= (1 + resonance * 0.15);
    }

    // Pinned memories get a significant boost
    if (mem.pinned) {
      adjusted *= 1.5;
    }

    return { ...r, adjustedScore: adjusted };
  }).sort((a, b) => (b.adjustedScore || b.rrfScore) - (a.adjustedScore || a.rrfScore));
}

// BM25 scoring for Chinese text (character-level tokenization)
export function bm25Score(query, document, k1 = 1.5, b = 0.75) {
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
export function dualScore(semanticSim, bm25, lambda = 0.7) {
  const normalizedBm25 = Math.min(bm25 / 10, 1);
  return lambda * semanticSim + (1 - lambda) * normalizedBm25;
}

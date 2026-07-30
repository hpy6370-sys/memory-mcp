import { pipeline } from "@xenova/transformers";
import db from "./db.js";

// Phase 3: Embedding model (lazy loaded)
let embedder = null;

export async function getEmbedder() {
  if (!embedder) {
    embedder = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5');
  }
  return embedder;
}

export async function generateEmbedding(text) {
  const model = await getEmbedder();
  const output = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

export function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function searchByEmbedding(queryVector, topK = 5) {
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

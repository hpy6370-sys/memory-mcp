import { createRequire } from "module";
const require = createRequire(import.meta.url);
const nodejieba = require("nodejieba");

// jieba-based BM25 scoring for Chinese text
// v1 used character-level tokenization which misses word boundaries
// v2 uses jieba word segmentation for proper Chinese tokenization

const STOPWORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
  '没有', '看', '好', '自己', '这', '他', '她', '它', '们', '那', '被',
  '从', '没', '把', '让', '给', '用', '只', '还', '而', '但', '对',
  '这个', '那个', '什么', '怎么', '为什么', '呢', '吧', '啊', '哦',
  '嗯', '吗', '么', '呀', '哈', '嘿', '哎', '唉',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'i', 'you', 'he', 'she', 'it', 'we', 'they',
]);

export function tokenize(text) {
  if (!text) return [];
  // cutForSearch gives finer granularity (both long and short terms)
  const words = nodejieba.cutForSearch(text);
  return words
    .map(w => w.trim().toLowerCase())
    .filter(w => w.length > 0 && !STOPWORDS.has(w) && !/^\s+$/.test(w) && !/^[,，。.!！?？、；;：:""''「」【】（）()]+$/.test(w));
}

// BM25 with jieba tokenization and proper IDF
export function bm25Score(queryTokens, docTokens, { k1 = 1.5, b = 0.75, avgDl = 150, corpusSize = 500 } = {}) {
  if (!queryTokens.length || !docTokens.length) return 0;

  const docLen = docTokens.length;

  // Build doc term frequency map
  const docTf = new Map();
  for (const t of docTokens) {
    docTf.set(t, (docTf.get(t) || 0) + 1);
  }

  let score = 0;
  for (const qt of queryTokens) {
    const tf = docTf.get(qt) || 0;
    if (tf === 0) continue;

    // IDF approximation: log((N - n + 0.5) / (n + 0.5) + 1)
    const idf = Math.log(1 + (corpusSize - 1 + 0.5) / (1 + 0.5));

    // BM25 TF component
    const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgDl));

    score += idf * tfNorm;
  }

  return score;
}

// Convenience: tokenize + score in one call
export function bm25(query, document, options) {
  const queryTokens = tokenize(query);
  const docTokens = tokenize(document);
  return bm25Score(queryTokens, docTokens, options);
}

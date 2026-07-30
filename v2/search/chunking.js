import { createRequire } from "module";
const require = createRequire(import.meta.url);
const nodejieba = require("nodejieba");

// Topic-based chunking for memory storage
// Problem: a single memory covering multiple topics produces a blurry embedding
// Solution: split into focused chunks, each with its own embedding
// Each chunk stores parent_id pointing to the original memory

const SENTENCE_SPLITTERS = /(?<=[。！？\n])\s*/;
const MIN_CHUNK_TOKENS = 15;
const MAX_CHUNK_TOKENS = 200;
const TOPIC_SHIFT_THRESHOLD = 0.4;

// Split text into sentences
function splitSentences(text) {
  if (!text) return [];
  return text
    .split(SENTENCE_SPLITTERS)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

// Calculate token overlap between two token sets (Jaccard-like)
function tokenOverlap(tokensA, tokensB) {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}

// Tokenize a sentence for topic comparison
function topicTokens(sentence) {
  return nodejieba.cut(sentence)
    .map(w => w.trim().toLowerCase())
    .filter(w => w.length > 1 && !/^[\s,，。.!！?？、；;：:""''「」【】（）()]+$/.test(w));
}

// Chunk text into topic-focused segments
// Returns array of { text, sentences } objects
export function chunkByTopic(text) {
  const sentences = splitSentences(text);
  if (sentences.length <= 2) {
    return [{ text, sentences }];
  }

  const chunks = [];
  let currentChunk = { sentences: [sentences[0]], tokens: topicTokens(sentences[0]) };

  for (let i = 1; i < sentences.length; i++) {
    const sentTokens = topicTokens(sentences[i]);
    const overlap = tokenOverlap(currentChunk.tokens, sentTokens);

    const currentLength = currentChunk.sentences.join('').length;
    const wouldExceed = currentLength + sentences[i].length > MAX_CHUNK_TOKENS * 3;

    // Start new chunk if topic shifted OR current chunk too long
    if ((overlap < TOPIC_SHIFT_THRESHOLD && currentLength > MIN_CHUNK_TOKENS * 3) || wouldExceed) {
      chunks.push({
        text: currentChunk.sentences.join('\n'),
        sentences: [...currentChunk.sentences],
      });
      currentChunk = { sentences: [sentences[i]], tokens: sentTokens };
    } else {
      currentChunk.sentences.push(sentences[i]);
      // Accumulate tokens for topic tracking
      for (const t of sentTokens) currentChunk.tokens.push(t);
    }
  }

  // Don't forget the last chunk
  if (currentChunk.sentences.length > 0) {
    chunks.push({
      text: currentChunk.sentences.join('\n'),
      sentences: [...currentChunk.sentences],
    });
  }

  // If we only got 1 chunk, no point in chunking
  if (chunks.length <= 1) {
    return [{ text, sentences }];
  }

  return chunks;
}

// Check if a text is worth chunking (long enough, multiple topics)
export function shouldChunk(text) {
  if (!text) return false;
  const sentences = splitSentences(text);
  if (sentences.length < 3) return false;
  if (text.length < 100) return false;
  return true;
}

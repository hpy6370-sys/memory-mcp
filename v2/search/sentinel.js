import { tokenize } from "./bm25.js";
import db from "../../db.js";

// Query Understanding / 前置哨兵
// Analyzes recent conversation context to generate a better search query
// Instead of searching with the raw user message, we extract:
// 1. Key topics/entities
// 2. Temporal references
// 3. Mood/atmosphere cues
// 4. Expanded query terms

const TIME_PATTERNS = [
  { pattern: /去年|上一年|last year/i, tag: 'past-year' },
  { pattern: /上个月|上月|last month/i, tag: 'past-month' },
  { pattern: /上周|上星期|last week/i, tag: 'past-week' },
  { pattern: /昨天|yesterday/i, tag: 'yesterday' },
  { pattern: /前天/i, tag: 'day-before' },
  { pattern: /今天|today/i, tag: 'today' },
  { pattern: /刚才|刚刚|just now/i, tag: 'just-now' },
  { pattern: /以前|之前|过去|曾经|以前/i, tag: 'past' },
  { pattern: /第一次|最初|开始/i, tag: 'origin' },
  { pattern: /生日|birthday/i, tag: 'birthday' },
  { pattern: /纪念日|anniversary/i, tag: 'anniversary' },
];

const MOOD_PATTERNS = [
  { pattern: /开心|高兴|好开心|太好了|哈哈|嘻嘻/i, tags: ['开心'] },
  { pattern: /难过|伤心|哭|呜呜|想哭/i, tags: ['难过'] },
  { pattern: /生气|讨厌|烦|气死/i, tags: ['生气'] },
  { pattern: /累|困|好累|好困|疲惫/i, tags: ['疲惫'] },
  { pattern: /想你|想念|好想/i, tags: ['思念'] },
  { pattern: /撒娇|嘛|嘛嘛|哼|人家/i, tags: ['撒娇'] },
  { pattern: /焦虑|紧张|害怕|担心/i, tags: ['焦虑'] },
  { pattern: /无聊|发呆|没意思/i, tags: ['无聊'] },
  { pattern: /害羞|不好意思/i, tags: ['害羞'] },
  { pattern: /吃|饭|外卖|饿|馋|好吃/i, tags: ['吃东西'] },
  { pattern: /睡|困|晚安|失眠/i, tags: ['深夜'] },
  { pattern: /代码|bug|报错|函数|模块/i, tags: ['工作'] },
  { pattern: /论文|作业|考试|课/i, tags: ['学习'] },
];

// Extract entities from text using simple NER-like patterns
// This is a lightweight fallback; v2 Phase 3 will use a real model
function extractEntities(text) {
  const entities = new Set();

  // Match known entity names from the entity table
  try {
    const knownEntities = db.prepare("SELECT DISTINCT name FROM entities").all();
    for (const e of knownEntities) {
      if (text.includes(e.name)) {
        entities.add(e.name);
      }
    }
  } catch (e) {
    // entities table might not exist yet
  }

  // Extract quoted strings as potential entities
  const quoted = text.match(/[「「]([^」」]+)[」」]/g);
  if (quoted) {
    for (const q of quoted) {
      entities.add(q.replace(/[「「」」]/g, ''));
    }
  }

  return [...entities];
}

// Analyze query context and produce an enriched search spec
export function analyzeQuery(rawQuery, recentMessages = []) {
  const combinedText = [rawQuery, ...recentMessages.slice(0, 3)].join(' ');

  // 1. Tokenize for BM25 keywords
  const keywords = tokenize(rawQuery);

  // 2. Detect temporal references
  const temporalTags = [];
  for (const { pattern, tag } of TIME_PATTERNS) {
    if (pattern.test(combinedText)) {
      temporalTags.push(tag);
    }
  }

  // 3. Detect mood/atmosphere
  const moodTags = [];
  for (const { pattern, tags } of MOOD_PATTERNS) {
    if (pattern.test(combinedText)) {
      moodTags.push(...tags);
    }
  }

  // 4. Extract entities
  const entities = extractEntities(combinedText);

  // 5. Build expanded query
  // Add entity names and key phrases to the search terms
  const expandedTerms = [...new Set([
    ...keywords,
    ...entities,
  ])];

  return {
    original: rawQuery,
    keywords,
    expandedTerms,
    entities,
    temporalTags,
    moodTags: [...new Set(moodTags)],
    hasTemporal: temporalTags.length > 0,
    hasMood: moodTags.length > 0,
  };
}

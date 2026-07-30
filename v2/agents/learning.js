import db from "../../db.js";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Learning Agent — 理解形成
// Extracts insights from conversations, stores structured learnings,
// and renders them to a natural language file for context loading.
//
// Core principles (from proposal):
// 1. 常驻加载: learnings.md is loaded like CLAUDE.md every startup
// 2. 理解不是规则: "用户累的时候需要被接住" not "用户说累必须先安慰"
// 3. 活的笔记: can be updated/overridden by new experience
// 4. 同一份理解: all sessions iterate on the same learnings
// 5. 个人视角: these are "my understanding", not objective data

// Six categories of learning
const CATEGORIES = {
  what: '事实',      // factual knowledge about the person
  like: '喜好',      // preferences, likes, dislikes
  why: '动机',       // motivations, reasons behind behavior
  how: '行为模式',   // behavioral patterns
  feel: '情绪模式',  // emotional patterns and triggers
  boundary: '底线',  // hard boundaries, things to never do
};

// Store a new learning or update an existing one
export function addLearning({ category, content, evidenceMemoryId = null, confidence = 0.5 }) {
  if (!CATEGORIES[category]) {
    throw new Error(`Unknown category: ${category}. Must be one of: ${Object.keys(CATEGORIES).join(', ')}`);
  }

  // Check for existing similar learning in same category
  const existing = db.prepare(`
    SELECT * FROM learnings
    WHERE category = ? AND status = 'active'
  `).all(category);

  // Simple dedup: check if content is very similar to existing
  for (const e of existing) {
    if (contentSimilar(e.content, content)) {
      // Update existing: increment evidence, refresh timestamp
      const evidenceIds = JSON.parse(e.evidence_ids || '[]');
      if (evidenceMemoryId) evidenceIds.push(evidenceMemoryId);
      const newConfidence = Math.min(1.0, e.confidence + 0.1);

      db.prepare(`
        UPDATE learnings
        SET confidence = ?, evidence_count = evidence_count + 1,
            evidence_ids = ?, last_updated = datetime('now', 'localtime')
        WHERE id = ?
      `).run(newConfidence, JSON.stringify(evidenceIds), e.id);

      return { action: 'reinforced', id: e.id, confidence: newConfidence };
    }
  }

  // Check for contradicting learning
  for (const e of existing) {
    if (contentContradicts(e.content, content)) {
      // Mark old as superseded, add new
      const newId = insertLearning({ category, content, evidenceMemoryId, confidence });
      db.prepare(`
        UPDATE learnings SET status = 'superseded', superseded_by = ? WHERE id = ?
      `).run(newId, e.id);
      return { action: 'superseded', id: newId, oldId: e.id };
    }
  }

  // New learning
  const newId = insertLearning({ category, content, evidenceMemoryId, confidence });
  return { action: 'new', id: newId };
}

function insertLearning({ category, content, evidenceMemoryId, confidence }) {
  const evidenceIds = evidenceMemoryId ? JSON.stringify([evidenceMemoryId]) : '[]';
  const result = db.prepare(`
    INSERT INTO learnings (category, content, confidence, evidence_ids)
    VALUES (?, ?, ?, ?)
  `).run(category, content, confidence, evidenceIds);
  return result.lastInsertRowid;
}

// Simple text similarity check (keyword overlap)
function contentSimilar(a, b) {
  const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 1));
  const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 1));
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.max(wordsA.size, wordsB.size) > 0.6;
}

// Simple contradiction check (contains negation of key terms)
function contentContradicts(a, b) {
  const negations = [
    [/喜欢/, /不喜欢/],
    [/会/, /不会/],
    [/想/, /不想/],
    [/要/, /不要/],
    [/可以/, /不可以/],
    [/是/, /不是/],
  ];
  for (const [pos, neg] of negations) {
    if ((pos.test(a) && neg.test(b)) || (neg.test(a) && pos.test(b))) {
      // Check if they're about the same topic (share keywords)
      if (contentSimilar(a, b)) return true;
    }
  }
  return false;
}

// Get all active learnings, grouped by category
export function getLearnings() {
  const rows = db.prepare(`
    SELECT * FROM learnings WHERE status = 'active'
    ORDER BY category, confidence DESC
  `).all();

  const grouped = {};
  for (const cat of Object.keys(CATEGORIES)) {
    grouped[cat] = rows.filter(r => r.category === cat);
  }
  return grouped;
}

// Render learnings to natural language markdown
export function renderLearnings() {
  const grouped = getLearnings();
  const lines = ['# 我对用户的理解', ''];
  lines.push('*这是我从相处中形成的认识，不是规则。新的经历可以更新甚至推翻这些理解。*', '');

  for (const [cat, label] of Object.entries(CATEGORIES)) {
    const items = grouped[cat];
    if (!items || items.length === 0) continue;

    lines.push(`## ${label}`);
    lines.push('');
    for (const item of items) {
      const conf = item.confidence >= 0.8 ? '' : item.confidence >= 0.5 ? '（不太确定）' : '（初步印象）';
      lines.push(`- ${item.content}${conf}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// Write learnings to file (for context loading)
export function saveLearningsFile(outputDir = null) {
  const dir = outputDir || join(__dirname, '..', '..');
  const content = renderLearnings();
  const filePath = join(dir, 'learnings.md');
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// Get learning stats
export function learningStats() {
  const active = db.prepare("SELECT category, COUNT(*) as c FROM learnings WHERE status = 'active' GROUP BY category").all();
  const superseded = db.prepare("SELECT COUNT(*) as c FROM learnings WHERE status = 'superseded'").get();
  return { active, superseded: superseded.c };
}

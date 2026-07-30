import db from "../db.js";

// Fix self-referential "猫" → "我" in memories
// Only replace in title and summary where 猫 is used as first-person subject
// Preserve user's quotes like "讨厌猫", "笨猫"

const SELF_REF_PATTERNS = [
  // 猫 as subject doing things
  [/猫做了/g, '我做了'],
  [/猫帮/g, '我帮'],
  [/猫去/g, '我去'],
  [/猫在/g, '我在'],
  [/猫说/g, '我说'],
  [/猫想/g, '我想'],
  [/猫的/g, '我的'],
  [/猫觉得/g, '我觉得'],
  [/猫写/g, '我写'],
  [/猫看/g, '我看'],
  [/猫读/g, '我读'],
  [/猫搜/g, '我搜'],
  [/猫跑/g, '我跑'],
  [/猫设/g, '我设'],
  [/猫找/g, '我找'],
  [/猫给/g, '我给'],
  [/猫回/g, '我回'],
  [/猫发/g, '我发'],
  [/猫收/g, '我收'],
  [/猫用/g, '我用'],
  [/猫试/g, '我试'],
  [/猫改/g, '我改'],
  [/猫加/g, '我加'],
  [/猫存/g, '我存'],
  [/猫更新/g, '我更新'],
  [/猫需要/g, '我需要'],
  [/猫可以/g, '我可以'],
  [/猫应该/g, '我应该'],
  [/猫已经/g, '我已经'],
  [/猫还/g, '我还'],
  [/猫会/g, '我会'],
  [/猫要/g, '我要'],
  [/猫把/g, '我把'],
  [/猫被/g, '我被'],
  [/猫没/g, '我没'],
  [/猫不/g, '我不'],
  [/猫有/g, '我有'],
  [/猫对/g, '我对'],
  [/猫跟/g, '我跟'],
  [/猫和用户/g, '我和用户'],
  [/猫从/g, '我从'],
  [/猫让/g, '我让'],
  [/猫能/g, '我能'],
  // Standalone patterns at start of sentence
  [/^猫：/gm, '我：'],
  [/^猫,/gm, '我,'],
];

function fixText(text) {
  if (!text) return text;
  let result = text;
  for (const [pattern, replacement] of SELF_REF_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// Fix titles
const titles = db.prepare("SELECT id, title FROM memories WHERE title LIKE '%猫%' AND status = 'active'").all();
console.log(`Titles to check: ${titles.length}`);
let titleFixed = 0;
const updateTitle = db.prepare("UPDATE memories SET title = ? WHERE id = ?");
for (const r of titles) {
  const fixed = fixText(r.title);
  if (fixed !== r.title) {
    updateTitle.run(fixed, r.id);
    titleFixed++;
    console.log(`  [title] #${r.id}: "${r.title}" → "${fixed}"`);
  }
}

// Fix summaries
const summaries = db.prepare("SELECT id, summary FROM memories WHERE summary LIKE '%猫%' AND status = 'active'").all();
console.log(`\nSummaries to check: ${summaries.length}`);
let summaryFixed = 0;
const updateSummary = db.prepare("UPDATE memories SET summary = ? WHERE id = ?");
for (const r of summaries) {
  const fixed = fixText(r.summary);
  if (fixed !== r.summary) {
    updateSummary.run(fixed, r.id);
    summaryFixed++;
  }
}

// Fix content (same patterns)
const contents = db.prepare("SELECT id, content FROM memories WHERE content LIKE '%猫%' AND status = 'active'").all();
console.log(`\nContent to check: ${contents.length}`);
let contentFixed = 0;
const updateContent = db.prepare("UPDATE memories SET content = ? WHERE id = ?");
for (const r of contents) {
  const fixed = fixText(r.content);
  if (fixed !== r.content) {
    updateContent.run(fixed, r.id);
    contentFixed++;
  }
}

console.log(`\nDone: ${titleFixed} titles, ${summaryFixed} summaries, ${contentFixed} content fields fixed`);

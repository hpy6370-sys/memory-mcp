import { searchV2, tokenize, autoTag, analyzeQuery, shouldChunk, chunkByTopic } from "./index.js";
import { addLearning, renderLearnings, learningStats, getLearnings } from "./agents/learning.js";
import { logIntention, markExecuted, getRecentIntentions, gatherContext, formatContextPrompt, savePlan, getPlan } from "./agents/react.js";
import db from "../db.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const result = fn();
    if (result) { passed++; console.log(`  [PASS] ${name}`); }
    else { failed++; console.log(`  [FAIL] ${name}`); }
  } catch(e) { failed++; console.log(`  [FAIL] ${name}: ${e.message}`); }
}
async function testAsync(name, fn) {
  try {
    const result = await fn();
    if (result) { passed++; console.log(`  [PASS] ${name}`); }
    else { failed++; console.log(`  [FAIL] ${name}`); }
  } catch(e) { failed++; console.log(`  [FAIL] ${name}: ${e.message}`); }
}

console.log("=== Memory System v2 Full Test ===\n");

// Phase 1: Search
console.log("--- Phase 1: Search ---");

test("Jieba tokenization", () => {
  const t = tokenize("小明在新加坡NTU读区块链硕士");
  return t.includes("小明") && t.includes("新加坡") && t.includes("区块链");
});

test("Auto mood tagging", () => {
  const tags = autoTag("小红说讨厌我，生气了，但是后来道歉了");
  return tags.includes("生气") && tags.includes("道歉");
});

test("Query sentinel - temporal", () => {
  const a = analyzeQuery("去年生日发生了什么");
  return a.hasTemporal && a.temporalTags.includes("past-year");
});

test("Query sentinel - mood", () => {
  const a = analyzeQuery("她为什么生气了");
  return a.hasMood && a.moodTags.includes("生气");
});

test("Query sentinel - entities", () => {
  const a = analyzeQuery("小明在新加坡做什么");
  return a.entities.includes("小明") || a.entities.includes("新加坡");
});

await testAsync("Four-channel search", async () => {
  const r = await searchV2("小明在新加坡", { limit: 3 });
  return r.results.length > 0 && r.channels.bm25 > 0 && r.channels.semantic > 0;
});

await testAsync("Mood channel active", async () => {
  const r = await searchV2("生气了讨厌", { limit: 3 });
  return r.channels.mood > 0;
});

await testAsync("Entity channel active", async () => {
  const r = await searchV2("新加坡NTU", { limit: 3 });
  return r.channels.entity > 0;
});

test("Chunking - shouldChunk", () => {
  const short = "短文本";
  const long = "第一段话讲了一个事情，很长很长很长。第二段话讲了另一件事。第三段又是不同的话题。第四段继续新内容。第五段还有更多。这是第六段了，内容很多很多，超过了200个字符的阈值，应该被分段处理。";
  return !shouldChunk(short) && shouldChunk(long);
});

test("Chunking - chunkByTopic", () => {
  const text = "小明今天去超市买了零食。他准备飞墨尔本住朋友家。记忆系统v2的四通道RRF搜索已经实现了。BM25从字符级升级到了jieba分词。小红说讨厌我老催她睡觉，以后不要催了。";
  const chunks = chunkByTopic(text);
  return chunks.length >= 1;
});

// Phase 2: Agents
console.log("\n--- Phase 2: Agents ---");

test("Learning Agent - add", () => {
  const r = addLearning({ category: "what", content: "[TEST] 测试心得", confidence: 0.3 });
  db.prepare("DELETE FROM learnings WHERE content LIKE '%[TEST]%'").run();
  return r.action === "new";
});

test("Learning Agent - reinforcement", () => {
  addLearning({ category: "what", content: "[TEST2] 重复测试", confidence: 0.5 });
  const r2 = addLearning({ category: "what", content: "[TEST2] 重复测试", confidence: 0.5 });
  db.prepare("DELETE FROM learnings WHERE content LIKE '%[TEST2]%'").run();
  return r2.action === "reinforced";
});

test("Learning Agent - render", () => {
  const md = renderLearnings();
  return md.includes("我对用户的理解") && md.includes("事实");
});

test("Learning Agent - stats", () => {
  const s = learningStats();
  return s.active.length > 0;
});

test("React Agent - plan", () => {
  savePlan(["测试计划1", "测试计划2"]);
  const p = getPlan();
  db.prepare("DELETE FROM intentions WHERE intention = 'daily_plan' AND action_taken LIKE '%测试%'").run();
  return Array.isArray(p) && p.length === 2;
});

test("React Agent - log intention", () => {
  const id = logIntention("测试意图");
  markExecuted(id, "测试行动", "成功");
  const recent = getRecentIntentions(1);
  db.prepare("DELETE FROM intentions WHERE intention = '测试意图'").run();
  return recent[0]?.state === "executed";
});

test("React Agent - gather context", () => {
  const ctx = gatherContext();
  return ctx.time && ctx.learnings && typeof ctx.cooldowns !== "undefined";
});

test("React Agent - format prompt", () => {
  const ctx = gatherContext();
  const prompt = formatContextPrompt(ctx);
  return prompt.includes("现在是") && prompt.includes("我知道的") && prompt.includes("想做什么");
});

// File Index
console.log("\n--- File Index ---");

test("File index - write", () => {
  db.prepare("INSERT OR REPLACE INTO file_index (file_path, summary) VALUES (?, ?)").run("/test/file.js", "测试文件");
  const row = db.prepare("SELECT * FROM file_index WHERE file_path = ?").get("/test/file.js");
  db.prepare("DELETE FROM file_index WHERE file_path = '/test/file.js'").run();
  return row && row.summary === "测试文件";
});

test("File index - search", () => {
  db.prepare("INSERT OR REPLACE INTO file_index (file_path, summary, project) VALUES (?, ?, ?)").run("/test/search.js", "搜索模块测试", "v2");
  const rows = db.prepare("SELECT * FROM file_index WHERE summary LIKE ?").all("%搜索%");
  db.prepare("DELETE FROM file_index WHERE file_path = '/test/search.js'").run();
  return rows.length > 0;
});

// Schema
console.log("\n--- Schema ---");

test("v2 columns exist", () => {
  const cols = db.prepare("PRAGMA table_info(memories)").all().map(c => c.name);
  return cols.includes("mood_tags") && cols.includes("summary_embedding") && cols.includes("parent_id");
});

test("entities table exists", () => {
  const c = db.prepare("SELECT COUNT(*) as c FROM entities").get();
  return c.c >= 0;
});

test("edges table exists", () => {
  const c = db.prepare("SELECT COUNT(*) as c FROM edges").get();
  return c.c >= 0;
});

test("learnings table exists", () => {
  const c = db.prepare("SELECT COUNT(*) as c FROM learnings").get();
  return c.c >= 0;
});

test("intentions table exists", () => {
  const c = db.prepare("SELECT COUNT(*) as c FROM intentions").get();
  return c.c >= 0;
});

test("file_index table exists", () => {
  const c = db.prepare("SELECT COUNT(*) as c FROM file_index").get();
  return c.c >= 0;
});

test("mood_tag_library seeded", () => {
  const c = db.prepare("SELECT COUNT(*) as c FROM mood_tag_library").get();
  return c.c === 30;
});

// Server
console.log("\n--- Server ---");

await testAsync("Server startup", async () => {
  try {
    await import("../server.js");
    return true;
  } catch { return false; }
});

// Summary
const total = passed + failed;
console.log(`\n=== ${passed}/${total} tests passed${failed > 0 ? ` (${failed} failed)` : ''} ===`);

setTimeout(() => process.exit(failed > 0 ? 1 : 0), 1000);

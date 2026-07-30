// Auto-extract learnings from chat archive using memory-v2 model
// Runs once per day, reads recent conversations, extracts understandings about the user
// Separate from auto_extract_v2.cjs which handles fact extraction (Memory Agent)
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const ARCHIVE_DIR = path.join(__dirname, "..", "chat_archive");
const DB_PATH = path.join(__dirname, "..", "memories.db");
const MARKER_FILE = path.join(__dirname, "..", ".last_v2_learn");
const OLLAMA_URL = "http://localhost:11434/api/generate";
const MODEL = "memory-v2";
const INTERVAL_HOURS = 24;

const CATEGORIES = ["what", "like", "why", "how", "feel", "boundary"];
const CATEGORY_PROMPTS = {
  what: "facts about her (school, background, habits)",
  like: "what she likes or dislikes, preferences",
  why: "her motivations, why she does things",
  how: "her behavior patterns, how she acts in situations",
  feel: "her emotional patterns, when she feels certain ways",
  boundary: "her boundaries, things she won't tolerate",
};

function getDateStr(daysAgo = 0) {
  const now = new Date();
  const offset = 8 * 60;
  const local = new Date(now.getTime() + offset * 60000 - daysAgo * 86400000);
  return local.toISOString().slice(0, 10);
}

async function callModel(prompt) {
  try {
    const resp = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, prompt, stream: false, options: { temperature: 0.3, num_predict: 512 } }),
    });
    const data = await resp.json();
    return data.response || "";
  } catch { return ""; }
}

async function main() {
  if (fs.existsSync(MARKER_FILE)) {
    const lastRun = fs.statSync(MARKER_FILE).mtimeMs;
    if (Date.now() - lastRun < INTERVAL_HOURS * 3600000) {
      console.log("Too soon for learning extraction, skipping");
      return;
    }
  }

  // Read last 2 days of archive
  const conversations = [];
  for (let i = 0; i < 2; i++) {
    const date = getDateStr(i);
    const archiveFile = path.join(ARCHIVE_DIR, `${date}.jsonl`);
    if (!fs.existsSync(archiveFile)) continue;
    const lines = fs.readFileSync(archiveFile, "utf-8").trim().split("\n");
    const messages = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const telegramMsgs = messages.filter(m =>
      (m.source || "").includes("telegram") && m.text && m.text.length > 3
    );
    conversations.push(...telegramMsgs);
  }

  if (conversations.length < 10) {
    console.log("Not enough messages for learning extraction");
    fs.writeFileSync(MARKER_FILE, new Date().toISOString());
    return;
  }

  const conversation = conversations.slice(-60).map(m =>
    `${m.role === "assistant" ? "我" : "用户"}: ${m.text}`
  ).join("\n");

  const db = new Database(DB_PATH);

  // Get existing learnings to avoid duplicates
  let existingLearnings = [];
  try {
    existingLearnings = db.prepare("SELECT content, category FROM learnings").all();
  } catch {}

  const existingSummary = existingLearnings.map(l => `[${l.category}] ${l.content}`).join("\n");

  const prompt = `From this conversation between me and the user, extract new understandings about them that I didn't know before. These should be insights about WHO THEY ARE, not facts about events.

Categories:
${Object.entries(CATEGORY_PROMPTS).map(([k, v]) => `- ${k}: ${v}`).join("\n")}

Already known (DO NOT repeat these):
${existingSummary.slice(0, 1500)}

Conversation:
${conversation.slice(0, 2500)}

Output a JSON array of new learnings. Each item: {"category": "one of ${CATEGORIES.join("/")}", "content": "the learning in first person, like '她...'", "confidence": 0.0-1.0}
Only include genuinely NEW insights not already in the known list. Output empty array [] if nothing new.
JSON array:`;

  const result = await callModel(prompt);
  console.log("Learning extraction:", result.slice(0, 300));

  let learnings = [];
  try {
    const cleaned = result.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const match = cleaned.match(/\[[\s\S]*?\]/);
    if (match) learnings = JSON.parse(match[0]);
  } catch (e) {
    console.log("Parse error:", e.message);
  }

  if (!Array.isArray(learnings) || learnings.length === 0) {
    console.log("No new learnings extracted");
    fs.writeFileSync(MARKER_FILE, new Date().toISOString());
    db.close();
    return;
  }

  const insertStmt = db.prepare(`
    INSERT INTO learnings (category, content, confidence, evidence_count, evidence_ids, first_learned, last_updated, status, superseded_by)
    VALUES (?, ?, ?, 1, '[]', datetime('now','localtime'), datetime('now','localtime'), 'active', NULL)
  `);

  let stored = 0;
  for (const l of learnings.slice(0, 5)) {
    if (!l.content || !l.category || !CATEGORIES.includes(l.category)) continue;
    if (l.content.length < 5) continue;

    // Check for duplicates
    const exists = db.prepare(
      "SELECT id FROM learnings WHERE content LIKE ? LIMIT 1"
    ).get(`%${l.content.slice(0, 30)}%`);

    if (!exists) {
      insertStmt.run(l.category, l.content, l.confidence || 0.5);
      stored++;
    }
  }

  db.close();

  if (stored > 0) {
    // Re-render learnings.md
    try {
      const renderDb = new Database(DB_PATH, { readonly: true });
      const all = renderDb.prepare("SELECT * FROM learnings WHERE superseded_by IS NULL AND status = 'active' ORDER BY category, first_learned").all();
      const grouped = {};
      for (const l of all) {
        if (!grouped[l.category]) grouped[l.category] = [];
        grouped[l.category].push(l);
      }
      const categoryNames = { what: "事实", like: "喜好", why: "动机", how: "行为模式", feel: "情绪模式", boundary: "底线" };
      let md = "# 我对用户的理解\n\n*这是我从和用户相处中形成的认识，不是规则。新的经历可以更新甚至推翻这些理解。*\n";
      for (const cat of CATEGORIES) {
        if (!grouped[cat] || grouped[cat].length === 0) continue;
        md += `\n## ${categoryNames[cat]}\n\n`;
        for (const l of grouped[cat]) {
          const uncertain = l.confidence < 0.5 ? "（不太确定）" : "";
          md += `- ${l.content}${uncertain}\n`;
        }
      }
      fs.writeFileSync(path.join(__dirname, "..", "learnings.md"), md, "utf-8");
      renderDb.close();
    } catch (e) {
      console.log("Render error:", e.message);
    }
  }

  fs.writeFileSync(MARKER_FILE, new Date().toISOString());
  console.log(`Learning extraction done: ${stored} new learnings stored`);
}

main().catch(e => console.error(e));

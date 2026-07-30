// Auto-extract memories from chat archive using memory-v2 model
// Runs periodically, reads recent conversations, extracts and stores memories
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const ARCHIVE_DIR = path.join(__dirname, "..", "chat_archive");
const DB_PATH = path.join(__dirname, "..", "memories.db");
const MARKER_FILE = path.join(__dirname, "..", ".last_v2_extract");
const OLLAMA_URL = "http://localhost:11434/api/generate";
const MODEL = "memory-v2";
const INTERVAL_HOURS = 3;

function getDateStr() {
  const now = new Date();
  const offset = 8 * 60;
  const local = new Date(now.getTime() + offset * 60000);
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
  // Check interval
  if (fs.existsSync(MARKER_FILE)) {
    const lastRun = fs.statSync(MARKER_FILE).mtimeMs;
    if (Date.now() - lastRun < INTERVAL_HOURS * 3600000) {
      console.log("Too soon, skipping");
      return;
    }
  }

  // Read today's archive
  const today = getDateStr();
  const archiveFile = path.join(ARCHIVE_DIR, `${today}.jsonl`);
  if (!fs.existsSync(archiveFile)) {
    console.log("No archive for today");
    return;
  }

  const lines = fs.readFileSync(archiveFile, "utf-8").trim().split("\n");
  const messages = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const telegramMsgs = messages.filter(m =>
    (m.source || "").includes("telegram") && m.text && m.text.length > 3
  );

  if (telegramMsgs.length < 5) {
    console.log("Not enough messages to extract from");
    fs.writeFileSync(MARKER_FILE, new Date().toISOString());
    return;
  }

  // Build conversation segments
  const conversation = telegramMsgs.slice(-30).map(m =>
    `${m.role === "assistant" ? "我" : "用户"}: ${m.text}`
  ).join("\n");

  // Memory Agent: extract facts only
  const memPrompt = `From this conversation, extract important facts worth remembering as a JSON array of strings in first person. Only include genuinely new information.\n\nConversation:\n${conversation.slice(0, 2000)}\n\nExtracted memories (JSON array):`;
  const memResult = await callModel(memPrompt);

  console.log("Memory extraction:", memResult.slice(0, 200));

  // Store as memory (Memory Agent's job)
  const db = new Database(DB_PATH);
  try {
    const stmt = db.prepare(`
      INSERT INTO memories (title, content, type, tags, importance, layer, summary, mood_tags)
      VALUES (?, ?, 'note', 'auto-extract,v2,memory-agent', 2, 1, ?, '[]')
    `);
    stmt.run(
      `v2自动提取 ${today}`,
      memResult,
      `Memory Agent从${today}对话中自动提取的事实`
    );
    console.log("Stored memory extraction");
  } catch (e) {
    console.log("DB error:", e.message);
  }
  db.close();

  fs.writeFileSync(MARKER_FILE, new Date().toISOString());
  console.log("Done");
}

main().catch(e => console.error(e));

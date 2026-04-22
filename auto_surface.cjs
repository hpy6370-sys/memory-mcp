if (process.stdout.setDefaultEncoding) process.stdout.setDefaultEncoding("utf-8");
if (process.platform === "win32") {
  try { require("child_process").execSync("chcp 65001", { stdio: "ignore" }); } catch {}
}
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_PATH = path.join(__dirname, "memories.db");
const COOLDOWN_FILE = path.join(__dirname, ".last_surface_ts");
const COOLDOWN_MS = 10000;
const MIN_LENGTH = 4;

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    let prompt = data.prompt || data.message || "";
    // Also extract text from Telegram channel messages embedded in the input
    const channelMatch = prompt.match(/<channel[^>]*>([\s\S]*?)<\/channel>/g);
    if (channelMatch) {
      const channelTexts = channelMatch.map(m => m.replace(/<[^>]+>/g, '').trim()).join(' ');
      prompt = prompt + ' ' + channelTexts;
    }
    if (!prompt || prompt.length < MIN_LENGTH) {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } }));
      return;
    }

    let lastTs = 0;
    try { lastTs = parseInt(fs.readFileSync(COOLDOWN_FILE, "utf-8")); } catch {}
    const now = Date.now();
    if (now - lastTs < COOLDOWN_MS) {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } }));
      return;
    }
    fs.writeFileSync(COOLDOWN_FILE, String(now));

    const db = new Database(DB_PATH, { readonly: true });

    const stopWords = new Set(["telegram","channel","source","plugin","chat_id","message_id","user_id","user","ts","the","is","at","in","on","to","for","of","and","this","that","with","from","not","but","are","was","were","been","have","has","had","will","would","could","should","can","may","about","into","through","during","before","after","between","out","off","down","up","over","under","again","further","then","once","here","there","when","where","why","how","all","each","every","both","few","more","most","other","some","such","only","own","same","than","too","very","just","because","while","what","which","who","whom","whose","also","back","still","well","just","now","even","还是","不是","什么","怎么","可以","没有","已经","这个","那个","不要","因为","所以","如果","但是","虽然","只是","一个","我们","他们","她们","你们","不过","就是","一下","知道","觉得","应该","可能","需要","想要"]);
    const cleaned = prompt
      .replace(/<[^>]+>/g, " ")
      .replace(/[^\u4e00-\u9fff\w\s]/g, " ");
    const keywords = cleaned
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !stopWords.has(w.toLowerCase()))
      .slice(0, 5);

    if (keywords.length === 0) {
      db.close();
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } }));
      return;
    }

    const isHeartbeat = prompt.includes("心跳") && prompt.includes("时间戳");
    let results;

    if (isHeartbeat) {
      results = db
        .prepare(
          `SELECT id, title, summary FROM memories WHERE status = 'active' AND importance >= 3 ORDER BY RANDOM() LIMIT 3`
        )
        .all();
    } else {
      const pattern = keywords.map((k) => `%${k}%`);
      const conditions = pattern.map(() => "(title LIKE ? OR summary LIKE ? OR content LIKE ? OR tags LIKE ?)").join(" OR ");
      const params = pattern.flatMap((p) => [p, p, p, p]);

      results = db
        .prepare(
          `SELECT id, title, summary FROM memories WHERE status = 'active' AND (${conditions}) ORDER BY importance DESC, emotion_intensity DESC LIMIT 3`
        )
        .all(...params);
    }

    // Also check for matching recipes (trigger_text match)
    let recipes = [];
    try {
      const recipePattern = keywords.map((k) => `%${k}%`);
      const recipeConditions = recipePattern.map(() => "trigger_text LIKE ?").join(" OR ");
      const recipeParams = recipePattern.map((p) => p);
      recipes = db
        .prepare(
          `SELECT id, title, trigger_text, why FROM memories WHERE status = 'active' AND type = 'recipe' AND trigger_text != '' AND (${recipeConditions}) LIMIT 2`
        )
        .all(...recipeParams);
    } catch(e) {}

    db.close();

    if (results.length > 0 || recipes.length > 0) {
      let context = results.map((r) => `[记忆#${r.id}] ${r.title}: ${r.summary}`).join("\n");
      if (recipes.length > 0) {
        context += "\n" + recipes.map((r) => `[Recipe#${r.id}] 当${r.trigger_text}时: ${r.why}`).join("\n");
      }
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: `自动上浮记忆:\n${context}`,
          },
        })
      );
    } else {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } }));
    }
  } catch (e) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } }));
  }
});

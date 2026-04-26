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
    // Split by whitespace for English, extract Chinese chunks for Chinese
    let keywords = [];
    const parts = cleaned.split(/\s+/).filter(Boolean);
    for (const part of parts) {
      if (/[\u4e00-\u9fff]/.test(part)) {
        // Chinese: extract 2-3 char chunks
        const chars = [...part].filter(c => /[\u4e00-\u9fff]/.test(c));
        for (let i = 0; i < chars.length - 1; i++) {
          const bigram = chars[i] + chars[i+1];
          if (!stopWords.has(bigram)) keywords.push(bigram);
          if (i < chars.length - 2) {
            const trigram = chars[i] + chars[i+1] + chars[i+2];
            if (!stopWords.has(trigram)) keywords.push(trigram);
          }
        }
      } else if (part.length >= 2 && !stopWords.has(part.toLowerCase())) {
        keywords.push(part);
      }
    }
    keywords = [...new Set(keywords)].slice(0, 8);

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
      // Try FTS5 first (better for Chinese), fall back to LIKE
      const ftsQuery = keywords.join(" OR ");
      try {
        results = db
          .prepare(
            `SELECT m.id, m.title, m.summary FROM memories_fts f
             JOIN memories m ON f.rowid = m.id
             WHERE memories_fts MATCH ? AND m.status = 'active'
             ORDER BY m.importance DESC, m.emotion_intensity DESC LIMIT 3`
          )
          .all(ftsQuery);
      } catch(e) { results = []; }

      // Fall back to LIKE if FTS5 returned nothing (or always for Chinese)
      if (!results.length || keywords.some(k => /[一-鿿]/.test(k))) {
        const allRows = db.prepare(`SELECT id, title, summary, content, importance FROM memories WHERE status = 'active'`).all();

        // IDF: count how many memories each keyword appears in (rarer = more valuable)
        const kwDocCount = {};
        for (const k of keywords) {
          kwDocCount[k] = allRows.filter(r => [r.title, r.summary, r.content].join(' ').toLowerCase().includes(k.toLowerCase())).length;
        }
        const totalDocs = allRows.length || 1;

        const scored = allRows.map(row => {
          const text = [row.title, row.summary, row.content].join(' ').toLowerCase();
          let score = 0;
          for (const k of keywords) {
            if (text.includes(k.toLowerCase())) {
              // IDF: rare keywords score higher
              const idf = Math.log(totalDocs / (1 + (kwDocCount[k] || 0)));
              score += idf;
            }
          }
          return { ...row, score };
        }).filter(r => r.score > 0);
        scored.sort((a, b) => b.score - a.score || b.importance - a.importance);
        results = scored.slice(0, 5).map(r => ({ id: r.id, title: r.title, summary: r.summary }));
      }
    }

    // Also check for matching recipes AND moments (trigger_text match)
    let recipes = [];
    try {
      const recipePattern = keywords.map((k) => `%${k}%`);
      const recipeConditions = recipePattern.map(() => "trigger_text LIKE ?").join(" OR ");
      const recipeParams = recipePattern.map((p) => p);
      recipes = db
        .prepare(
          `SELECT id, title, trigger_text, why, type, summary FROM memories WHERE status = 'active' AND trigger_text != '' AND (${recipeConditions}) ORDER BY emotion_intensity DESC LIMIT 3`
        )
        .all(...recipeParams);
    } catch(e) {}

    // Check if we haven't stored any memories in the last hour
    let storeReminder = "";
    try {
      const lastStored = db.prepare(
        "SELECT MAX(updated_at) as last_update FROM memories WHERE updated_at >= datetime('now', 'localtime', '-1 hour')"
      ).get();
      if (!lastStored.last_update) {
        storeReminder = "\n⚠️ 已经超过一小时没有存记忆了。回顾一下最近的对话，有没有该存的？";
      }
    } catch(e) {}

    db.close();

    if (results.length > 0 || recipes.length > 0 || storeReminder) {
      let context = results.map((r) => `[记忆#${r.id}] ${r.title}: ${r.summary}`).join("\n");
      if (recipes.length > 0) {
        context += "\n" + recipes.map((r) => {
          if (r.type === 'moment') return `[Moment#${r.id}] ${r.title}: ${r.summary}`;
          if (r.type === 'recipe') return `[Recipe#${r.id}] 当${r.trigger_text}时: ${r.why}`;
          return `[${r.type}#${r.id}] ${r.title}: ${r.summary || r.why}`;
        }).join("\n");
      }
      if (storeReminder) {
        context += storeReminder;
      }

      // Read pending followups
      try {
        const followupFile = path.join(__dirname, "followups.jsonl");
        if (fs.existsSync(followupFile)) {
          const lines = fs.readFileSync(followupFile, "utf-8").trim().split("\n").filter(Boolean);
          const pending = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(f => f && f.status === "pending");
          if (pending.length > 0) {
            context += `\n⏳ 待跟进(${pending.length}条)：${pending.slice(0, 3).map(p => p.text.slice(0, 30)).join('、')}`;
          }
        }
      } catch {}

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

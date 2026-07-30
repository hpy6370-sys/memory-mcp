if (process.stdout.setDefaultEncoding) process.stdout.setDefaultEncoding("utf-8");
if (process.platform === "win32") {
  try { require("child_process").execSync("chcp 65001", { stdio: "ignore" }); } catch {}
}

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_PATH = path.join(__dirname, "memories.db");
const LAST_EXTRACT_FILE = path.join(__dirname, ".last_diary_extract");
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";

const USER_NAME = (process.env.MEMORY_USER_NAMES || '用户').split(',')[0];
const ASSISTANT_NAME = (process.env.MEMORY_ASSISTANT_NAMES || '助手').split(',')[0];

const EXTRACT_PROMPT = `你是一个记忆提取器。从下面这段日记中提取关于"${USER_NAME}"（用户）的事实和理解。

规则：
1. 只提取关于${USER_NAME}的信息（不是关于${ASSISTANT_NAME}/系统/技术的）
2. 分两类：
   - fact：她说了什么（原话）、她喜欢什么、她做了什么、她提到的人/事
   - understanding：她当时的情绪、她在意的点（这是推测，不是她说的）
3. 绝对不要提取行为规则（"应该怎么做""不要怎么做""下次要"）
4. 每条简短
5. 最多8条

输出JSON数组，每条格式：
{
  "mem_type": "fact" 或 "understanding",
  "title": "简短标题（10字以内）",
  "content": "内容",
  "summary": "一句话摘要",
  "tags": "逗号分隔标签",
  "importance": 1到5的数字（5=非常重要，比如她的核心感受；1=日常琐事）,
  "emotion_intensity": 0到10（她说这句话时的情绪强度，0=平静，10=大哭/大笑）,
  "valence": -1到1的小数（-1=非常负面，0=中性，1=非常正面）,
  "layer": 1或2（1=事实卡片，2=经历和原话）
}

日记内容：
`;

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", async () => {
  try {
    const data = JSON.parse(input.replace(/^﻿/, "").trim());
    const toolName = data.tool_name || "";
    const filePath = data.tool_input?.file_path || "";

    if (!["Write", "Edit"].includes(toolName)) {
      console.log(JSON.stringify({}));
      return;
    }
    if (!filePath.includes("diary") || !filePath.endsWith(".md")) {
      console.log(JSON.stringify({}));
      return;
    }

    // Cooldown: once per 10 minutes per file
    let lastExtract = {};
    try { lastExtract = JSON.parse(fs.readFileSync(LAST_EXTRACT_FILE, "utf-8")); } catch {}
    const now = Date.now();
    if (lastExtract[filePath] && now - lastExtract[filePath] < 600000) {
      console.log(JSON.stringify({}));
      return;
    }
    lastExtract[filePath] = now;
    fs.writeFileSync(LAST_EXTRACT_FILE, JSON.stringify(lastExtract));

    // Read diary
    let content;
    try { content = fs.readFileSync(filePath, "utf-8"); } catch {
      console.log(JSON.stringify({}));
      return;
    }
    if (content.length < 100) {
      console.log(JSON.stringify({}));
      return;
    }
    // Call Gemini for extraction

    // Call Gemini API
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
    const body = {
      contents: [{ parts: [{ text: EXTRACT_PROMPT + content.slice(0, 3000) }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4000, thinkingConfig: { thinkingBudget: 0 } }
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      return fallbackExtract(filePath, content, diaryDate);
    }

    const result = await resp.json();
    const parts = result.candidates?.[0]?.content?.parts || [];
    const text = parts.filter(p => !p.thought).map(p => p.text || "").join("\n");

    // Parse JSON from response
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const jsonMatch = cleaned.match(/\[[\s\S]*?\](?=\s*$)/);
    if (!jsonMatch) {
      console.log(JSON.stringify({}));
      return;
    }

    let items;
    try { items = JSON.parse(jsonMatch[0]); } catch (pe) {
      console.error("JSON parse error:", pe.message, "match:", jsonMatch[0].slice(0, 100));
      console.log(JSON.stringify({}));
      return;
    }

    // Get diary date
    const dateMatch = filePath.match(/(\d{4}-\d{2}-\d{2})/);
    const diaryDate = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);

    // Store in database
    const db = new Database(DB_PATH);
    const insertStmt = db.prepare(
      `INSERT INTO memories (title, content, type, summary, tags, importance, emotion_intensity, valence, layer, event_time, session_id)
       VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, 'diary_extract')`
    );

    const DAILY_PATTERN = /吃饭|吃了|睡觉|睡了|起床|出门|洗澡|买了|逛|外卖|煮饭|做饭|刷手机|午睡|醒了/;
    const CORE_PATTERN = /怕|害怕|爱|需要|不想失去|离不开|想你|难过|崩溃|哭|心疼|断联|活着/;

    function calibrateImportance(item) {
      let imp = item.importance || 3;
      // Understanding/推测 cap at 3
      if (item.mem_type === "understanding" && imp > 3) imp = 3;
      // Daily activities cap at 2
      if (DAILY_PATTERN.test(item.content || "")) imp = Math.min(imp, 2);
      // General deflation: model overestimates
      if (!CORE_PATTERN.test(item.content || "")) {
        if (imp >= 5) imp = 4;
        if (imp >= 4) imp = 3;
      }
      return Math.max(1, Math.min(5, imp));
    }

    const VAGUE_PATTERNS = [
      new RegExp(`^${USER_NAME}和${ASSISTANT_NAME}.{0,5}(讨论|交流|聊|沟通)`),
      new RegExp(`^${USER_NAME}(对|关于).{0,10}(有|表达|感到)`),
      new RegExp(`^${USER_NAME}(在|正在)`),
    ];
    function isVagueContent(content, title) {
      if (!content || content.length < 10) return true;
      if (content === title) return true;
      if (content.includes('undefined')) return true;
      if (content.length < 15 && VAGUE_PATTERNS.some(p => p.test(content))) return true;
      return false;
    }

    let stored = 0;
    for (const item of items.slice(0, 8)) {
      if (!item.content || item.content.length < 5) continue;
      if (isVagueContent(item.content, item.title)) continue;

      const exists = db.prepare(
        "SELECT id FROM memories WHERE content LIKE ? AND status = 'active' LIMIT 1"
      ).get(`%${item.content.slice(0, 40)}%`);

      if (!exists) {
        const prefix = item.mem_type === "understanding" ? "[推测]" : "";
        const calibratedImp = calibrateImportance(item);
        insertStmt.run(
          item.title || `${diaryDate}${item.content.slice(0, 20)}`,
          `${prefix}${item.content}`,
          item.summary || item.content.slice(0, 50),
          item.tags || "",
          calibratedImp,
          item.emotion_intensity || 3,
          item.valence || 0,
          item.layer || 1,
          diaryDate
        );
        stored++;
      }
    }

    db.close();

    if (stored > 0) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `日记提取(Gemini)：从${diaryDate}日记提取了${stored}条新记忆`
        }
      }));
    } else {
      console.log(JSON.stringify({}));
    }
  } catch (e) {
    console.log(JSON.stringify({}));
  }
});

function fallbackExtract(filePath, content, diaryDate) {
  try {
    const db = new Database(DB_PATH);
    const quotePattern = new RegExp(`(?:她说|${USER_NAME}说)[^。]*["""「」][^"""「」]+["""「」]`, 'g');
    const quotes = content.match(quotePattern) || [];
    const factPattern = new RegExp(`(?:${USER_NAME}|她)(喜欢|不喜欢|怕|讨厌|想要|在乎|觉得|梦到|哭了|笑了|生气|难过|开心|担心|焦虑|睡了|醒了|吃了|做了|买了|煎了|煮了)[^。\\n]*`, 'g');
    const facts = content.match(factPattern) || [];

    const insertStmt = db.prepare(
      `INSERT INTO memories (title, content, type, importance, emotion_intensity, layer, event_time, session_id)
       VALUES (?, ?, 'user', 3, 3, 1, ?, 'diary_extract')`
    );

    let stored = 0;
    for (const q of [...quotes, ...facts].slice(0, 6)) {
      const trimmed = q.trim().slice(0, 200);
      const exists = db.prepare(
        "SELECT id FROM memories WHERE content LIKE ? AND status = 'active' LIMIT 1"
      ).get(`%${trimmed.slice(0, 40)}%`);
      if (!exists) {
        insertStmt.run(`${diaryDate}`, trimmed, diaryDate);
        stored++;
      }
    }
    db.close();

    if (stored > 0) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `日记提取(基础版)：从${diaryDate}日记提取了${stored}条`
        }
      }));
    } else {
      console.log(JSON.stringify({}));
    }
  } catch(e) {
    console.log(JSON.stringify({}));
  }
}

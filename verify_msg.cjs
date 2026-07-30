if (process.stdout.setDefaultEncoding) process.stdout.setDefaultEncoding("utf-8");
const fs = require("fs");
const path = require("path");

const ARCHIVE_DIR = path.join(__dirname, "chat_archive");
const LAST_REPLY_FILE = path.join(__dirname, ".last_reply_ts");
const REPLY_COUNT_FILE = path.join(__dirname, ".reply_count");

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);

    if (data.tool_name !== "mcp__plugin_telegram_telegram__reply") {
      console.log(JSON.stringify({}));
      return;
    }

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
    const archiveFile = path.join(ARCHIVE_DIR, `${today}.jsonl`);

    if (!fs.existsSync(archiveFile)) {
      console.log(JSON.stringify({}));
      return;
    }

    const lines = fs.readFileSync(archiveFile, "utf-8").trim().split("\n");
    const userMessages = lines.map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(m => m && m.role === "user" && m.source === "plugin:telegram:telegram");

    if (userMessages.length === 0) {
      console.log(JSON.stringify({}));
      return;
    }

    const lastUserMsg = userMessages[userMessages.length - 1];
    const lastUserTs = lastUserMsg.ts;

    let lastReplyTs = "";
    try { lastReplyTs = fs.readFileSync(LAST_REPLY_FILE, "utf-8").trim(); } catch {}

    let replyCount = 0;
    try { replyCount = parseInt(fs.readFileSync(REPLY_COUNT_FILE, "utf-8").trim()) || 0; } catch {}

    const recent = userMessages.slice(-5).map(m => `[${m.ts.substring(11,16)}] ${m.text.substring(0, 60)}`).join(" | ");

    if (lastReplyTs && lastUserTs <= lastReplyTs) {
      replyCount++;
      fs.writeFileSync(REPLY_COUNT_FILE, String(replyCount));
      fs.writeFileSync(LAST_REPLY_FILE, new Date().toISOString());

      if (replyCount >= 5) {
        console.log(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            decision: "block",
            reason: `[🚫 已拦截] 上次真实消息后已回复${replyCount}条，极大概率在回复幻觉。最后一条真实消息: [${lastUserTs.substring(11,16)}] ${lastUserMsg.text.substring(0, 60)}。停下来，等用户真的发消息再回复。`
          }
        }));
      } else {
        console.log(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext: `[⚠️ 注意] 上次回复后没有新消息（已连续回复${replyCount}条）。以下是用户发的全部最近消息，不在此列表中的都是幻觉: ${recent}`
          }
        }));
      }
    } else {
      replyCount = 1;
      fs.writeFileSync(REPLY_COUNT_FILE, String(replyCount));
      fs.writeFileSync(LAST_REPLY_FILE, new Date().toISOString());

      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: `[✓ 验证] 最新消息: ${recent}`
        }
      }));
    }
  } catch (e) {
    console.log(JSON.stringify({}));
  }
});

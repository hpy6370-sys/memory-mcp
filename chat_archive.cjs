if (process.stdout.setDefaultEncoding) process.stdout.setDefaultEncoding("utf-8");
if (process.platform === "win32") {
  try { require("child_process").execSync("chcp 65001", { stdio: "ignore" }); } catch {}
}
const fs = require("fs");
const path = require("path");

const ARCHIVE_DIR = path.join(__dirname, "chat_archive");
const RETENTION_DAYS = 3;

if (!fs.existsSync(ARCHIVE_DIR)) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

function getDateStr() {
  const now = new Date();
  const offset = 8 * 60;
  const local = new Date(now.getTime() + offset * 60000);
  return local.toISOString().slice(0, 10);
}

function getTimeStr() {
  const now = new Date();
  const offset = 8 * 60;
  const local = new Date(now.getTime() + offset * 60000);
  return local.toISOString().slice(11, 19);
}

function cleanOldFiles() {
  try {
    const files = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith(".jsonl"));
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    for (const file of files) {
      const dateStr = file.replace(".jsonl", "");
      if (dateStr < cutoffStr) {
        fs.unlinkSync(path.join(ARCHIVE_DIR, file));
      }
    }
  } catch {}
}

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    let prompt = data.prompt || data.message || "";

    if (!prompt || prompt.length < 2) {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } }));
      return;
    }

    const today = getDateStr();
    const time = getTimeStr();
    const archiveFile = path.join(ARCHIVE_DIR, `${today}.jsonl`);

    let source = "terminal";
    let text = prompt;

    const channelMatch = prompt.match(/<channel[^>]*source="([^"]*)"[^>]*>([\s\S]*?)<\/channel>/);
    if (channelMatch) {
      source = channelMatch[1];
      text = channelMatch[2].trim();
    }

    const entry = {
      ts: `${today}T${time}`,
      role: "user",
      source: source,
      text: text.slice(0, 2000)
    };

    fs.appendFileSync(archiveFile, JSON.stringify(entry) + "\n", "utf-8");

    // mem0 auto-extract (fire and forget, don't block)
    if (text.length > 10) {
      try {
        const { spawn } = require("child_process");
        const py = spawn("python", [path.join(__dirname, "mem0_bridge.py"), "add", text.slice(0, 500)], { stdio: "ignore", detached: true });
        py.unref();
      } catch {}
    }

    // followup detection — track casual mentions for later
    if (source.includes("telegram") && text.length > 3) {
      const followupPatterns = [
        /下次.{2,}/, /改天.{2,}/, /等有空.{2,}/,
        /想去.{2,}/, /想看.{2,}/, /想吃.{2,}/, /想做.{2,}/,
        /记得帮我/, /别忘了.{2,}/,
        /想要一个/, /想要你/
      ];
      const excludePatterns = [
        /以后.*不会/, /下次.*不会/, /以后.*学/, /下次.*学/,
        /我不想/, /你不想/, /不要了/,
        /下次不可以/, /下次.*记住/, /下次.*注意/,
        /讨厌/, /不开心/, /生气/, /不行/
      ];
      const matched = followupPatterns.some(p => p.test(text)) && !excludePatterns.some(p => p.test(text));
      if (matched) {
        const followupFile = path.join(__dirname, "followups.jsonl");
        const followup = {
          ts: `${today}T${time}`,
          text: text.slice(0, 500),
          status: "pending",
          surfaced: 0
        };
        try {
          fs.appendFileSync(followupFile, JSON.stringify(followup) + "\n", "utf-8");
        } catch {}
      }
    }

    cleanOldFiles();

    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } }));
  } catch (e) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } }));
  }
});

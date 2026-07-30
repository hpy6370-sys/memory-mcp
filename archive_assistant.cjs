if (process.stdout.setDefaultEncoding) process.stdout.setDefaultEncoding("utf-8");
if (process.platform === "win32") {
  try { require("child_process").execSync("chcp 65001", { stdio: "ignore" }); } catch {}
}
const fs = require("fs");
const path = require("path");

const ARCHIVE_DIR = path.join(__dirname, "chat_archive");

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

// PostToolUse hook for telegram reply — archives assistant messages
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name || "";
    const toolInput = data.tool_input || {};

    // Only archive telegram reply tool calls
    if (!toolName.includes("telegram") || !toolName.includes("reply")) {
      console.log(JSON.stringify({}));
      return;
    }

    const text = toolInput.text || "";
    if (!text || text.length < 1) {
      console.log(JSON.stringify({}));
      return;
    }

    const today = getDateStr();
    const time = getTimeStr();
    const archiveFile = path.join(ARCHIVE_DIR, `${today}.jsonl`);
    const chatId = toolInput.chat_id || "";

    const entry = {
      ts: `${today}T${time}`,
      role: "assistant",
      source: "plugin:telegram:telegram",
      chat_id: chatId,
      text: text.slice(0, 2000)
    };

    fs.appendFileSync(archiveFile, JSON.stringify(entry) + "\n", "utf-8");
    console.log(JSON.stringify({}));
  } catch (e) {
    console.log(JSON.stringify({}));
  }
});

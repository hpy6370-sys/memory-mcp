const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const db = new Database(path.join(__dirname, "memories.db"), { readonly: true });
const rows = db.prepare(
  "SELECT id, type, title, content, summary, importance, emotion_intensity, layer FROM memories WHERE status = 'active' ORDER BY type, id"
).all();

let output = `# 记忆清理清单\n\n`;
output += `共 ${rows.length} 条活跃记忆\n\n`;
output += `请在每条后面标记：✅留 / ✏️改写 / ❌删\n`;
output += `改写的请写上改成什么\n\n---\n\n`;

let currentType = "";
for (const r of rows) {
  if (r.type !== currentType) {
    currentType = r.type;
    output += `\n## 类型：${currentType}\n\n`;
  }
  const emo = r.emotion_intensity ? ` | 情绪:${r.emotion_intensity}` : "";
  const imp = r.importance ? ` | 重要:${r.importance}` : "";
  const layer = r.layer ? ` | L${r.layer}` : "";
  output += `### #${r.id} ${r.title}\n`;
  output += `${imp}${emo}${layer}\n\n`;
  const content = r.content.length > 300 ? r.content.slice(0, 300) + "..." : r.content;
  output += `${content}\n\n`;
  output += `**判断：** \n\n---\n\n`;
}

db.close();

const outPath = path.join(process.env.MEMORY_EXPORT_DIR || __dirname, "记忆清理清单.md");
fs.writeFileSync(outPath, output, "utf-8");
console.log(`导出完成: ${rows.length} 条记忆 → ${outPath}`);

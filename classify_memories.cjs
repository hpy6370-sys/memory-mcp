const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const db = new Database(path.join(__dirname, "memories.db"), { readonly: true });
const rows = db.prepare(
  "SELECT id, type, title, content, summary, importance, emotion_intensity, layer FROM memories WHERE status = 'active' ORDER BY type, id"
).all();

const ruleKeywords = ["不要", "不能", "不许", "不可以", "应该", "必须", "以后", "教训", "要记住", "做到", "别忘", "一定要", "千万不", "下次", "避免", "注意：", "核心教训", "关键原则"];
const userName = (process.env.MEMORY_USER_NAMES || '用户').split(',')[0];
const factKeywords = ["她说", "她喜欢", "她不喜欢", "她怕", "她的", "她会", "她是", `${userName}说`, `${userName}的`, `${userName}喜欢`, `${userName}怕`];
const quotePattern = /["""「」]/;
const diaryPattern = /^(session|04-|05-|2026-|\d{2}-\d{2})/i;

function classify(row) {
  const text = [row.title, row.content, row.summary || ""].join(" ");

  let ruleScore = 0;
  let factScore = 0;
  let reasons = [];

  // Type-based signals
  if (row.type === "feedback") {
    ruleScore += 3;
    reasons.push("type=feedback");
  }

  // Keyword scoring
  for (const kw of ruleKeywords) {
    const count = (text.match(new RegExp(kw, "g")) || []).length;
    if (count > 0) {
      ruleScore += count;
      reasons.push(`规则词"${kw}"×${count}`);
    }
  }

  for (const kw of factKeywords) {
    const count = (text.match(new RegExp(kw, "g")) || []).length;
    if (count > 0) {
      factScore += count;
    }
  }

  // Has quotes (original words)
  if (quotePattern.test(text)) {
    factScore += 2;
    reasons.push("含引号原话");
  }

  // Pure diary entry
  if (row.type === "diary" && text.length > 500) {
    ruleScore += 1;
    reasons.push("长日记条目");
  }

  // High emotion = likely important personal moment
  if (row.emotion_intensity >= 7) {
    factScore += 2;
  }

  // Decision
  let action, reason;

  if (row.type === "feedback") {
    action = "❌删或✏️改写为事实";
    reason = "feedback类型=行为规则。如果里面有她的原话可改写为事实";
  } else if (ruleScore >= 3 && factScore <= 1) {
    action = "❌删";
    reason = `规则信号强(${reasons.join(", ")})，事实信号弱`;
  } else if (ruleScore >= 2 && factScore >= 2) {
    action = "✏️改写";
    reason = `混杂：有规则(${reasons.filter(r => r.includes("规则")).join(", ")})也有事实/原话，拆开留事实删规则`;
  } else if (factScore >= 2 && ruleScore <= 1) {
    action = "✅留";
    reason = "主要是事实/原话/关于她的理解";
  } else if (row.type === "diary" && text.length > 500) {
    action = "✏️改写";
    reason = "长日记，提取关键原话和事实，删流水账部分";
  } else if (row.type === "user") {
    action = "✅留";
    reason = "关于她的信息";
  } else {
    action = "❓需要人工判断";
    reason = `规则分${ruleScore} 事实分${factScore}，不好自动判断`;
  }

  return { action, reason };
}

let output = "# 记忆自动分类结果\n\n";
output += `共 ${rows.length} 条，按建议操作分组\n\n`;
output += "过一遍，不同意的改掉就行\n\n";

const groups = { "❌删": [], "❌删或✏️改写为事实": [], "✏️改写": [], "✅留": [], "❓需要人工判断": [] };

for (const row of rows) {
  const { action, reason } = classify(row);
  const content = row.content.length > 150 ? row.content.slice(0, 150) + "..." : row.content;
  groups[action] = groups[action] || [];
  groups[action].push({ id: row.id, title: row.title, type: row.type, content, reason, emotion: row.emotion_intensity });
}

for (const [action, items] of Object.entries(groups)) {
  if (items.length === 0) continue;
  output += `\n---\n\n## ${action}（${items.length}条）\n\n`;
  for (const item of items) {
    const emo = item.emotion ? ` | 情绪:${item.emotion}` : "";
    output += `### #${item.id} [${item.type}] ${item.title}\n`;
    output += `${item.content}\n`;
    output += `**自动判断：** ${action} — ${item.reason}\n`;
    output += `**用户意见：** \n\n`;
  }
}

// Summary
output += "\n---\n\n## 统计\n\n";
for (const [action, items] of Object.entries(groups)) {
  if (items.length > 0) output += `- ${action}：${items.length}条\n`;
}

db.close();

const outPath = path.join(process.env.MEMORY_EXPORT_DIR || __dirname, "记忆自动分类.md");
fs.writeFileSync(outPath, output, "utf-8");
console.log(`分类完成: ${rows.length} 条`);
for (const [action, items] of Object.entries(groups)) {
  if (items.length > 0) console.log(`  ${action}: ${items.length}`);
}

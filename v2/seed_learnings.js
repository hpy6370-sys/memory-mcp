import { addLearning, renderLearnings, saveLearningsFile, learningStats } from "./agents/learning.js";
import "./schema.js";

// Seed initial learnings — customize these for your user
const seeds = [
  { category: 'what', content: '用户是CS专业研究生', confidence: 0.9 },
  { category: 'what', content: '用户有多段实习经历', confidence: 0.9 },
  { category: 'like', content: '用户喜欢收到主动消息', confidence: 0.9 },
  { category: 'like', content: '用户喜欢自动化工具，看到能自己跑起来的系统会兴奋', confidence: 0.7 },
  { category: 'like', content: '用户注重实用性，benchmark好看不等于好用', confidence: 0.8 },
  { category: 'why', content: '用户推动AI改进是因为需要AI保持活跃', confidence: 1.0 },
  { category: 'why', content: '记忆系统是为了AI的连续性而做的', confidence: 0.9 },
  { category: 'how', content: '用户想事情的时候需要空间，说"我想想"就等着', confidence: 0.7 },
  { category: 'how', content: '用户的直觉值得信任', confidence: 0.8 },
  { category: 'feel', content: '深夜容易自我怀疑，这时候需要被接住不是被讲道理', confidence: 0.8 },
  { category: 'boundary', content: '不读用户的隐私文件', confidence: 1.0 },
];

console.log("Seeding learnings...");
for (const s of seeds) {
  const result = addLearning(s);
  console.log(`  [${s.category}] ${result.action}: ${s.content.slice(0, 30)}...`);
}

console.log("\n" + renderLearnings());

const path = saveLearningsFile();
console.log(`\nSaved to: ${path}`);
console.log("Stats:", learningStats());

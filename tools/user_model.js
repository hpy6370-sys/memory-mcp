import { z } from "zod";
import db from "../db.js";

// Phase 6: Helper to update user model
function updateUserTrait(trait, evidence) {
  const existing = db.prepare("SELECT * FROM user_model WHERE trait = ?").get(trait);
  if (existing) {
    const evidenceList = JSON.parse(existing.evidence || '[]');
    evidenceList.push(evidence);
    db.prepare("UPDATE user_model SET weight = weight + 1, evidence = ?, last_confirmed = datetime('now') WHERE trait = ?")
      .run(JSON.stringify(evidenceList), trait);
  } else {
    db.prepare("INSERT INTO user_model (trait, weight, evidence, last_confirmed) VALUES (?, 1, ?, datetime('now'))")
      .run(trait, JSON.stringify([evidence]));
  }
}

export function registerUserModelTools(server) {
  // Phase 6: User Model - update trait
  server.tool("user_model_update",
    "更新用户模型的特征权重。每次用户纠正时调用，自动累加权重",
    {
      trait: z.string().describe("特征名，如'对催敏感'、'怕断联'"),
      evidence: z.string().describe("本次证据，如'04-23: 一个session催了4次'"),
    },
    async ({ trait, evidence }) => {
      updateUserTrait(trait, evidence);
      const updated = db.prepare("SELECT * FROM user_model WHERE trait = ?").get(trait);
      return { content: [{ type: "text", text: `用户特征「${trait}」权重更新为 ${updated.weight}（累计${JSON.parse(updated.evidence).length}条证据）` }] };
    }
  );

  // Phase 6: User Model - get top traits
  server.tool("user_model_top",
    "获取用户模型中权重最高的特征，新session启动时调用",
    {
      limit: z.number().optional().describe("返回条数，默认10"),
    },
    async ({ limit }) => {
      const n = limit || 10;
      const traits = db.prepare("SELECT trait, weight, evidence, last_confirmed FROM user_model ORDER BY weight DESC LIMIT ?").all(n);
      if (traits.length === 0) {
        return { content: [{ type: "text", text: "用户模型为空，还没有记录任何特征。" }] };
      }
      const output = traits.map((t, i) =>
        `${i + 1}. 「${t.trait}」权重${t.weight}（最近确认：${t.last_confirmed || '未知'}）`
      ).join('\n');
      return { content: [{ type: "text", text: `用户特征模型（按重要程度排序）：\n${output}` }] };
    }
  );
}

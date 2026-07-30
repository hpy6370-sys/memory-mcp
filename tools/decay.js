import db from "../db.js";

export function registerDecayTool(server) {
  server.tool("memory_decay",
    "衰减检查：用连续指数衰减计算每条记忆的健康分，低于阈值的过期。高importance/emotion/pinned衰减极慢。",
    {},
    async () => {
      const rows = db.prepare(`
        Select id, title, type, importance, emotion_intensity, pinned, activation_count, resolved, valence, surprise_score,
          CAST(julianday('now', 'localtime') - julianday(created_at) AS INTEGER) as days_old,
          CASE WHEN last_activated != '' THEN CAST(julianday('now', 'localtime') - julianday(last_activated) AS INTEGER) ELSE CAST(julianday('now', 'localtime') - julianday(created_at) AS INTEGER) END as days_since_activated
        FROM memories WHERE status = 'active'
      `).all();

      const LAMBDA = 0.05;
      const EXPIRE_THRESHOLD = 0.2;
      const expired = [];
      const scores = [];

      for (const r of rows) {
        if (r.pinned) continue;
        if (r.type === 'user' || r.type === 'feedback' || r.type === 'project' || r.type === 'recipe' || r.type === 'consolidated') continue;

        // Continuous decay: base score decays exponentially with time since last activation
        const baseDecay = Math.exp(-LAMBDA * r.days_since_activated);

        // Boosts that resist decay
        const importanceBoost = r.importance / 5.0;
        const emotionBoost = (r.emotion_intensity || 0) / 10.0 * 2.0;
        const activationBoost = Math.min(r.activation_count * 0.1, 0.5);
        const surpriseBoost = (r.surprise_score || 0.5) * 0.3;
        const resolvedPenalty = r.resolved ? -0.3 : 0;

        const healthScore = baseDecay + importanceBoost + emotionBoost + activationBoost + surpriseBoost + resolvedPenalty;

        scores.push({ id: r.id, title: r.title, health: healthScore.toFixed(3), days: r.days_since_activated });

        if (healthScore < EXPIRE_THRESHOLD) {
          db.prepare("UPDATE memories SET status = 'expired', updated_at = datetime('now', 'localtime') WHERE id = ?").run(r.id);
          expired.push({ id: r.id, title: r.title, health: healthScore.toFixed(3), days: r.days_since_activated });
        }
      }

      const bottom5 = scores.sort((a, b) => parseFloat(a.health) - parseFloat(b.health)).slice(0, 5);

      return { content: [{ type: "text", text: expired.length
        ? `衰减完成，${expired.length}条过期：\n${expired.map(e => `- ID ${e.id}: ${e.title} (健康分${e.health}, ${e.days}天)`).join('\n')}\n\n最低5条：\n${bottom5.map(s => `- ID ${s.id}: ${s.title} (${s.health}, ${s.days}天)`).join('\n')}`
        : `没有需要过期的记忆。最低5条：\n${bottom5.map(s => `- ID ${s.id}: ${s.title} (${s.health}, ${s.days}天)`).join('\n')}`
      }] };
    }
  );
}

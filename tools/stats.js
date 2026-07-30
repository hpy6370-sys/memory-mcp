import db from "../db.js";

export function registerStatsTool(server) {
  server.tool("memory_stats",
    "查看记忆统计",
    {},
    async () => {
      const total = db.prepare("SELECT COUNT(*) as count FROM memories").get();
      const active = db.prepare("SELECT COUNT(*) as count FROM memories WHERE status = 'active'").get();
      const expired = db.prepare("SELECT COUNT(*) as count FROM memories WHERE status = 'expired'").get();
      const byType = db.prepare("SELECT type, COUNT(*) as count FROM memories GROUP BY type").all();
      const byLayer = db.prepare("SELECT layer, COUNT(*) as count FROM memories GROUP BY layer").all();
      const pinned = db.prepare("SELECT COUNT(*) as count FROM memories WHERE pinned = 1").get();
      const highEmotion = db.prepare("SELECT COUNT(*) as count FROM memories WHERE emotion_intensity >= 7").get();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total: total.count,
            active: active.count,
            expired: expired.count,
            pinned: pinned.count,
            highEmotion: highEmotion.count,
            byType,
            byLayer
          }, null, 2)
        }]
      };
    }
  );
}

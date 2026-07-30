import { z } from "zod";
import db from "../db.js";

export function registerExpireTool(server) {
  server.tool("memory_expire",
    "将记忆标记为过期（不删除，保留历史）",
    {
      id: z.number().describe("记忆ID"),
      reason: z.string().optional().describe("过期原因"),
    },
    async ({ id, reason }) => {
      db.prepare("UPDATE memories SET status = 'expired', updated_at = datetime('now', 'localtime') WHERE id = ?").run(id);
      return { content: [{ type: "text", text: `记忆 ${id} 已标记为过期${reason ? '：' + reason : ''}` }] };
    }
  );
}

import { z } from "zod";
import db from "../db.js";

export function registerDeleteTool(server) {
  server.tool("memory_delete",
    "彻底删除一条记忆（不可恢复，建议用memory_expire代替）",
    { id: z.number().describe("记忆ID") },
    async ({ id }) => {
      db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      return { content: [{ type: "text", text: `记忆 ${id} 已彻底删除` }] };
    }
  );
}

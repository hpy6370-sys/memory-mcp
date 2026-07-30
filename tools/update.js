import { z } from "zod";
import db from "../db.js";

export function registerUpdateTool(server) {
  server.tool("memory_update",
    "更新一条记忆的任意字段",
    {
      id: z.number().describe("记忆ID"),
      title: z.string().optional(),
      content: z.string().optional(),
      tags: z.string().optional(),
      mood: z.string().optional(),
      importance: z.number().optional(),
      pinned: z.boolean().optional(),
      layer: z.number().optional(),
      summary: z.string().optional(),
      emotion_intensity: z.number().optional(),
      related_ids: z.string().optional(),
      status: z.string().optional(),
      activation_count: z.number().optional(),
    },
    async ({ id, ...updates }) => {
      const fields = [];
      const params = [];
      for (const [k, v] of Object.entries(updates)) {
        if (v !== undefined) {
          fields.push(`${k} = ?`);
          params.push(k === "pinned" ? (v ? 1 : 0) : v);
        }
      }
      if (!fields.length) return { content: [{ type: "text", text: "没有需要更新的字段" }] };
      fields.push("updated_at = datetime('now', 'localtime')");
      params.push(id);
      db.prepare(`UPDATE memories SET ${fields.join(", ")} WHERE id = ?`).run(...params);
      return { content: [{ type: "text", text: `记忆 ${id} 已更新` }] };
    }
  );
}

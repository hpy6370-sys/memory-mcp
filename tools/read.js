import { z } from "zod";
import db from "../db.js";

export function registerReadTool(server) {
  server.tool("memory_read",
    "读取记忆，可按类型、层级、重要程度、状态筛选",
    {
      type: z.string().optional().describe("按类型筛选"),
      layer: z.number().optional().describe("按层级筛选：1=事实 2=经历 3=决策链"),
      status: z.string().optional().describe("按状态筛选：active/expired/archived"),
      pinned: z.boolean().optional().describe("只看置顶"),
      importance_min: z.number().optional().describe("最低重要程度"),
      limit: z.number().optional().describe("返回条数，默认20"),
    },
    async ({ type, layer, status, pinned, importance_min, limit }) => {
      let sql = "SELECT * FROM memories WHERE 1=1";
      const params = [];
      if (type) { sql += " AND type = ?"; params.push(type); }
      if (layer) { sql += " AND layer = ?"; params.push(layer); }
      if (status) { sql += " AND status = ?"; params.push(status); }
      else { sql += " AND status = 'active'"; }
      if (pinned) { sql += " AND pinned = 1"; }
      if (importance_min) { sql += " AND importance >= ?"; params.push(importance_min); }
      sql += " ORDER BY pinned DESC, importance DESC, emotion_intensity DESC, updated_at DESC LIMIT ?";
      params.push(limit || 20);
      const rows = db.prepare(sql).all(...params);
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    }
  );
}

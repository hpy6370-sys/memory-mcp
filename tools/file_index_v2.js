import { z } from "zod";
import db from "../db.js";

export function registerFileIndexTools(server) {
  server.tool("file_index_write",
    "记录文件摘要。每次创建或修改文件后调用，写一句话描述这个文件是什么、做什么用的。",
    {
      file_path: z.string().describe("文件路径"),
      summary: z.string().describe("一句话描述：这个文件是什么，做什么用的"),
      project: z.string().optional().describe("所属项目名"),
      related_files: z.string().optional().describe("关联文件路径，JSON数组"),
      key_contents: z.string().optional().describe("关键函数/段落/结构摘要（MTM层）"),
    },
    async ({ file_path, summary, project, related_files, key_contents }) => {
      const existing = db.prepare("SELECT id, touch_count FROM file_index WHERE file_path = ?").get(file_path);

      if (existing) {
        const fields = ["summary = ?", "last_touched = datetime('now', 'localtime')", "touch_count = touch_count + 1"];
        const params = [summary];
        if (project) { fields.push("project = ?"); params.push(project); }
        if (related_files) { fields.push("related_files = ?"); params.push(related_files); }
        if (key_contents) { fields.push("key_contents = ?"); params.push(key_contents); }
        params.push(existing.id);
        db.prepare(`UPDATE file_index SET ${fields.join(", ")} WHERE id = ?`).run(...params);
        return { content: [{ type: "text", text: `文件索引已更新：${file_path}（第${existing.touch_count + 1}次）` }] };
      }

      db.prepare(`
        INSERT INTO file_index (file_path, summary, project, related_files, key_contents)
        VALUES (?, ?, ?, ?, ?)
      `).run(file_path, summary, project || "", related_files || "[]", key_contents || "");

      return { content: [{ type: "text", text: `文件索引已创建：${file_path}` }] };
    }
  );

  server.tool("file_index_search",
    "搜索文件索引。找我做过的文件、某个项目的文件、或者按关键词搜。",
    {
      query: z.string().optional().describe("搜索关键词（搜路径、摘要、项目名）"),
      project: z.string().optional().describe("按项目筛选"),
      limit: z.number().optional().describe("返回条数，默认20"),
    },
    async ({ query, project, limit }) => {
      const maxResults = limit || 20;
      let sql = "SELECT * FROM file_index WHERE 1=1";
      const params = [];

      if (query) {
        sql += " AND (file_path LIKE ? OR summary LIKE ? OR key_contents LIKE ?)";
        const pattern = `%${query}%`;
        params.push(pattern, pattern, pattern);
      }
      if (project) {
        sql += " AND project = ?";
        params.push(project);
      }

      sql += " ORDER BY last_touched DESC LIMIT ?";
      params.push(maxResults);

      const rows = db.prepare(sql).all(...params);

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "没有找到匹配的文件" }] };
      }

      const output = rows.map(r =>
        `${r.file_path}\n  摘要：${r.summary}${r.project ? `\n  项目：${r.project}` : ''}${r.key_contents ? `\n  关键内容：${r.key_contents}` : ''}\n  最后操作：${r.last_touched}（${r.touch_count}次）`
      ).join("\n\n");

      return { content: [{ type: "text", text: output }] };
    }
  );
}

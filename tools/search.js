import { z } from "zod";
import db from "../db.js";
import { searchV2 } from "../v2/index.js";

export function registerSearchTool(server) {
  server.tool("memory_search",
    "搜索记忆。v2四通道：BM25(jieba) + 语义embedding + 实体图谱 + 氛围标签，RRF融合排序。",
    {
      query: z.string().describe("搜索关键词"),
      layer: z.number().optional().describe("只搜指定层级"),
      limit: z.number().optional().describe("返回条数，默认10"),
      current_valence: z.number().optional().describe("当前对话情绪-1到1，用于情绪共振匹配"),
      recent_messages: z.array(z.string()).optional().describe("最近3-4条对话消息，用于前置哨兵分析上下文"),
    },
    async ({ query, layer, limit, current_valence, recent_messages }) => {
      const maxResults = limit || 10;

      const { results, analyzed, channels } = await searchV2(query, {
        layer,
        limit: maxResults,
        currentValence: current_valence,
        recentMessages: recent_messages || [],
      });

      if (results.length === 0) {
        return { content: [{ type: "text", text: "没有找到相关记忆" }] };
      }

      // Format output
      const output = {
        query_analysis: {
          keywords: analyzed.keywords.slice(0, 10),
          entities: analyzed.entities,
          mood: analyzed.moodTags,
          temporal: analyzed.temporalTags,
        },
        channels,
        results: results.map(r => {
          const { _search, ...mem } = r;
          return {
            ...mem,
            search_score: _search.adjustedScore?.toFixed(4) || _search.rrfScore.toFixed(4),
            matched_channels: Object.keys(_search.channels),
          };
        }),
      };

      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    }
  );
}

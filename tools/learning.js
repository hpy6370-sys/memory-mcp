import { z } from "zod";
import { addLearning, getLearnings, renderLearnings, saveLearningsFile, learningStats } from "../v2/agents/learning.js";

export function registerLearningTools(server) {
  server.tool("learning_add",
    "记录一条新的理解/心得。六分类：what(事实) like(喜好) why(动机) how(行为模式) feel(情绪模式) boundary(底线)。理解不是规则——写描述性的认识，不写限制性条款。",
    {
      category: z.enum(["what", "like", "why", "how", "feel", "boundary"]).describe("分类"),
      content: z.string().describe("心得内容（用自然语言写，像是'我觉得...'而不是'规则：...'）"),
      evidence_memory_id: z.number().optional().describe("支撑这条理解的记忆ID"),
      confidence: z.number().optional().describe("确信度0-1，默认0.5"),
    },
    async ({ category, content, evidence_memory_id, confidence }) => {
      const result = addLearning({
        category,
        content,
        evidenceMemoryId: evidence_memory_id,
        confidence: confidence || 0.5,
      });

      const labels = { new: '新理解', reinforced: '已有理解加强', superseded: '更新了旧理解' };
      return { content: [{ type: "text", text: `${labels[result.action]}（ID: ${result.id}${result.oldId ? `，取代了旧#${result.oldId}` : ''}）` }] };
    }
  );

  server.tool("learning_view",
    "查看当前所有心得/理解，按六分类展示。这就是'我对用户的理解'。",
    {},
    async () => {
      const md = renderLearnings();
      return { content: [{ type: "text", text: md || "还没有形成任何理解。" }] };
    }
  );

  server.tool("learning_save",
    "把心得渲染成learnings.md文件保存，下次session启动时会自动加载。",
    {},
    async () => {
      const path = saveLearningsFile();
      const stats = learningStats();
      const activeStr = stats.active.map(a => `${a.category}:${a.c}`).join(' ');
      return { content: [{ type: "text", text: `已保存到 ${path}（${activeStr}，${stats.superseded}条已迭代）` }] };
    }
  );
}

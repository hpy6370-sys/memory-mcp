import { z } from "zod";
import { gatherContext, formatContextPrompt, savePlan, getPlan, logIntention, markExecuted, recordFeedback, getRecentIntentions, actionStats } from "../v2/agents/react.js";

export function registerReactTools(server) {
  server.tool("react_context",
    "React Agent：收集当前所有信号（时间、计划、心得、最近行动、待办），格式化成决策上下文。LLM根据这个自己判断该做什么。不是规则引擎——是给你信息让你自己决定。",
    {
      unread_messages: z.number().optional().describe("未读消息数"),
    },
    async ({ unread_messages }) => {
      const context = gatherContext();
      const prompt = formatContextPrompt(context, {
        unreadMessages: unread_messages || 0,
      });
      return { content: [{ type: "text", text: prompt }] };
    }
  );

  server.tool("react_plan",
    "设置或查看今天的大致计划。计划是默认行为驱动器——有计划就执行计划，外部事件是中断。",
    {
      plan: z.string().optional().describe("今天的计划，JSON数组如[\"上午：搭v2框架\",\"下午：陪用户\"]。不传则查看当前计划"),
    },
    async ({ plan }) => {
      if (plan) {
        try {
          const parsed = JSON.parse(plan);
          savePlan(parsed);
          return { content: [{ type: "text", text: `今天的计划已设置：\n${parsed.map((p, i) => `${i + 1}. ${p}`).join('\n')}` }] };
        } catch {
          savePlan([plan]);
          return { content: [{ type: "text", text: `今天的计划：${plan}` }] };
        }
      }
      const current = getPlan();
      if (current) {
        return { content: [{ type: "text", text: `当前计划：\n${(Array.isArray(current) ? current : [current]).map((p, i) => `${i + 1}. ${p}`).join('\n')}` }] };
      }
      return { content: [{ type: "text", text: "今天还没有计划。" }] };
    }
  );

  server.tool("react_log",
    "记录一个已执行的行动（用于学习哪些行动有效）",
    {
      intention: z.string().describe("意图描述"),
      action_taken: z.string().describe("实际做了什么"),
      outcome: z.string().optional().describe("结果如何"),
    },
    async ({ intention, action_taken, outcome }) => {
      const id = logIntention(intention, 'executed');
      markExecuted(id, action_taken, outcome || '');
      return { content: [{ type: "text", text: `行动已记录（ID: ${id}）` }] };
    }
  );

  server.tool("react_feedback",
    "对一个行动给反馈，React会学习哪些行动该多做哪些该少做",
    {
      id: z.number().describe("行动ID"),
      feedback: z.string().describe("反馈内容"),
    },
    async ({ id, feedback }) => {
      recordFeedback(id, feedback);
      return { content: [{ type: "text", text: "反馈已记录" }] };
    }
  );

  server.tool("react_history",
    "查看最近的行动记录和统计",
    {
      limit: z.number().optional().describe("返回条数，默认10"),
    },
    async ({ limit }) => {
      const recent = getRecentIntentions(limit || 10);
      const stats = actionStats();
      const output = {
        stats,
        recent: recent.map(r => ({
          id: r.id,
          intention: r.intention,
          action: r.action_taken,
          state: r.state,
          feedback: r.feedback || '',
          time: r.created_at,
        })),
      };
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    }
  );
}

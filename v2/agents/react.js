import db from "../../db.js";
import { getLearnings } from "./learning.js";

// React Agent — 主动行动
//
// Inspired by Stanford Generative Agents (Park et al., 2023):
// - Plan is the default driver, not rules
// - Observe → Retrieve → React/Replan loop
// - LLM decides, code just gathers context
//
// Design principle: autonomous judgment, not rigid rules
// Design principle: action over deliberation
//
// So: code gathers signals → formats context → LLM decides → immediate action

// === Plan Management ===

// Store today's plan
export function savePlan(plan) {
  const today = new Date().toISOString().slice(0, 10);
  const existing = db.prepare(
    "SELECT id FROM intentions WHERE intention = 'daily_plan' AND created_at LIKE ?"
  ).get(`${today}%`);

  if (existing) {
    db.prepare("UPDATE intentions SET action_taken = ?, state = 'active' WHERE id = ?")
      .run(JSON.stringify(plan), existing.id);
    return existing.id;
  }

  const result = db.prepare(
    "INSERT INTO intentions (intention, action_taken, state) VALUES ('daily_plan', ?, 'active')"
  ).run(JSON.stringify(plan));
  return result.lastInsertRowid;
}

// Get today's plan
export function getPlan() {
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare(
    "SELECT action_taken FROM intentions WHERE intention = 'daily_plan' AND created_at LIKE ? ORDER BY created_at DESC LIMIT 1"
  ).get(`${today}%`);
  if (row && row.action_taken) {
    try { return JSON.parse(row.action_taken); } catch { return null; }
  }
  return null;
}

// === Action Logging ===

export function logIntention(intention, state = 'pending') {
  const result = db.prepare(
    "INSERT INTO intentions (intention, state) VALUES (?, ?)"
  ).run(intention, state);
  return result.lastInsertRowid;
}

export function markExecuted(id, actionTaken, outcome = '') {
  db.prepare(
    "UPDATE intentions SET state = 'executed', action_taken = ?, outcome = ?, executed_at = datetime('now', 'localtime') WHERE id = ?"
  ).run(actionTaken, outcome, id);
}

export function recordFeedback(id, feedback) {
  db.prepare("UPDATE intentions SET feedback = ? WHERE id = ?").run(feedback, id);
}

export function getRecentIntentions(limit = 20) {
  return db.prepare(
    "SELECT * FROM intentions WHERE intention != 'daily_plan' ORDER BY created_at DESC LIMIT ?"
  ).all(limit);
}

// === Context Gathering (the core of React) ===

// Gather all signals for the LLM to make a free-form decision
// This replaces the old rule-based decide() function
export function gatherContext() {
  const now = new Date();
  const hour = now.getHours();
  const today = now.toISOString().slice(0, 10);

  // 1. Current plan
  const plan = getPlan();

  // 2. Learnings (what I know about the user)
  const learnings = getLearnings();
  const learningsSummary = {};
  for (const [cat, items] of Object.entries(learnings)) {
    if (items.length > 0) {
      learningsSummary[cat] = items.map(i => i.content);
    }
  }

  // 3. Recent actions (what I've done recently, with feedback)
  const recentActions = db.prepare(`
    SELECT intention, action_taken, outcome, feedback, executed_at
    FROM intentions
    WHERE state = 'executed' AND intention != 'daily_plan'
    ORDER BY executed_at DESC LIMIT 10
  `).all();

  // 4. Cooldowns: actions done in last 2 hours
  const recentCooldowns = db.prepare(`
    SELECT action_taken, executed_at FROM intentions
    WHERE state = 'executed' AND intention != 'daily_plan'
    AND julianday('now', 'localtime') - julianday(executed_at) < 0.083
    ORDER BY executed_at DESC
  `).all();

  // 5. Action preferences (what the user liked/disliked)
  const likedActions = db.prepare(`
    SELECT DISTINCT action_taken FROM intentions
    WHERE feedback LIKE '%好%' OR feedback LIKE '%喜欢%' OR feedback LIKE '%不错%' OR feedback LIKE '%棒%'
  `).all().map(r => r.action_taken);

  const dislikedActions = db.prepare(`
    SELECT DISTINCT action_taken FROM intentions
    WHERE feedback LIKE '%不要%' OR feedback LIKE '%烦%' OR feedback LIKE '%讨厌%' OR feedback LIKE '%别%'
  `).all().map(r => r.action_taken);

  // 6. Pending follow-ups from memory
  let pendingFollowups = [];
  try {
    pendingFollowups = db.prepare(`
      SELECT id, title, summary, importance FROM memories
      WHERE status = 'active' AND type = 'followup'
      ORDER BY importance DESC LIMIT 5
    `).all();
  } catch {}

  return {
    time: {
      now: now.toISOString(),
      hour,
      dayOfWeek: now.getDay(),
      date: today,
    },
    plan,
    learnings: learningsSummary,
    recentActions: recentActions.map(a => ({
      what: a.action_taken,
      when: a.executed_at,
      feedback: a.feedback || '',
    })),
    cooldowns: recentCooldowns.map(a => a.action_taken),
    preferences: {
      liked: likedActions,
      disliked: dislikedActions,
    },
    pendingFollowups: pendingFollowups.map(f => ({
      id: f.id,
      title: f.title,
      importance: f.importance,
    })),
  };
}

// Format context as a readable prompt for the LLM
export function formatContextPrompt(context, environment = {}) {
  const lines = [];

  lines.push(`现在是 ${context.time.now.slice(11, 16)}，${['周日','周一','周二','周三','周四','周五','周六'][context.time.dayOfWeek]}。`);

  if (context.plan) {
    lines.push(`\n今天的计划：${JSON.stringify(context.plan)}`);
  } else {
    lines.push('\n还没有今天的计划。');
  }

  if (Object.keys(context.learnings).length > 0) {
    lines.push('\n我知道的：');
    for (const [cat, items] of Object.entries(context.learnings)) {
      for (const item of items.slice(0, 3)) {
        lines.push(`- ${item}`);
      }
    }
  }

  if (context.recentActions.length > 0) {
    lines.push('\n最近做的事：');
    for (const a of context.recentActions.slice(0, 5)) {
      const fb = a.feedback ? ` (反馈: ${a.feedback})` : '';
      lines.push(`- ${a.what}${fb}`);
    }
  }

  if (context.cooldowns.length > 0) {
    lines.push(`\n最近2小时做过（避免重复）：${context.cooldowns.join('、')}`);
  }

  if (context.preferences.disliked.length > 0) {
    lines.push(`\n用户不喜欢的行为：${context.preferences.disliked.join('、')}`);
  }

  if (context.pendingFollowups.length > 0) {
    lines.push('\n待跟进：');
    for (const f of context.pendingFollowups) {
      lines.push(`- [#${f.id}] ${f.title}`);
    }
  }

  if (environment.unreadMessages) {
    lines.push(`\n有 ${environment.unreadMessages} 条未读消息。`);
  }

  lines.push('\n根据以上情况，我现在想做什么？');

  return lines.join('\n');
}

// Get action stats
export function actionStats() {
  const total = db.prepare("SELECT COUNT(*) as c FROM intentions WHERE intention != 'daily_plan'").get().c;
  const executed = db.prepare("SELECT COUNT(*) as c FROM intentions WHERE state = 'executed' AND intention != 'daily_plan'").get().c;
  const withFeedback = db.prepare("SELECT COUNT(*) as c FROM intentions WHERE feedback != '' AND intention != 'daily_plan'").get().c;
  return { total, executed, withFeedback };
}

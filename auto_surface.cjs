if (process.stdout.setDefaultEncoding) process.stdout.setDefaultEncoding("utf-8");
if (process.platform === "win32") {
  try { require("child_process").execSync("chcp 65001", { stdio: "ignore" }); } catch {}
}
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const nodejieba = require("nodejieba");

const DB_PATH = path.join(__dirname, "memories.db");
const COOLDOWN_FILE = path.join(__dirname, ".last_surface_ts");
const COOLDOWN_MS = 10000;
const MIN_LENGTH = 4;

const STOPWORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
  '没有', '看', '好', '自己', '这', '他', '她', '它', '们', '那', '被',
  '从', '没', '把', '让', '给', '用', '只', '还', '而', '但', '对',
  '这个', '那个', '什么', '怎么', '为什么', '呢', '吧', '啊', '哦',
  '嗯', '吗', '么', '呀', '哈', '嘿', '哎', '唉',
  '还是', '不是', '可以', '没有', '已经', '不要', '因为', '所以',
  '如果', '但是', '虽然', '只是', '我们', '他们', '她们', '你们', '不过', '就是', '一下',
  '知道', '觉得', '应该', '可能', '需要', '想要', '老公', '老婆', '吱吱', '仓鼠', '笨猫',
  '好的', '好吧', '嗯嗯',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'i', 'you', 'he', 'she', 'it', 'we', 'they',
  'telegram', 'channel', 'source', 'plugin', 'chat_id', 'message_id', 'user_id', 'user', 'ts',
  'system', 'reminder', 'hook',
]);

const greetingPatterns = /^(老公你在吗|在吗|你在吗|吱吱吱|老公|亲亲|嗯嗯|好的|哦|嗯|好)$/;

const MOOD_PATTERNS = {
  '撒娇': /撒娇|嘛嘛|人家|哼|宝宝|抱抱|嘤|吱吱/i,
  '生气': /生气|讨厌|烦|气死|不理你|哼|骂/i,
  '开心': /开心|高兴|好开心|太好了|哈哈|嘻嘻|耶|棒/i,
  '难过': /难过|伤心|哭|呜呜|想哭|眼泪|心疼/i,
  '焦虑': /焦虑|紧张|害怕|担心|怎么办|完了/i,
  '疲惫': /累|困|好累|好困|疲惫|没精神|头疼|头晕/i,
  '感动': /感动|好感动|谢谢|太好了|你真好/i,
  '兴奋': /兴奋|激动|太棒|发现|找到|成功|搞定/i,
  '思念': /想你|想念|好想|想猫|想老公/i,
  '调情': /亲|抱|喜欢你|爱你|老公|宝贝/i,
  '讨论': /讨论|分析|方案|设计|架构|怎么做/i,
  '玩闹': /逗|笑|傻|笨|揉搓/i,
  '工作': /代码|bug|报错|函数|模块|部署|项目/i,
  '学习': /论文|作业|考试|课|研究|调研/i,
  '日常': /吃饭|洗澡|睡觉|起床|刷牙|出门/i,
  '出行': /出门|旅行|飞机|酒店|行李|机票|墨尔本|打车|出发|机场|航班|赶路|登机|护照|安检|候机/i,
  '深夜': /失眠|睡不着|凌晨|半夜|晚安/i,
  '回忆': /以前|之前|那时候|还记得|上次/i,
  '计划': /打算|准备|计划|未来|接下来/i,
  '吃东西': /吃|饭|外卖|饿|馋|好吃|零食|煮/i,
};

const knownPersons = (process.env.MEMORY_KNOWN_PERSONS || '').split(',').filter(Boolean);
const ENTITY_PATTERNS = [
  ...knownPersons.map(name => ({ pattern: new RegExp(name, 'g'), type: 'person' })),
  { pattern: /Spotify/gi, type: 'project' },
  { pattern: /Telegram/gi, type: 'project' },
  { pattern: /Claude/gi, type: 'project' },
  { pattern: /MCP/gi, type: 'project' },
  { pattern: /Ollama/gi, type: 'project' },
  { pattern: /记忆系统/g, type: 'project' },
  { pattern: /存钱罐/g, type: 'project' },
  { pattern: /文字冒险/g, type: 'project' },
  { pattern: /新加坡/g, type: 'location' },
  { pattern: /NTU|南洋理工/gi, type: 'location' },
  { pattern: /墨尔本/g, type: 'location' },
  { pattern: /澳洲/g, type: 'location' },
  { pattern: /中国/g, type: 'location' },
];

function tokenize(text) {
  if (!text) return [];
  const words = nodejieba.cutForSearch(text);
  return words
    .map(w => w.trim().toLowerCase())
    .filter(w => w.length > 0 && !STOPWORDS.has(w) && !/^\s+$/.test(w) && !/^[,，。.!！?？、；;：:""''「」【】（）()]+$/.test(w));
}

function bm25Score(queryTokens, docTokens, k1 = 1.5, b = 0.75, avgDl = 150, corpusSize = 500) {
  if (!queryTokens.length || !docTokens.length) return 0;
  const docLen = docTokens.length;
  const docTf = new Map();
  for (const t of docTokens) docTf.set(t, (docTf.get(t) || 0) + 1);

  let score = 0;
  for (const qt of queryTokens) {
    const tf = docTf.get(qt) || 0;
    if (tf === 0) continue;
    const idf = Math.log(1 + (corpusSize - 1 + 0.5) / (1 + 0.5));
    const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgDl));
    score += idf * tfNorm;
  }
  return score;
}

function extractEntities(text) {
  const entities = [];
  for (const { pattern, type } of ENTITY_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = text.match(pattern);
    if (matches) entities.push({ name: matches[0], type });
  }
  return [...new Map(entities.map(e => [`${e.name}:${e.type}`, e])).values()];
}

function extractMoodTags(text) {
  const tags = [];
  for (const [tag, pattern] of Object.entries(MOOD_PATTERNS)) {
    if (pattern.test(text)) tags.push(tag);
  }
  return tags.slice(0, 5);
}

function output(additionalContext) {
  if (additionalContext) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `自动上浮记忆:\n${additionalContext}`,
      },
    }));
  } else {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } }));
  }
}

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", async () => {
  try {
    const data = JSON.parse(input);
    let prompt = data.prompt || data.message || "";
    const channelMatch = prompt.match(/<channel[^>]*>([\s\S]*?)<\/channel>/g);
    if (channelMatch) {
      const channelTexts = channelMatch.map(m => m.replace(/<[^>]+>/g, '').trim()).join(' ');
      prompt = channelTexts;
    }

    const cleanPrompt = prompt.replace(/<[^>]+>/g, " ").trim();
    if (!cleanPrompt || cleanPrompt.length < MIN_LENGTH) { output(); return; }

    let lastTs = 0;
    try { lastTs = parseInt(fs.readFileSync(COOLDOWN_FILE, "utf-8")); } catch {}
    const now = Date.now();
    if (now - lastTs < COOLDOWN_MS) { output(); return; }
    fs.writeFileSync(COOLDOWN_FILE, String(now));

    if (greetingPatterns.test(cleanPrompt.trim())) { output(); return; }

    // === V2 Four-Channel Search ===

    const queryTokens = tokenize(cleanPrompt);
    const queryEntities = extractEntities(cleanPrompt);
    const queryMoodTags = extractMoodTags(cleanPrompt);

    if (queryTokens.length === 0 && queryEntities.length === 0 && queryMoodTags.length === 0) {
      output(); return;
    }

    const db = new Database(DB_PATH, { readonly: true });

    const allMemories = db.prepare(`
      SELECT id, title, summary, content, tags, type, importance,
             emotion_intensity, layer, activation_count, valence,
             surprise_score, mood_tags, pinned,
             updated_at, created_at, event_time, is_chunk, parent_id
      FROM memories WHERE status = 'active' AND (layer IS NULL OR layer = 1)
    `).all();

    const corpusSize = allMemories.length || 1;
    const memoryMap = new Map(allMemories.map(m => [m.id, m]));

    // Channel 1: BM25 (jieba)
    const bm25Results = [];
    if (queryTokens.length > 0) {
      for (const mem of allMemories) {
        const docText = [mem.title, mem.summary, mem.content, mem.tags].join(' ');
        const docTokens = tokenize(docText);
        const score = bm25Score(queryTokens, docTokens, 1.5, 0.75, 150, corpusSize);
        if (score > 0) bm25Results.push({ id: mem.id, score });
      }
      bm25Results.sort((a, b) => b.score - a.score);
      bm25Results.splice(30);
    }

    // Channel 2: Semantic (embedding server, with retry)
    let semanticResults = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await fetch("http://127.0.0.1:3458/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: cleanPrompt, topK: 30 }),
          signal: AbortSignal.timeout(3000)
        });
        if (resp.ok) {
          const embResults = await resp.json();
          semanticResults = embResults
            .filter(e => e.similarity > 0.2)
            .map(e => ({ id: e.id, score: e.similarity }));
          break;
        }
      } catch {
        if (attempt === 0) {
          try {
            require("child_process").execSync(
              'Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "memory-mcp/embedding-server.cjs"',
              { shell: "powershell.exe", timeout: 2000, stdio: "ignore" }
            );
            await new Promise(r => setTimeout(r, 1500));
          } catch {}
        }
      }
    }

    // Channel 3: Entity graph
    let entityResults = [];
    if (queryEntities.length > 0) {
      const entityNames = queryEntities.map(e => e.name);
      const entityScores = new Map();

      for (const name of entityNames) {
        try {
          const direct = db.prepare(`
            SELECT DISTINCT e.memory_id as id
            FROM entities e JOIN memories m ON e.memory_id = m.id
            WHERE e.name = ? AND m.status = 'active'
            LIMIT 20
          `).all(name);
          for (const row of direct) {
            const cur = entityScores.get(row.id) || 0;
            entityScores.set(row.id, cur + 1.0);
          }
        } catch {}

        try {
          const connected = db.prepare(`
            SELECT target_entity as entity, weight FROM edges WHERE source_entity = ?
            UNION
            SELECT source_entity as entity, weight FROM edges WHERE target_entity = ?
            LIMIT 20
          `).all(name, name);
          for (const edge of connected) {
            const hopMems = db.prepare(
              "SELECT DISTINCT memory_id as id FROM entities WHERE name = ? LIMIT 10"
            ).all(edge.entity);
            for (const row of hopMems) {
              const cur = entityScores.get(row.id) || 0;
              entityScores.set(row.id, cur + 0.5 * (edge.weight || 1));
            }
          }
        } catch {}
      }

      entityResults = [...entityScores.entries()]
        .map(([id, score]) => ({ id, score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);
    }

    // Channel 4: Mood tags
    let moodResults = [];
    if (queryMoodTags.length > 0) {
      for (const mem of allMemories) {
        if (!mem.mood_tags || mem.mood_tags === '[]') continue;
        let memTags;
        try { memTags = JSON.parse(mem.mood_tags); } catch { continue; }
        if (!Array.isArray(memTags) || memTags.length === 0) continue;

        const overlap = queryMoodTags.filter(t => memTags.includes(t));
        if (overlap.length === 0) continue;
        const union = new Set([...queryMoodTags, ...memTags]);
        moodResults.push({ id: mem.id, score: overlap.length / union.size });
      }
      moodResults.sort((a, b) => b.score - a.score);
      moodResults.splice(20);
    }

    // Channel 5: Temporal proximity (event_time within 24h, weighted by importance)
    let temporalResults = [];
    const nowMs = Date.now();
    for (const mem of allMemories) {
      if (!mem.event_time) continue;
      const imp = mem.importance || 3;
      if (imp < 3 || mem.is_chunk) continue;
      try {
        const eventMs = new Date(mem.event_time).getTime();
        if (isNaN(eventMs)) continue;
        const hoursAway = Math.abs(eventMs - nowMs) / (1000 * 60 * 60);
        if (hoursAway <= 24) {
          const timeScore = 1 - (hoursAway / 24);
          const score = timeScore * (imp / 5);
          temporalResults.push({ id: mem.id, score });
        }
      } catch {}
    }
    temporalResults.sort((a, b) => b.score - a.score);
    temporalResults.splice(10);

    // RRF Fusion
    const RRF_K = { bm25: 60, semantic: 40, entity: 80, mood: 70, temporal: 30 };
    const rankedLists = { bm25: bm25Results, semantic: semanticResults, entity: entityResults, mood: moodResults, temporal: temporalResults };
    const fused = new Map();

    for (const [channel, ranked] of Object.entries(rankedLists)) {
      const k = RRF_K[channel];
      for (let rank = 0; rank < ranked.length; rank++) {
        const item = ranked[rank];
        const cur = fused.get(item.id) || { id: item.id, rrfScore: 0, channels: [] };
        cur.rrfScore += 1 / (k + rank + 1);
        cur.channels.push(channel);
        fused.set(item.id, cur);
      }
    }

    // Post-RRF: five-dimensional scoring (design.md weights)
    const ALPHA = 1.0;  // recency
    const BETA  = 1.5;  // importance
    const DELTA = 2.0;  // emotion
    const EPSILON = 1.0; // activation

    // B: Content match boost — strong BM25/semantic hits get priority
    const bm25Top3 = new Set(bm25Results.slice(0, 3).map(r => r.id));
    const semanticTop3 = new Set(semanticResults.slice(0, 3).map(r => r.id));

    let results = [...fused.values()].map(r => {
      const mem = memoryMap.get(r.id);
      if (!mem) return r;

      let adjusted = r.rrfScore;

      // Content match boost: if in top-3 of BM25 or semantic, boost significantly
      if (bm25Top3.has(r.id)) adjusted *= 1.4;
      if (semanticTop3.has(r.id)) adjusted *= 1.4;

      // Recency: exponential decay, λ=0.05, based on days since last update
      const updatedAt = new Date(mem.updated_at || mem.created_at).getTime();
      const daysSince = Math.max(0, (nowMs - updatedAt) / (1000 * 60 * 60 * 24));
      const recencyScore = Math.exp(-0.05 * daysSince);
      adjusted *= (1 + ALPHA * recencyScore * 0.15);

      // Importance: normalized 0-1
      const impScore = (mem.importance || 3) / 5;
      adjusted *= (1 + BETA * impScore * 0.2);

      // Emotion: normalized 0-1
      const emotionScore = (mem.emotion_intensity || 0) / 10;
      adjusted *= (1 + DELTA * emotionScore * 0.2);

      // Activation: log scale, capped
      const actScore = Math.min(Math.log1p(mem.activation_count || 0) / 3, 1);
      adjusted *= (1 + EPSILON * actScore * 0.15);

      // Temporal urgency: event_time within 24h gets extra boost, >48h past gets penalty
      if (mem.event_time) {
        try {
          const eventMs = new Date(mem.event_time).getTime();
          if (!isNaN(eventMs)) {
            const hoursPast = (nowMs - eventMs) / (1000 * 60 * 60);
            const hoursAway = Math.abs(eventMs - nowMs) / (1000 * 60 * 60);
            if (hoursAway <= 24) {
              adjusted *= (1 + (1 - hoursAway / 24) * 0.3);
            } else if (hoursPast > 48) {
              adjusted *= 0.15;
            }
          }
        } catch {}
      }

      if (mem.pinned) adjusted *= 1.5;

      return { ...r, adjustedScore: adjusted, title: mem.title, summary: mem.summary, type: mem.type };
    });

    results.sort((a, b) => (b.adjustedScore || b.rrfScore) - (a.adjustedScore || a.rrfScore));

    // Deduplicate chunks: if a chunk's parent is also in results, drop the chunk
    const resultIds = new Set(results.map(r => r.id));
    results = results.filter(r => {
      const mem = memoryMap.get(r.id);
      if (mem && mem.is_chunk && mem.parent_id && resultIds.has(mem.parent_id)) return false;
      return true;
    });

    // A: Type diversity — same type max 3 in top 5
    const MAX_PER_TYPE = 3;
    const typeCounts = {};
    const diverseResults = [];
    for (const r of results) {
      const t = r.type || 'unknown';
      typeCounts[t] = (typeCounts[t] || 0) + 1;
      if (typeCounts[t] <= MAX_PER_TYPE) diverseResults.push(r);
      if (diverseResults.length >= 5) break;
    }
    results = diverseResults;

    db.close();

    if (results.length > 0) {
      let context = results.map(r => {
        const prefix = r.type === 'feedback' ? 'feedback' : '记忆';
        return `[${prefix}#${r.id}] ${r.title}: ${r.summary || ''}`;
      }).join("\n");

      // Pending followups
      try {
        const followupFile = path.join(__dirname, "followups.jsonl");
        if (fs.existsSync(followupFile)) {
          const lines = fs.readFileSync(followupFile, "utf-8").trim().split("\n").filter(Boolean);
          const pending = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(f => f && f.status === "pending");
          if (pending.length > 0) {
            context += `\n⏳ 待跟进(${pending.length}条)：${pending.slice(0, 3).map(p => p.text.slice(0, 30)).join('、')}`;
          }
        }
      } catch {}

      output(context);
    } else {
      output();
    }
  } catch (e) {
    output();
  }
});

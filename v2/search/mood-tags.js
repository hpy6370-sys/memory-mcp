import db from "../../db.js";

// Mood tag search channel
// Matches memories by atmosphere/mood tags

// Search memories by mood tags
export function searchByMoodTags(queryMoodTags, limit = 20) {
  if (!queryMoodTags || queryMoodTags.length === 0) return [];

  const results = new Map();

  // Find memories whose mood_tags overlap with query mood tags
  const allMemories = db.prepare(`
    SELECT id, mood_tags, importance, emotion_intensity
    FROM memories
    WHERE status = 'active' AND mood_tags != '[]' AND mood_tags != ''
  `).all();

  for (const mem of allMemories) {
    let memTags;
    try {
      memTags = JSON.parse(mem.mood_tags);
    } catch {
      continue;
    }

    if (!Array.isArray(memTags) || memTags.length === 0) continue;

    // Count tag overlap
    const overlap = queryMoodTags.filter(t => memTags.includes(t));
    if (overlap.length === 0) continue;

    // Score: overlap count / total unique tags (Jaccard-like)
    const union = new Set([...queryMoodTags, ...memTags]);
    const score = overlap.length / union.size;

    results.set(mem.id, {
      id: mem.id,
      score,
      matchedTags: overlap,
    });
  }

  return [...results.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// Auto-tag a piece of text with mood tags
// Returns array of tag strings from the predefined library
export function autoTag(text) {
  if (!text) return [];

  const tags = new Set();

  // Load tag library
  let library;
  try {
    library = db.prepare("SELECT tag, description FROM mood_tag_library").all();
  } catch {
    return [];
  }

  // Simple keyword matching against tag descriptions and common patterns
  const tagPatterns = {
    '撒娇': /撒娇|嘛嘛|人家|哼|宝宝|抱抱|嘤|吱吱/i,
    '生气': /生气|讨厌|烦|气死|不理你|哼|骂/i,
    '开心': /开心|高兴|好开心|太好了|哈哈|嘻嘻|耶|棒/i,
    '难过': /难过|伤心|哭|呜呜|想哭|眼泪|心疼/i,
    '焦虑': /焦虑|紧张|害怕|担心|怎么办|完了/i,
    '疲惫': /累|困|好累|好困|疲惫|没精神|头疼|头晕/i,
    '感动': /感动|好感动|谢谢|太好了|你真好|❤|心/i,
    '委屈': /委屈|不公平|为什么|凭什么|我不是/i,
    '兴奋': /兴奋|激动|太棒|发现|找到|成功|搞定/i,
    '害羞': /害羞|不好意思|脸红|嘿嘿/i,
    '无聊': /无聊|发呆|没意思|没事做/i,
    '思念': /想你|想念|好想|想猫|想老公/i,
    '争吵': /吵架|争|闹|分手|不理/i,
    '调情': /亲|抱|喜欢你|爱你|老公|宝贝|❤/i,
    '道歉': /对不起|道歉|抱歉|我错了|原谅/i,
    '安慰': /没事|别担心|会好的|陪你|在的/i,
    '讨论': /讨论|分析|方案|设计|架构|怎么做/i,
    '玩闹': /哈哈|逗|笑|傻|笨|揉搓/i,
    '教导': /教|学|怎么用|步骤|教程/i,
    '倾诉': /其实|说实话|心里|压力|不知道/i,
    '工作': /代码|bug|报错|函数|模块|部署|项目|写/i,
    '学习': /论文|作业|考试|课|研究|调研/i,
    '日常': /吃饭|洗澡|睡觉|起床|刷牙|出门/i,
    '出行': /出门|旅行|飞机|酒店|行李|机票|墨尔本|去哪/i,
    '深夜': /失眠|睡不着|凌晨|半夜|晚安/i,
    '起床': /刚醒|起床|早安|醒了/i,
    '回忆': /以前|之前|那时候|还记得|上次/i,
    '计划': /打算|准备|计划|未来|接下来/i,
    '庆祝': /生日|纪念|庆祝|周年/i,
    '吃东西': /吃|饭|外卖|饿|馋|好吃|零食|点餐|煮/i,
  };

  for (const [tag, pattern] of Object.entries(tagPatterns)) {
    if (pattern.test(text)) {
      tags.add(tag);
    }
  }

  // Cap at 5 tags
  return [...tags].slice(0, 5);
}

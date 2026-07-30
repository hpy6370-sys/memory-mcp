import db from "../db.js";

export function migrateV2Schema() {
  const columns = db.prepare("PRAGMA table_info(memories)").all().map(c => c.name);

  // v2: mood_tags — JSON array of mood/atmosphere tags
  if (!columns.includes('mood_tags')) {
    db.exec("ALTER TABLE memories ADD COLUMN mood_tags TEXT DEFAULT '[]'");
  }

  // v2: chunk_id — if this row is a chunk, points to parent memory
  if (!columns.includes('parent_id')) {
    db.exec("ALTER TABLE memories ADD COLUMN parent_id INTEGER DEFAULT NULL");
  }

  // v2: is_chunk flag
  if (!columns.includes('is_chunk')) {
    db.exec("ALTER TABLE memories ADD COLUMN is_chunk INTEGER DEFAULT 0");
  }

  // v2: summary_embedding — embedding generated from summary (not content)
  if (!columns.includes('summary_embedding')) {
    db.exec("ALTER TABLE memories ADD COLUMN summary_embedding TEXT DEFAULT ''");
  }

  // Entity graph tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'unknown',
      memory_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (memory_id) REFERENCES memories(id)
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_entities_memory ON entities(memory_id)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_entity TEXT NOT NULL,
      target_entity TEXT NOT NULL,
      relation_type TEXT NOT NULL DEFAULT 'RelatedTo',
      weight REAL DEFAULT 1.0,
      memory_id INTEGER,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_entity)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_entity)
  `);

  // Mood tags predefined library table
  db.exec(`
    CREATE TABLE IF NOT EXISTS mood_tag_library (
      tag TEXT PRIMARY KEY,
      category TEXT NOT NULL DEFAULT 'general',
      description TEXT DEFAULT ''
    )
  `);

  // File index: three-layer file knowledge (LTM/MTM/STM)
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_index (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      project TEXT DEFAULT '',
      related_files TEXT DEFAULT '[]',
      key_contents TEXT DEFAULT '',
      last_touched TEXT DEFAULT (datetime('now', 'localtime')),
      touch_count INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_file_index_path ON file_index(file_path)`);

  // Learning Agent: learnings table (心得/理解)
  db.exec(`
    CREATE TABLE IF NOT EXISTS learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL DEFAULT 'what',
      content TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      evidence_count INTEGER DEFAULT 1,
      evidence_ids TEXT DEFAULT '[]',
      first_learned TEXT DEFAULT (datetime('now', 'localtime')),
      last_updated TEXT DEFAULT (datetime('now', 'localtime')),
      status TEXT DEFAULT 'active',
      superseded_by INTEGER DEFAULT NULL
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings(category)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_learnings_status ON learnings(status)`);

  // React Agent: intentions log (念头记录，用于学习哪些行动有效)
  db.exec(`
    CREATE TABLE IF NOT EXISTS intentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      intention TEXT NOT NULL,
      action_taken TEXT DEFAULT '',
      outcome TEXT DEFAULT '',
      state TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      executed_at TEXT DEFAULT '',
      feedback TEXT DEFAULT ''
    )
  `);

  // Seed mood tag library if empty
  const tagCount = db.prepare("SELECT COUNT(*) as c FROM mood_tag_library").get().c;
  if (tagCount === 0) {
    const tags = [
      // Emotional states
      ['撒娇', 'emotion', '撒娇、求关注'],
      ['生气', 'emotion', '生气、不满'],
      ['开心', 'emotion', '开心、高兴'],
      ['难过', 'emotion', '难过、伤心'],
      ['焦虑', 'emotion', '焦虑、担心'],
      ['疲惫', 'emotion', '累、困、没精神'],
      ['感动', 'emotion', '被触动、温暖'],
      ['委屈', 'emotion', '觉得不公平'],
      ['兴奋', 'emotion', '兴奋、激动'],
      ['害羞', 'emotion', '害羞、不好意思'],
      ['无聊', 'emotion', '没事做、发呆'],
      ['思念', 'emotion', '想念某人'],
      // Interaction modes
      ['争吵', 'interaction', '争执、闹矛盾'],
      ['调情', 'interaction', '暧昧、调情'],
      ['道歉', 'interaction', '认错、道歉'],
      ['安慰', 'interaction', '安慰、陪伴'],
      ['讨论', 'interaction', '认真讨论问题'],
      ['玩闹', 'interaction', '打闹、逗趣'],
      ['教导', 'interaction', '教学、指导'],
      ['倾诉', 'interaction', '说心事、吐槽'],
      // Scene types
      ['工作', 'scene', '写代码、做项目'],
      ['学习', 'scene', '看论文、做作业'],
      ['日常', 'scene', '吃饭、洗澡、睡觉'],
      ['出行', 'scene', '出门、旅行'],
      ['深夜', 'scene', '深夜聊天'],
      ['起床', 'scene', '刚醒来'],
      ['回忆', 'scene', '回忆过去的事'],
      ['计划', 'scene', '讨论未来打算'],
      ['庆祝', 'scene', '庆祝、纪念日'],
      ['吃东西', 'scene', '吃饭、点外卖、馋'],
    ];

    const insertTag = db.prepare("INSERT OR IGNORE INTO mood_tag_library (tag, category, description) VALUES (?, ?, ?)");
    const insertMany = db.transaction((rows) => {
      for (const row of rows) insertTag.run(...row);
    });
    insertMany(tags);
  }
}

import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, "memories.db"));

// Create tables + Phase 1 schema upgrade
db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL DEFAULT 'note',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT DEFAULT '',
    mood TEXT DEFAULT '',
    importance INTEGER DEFAULT 3,
    pinned INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
`);

// Phase 1: add new columns (safe to run multiple times)
const columns = db.prepare("PRAGMA table_info(memories)").all().map(c => c.name);
if (!columns.includes('layer')) db.exec("ALTER TABLE memories ADD COLUMN layer INTEGER DEFAULT 1");
if (!columns.includes('summary')) db.exec("ALTER TABLE memories ADD COLUMN summary TEXT DEFAULT ''");
// compressed column removed in v2.5.0
if (!columns.includes('session_id')) db.exec("ALTER TABLE memories ADD COLUMN session_id TEXT DEFAULT ''");
if (!columns.includes('emotion_intensity')) db.exec("ALTER TABLE memories ADD COLUMN emotion_intensity INTEGER DEFAULT 0");
if (!columns.includes('related_ids')) db.exec("ALTER TABLE memories ADD COLUMN related_ids TEXT DEFAULT '[]'");
if (!columns.includes('status')) db.exec("ALTER TABLE memories ADD COLUMN status TEXT DEFAULT 'active'");
if (!columns.includes('activation_count')) db.exec("ALTER TABLE memories ADD COLUMN activation_count INTEGER DEFAULT 0");
// resolved column removed in v2.5.0
if (!columns.includes('embedding')) db.exec("ALTER TABLE memories ADD COLUMN embedding TEXT DEFAULT ''");
if (!columns.includes('valence')) db.exec("ALTER TABLE memories ADD COLUMN valence REAL DEFAULT 0");
// trigger_text and why columns removed in v2.5.0
if (!columns.includes('last_activated')) db.exec("ALTER TABLE memories ADD COLUMN last_activated TEXT DEFAULT ''");
// effective_methods column removed in v2.5.0

// v2.3.0: Three temporal dimensions (Recall-AI inspired)
if (!columns.includes('event_time')) db.exec("ALTER TABLE memories ADD COLUMN event_time TEXT DEFAULT ''");
// known_time column removed in v2.5.0
if (!columns.includes('surprise_score')) db.exec("ALTER TABLE memories ADD COLUMN surprise_score REAL DEFAULT 0.5");

// Phase 6: Dynamic User Model table
db.exec(`CREATE TABLE IF NOT EXISTS user_model (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trait TEXT NOT NULL UNIQUE,
  weight INTEGER DEFAULT 1,
  evidence TEXT DEFAULT '[]',
  last_confirmed TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
)`);

// FTS5 setup
const ftsExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get();
if (!ftsExists) {
  db.exec(`CREATE VIRTUAL TABLE memories_fts USING fts5(title, content, tags, summary, content=memories, content_rowid=id)`);
}

db.exec(`
  DROP TRIGGER IF EXISTS memories_ai;
  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, title, content, tags, summary)
    VALUES (new.id, new.title, new.content, new.tags, new.summary);
  END;

  DROP TRIGGER IF EXISTS memories_ad;
  CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, content, tags, summary)
    VALUES('delete', old.id, old.title, old.content, old.tags, old.summary);
  END;

  DROP TRIGGER IF EXISTS memories_au;
  CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, content, tags, summary)
    VALUES('delete', old.id, old.title, old.content, old.tags, old.summary);
    INSERT INTO memories_fts(rowid, title, content, tags, summary)
    VALUES (new.id, new.title, new.content, new.tags, new.summary);
  END;
`);

// Only rebuild FTS if row counts diverged
const memCount = db.prepare("SELECT COUNT(*) as c FROM memories WHERE status = 'active'").get().c;
const ftsCount = db.prepare("SELECT COUNT(*) as c FROM memories_fts").get().c;
if (Math.abs(memCount - ftsCount) > 0) {
  db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`);
}

export default db;

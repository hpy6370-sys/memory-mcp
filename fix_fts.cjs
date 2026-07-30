const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "memories.db"));

// Drop old FTS and triggers
db.exec("DROP TRIGGER IF EXISTS memories_ai");
db.exec("DROP TRIGGER IF EXISTS memories_ad");
db.exec("DROP TRIGGER IF EXISTS memories_au");
db.exec("DROP TABLE IF EXISTS memories_fts");

// Recreate FTS without compressed column
db.exec("CREATE VIRTUAL TABLE memories_fts USING fts5(title, content, tags, summary, content=memories, content_rowid=id)");

// New triggers without compressed
db.exec(`CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, content, tags, summary) VALUES (new.id, new.title, new.content, new.tags, new.summary);
END`);

db.exec(`CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content, tags, summary) VALUES('delete', old.id, old.title, old.content, old.tags, old.summary);
END`);

db.exec(`CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content, tags, summary) VALUES('delete', old.id, old.title, old.content, old.tags, old.summary);
  INSERT INTO memories_fts(rowid, title, content, tags, summary) VALUES (new.id, new.title, new.content, new.tags, new.summary);
END`);

// Rebuild FTS
db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
console.log("FTS rebuilt without compressed column");

// Show final columns
const cols = db.prepare("PRAGMA table_info(memories)").all().map(c => c.name);
console.log("columns:", cols.join(", "));
console.log("total:", cols.length);

db.close();

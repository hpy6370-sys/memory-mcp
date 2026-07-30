const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "memories.db"));

// Update FTS triggers to not reference compressed column
db.exec("DROP TRIGGER IF EXISTS memories_ai");
db.exec("DROP TRIGGER IF EXISTS memories_ad");
db.exec("DROP TRIGGER IF EXISTS memories_au");

db.exec(`CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, content, tags, summary, compressed) VALUES (new.id, new.title, new.content, new.tags, new.summary, '');
END`);

db.exec(`CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content, tags, summary, compressed) VALUES('delete', old.id, old.title, old.content, old.tags, old.summary, '');
END`);

db.exec(`CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content, tags, summary, compressed) VALUES('delete', old.id, old.title, old.content, old.tags, old.summary, '');
  INSERT INTO memories_fts(rowid, title, content, tags, summary, compressed) VALUES (new.id, new.title, new.content, new.tags, new.summary, '');
END`);

try {
  db.exec("ALTER TABLE memories DROP COLUMN compressed");
  console.log("dropped: compressed");
} catch(e) {
  console.log("skip compressed:", e.message);
}

db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
console.log("FTS rebuilt");

// Show remaining columns
const cols = db.prepare("PRAGMA table_info(memories)").all().map(c => c.name);
console.log("remaining columns:", cols.join(", "));

db.close();

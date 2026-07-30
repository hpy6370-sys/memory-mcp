const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Only run once every 12 hours
const LOCK_FILE = path.join(__dirname, '.last_consolidate');
try {
  const last = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
  if (Date.now() - parseInt(last) < 12 * 60 * 60 * 1000) {
    process.exit(0);
  }
} catch {}
fs.writeFileSync(LOCK_FILE, Date.now().toString());

const db = new Database(path.join(__dirname, 'memories.db'));

const all = db.prepare("SELECT id, title, content, type, layer, status, importance, created_at FROM memories WHERE status = 'active' ORDER BY id").all();
console.log('Total active memories:', all.length);

// Group by similar titles (case-insensitive, trimmed)
const titleMap = {};
all.forEach(m => {
  const key = (m.title || '').trim().toLowerCase();
  if (!key || key.length < 3) return;
  if (!titleMap[key]) titleMap[key] = [];
  titleMap[key].push(m);
});

const dupeGroups = Object.entries(titleMap).filter(([k, v]) => v.length > 1);
console.log(`\nFound ${dupeGroups.length} duplicate groups\n`);

const expireStmt = db.prepare("UPDATE memories SET status = 'expired' WHERE id = ?");
let totalExpired = 0;

const transaction = db.transaction(() => {
  for (const [title, mems] of dupeGroups) {
    // Keep the one with highest importance, or latest if same importance
    mems.sort((a, b) => {
      if (b.importance !== a.importance) return b.importance - a.importance;
      return b.id - a.id; // newer wins on tie
    });

    const keep = mems[0];
    const toExpire = mems.slice(1);

    console.log(`[KEEP #${keep.id}] ${title.substring(0, 50)} (imp=${keep.importance})`);
    for (const m of toExpire) {
      console.log(`  [EXPIRE #${m.id}] (imp=${m.importance})`);
      expireStmt.run(m.id);
      totalExpired++;
    }
  }
});

transaction();

console.log(`\nDone! Expired ${totalExpired} duplicate memories.`);
console.log(`Remaining active: ${all.length - totalExpired}`);

db.close();

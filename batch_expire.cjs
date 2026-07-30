const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "memories.db"));

// IDs to expire - all marked ❌删 in the classification
const toExpire = [
  // Original ❌删 (confirmed by user)
  947, 1008, 1010,
  // ❌删或改写 - marked delete
  253, 765, 779, 873,
  // ❓需要人工判断 - marked delete (auto_extract garbage)
  48, 931, 752, 753, 754, 755, 757, 758, 798, 799, 805,
  808, 809, 810, 823, 825, 827, 828, 830, 831, 832, 833,
  837, 847, 849, 850, 882, 892, 894, 896, 906, 909,
  871, 872, 877, 878, 879, 880,
  936, 937, 938, 946, 950, 960, 966, 967, 968, 971, 974, 975, 976, 978, 979,
  1011, 1014, 1015, 1016,
  328, 533, 651, 783, 787, 818, 874,
  // ✏️改写 section - ones I marked as delete
  756, 944,
  // user confirmed delete
  920,
];

const uniqueIds = [...new Set(toExpire)];

const stmt = db.prepare(
  "UPDATE memories SET status = 'expired', summary = '[清理-0516] ' || summary WHERE id = ? AND status = 'active'"
);

let count = 0;
for (const id of uniqueIds) {
  const result = stmt.run(id);
  if (result.changes > 0) count++;
}

console.log(`Expired ${count}/${uniqueIds.length} memories`);

// Also rebuild FTS5 index
try {
  db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
  console.log("FTS5 index rebuilt");
} catch(e) {
  console.log("FTS5 rebuild skipped:", e.message);
}

db.close();

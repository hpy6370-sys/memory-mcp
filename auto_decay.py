"""Auto decay - expires old low-value memories using exponential decay."""
import sqlite3, math, os

DB_PATH = os.path.join(os.path.dirname(__file__), 'memories.db')
LAMBDA = 0.05  # decay rate
THRESHOLD = 0.2  # below this = expire

try:
    db = sqlite3.connect(DB_PATH)
    rows = db.execute("""
        SELECT id, type, importance, emotion_intensity, pinned,
               CAST(julianday('now') - julianday(COALESCE(last_activated, created_at)) AS REAL) as days
        FROM memories
        WHERE status = 'active'
    """).fetchall()

    expired = 0
    for r in rows:
        mid, mtype, importance, emotion, pinned, days = r
        importance = importance or 3
        emotion = emotion or 0
        days = days or 0

        # Protected types never decay
        if mtype in ('user', 'project', 'consolidated') or pinned:
            continue

        # Exponential decay
        base = math.exp(-LAMBDA * days)

        # Boosts
        imp_boost = importance / 5.0
        emo_boost = (emotion / 10.0) * 2.0
        health = base * (1 + imp_boost + emo_boost)

        if health < THRESHOLD:
            db.execute("UPDATE memories SET status = 'expired' WHERE id = ?", (mid,))
            expired += 1

    db.commit()
    db.close()
    if expired > 0:
        print(f"Decayed {expired} memories")
except Exception as e:
    pass

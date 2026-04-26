"""Fact extractor — extracts facts from messages, stores directly in memories.db as Layer 1."""
import sys, os, json, warnings, sqlite3
warnings.filterwarnings('ignore')

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

DB_PATH = os.path.join(os.path.dirname(__file__), 'memories.db')
GROQ_KEY = os.environ.get('GROQ_API_KEY', '')

def extract_and_store(text):
    if not GROQ_KEY or len(text) < 15:
        return
    try:
        from groq import Groq
        client = Groq(api_key=GROQ_KEY)
        resp = client.chat.completions.create(
            model='llama-3.3-70b-versatile',
            messages=[
                {'role': 'system', 'content': 'Extract PERSONAL facts about the speaker from this message. Return a JSON array of short fact strings about the person (their preferences, habits, belongings, experiences, schedule, health, relationships). Do NOT extract definitions, general knowledge, or facts about other people. If no personal facts, return []. Respond ONLY with the JSON array.'},
                {'role': 'user', 'content': text}
            ],
            temperature=0,
            max_tokens=500
        )
        content = resp.choices[0].message.content.strip()
        if content.startswith('['):
            facts = json.loads(content)
        else:
            return

        if not facts:
            return

        db = sqlite3.connect(DB_PATH)
        for fact in facts[:5]:
            if isinstance(fact, str) and len(fact) > 5:
                cursor = db.execute(
                    """INSERT INTO memories (title, content, type, tags, importance, layer, summary, status)
                    VALUES (?, ?, 'note', 'auto-extracted,fact', 3, 1, ?, 'active')""",
                    (fact[:50], fact, fact)
                )
                row_id = cursor.lastrowid
                db.execute(
                    """INSERT INTO memories_fts (rowid, title, content, tags, summary, compressed)
                    VALUES (?, ?, ?, 'auto-extracted,fact', ?, '')""",
                    (row_id, fact[:50], fact, fact)
                )
        db.commit()
        db.close()
    except Exception as e:
        pass

def search_facts(query):
    try:
        db = sqlite3.connect(DB_PATH)
        results = db.execute(
            """SELECT content FROM memories
            WHERE tags LIKE '%auto-extracted%' AND status = 'active'
            AND (content LIKE ? OR summary LIKE ?)
            ORDER BY created_at DESC LIMIT 10""",
            (f'%{query}%', f'%{query}%')
        ).fetchall()
        db.close()
        return json.dumps([r[0] for r in results], ensure_ascii=False)
    except:
        return '[]'

if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(1)
    action = sys.argv[1]
    text = sys.argv[2]
    if action == 'add':
        extract_and_store(text)
    elif action == 'search':
        print(search_facts(text))
    elif action == 'all':
        try:
            db = sqlite3.connect(DB_PATH)
            results = db.execute(
                "SELECT content FROM memories WHERE tags LIKE '%auto-extracted%' AND status = 'active' ORDER BY created_at DESC LIMIT 20"
            ).fetchall()
            db.close()
            print(json.dumps([r[0] for r in results], ensure_ascii=False))
        except:
            print('[]')

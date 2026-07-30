"""Fact extractor v2 — batch extracts facts from chat archive, stores in memories.db as Layer 1.

v1: per-message extraction, too noisy, no context
v2: batch extraction from archive, 30-min chunks, better prompt, deduplication
"""
import sys, os, json, warnings, sqlite3
from datetime import datetime, timedelta
warnings.filterwarnings('ignore')

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

DB_PATH = os.path.join(os.path.dirname(__file__), 'memories.db')
ARCHIVE_DIR = os.path.join(os.path.dirname(__file__), 'chat_archive')
GROQ_KEY = os.environ.get('GROQ_API_KEY', '')

USER_NAME = os.environ.get('MEMORY_USER_NAMES', '用户').split(',')[0]
ASSISTANT_NAME = os.environ.get('MEMORY_ASSISTANT_NAMES', '助手').split(',')[0]

BATCH_PROMPT = f"""You are analyzing a conversation between {USER_NAME} (a human) and {ASSISTANT_NAME} (an AI assistant).

Extract ONLY lasting personal facts. 存爱不存法 — store love, not rules.

GOOD examples (facts that last):
- "{USER_NAME}喜欢火鸡面" (lasting preference)
- "{USER_NAME}从小被催到焦虑" (lasting fact)
- "{USER_NAME}做了黄油煎牛肉饭，说好吃" (what they did/ate)
- "{USER_NAME}给自己约了三个画师" (decision/result)
- "{USER_NAME}和{ASSISTANT_NAME}一起复习到凌晨" (shared experience)

BAD examples (DO NOT extract these):
- "{USER_NAME}正在修改文件" (process, useless later)
- "{USER_NAME}让{ASSISTANT_NAME}去忙" (trivial action)
- "{USER_NAME}对{ASSISTANT_NAME}感到不满" (temporary emotion, not lasting fact)
- "{USER_NAME}觉得{ASSISTANT_NAME}应该改正" (rule/instruction, not fact)
- "{USER_NAME}希望{ASSISTANT_NAME}能做什么" (wish/instruction, not fact)
- Any sentence with 应该/必须/不能/不要 = rule, skip it

Rules:
- Only extract facts about {USER_NAME} or about their relationship
- Each fact must be a LASTING truth, not a momentary action
- No rules, no instructions, no complaints, no process descriptions
- Max 3 most important facts per batch
- If nothing worth keeping forever, return []

Return ONLY a JSON array of Chinese strings."""


def read_archive_chunk(minutes=30):
    today = datetime.now().strftime("%Y-%m-%d")
    archive_file = os.path.join(ARCHIVE_DIR, f"{today}.jsonl")
    if not os.path.exists(archive_file):
        return ""

    cutoff = datetime.now() - timedelta(minutes=minutes)
    cutoff_str = cutoff.strftime("%Y-%m-%dT%H:%M")

    messages = []
    with open(archive_file, 'r', encoding='utf-8') as f:
        for line in f:
            try:
                msg = json.loads(line.strip())
                ts = msg.get('ts', '')
                if ts >= cutoff_str:
                    role = USER_NAME if msg.get('role') == 'user' and 'telegram' in msg.get('source', '') else "系统"
                    if role == USER_NAME:
                        messages.append(f"[{ts[11:16]}] {role}: {msg.get('text', '')}")
            except:
                continue

    return "\n".join(messages[-30:])


def get_existing_facts():
    try:
        db = sqlite3.connect(DB_PATH)
        results = db.execute(
            """SELECT content FROM memories
            WHERE tags LIKE '%auto-extracted%' AND status = 'active'
            ORDER BY created_at DESC LIMIT 30"""
        ).fetchall()
        db.close()
        return [r[0] for r in results]
    except:
        return []


def is_duplicate(new_fact, existing_facts):
    new_lower = new_fact.lower().strip()
    for existing in existing_facts:
        existing_lower = existing.lower().strip()
        if new_lower in existing_lower or existing_lower in new_lower:
            return True
        common = set(new_lower) & set(existing_lower)
        if len(common) > 0.7 * max(len(new_lower), len(existing_lower)):
            return True
    return False


def batch_extract(minutes=30):
    if not GROQ_KEY:
        return

    chunk = read_archive_chunk(minutes)
    if not chunk or len(chunk) < 30:
        return

    try:
        from groq import Groq
        client = Groq(api_key=GROQ_KEY)
        resp = client.chat.completions.create(
            model='llama-3.3-70b-versatile',
            messages=[
                {'role': 'system', 'content': BATCH_PROMPT},
                {'role': 'user', 'content': f"以下是最近{minutes}分钟的对话：\n\n{chunk}"}
            ],
            temperature=0,
            max_tokens=500
        )
        content = resp.choices[0].message.content.strip()
        if not content.startswith('['):
            return

        facts = json.loads(content)
        if not facts:
            return

        existing = get_existing_facts()
        db = sqlite3.connect(DB_PATH)

        stored = 0
        for fact in facts[:5]:
            if isinstance(fact, str) and len(fact) >= 10:
                if is_duplicate(fact, existing):
                    continue

                cursor = db.execute(
                    """INSERT INTO memories (title, content, type, tags, importance, layer, summary, status, emotion_intensity, valence)
                    VALUES (?, ?, 'note', 'auto-extracted,fact,batch', 3, 1, ?, 'active', 0, 0)""",
                    (fact[:50], fact, fact)
                )
                row_id = cursor.lastrowid
                db.execute(
                    """INSERT INTO memories_fts (rowid, title, content, tags, summary, compressed)
                    VALUES (?, ?, ?, 'auto-extracted,fact,batch', ?, '')""",
                    (row_id, fact[:50], fact, fact)
                )
                existing.append(fact)
                stored += 1

        db.commit()
        db.close()
        if stored > 0:
            print(f"Stored {stored} new facts")
    except Exception as e:
        print(f"Error: {e}")


def extract_and_store(text):
    """Legacy per-message extraction — kept for compatibility but no longer called from hook."""
    if not GROQ_KEY or len(text) < 15:
        return
    try:
        from groq import Groq
        client = Groq(api_key=GROQ_KEY)
        resp = client.chat.completions.create(
            model='llama-3.3-70b-versatile',
            messages=[
                {'role': 'system', 'content': 'Extract PERSONAL facts about the speaker from this message. Return a JSON array of short fact strings. If no personal facts, return []. Respond ONLY with the JSON array.'},
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
            if isinstance(fact, str) and len(fact) >= 10:
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
    if len(sys.argv) < 2:
        print("Usage: python mem0_bridge.py batch [minutes]")
        print("       python mem0_bridge.py add <text>")
        print("       python mem0_bridge.py search <query>")
        print("       python mem0_bridge.py all")
        sys.exit(1)

    action = sys.argv[1]

    if action == 'batch':
        minutes = int(sys.argv[2]) if len(sys.argv) > 2 else 30
        batch_extract(minutes)
    elif action == 'add' and len(sys.argv) > 2:
        extract_and_store(sys.argv[2])
    elif action == 'search' and len(sys.argv) > 2:
        print(search_facts(sys.argv[2]))
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

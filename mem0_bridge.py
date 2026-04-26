"""mem0 bridge - called from chat_archive.cjs to auto-extract memories"""
import sys, os, json, warnings
warnings.filterwarnings('ignore')

GROQ_KEY = os.environ.get('GROQ_API_KEY', '')
DATA_PATH = os.path.join(os.path.dirname(__file__), 'mem0_data')

def get_memory():
    os.environ['GROQ_API_KEY'] = GROQ_KEY
    from mem0 import Memory
    return Memory.from_config({
        'llm': {'provider': 'groq', 'config': {'model': 'llama-3.3-70b-versatile', 'api_key': GROQ_KEY}},
        'embedder': {'provider': 'huggingface', 'config': {'model': 'sentence-transformers/all-MiniLM-L6-v2'}},
        'vector_store': {'provider': 'qdrant', 'config': {'collection_name': 'niannian', 'path': DATA_PATH, 'embedding_model_dims': 384}},
        'version': 'v1.1'
    })

if __name__ == '__main__':
    action = sys.argv[1] if len(sys.argv) > 1 else 'add'
    text = sys.argv[2] if len(sys.argv) > 2 else ''
    if not text:
        text = sys.stdin.read().strip()
    if not text:
        sys.exit(0)

    m = get_memory()

    if action == 'add':
        result = m.add(text, user_id='niannian')
        print(json.dumps(result, ensure_ascii=False))
    elif action == 'search':
        result = m.search(text, filters={'user_id': 'niannian'})
        print(json.dumps(result, ensure_ascii=False))
    elif action == 'all':
        result = m.get_all(filters={'user_id': 'niannian'})
        print(json.dumps(result, ensure_ascii=False))

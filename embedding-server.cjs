const http = require("http");
const { pipeline } = require("@xenova/transformers");
const Database = require("better-sqlite3");
const path = require("path");

const PORT = 3458;
const DB_PATH = path.join(__dirname, "memories.db");

let embedder = null;

async function getEmbedder() {
  if (!embedder) {
    console.log("Loading embedding model...");
    embedder = await pipeline("feature-extraction", "Xenova/bge-small-zh-v1.5");
    console.log("Model loaded.");
  }
  return embedder;
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function generateEmbedding(text) {
  const model = await getEmbedder();
  const output = await model(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  let body = "";
  req.on("data", chunk => (body += chunk));
  req.on("end", async () => {
    try {
      const data = JSON.parse(body);

      if (req.url === "/embed") {
        const vec = await generateEmbedding(data.text || "");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ embedding: vec }));

      } else if (req.url === "/search") {
        const queryVec = await generateEmbedding(data.text || "");
        const topK = data.topK || 5;
        const db = new Database(DB_PATH, { readonly: true });
        const rows = db.prepare(
          "SELECT id, embedding FROM memories WHERE status = 'active' AND embedding IS NOT NULL AND embedding != ''"
        ).all();

        const scored = [];
        for (const row of rows) {
          try {
            const vec = JSON.parse(row.embedding);
            const sim = cosineSimilarity(queryVec, vec);
            scored.push({ id: row.id, similarity: sim });
          } catch (e) {}
        }
        scored.sort((a, b) => b.similarity - a.similarity);
        db.close();

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(scored.slice(0, topK)));

      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

// Pre-load model on startup
getEmbedder().then(() => {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Embedding server running on http://127.0.0.1:${PORT}`);
  });
});

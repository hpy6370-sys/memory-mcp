import db from "../../db.js";

// Entity graph search channel
// Given entity names, find related memories through the entity graph

// Find memories that share entities with the query entities
export function searchByEntities(entityNames, limit = 20) {
  if (!entityNames || entityNames.length === 0) return [];

  const results = new Map();

  for (const name of entityNames) {
    // Direct: memories containing this entity
    try {
      const directMemories = db.prepare(`
        SELECT DISTINCT e.memory_id as id, m.importance, m.emotion_intensity
        FROM entities e
        JOIN memories m ON e.memory_id = m.id
        WHERE e.name = ? AND m.status = 'active'
        LIMIT ?
      `).all(name, limit);

      for (const row of directMemories) {
        if (!results.has(row.id)) {
          results.set(row.id, { id: row.id, score: 0, paths: [] });
        }
        results.get(row.id).score += 1.0;
        results.get(row.id).paths.push({ via: name, type: 'direct' });
      }
    } catch (e) {
      // entities table might not exist
    }

    // 1-hop: find entities connected via edges, then their memories
    try {
      const connectedEntities = db.prepare(`
        SELECT target_entity as entity, relation_type, weight
        FROM edges WHERE source_entity = ?
        UNION
        SELECT source_entity as entity, relation_type, weight
        FROM edges WHERE target_entity = ?
        LIMIT 20
      `).all(name, name);

      for (const edge of connectedEntities) {
        const hopMemories = db.prepare(`
          SELECT DISTINCT memory_id as id
          FROM entities
          WHERE name = ?
          LIMIT 10
        `).all(edge.entity);

        for (const row of hopMemories) {
          if (!results.has(row.id)) {
            results.set(row.id, { id: row.id, score: 0, paths: [] });
          }
          // 1-hop connections get lower weight
          results.get(row.id).score += 0.5 * (edge.weight || 1);
          results.get(row.id).paths.push({
            via: `${name} → ${edge.entity}`,
            type: edge.relation_type,
          });
        }
      }
    } catch (e) {
      // edges table might not exist
    }
  }

  return [...results.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// Extract entities from text and store them
// Lightweight version: extracts proper nouns, project names, people
export function extractAndStoreEntities(memoryId, text, title = '') {
  const entities = [];
  const combinedText = `${title} ${text}`;

  // Person names - configure via MEMORY_KNOWN_PERSONS env var (comma-separated)
  const knownPersons = (process.env.MEMORY_KNOWN_PERSONS || '').split(',').filter(Boolean);
  const personPatterns = knownPersons.map(name => new RegExp(name, 'g'));
  for (const p of personPatterns) {
    const matches = combinedText.match(p);
    if (matches) {
      entities.push({ name: matches[0], type: 'person' });
    }
  }

  // Project/tool names (English words or Chinese project names)
  const projectPatterns = [
    /Spotify/gi, /Telegram/gi, /Claude/gi, /MAPLE/gi, /LightMem/gi,
    /MCP/gi, /Ollama/gi, /Unsloth/gi, /BGE/gi, /Gemini/gi,
    /记忆系统/g, /和弦日记/g, /文字冒险/g, /存钱罐/g,
  ];
  for (const p of projectPatterns) {
    const matches = combinedText.match(p);
    if (matches) {
      entities.push({ name: matches[0], type: 'project' });
    }
  }

  // Location names
  const locationPatterns = [
    /新加坡/g, /NTU/gi, /南洋理工/g, /墨尔本/g, /澳洲/g,
    /瑞士/g, /中国/g,
  ];
  for (const p of locationPatterns) {
    const matches = combinedText.match(p);
    if (matches) {
      entities.push({ name: matches[0], type: 'location' });
    }
  }

  // Deduplicate
  const seen = new Set();
  const unique = entities.filter(e => {
    const key = `${e.name}:${e.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Store in DB
  const insertEntity = db.prepare(
    "INSERT OR IGNORE INTO entities (name, type, memory_id) VALUES (?, ?, ?)"
  );
  const insertEdge = db.prepare(
    "INSERT OR IGNORE INTO edges (source_entity, target_entity, relation_type, weight, memory_id) VALUES (?, ?, ?, ?, ?)"
  );

  const store = db.transaction(() => {
    for (const e of unique) {
      insertEntity.run(e.name, e.type, memoryId);
    }

    // Create edges between co-occurring entities in the same memory
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        insertEdge.run(
          unique[i].name, unique[j].name,
          'CoOccurs', 1.0, memoryId
        );
      }
    }
  });

  try {
    store();
  } catch (e) {
    // Ignore errors during entity storage
  }

  return unique;
}

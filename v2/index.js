// Memory System v2 — module entry point
// Initializes v2 schema and exports the new search pipeline

import { migrateV2Schema } from "./schema.js";
import { searchV2 } from "./search/pipeline.js";
import { analyzeQuery } from "./search/sentinel.js";
import { tokenize, bm25 } from "./search/bm25.js";
import { rrfFuse } from "./search/rrf.js";
import { extractAndStoreEntities, searchByEntities } from "./search/entity-graph.js";
import { autoTag, searchByMoodTags } from "./search/mood-tags.js";
import { chunkByTopic, shouldChunk } from "./search/chunking.js";
import { rerank } from "./search/rerank.js";
import { callLocalModel, extractMemories, extractLearnings, analyzeQueryWithModel, isModelAvailable } from "./local_model.js";

// Run schema migration on import
migrateV2Schema();

export {
  searchV2,
  analyzeQuery,
  tokenize,
  bm25,
  rrfFuse,
  extractAndStoreEntities,
  searchByEntities,
  autoTag,
  searchByMoodTags,
  chunkByTopic,
  shouldChunk,
  rerank,
  callLocalModel,
  extractMemories,
  extractLearnings,
  analyzeQueryWithModel,
  isModelAvailable,
};

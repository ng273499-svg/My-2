export {
  HIERARCHICAL_VECTOR_DIMENSIONS,
  DeterministicHashedEmbeddingAdapter,
  OpenAIEmbeddingAdapter,
  cosineSimilarityVec,
  type MemoryEmbeddingProvider,
} from './embeddings';
export { WorkingMemoryBuffer, type WorkingMemoryOptions } from './working-memory';
export {
  computeTemporalRetentionScore,
  rankHierarchicalMemories,
  tokenizeMemoryQuery,
  type RankMemoriesInput,
  type RankMemoriesOutput,
} from './decay-and-scoring';
export {
  sanitizeMemoryCandidate,
  extractSubjectValuePair,
  inspectDuplicatesAndContradictions,
  distillConversationSession,
  type SanitizedMemoryCandidate,
  type DistilledSessionCandidate,
  type ConversationDistillationInput,
} from './consolidation';
export {
  HIERARCHICAL_SCOPE_DESCRIPTORS,
  HierarchicalMemoryEngine,
  inferScopeFromCategory,
  type StoreMemoryInput,
  type SessionConsolidationReport,
  type HierarchicalMemoryEngineOptions,
} from './hierarchical-memory-engine';

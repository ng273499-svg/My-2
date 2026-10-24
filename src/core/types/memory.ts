export type MemoryCategory =
  | 'preference'
  | 'fact'
  | 'project_context'
  | 'episodic_summary'
  | 'workflow'
  | 'knowledge_chunk'
  | 'event_record'
  | 'research_summary';

export type HierarchicalMemoryScope =
  | 'working'
  | 'episodic'
  | 'semantic'
  | 'project'
  | 'knowledge'
  | 'procedural'
  | 'event';

export type MemoryLifecycleStatus = 'active' | 'superseded' | 'archived';

export type MemoryProvenance =
  | 'user_explicit'
  | 'operator_manual'
  | 'episodic_consolidation'
  | 'system_seed'
  | 'untrusted_external';

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  memoryScope?: HierarchicalMemoryScope;
  memoryStatus?: MemoryLifecycleStatus;
  projectId?: string | null;
  content: string;
  tags: string[];
  importance: 1 | 2 | 3 | 4 | 5;
  confidence?: number;
  recallCount?: number;
  provenance?: MemoryProvenance;
  supersededById?: string | null;
  sourceConversationId?: string;
  verified: boolean;
  persistenceLayer: 'ephemeral_session' | 'supabase_cloud' | 'degraded_fallback';
  similarity?: number;
  retentionScore?: number;
  compositeScore?: number;
  lastRecalledAt?: string | null;
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface MemoryStatusSummary {
  shortTermTurnCount: number;
  storedEntriesCount: number;
  activeEntriesCount?: number;
  supersededEntriesCount?: number;
  expiredEntriesCount?: number;
  countsByScope?: Record<HierarchicalMemoryScope, number>;
  persistenceMode: 'ephemeral_session' | 'supabase_cloud' | 'degraded_fallback';
  semanticVectorReady: boolean;
  embeddingMode?: 'deterministic_hash_1536' | 'openai_neural_1536';
  isNeuralEmbeddingActive?: boolean;
  statusLabel: string;
}

export interface HierarchicalMemoryQuery {
  query: string;
  projectId?: string | null;
  scopes?: HierarchicalMemoryScope[];
  taskType?: string;
  maxItems?: number;
  maxTokenBudget?: number;
  includeSuperseded?: boolean;
  reinforceRecalled?: boolean;
  nowMs?: number;
}

export interface HierarchicalRetrievalBundle {
  entries: MemoryEntry[];
  formattedSnippets: string[];
  totalTokensEstimated: number;
  countsByScope: Partial<Record<HierarchicalMemoryScope, number>>;
  untrustedItemsQuarantined: number;
  expiredFilteredOut: number;
  supersededFilteredOut: number;
}

export interface ConsolidationOutcome {
  action: 'inserted' | 'deduplicated_reinforced' | 'superseded_previous' | 'skipped_routine';
  entry?: MemoryEntry;
  supersededIds: string[];
  reason: string;
}

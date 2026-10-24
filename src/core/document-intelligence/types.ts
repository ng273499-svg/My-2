/**
 * =============================================================================
 * JARVIS-X v1.2.0 — Grounded Document Intelligence + Hybrid RAG Engine
 * Provider-neutral type contracts for the document pipeline:
 *   DOCUMENT → security validation → extraction → structural parsing →
 *   normalization → chunking → metadata/provenance → indexing → hybrid
 *   retrieval → reranking → context assembly → model reasoning → claim
 *   grounding → citations → verification → answer
 * =============================================================================
 */

/** -------------------------------------------------------------------------
 * 1. Formats & lifecycle
 * ------------------------------------------------------------------------ */

export type SupportedDocumentFormat =
  | 'pdf'
  | 'txt'
  | 'markdown'
  | 'docx'
  | 'csv'
  | 'json'
  | 'code'
  | 'html'
  | 'xml'
  | 'yaml'
  | 'toml';

/** Adapters reserved for a future release. Never claim these work now. */
export type FutureDocumentFormat = 'xlsx' | 'pptx' | 'odt' | 'epub';

export type DocumentLifecycleState =
  | 'INGESTING'
  | 'READY'
  | 'PARTIAL'
  | 'OCR_REQUIRED'
  | 'FAILED'
  | 'REMOVED';

export type ParserCapabilityStatus =
  | 'AVAILABLE'
  | 'PARTIAL'
  | 'NOT_INSTALLED'
  | 'UNSUPPORTED';

export interface ParserCapability {
  format: SupportedDocumentFormat | FutureDocumentFormat;
  status: ParserCapabilityStatus;
  parser: string;
  parserVersion: string;
  notes: string;
  supportsPageProvenance: boolean;
  supportsTables: boolean;
  supportsOcrPath: boolean;
}

export type TrustLevel = 'untrusted_external' | 'user_authorized' | 'system_verified';

/** -------------------------------------------------------------------------
 * 2. Normalized document model
 * ------------------------------------------------------------------------ */

export interface DocumentBlock {
  blockId: string;
  kind: 'heading' | 'paragraph' | 'list' | 'table' | 'code' | 'raw';
  text: string;
  level?: number;
  page?: number;
  order: number;
}

export interface DocumentTable {
  tableId: string;
  page?: number;
  headers: string[];
  rows: string[][];
  truncated: boolean;
}

export interface DocumentSection {
  sectionId: string;
  heading: string | null;
  headingPath: string[];
  level: number;
  startPage?: number;
  endPage?: number;
  blockIds: string[];
}

export interface DocumentProvenance {
  /** Where the document came from. Never a secret. */
  source: 'upload' | 'camera' | 'workspace' | 'url_import';
  originalFileName: string;
  pageCount: number;
  pageProvenanceAvailable: boolean;
  extractedAt: string;
}

export interface NormalizedDocument {
  documentId: string;
  ownerId: string;
  projectId: string | null;
  filename: string;
  mimeType: string;
  format: SupportedDocumentFormat;
  title: string;
  source: DocumentProvenance['source'];
  pageCount: number;
  sections: DocumentSection[];
  blocks: DocumentBlock[];
  tables: DocumentTable[];
  metadata: Record<string, string | number | boolean | null>;
  parser: string;
  parserVersion: string;
  ingestedAt: string;
  contentHash: string;
  trustLevel: TrustLevel;
  provenance: DocumentProvenance;
  lifecycle: DocumentLifecycleState;
  warnings: string[];
  /** True when OCR is required before useful extraction can happen. */
  ocrRequired: boolean;
  injectionFlagged: boolean;
}

/** -------------------------------------------------------------------------
 * 3. Chunking
 * ------------------------------------------------------------------------ */

export interface DocumentChunk {
  chunkId: string;
  documentId: string;
  ownerId: string;
  projectId: string | null;
  /** Nearest structural heading, when detectable. */
  section: string | null;
  headingPath: string[];
  page: number | null;
  pageRange: [number, number] | null;
  text: string;
  charCount: number;
  tokenEstimate: number;
  contentHash: string;
  trustLevel: TrustLevel;
  order: number;
  /** Recency used by retrieval scoring. */
  ingestedAt: string;
}

export interface ChunkingOptions {
  maxChunkChars: number;
  overlapChars: number;
  minChunkChars: number;
}

/** -------------------------------------------------------------------------
 * 4. Embeddings (provider-neutral)
 * ------------------------------------------------------------------------ */

export type EmbeddingMode = 'neural' | 'deterministic_fallback' | 'unavailable';

export interface EmbeddingProvider {
  readonly providerId: string;
  readonly dimensions: number;
  readonly mode: EmbeddingMode;
  /** True only for genuine semantic neural models. */
  readonly isNeuralSemanticModel: boolean;
  isConfigured(): boolean;
  embed(text: string): Promise<number[]>;
}

export interface EmbeddingStatus {
  mode: EmbeddingMode;
  providerId: string;
  dimensions: number;
  honestNote: string;
}

/** -------------------------------------------------------------------------
 * 5. Retrieval
 * ------------------------------------------------------------------------ */

export type QueryIntent =
  | 'factual_lookup'
  | 'summarization'
  | 'comparison'
  | 'extraction'
  | 'explanation'
  | 'cross_document_synthesis'
  | 'table_data'
  | 'code_documentation';

export interface QueryUnderstanding {
  intent: QueryIntent;
  keywords: string[];
  entities: string[];
  wantsComparison: boolean;
  wantsSummary: boolean;
  rationale: string;
}

export interface RetrievalScope {
  ownerId: string;
  projectId?: string | null;
  documentIds?: string[];
  includeAllProjects?: boolean;
}

export interface RetrievalWeights {
  vector: number;
  keyword: number;
  recency: number;
  trust: number;
  metadata: number;
}

export interface ScoredChunk {
  chunk: DocumentChunk;
  vectorScore: number;
  keywordScore: number;
  metadataScore: number;
  recencyScore: number;
  trustScore: number;
  hybridScore: number;
  rerankScore?: number;
}

export interface RetrievalResult {
  query: string;
  understanding: QueryUnderstanding;
  candidates: ScoredChunk[];
  selected: ScoredChunk[];
  rerankingMode: 'deterministic_fallback' | 'provider';
  embeddingStatus: EmbeddingStatus;
  candidateCount: number;
  selectedCount: number;
  diagnostics: string[];
}

/** -------------------------------------------------------------------------
 * 6. Context assembly
 * ------------------------------------------------------------------------ */

export interface AssembledContext {
  /** Untrusted document evidence, clearly delimited. */
  untrustedEvidenceBlock: string;
  citations: Citation[];
  usedChunks: DocumentChunk[];
  tokenEstimate: number;
  budgetTokens: number;
  truncated: boolean;
  duplicatePassagesRemoved: number;
}

/** -------------------------------------------------------------------------
 * 7. Citations
 * ------------------------------------------------------------------------ */

export interface Citation {
  citationId: string;
  documentId: string;
  documentTitle: string;
  chunkId: string;
  page: number | null;
  pageRange: [number, number] | null;
  section: string | null;
  headingPath: string[];
  /** Human-readable location derived from verified provenance only. */
  locationLabel: string;
}

/** -------------------------------------------------------------------------
 * 8. Grounding & claims
 * ------------------------------------------------------------------------ */

export type GroundingStatus =
  | 'SUPPORTED'
  | 'PARTIALLY_SUPPORTED'
  | 'NOT_SUPPORTED'
  | 'CONFLICTING_EVIDENCE';

export interface ClaimEvidenceLink {
  claim: string;
  supportingChunkIds: string[];
  citationIds: string[];
  confidence: number;
}

export interface ClaimVerificationResult {
  claims: ClaimEvidenceLink[];
  unsupportedClaims: string[];
  supportedCount: number;
  totalClaims: number;
  status: GroundingStatus;
  summary: string;
}

export interface GroundedAnswer {
  answer: string;
  status: GroundingStatus;
  citations: Citation[];
  verification: ClaimVerificationResult;
  conflicts: DetectedConflict[];
  warnings: string[];
  usedDocumentIds: string[];
  /** True when JARVIS declines due to insufficient evidence. */
  insufficientEvidence: boolean;
}

/** -------------------------------------------------------------------------
 * 9. Conflict detection
 * ------------------------------------------------------------------------ */

export interface DetectedConflict {
  topic: string;
  positions: Array<{
    statement: string;
    documentId: string;
    documentTitle: string;
    chunkId: string;
    citationId: string;
  }>;
  explanation: string;
  freshnessNote: string;
}

/** -------------------------------------------------------------------------
 * 10. Summarization
 * ------------------------------------------------------------------------ */

export type SummaryKind =
  | 'quick'
  | 'detailed'
  | 'section'
  | 'key_points'
  | 'action_items'
  | 'technical'
  | 'compare';

export interface SummaryResult {
  kind: SummaryKind;
  summary: string;
  usedChunkIds: string[];
  citations: Citation[];
  stages: number;
  bounded: boolean;
  truncated: boolean;
}

/** -------------------------------------------------------------------------
 * 11. Security gate
 * ------------------------------------------------------------------------ */

export interface DocumentSecurityVerdict {
  allowed: boolean;
  rejectionReason: string | null;
  checks: Array<{ check: string; passed: boolean; detail: string }>;
  detectedFormat: SupportedDocumentFormat | null;
  declaredFormat: SupportedDocumentFormat | null;
  mimeMismatch: boolean;
  archiveRisk: boolean;
  sizeBytes: number;
  maxAllowedBytes: number;
}

export interface DocumentSecurityLimits {
  maxBytes: number;
  maxPages: number;
  maxChunks: number;
  maxExtractedChars: number;
  allowedExtensions: string[];
}

/** -------------------------------------------------------------------------
 * 12. Ingestion & query results
 * ------------------------------------------------------------------------ */

export interface IngestionResult {
  ok: boolean;
  documentId: string | null;
  lifecycle: DocumentLifecycleState;
  format: SupportedDocumentFormat | null;
  pageCount: number;
  chunkCount: number;
  contentHash: string | null;
  embeddingStatus: EmbeddingStatus;
  duplicateOf: string | null;
  revisedFrom: string | null;
  ocrRequired: boolean;
  warnings: string[];
  errors: string[];
  durationMs: number;
  parser: string | null;
}

export interface DocumentQueryResult {
  ok: boolean;
  answer: GroundedAnswer | null;
  retrieval: RetrievalResult | null;
  errors: string[];
  durationMs: number;
}

/** -------------------------------------------------------------------------
 * 13. Observability
 * ------------------------------------------------------------------------ */

export interface DocumentObservabilityEvent {
  eventId: string;
  timestamp: string;
  documentId: string | null;
  phase:
    | 'security_validation'
    | 'extraction'
    | 'structuring'
    | 'chunking'
    | 'indexing'
    | 'retrieval'
    | 'reranking'
    | 'citation_verification'
    | 'answer_ready'
    | 'removed'
    | 'failed';
  parser: string | null;
  chunkCount: number;
  candidateCount: number;
  selectedCount: number;
  rerankingMode: string | null;
  citationCount: number;
  verificationStatus: string | null;
  durationMs: number;
  errors: string[];
}

/** -------------------------------------------------------------------------
 * 14. Deletion / lifecycle record
 * ------------------------------------------------------------------------ */

export interface DocumentRemovalResult {
  ok: boolean;
  documentId: string;
  chunksRevoked: number;
  memoryEntriesRevoked: number;
  auditRetained: boolean;
  error?: string;
}

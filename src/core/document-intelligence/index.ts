/**
 * JARVIS-X v1.2.0 — Grounded Document Intelligence + Hybrid RAG Engine
 *
 * Orchestrates the full pipeline:
 *
 *   DOCUMENT
 *     → security validation
 *     → extraction
 *     → structural parsing
 *     → normalization
 *     → chunking
 *     → metadata / provenance
 *     → indexing
 *     → hybrid retrieval
 *     → reranking
 *     → context assembly
 *     → grounded reasoning
 *     → claim grounding
 *     → citations
 *     → verification
 *     → answer
 *
 * The engine never pretends it read content that was not successfully
 * extracted. Every failure path is explicit and user-visible.
 */

import crypto from 'crypto';
import type {
  DocumentChunk,
  DocumentObservabilityEvent,
  DocumentQueryResult,
  IngestionResult,
  NormalizedDocument,
  RetrievalResult,
  RetrievalScope,
  SummaryKind,
  SummaryResult,
  SupportedDocumentFormat,
  GroundedAnswer,
  Citation,
} from './types';
import { DocumentSecurityGate, formatFromExtension } from './security-gate';
import { ParserRegistry } from './parsers';
import { chunkDocument, deriveSections, hashContent } from './chunking';
import { DocumentEmbeddingService } from './embeddings';
import { DocumentIndex, HybridRetriever } from './retrieval';
import { RerankingService } from './reranking';
import { ContextAssembler } from './context-assembly';
import { GroundedAnswerer } from './grounding';
import { SummarizationEngine } from './summarization';
import { DocumentStore, hashBytes } from './document-store';
import { DocumentInjectionDefense } from './injection-defense';
import { buildCitations } from './citations';

export const DOCUMENT_ENGINE_VERSION = '1.2.0';

export interface KnowledgeChunkPayload {
  id: string;
  text: string;
  sourceLabel?: string;
  projectId?: string | null;
  contentHash?: string;
  tokenEstimate?: number;
}

/**
 * Per-call knowledge sink. It is supplied by the *caller* (the API route) which
 * is bound to a single request-scoped, actor-scoped runtime — so document
 * evidence can never be written into another tenant's memory repository.
 */
export type MemoryIngestSink = (
  ownerId: string,
  chunk: KnowledgeChunkPayload,
  meta: { sourceLabel: string; projectId: string | null; tags: string[] }
) => Promise<{ entryId?: string } | unknown> | { entryId?: string } | unknown;

export interface DocumentEngineOptions {
  workspaceRoot?: string;
  embeddingService?: DocumentEmbeddingService;
  nowIso?: () => string;
}

export interface IngestInput {
  ownerId: string;
  fileName: string;
  mimeType: string;
  bytes?: Uint8Array;
  textContent?: string;
  projectId?: string | null;
  source?: NormalizedDocument['source'];
  /** Owner-supplied title override. Never trusted as authority. */
  titleHint?: string | null;
  /** Per-request, actor-bound knowledge sink (see MemoryIngestSink). */
  memorySink?: MemoryIngestSink;
  /** Optional cooperative cancellation, checked between pipeline phases. */
  signal?: AbortSignal;
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

export class DocumentIntelligenceEngine {
  readonly securityGate: DocumentSecurityGate;
  readonly parsers: ParserRegistry;
  readonly embeddings: DocumentEmbeddingService;
  readonly index: DocumentIndex;
  readonly retriever: HybridRetriever;
  readonly reranking: RerankingService;
  readonly assembler: ContextAssembler;
  readonly answerer: GroundedAnswerer;
  readonly summarizer: SummarizationEngine;
  readonly store: DocumentStore;
  readonly injectionDefense: DocumentInjectionDefense;

  private readonly nowIso: () => string;
  private readonly observability: DocumentObservabilityEvent[] = [];
  private readonly memoryEntryIds = new Map<string, string[]>();

  constructor(options: DocumentEngineOptions = {}) {
    this.securityGate = new DocumentSecurityGate();
    this.parsers = new ParserRegistry();
    this.embeddings = options.embeddingService ?? new DocumentEmbeddingService();
    this.index = new DocumentIndex(this.embeddings);
    this.retriever = new HybridRetriever(this.index);
    this.reranking = new RerankingService();
    this.assembler = new ContextAssembler();
    this.answerer = new GroundedAnswerer();
    this.summarizer = new SummarizationEngine();
    this.store = new DocumentStore();
    this.injectionDefense = new DocumentInjectionDefense();
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  /* ---------------------------------------------------------------------
   * Observability
   * ------------------------------------------------------------------- */

  private record(event: Omit<DocumentObservabilityEvent, 'eventId' | 'timestamp'>): void {
    this.observability.push({
      eventId: newId('evt'),
      timestamp: this.nowIso(),
      ...event,
    });
    // Bounded buffer — observability must never grow without limit.
    if (this.observability.length > 500) {
      this.observability.splice(0, this.observability.length - 500);
    }
  }

  /** Redacted observability snapshot. No document text or secrets. */
  observabilityEvents(): DocumentObservabilityEvent[] {
    return this.observability.map((e) => ({ ...e }));
  }

  parserCapabilities() {
    return this.parsers.capabilities();
  }

  embeddingStatus() {
    return this.embeddings.status();
  }

  /* ---------------------------------------------------------------------
   * Ingestion pipeline
   * ------------------------------------------------------------------- */

  async ingest(input: IngestInput): Promise<IngestionResult> {
    const startedAt = Date.now();
    const warnings: string[] = [];
    const errors: string[] = [];
    const embeddingStatus = this.embeddings.status();

    const fail = (
      lifecycle: IngestionResult['lifecycle'],
      message: string,
      extra?: Partial<IngestionResult>
    ): IngestionResult => {
      errors.push(message);
      this.record({
        documentId: null,
        phase: 'failed',
        parser: null,
        chunkCount: 0,
        candidateCount: 0,
        selectedCount: 0,
        rerankingMode: null,
        citationCount: 0,
        verificationStatus: null,
        durationMs: Date.now() - startedAt,
        errors: [message],
      });
      return {
        ok: false,
        documentId: null,
        lifecycle,
        format: null,
        pageCount: 0,
        chunkCount: 0,
        contentHash: null,
        embeddingStatus,
        duplicateOf: null,
        revisedFrom: null,
        ocrRequired: false,
        warnings,
        errors,
        durationMs: Date.now() - startedAt,
        parser: null,
        ...extra,
      };
    };

    // ---- 0. Input sanity ------------------------------------------------
    if (!input.ownerId || typeof input.ownerId !== 'string') {
      return fail('FAILED', 'Owner identity could not be resolved server-side.');
    }
    if (!input.fileName || typeof input.fileName !== 'string') {
      return fail('FAILED', 'A file name is required for ingestion.');
    }
    if (!input.bytes && !input.textContent) {
      return fail('FAILED', 'No document content was supplied.');
    }

    // ---- 1. Security validation -----------------------------------------
    const verdict = this.securityGate.validate({
      fileName: input.fileName,
      mimeType: input.mimeType ?? 'application/octet-stream',
      bytes: input.bytes,
      textCharCount: input.textContent?.length,
    });

    this.record({
      documentId: null,
      phase: 'security_validation',
      parser: null,
      chunkCount: 0,
      candidateCount: 0,
      selectedCount: 0,
      rerankingMode: null,
      citationCount: 0,
      verificationStatus: verdict.allowed ? 'allowed' : 'rejected',
      durationMs: Date.now() - startedAt,
      errors: verdict.allowed ? [] : [verdict.rejectionReason ?? 'Rejected by security gate.'],
    });

    if (!verdict.allowed) {
      return fail('FAILED', verdict.rejectionReason ?? 'Document rejected by the security gate.');
    }
    if (verdict.mimeMismatch) {
      warnings.push(
        'Declared MIME type did not match the file extension; the extension allow-list and magic bytes were used instead.'
      );
    }

    const cancelled = (): boolean => Boolean(input.signal?.aborted);

    if (cancelled()) {
      return fail('FAILED', 'Document ingestion was cancelled before parsing.');
    }

    // ---- 2. Format resolution ------------------------------------------
    const format: SupportedDocumentFormat =
      verdict.detectedFormat ?? (formatFromExtension(input.fileName) as SupportedDocumentFormat);

    if (!format) {
      return fail('FAILED', `Unsupported document format for "${input.fileName}".`);
    }

    // ---- 3. Content hash (duplicate / revision detection) ---------------
    const contentHash = input.bytes
      ? hashBytes(input.bytes)
      : hashContent(input.textContent ?? '');

    const existing = this.store.findByContentHash(input.ownerId, contentHash);
    if (existing) {
      this.record({
        documentId: existing.document.documentId,
        phase: 'extraction',
        parser: existing.document.parser,
        chunkCount: existing.chunks.length,
        candidateCount: 0,
        selectedCount: 0,
        rerankingMode: null,
        citationCount: 0,
        verificationStatus: 'duplicate_detected',
        durationMs: Date.now() - startedAt,
        errors: [],
      });

      return {
        ok: true,
        documentId: existing.document.documentId,
        lifecycle: existing.lifecycle,
        format: existing.document.format,
        pageCount: existing.document.pageCount,
        chunkCount: existing.chunks.length,
        contentHash,
        embeddingStatus,
        duplicateOf: existing.document.documentId,
        revisedFrom: null,
        ocrRequired: existing.document.ocrRequired,
        warnings: [
          `Identical content is already ingested as "${existing.document.filename}" (${existing.document.documentId}). No duplicate copy was created.`,
        ],
        errors,
        durationMs: Date.now() - startedAt,
        parser: existing.document.parser,
      };
    }

    if (cancelled()) {
      return fail('FAILED', 'Document ingestion was cancelled before extraction.');
    }

    // ---- 4. Extraction --------------------------------------------------
    const extraction = await this.parsers.extract(format, {
      bytes: input.bytes,
      textContent: input.textContent,
      fileName: input.fileName,
      mimeType: input.mimeType,
    });

    if (!extraction.ok) {
      const capability = this.parsers.capabilities().find((c) => c.format === format);
      const notInstalled = capability?.status === 'NOT_INSTALLED';
      return fail(
        'FAILED',
        extraction.parserError ??
          `Extraction failed for ${format}. ${notInstalled ? 'No parser is installed for this format.' : ''}`.trim()
      );
    }

    warnings.push(...extraction.warnings);

    // Ensure we never claim content we did not extract.
    const totalChars = extraction.blocks.reduce((sum, b) => sum + b.text.trim().length, 0);
    if (totalChars === 0) {
      if (extraction.ocrRequired) {
        return fail(
          'OCR_REQUIRED',
          'No machine-readable text could be extracted. This document appears to be scanned imagery; OCR is required and its contents will not be inferred.',
          {
            format,
            pageCount: extraction.pageCount,
            ocrRequired: true,
            contentHash,
            parser: extraction.parser,
          }
        );
      }
      return fail('FAILED', 'Extraction produced no readable text.', {
        format,
        pageCount: extraction.pageCount,
        contentHash,
        parser: extraction.parser,
      });
    }

    this.record({
      documentId: null,
      phase: 'extraction',
      parser: extraction.parser,
      chunkCount: 0,
      candidateCount: 0,
      selectedCount: 0,
      rerankingMode: null,
      citationCount: 0,
      verificationStatus: extraction.ocrRequired ? 'ocr_required' : 'extracted',
      durationMs: Date.now() - startedAt,
      errors: [],
    });

    // ---- 5. Injection scan (content preserved, authority removed) -------
    const injection = this.injectionDefense.scanBlocks(extraction.blocks.map((b) => b.text));
    if (injection.flagged) {
      warnings.push(
        `Document content contains directive-like text (${injection.detectedPatterns.join(', ')}). ` +
          'It was preserved as untrusted content only and has no authority over JARVIS-X.'
      );
    }

    // ---- 6. Normalization ------------------------------------------------
    const documentId = newId('doc');
    const ingestedAt = this.nowIso();

    const document: NormalizedDocument = {
      documentId,
      ownerId: input.ownerId,
      projectId: input.projectId ?? null,
      filename: input.fileName,
      mimeType: input.mimeType,
      format,
      title: input.titleHint?.trim() || extraction.title || input.fileName,
      source: input.source ?? 'upload',
      pageCount: extraction.pageCount,
      sections: [],
      blocks: extraction.blocks,
      tables: extraction.tables,
      metadata: extraction.metadata,
      parser: extraction.parser,
      parserVersion: extraction.parserVersion,
      ingestedAt,
      contentHash,
      trustLevel: 'untrusted_external',
      provenance: {
        source: input.source ?? 'upload',
        originalFileName: input.fileName,
        pageCount: extraction.pageCount,
        pageProvenanceAvailable: extraction.pageProvenanceAvailable,
        extractedAt: ingestedAt,
      },
      lifecycle: extraction.ocrRequired ? 'OCR_REQUIRED' : 'INGESTING',
      warnings: [...new Set(warnings)],
      ocrRequired: extraction.ocrRequired,
      injectionFlagged: injection.flagged,
    };

    this.record({
      documentId,
      phase: 'structuring',
      parser: extraction.parser,
      chunkCount: 0,
      candidateCount: 0,
      selectedCount: 0,
      rerankingMode: null,
      citationCount: 0,
      verificationStatus: 'normalized',
      durationMs: Date.now() - startedAt,
      errors: [],
    });

    if (cancelled()) {
      return fail('FAILED', 'Document ingestion was cancelled after normalization; nothing was indexed.');
    }

    // ---- 7. Chunking -----------------------------------------------------
    // Populate the section map from actual structure before chunking.
    const derived = deriveSections(extraction.blocks);
    document.sections = derived.sections;

    const { chunks, duplicatesRemoved } = chunkDocument(document);

    if (duplicatesRemoved > 0) {
      warnings.push(`${duplicatesRemoved} duplicate passage(s) were collapsed during chunking.`);
    }

    if (chunks.length === 0) {
      return fail('PARTIAL', 'Document structure was read but no indexable chunks were produced.', {
        format,
        pageCount: extraction.pageCount,
        contentHash,
        parser: extraction.parser,
      });
    }

    this.record({
      documentId,
      phase: 'chunking',
      parser: extraction.parser,
      chunkCount: chunks.length,
      candidateCount: 0,
      selectedCount: 0,
      rerankingMode: null,
      citationCount: 0,
      verificationStatus: 'chunked',
      durationMs: Date.now() - startedAt,
      errors: [],
    });

    // ---- 8. Indexing ------------------------------------------------------
    await this.index.addChunks(chunks);

    this.record({
      documentId,
      phase: 'indexing',
      parser: extraction.parser,
      chunkCount: chunks.length,
      candidateCount: 0,
      selectedCount: 0,
      rerankingMode: this.reranking.mode,
      citationCount: 0,
      verificationStatus: 'indexed',
      durationMs: Date.now() - startedAt,
      errors: [],
    });

    // ---- 9. Hierarchical memory integration (knowledge scope) ------------
    let memoryEntries = 0;
    if (input.memorySink) {
      const entryIds: string[] = [];
      for (const chunk of chunks.slice(0, 40)) {
        try {
          const outcome = await input.memorySink(
            input.ownerId,
            {
              id: chunk.chunkId,
              text: chunk.text,
              sourceLabel: `${document.title} (${chunk.section ?? 'document body'})`,
              projectId: document.projectId,
              contentHash: chunk.contentHash,
              tokenEstimate: chunk.tokenEstimate,
            },
            {
              sourceLabel: `${document.title} — ${chunk.section ?? 'document body'}`,
              projectId: document.projectId,
              // Evidence is tagged as document evidence, never as a personal fact.
              tags: ['document_evidence', 'unverified', format, `doc:${documentId}`],
            }
          );
          const entryId =
            outcome && typeof outcome === 'object' && 'entryId' in outcome
              ? (outcome as { entryId?: string }).entryId
              : undefined;
          // Only real memory entry IDs are recorded, so deletion can revoke them.
          if (entryId) entryIds.push(entryId);
          memoryEntries += 1;
        } catch {
          warnings.push('Some document chunks could not be mirrored into knowledge memory.');
          break;
        }
      }
      if (entryIds.length > 0) {
        this.memoryEntryIds.set(documentId, entryIds);
      }
    }

    // ---- 10. Lifecycle finalization --------------------------------------
    // PARTIAL means extraction genuinely covered only part of the document —
    // not merely "some warning was emitted".
    const pagesWithText = new Set(
      extraction.blocks
        .map((b) => b.page)
        .filter((p): p is number => typeof p === 'number' && p > 0)
    );
    const extractionPartial =
      format === 'pdf' &&
      extraction.pageCount > 0 &&
      pagesWithText.size > 0 &&
      pagesWithText.size < extraction.pageCount;

    if (extractionPartial) {
      warnings.push(
        `Only ${pagesWithText.size} of ${extraction.pageCount} page(s) yielded machine-readable text. ` +
          'The remaining pages were NOT read and will not be inferred.'
      );
    }

    const lifecycle: NormalizedDocument['lifecycle'] = extraction.ocrRequired
      ? 'OCR_REQUIRED'
      : extractionPartial
        ? 'PARTIAL'
        : 'READY';

    document.lifecycle = lifecycle;
    document.warnings = [...new Set(warnings)];
    const record = this.store.put(document, chunks);
    record.lifecycle = lifecycle;

    this.record({
      documentId,
      phase: 'answer_ready',
      parser: extraction.parser,
      chunkCount: chunks.length,
      candidateCount: 0,
      selectedCount: 0,
      rerankingMode: this.reranking.mode,
      citationCount: 0,
      verificationStatus: lifecycle.toLowerCase(),
      durationMs: Date.now() - startedAt,
      errors: [],
    });

    if (lifecycle === 'OCR_REQUIRED') {
      warnings.push(
        'OCR is required for at least part of this document. JARVIS-X will not fabricate the unreadable pages.'
      );
    }

    return {
      ok: true,
      documentId,
      lifecycle,
      format,
      pageCount: extraction.pageCount,
      chunkCount: chunks.length,
      contentHash,
      embeddingStatus,
      duplicateOf: null,
      revisedFrom: null,
      ocrRequired: extraction.ocrRequired,
      warnings: [...new Set(warnings)],
      errors,
      durationMs: Date.now() - startedAt,
      parser: extraction.parser,
    };
  }

  /* ---------------------------------------------------------------------
   * Document access
   * ------------------------------------------------------------------- */

  getDocument(ownerId: string, documentId: string) {
    const record = this.store.get(ownerId, documentId);
    if (!record) return null;
    return {
      documentId: record.document.documentId,
      filename: record.document.filename,
      title: record.document.title,
      format: record.document.format,
      mimeType: record.document.mimeType,
      projectId: record.document.projectId,
      lifecycle: record.lifecycle,
      pageCount: record.document.pageCount,
      chunkCount: record.chunks.length,
      parser: record.document.parser,
      parserVersion: record.document.parserVersion,
      pageProvenanceAvailable: record.document.provenance.pageProvenanceAvailable,
      ocrRequired: record.document.ocrRequired,
      injectionFlagged: record.document.injectionFlagged,
      embeddingStatus: this.embeddings.status(),
      indexingStatus: this.index.hasDocument(ownerId, documentId) ? 'indexed' : 'not_indexed',
      trustLevel: record.document.trustLevel,
      contentHash: record.document.contentHash,
      ingestedAt: record.document.ingestedAt,
      updatedAt: record.updatedAt,
      warnings: record.document.warnings,
      metadata: record.document.metadata,
    };
  }

  listDocuments(ownerId: string, options?: { projectId?: string | null }) {
    return this.store.list(ownerId, options).map((record) => ({
      documentId: record.document.documentId,
      filename: record.document.filename,
      title: record.document.title,
      format: record.document.format,
      projectId: record.document.projectId,
      lifecycle: record.lifecycle,
      pageCount: record.document.pageCount,
      chunkCount: record.chunks.length,
      parser: record.document.parser,
      ocrRequired: record.document.ocrRequired,
      embeddingMode: this.embeddings.status().mode,
      ingestedAt: record.document.ingestedAt,
      updatedAt: record.updatedAt,
    }));
  }

  /* ---------------------------------------------------------------------
   * Query pipeline
   * ------------------------------------------------------------------- */

  async query(params: {
    ownerId: string;
    query: string;
    projectId?: string | null;
    documentIds?: string[];
    includeAllProjects?: boolean;
    topK?: number;
    budgetTokens?: number;
    signal?: AbortSignal;
  }): Promise<DocumentQueryResult> {
    const startedAt = Date.now();
    const errors: string[] = [];

    if (params.signal?.aborted) {
      return {
        ok: false,
        answer: null,
        retrieval: null,
        errors: ['Document query was cancelled before retrieval.'],
        durationMs: Date.now() - startedAt,
      };
    }

    if (!params.ownerId) {
      return {
        ok: false,
        answer: null,
        retrieval: null,
        errors: ['Owner identity could not be resolved server-side.'],
        durationMs: Date.now() - startedAt,
      };
    }
    if (!params.query || params.query.trim().length === 0) {
      return {
        ok: false,
        answer: null,
        retrieval: null,
        errors: ['A query is required.'],
        durationMs: Date.now() - startedAt,
      };
    }

    const scope: RetrievalScope = {
      ownerId: params.ownerId,
      projectId: params.projectId ?? null,
      documentIds: params.documentIds,
      includeAllProjects: params.includeAllProjects ?? false,
    };

    const retrieved = await this.retriever.retrieve(params.query, scope, {
      candidateLimit: 40,
    });

    if (params.signal?.aborted) {
      return {
        ok: false,
        answer: null,
        retrieval: null,
        errors: ['Document query was cancelled after retrieval; no answer was produced.'],
        durationMs: Date.now() - startedAt,
      };
    }

    this.record({
      documentId: null,
      phase: 'retrieval',
      parser: null,
      chunkCount: 0,
      candidateCount: retrieved.candidateCount,
      selectedCount: 0,
      rerankingMode: null,
      citationCount: 0,
      verificationStatus: null,
      durationMs: Date.now() - startedAt,
      errors: [],
    });

    const { selected, removedDuplicates } = await this.reranking.rerank(
      retrieved.scored,
      params.query,
      retrieved.understanding
    );

    this.record({
      documentId: null,
      phase: 'reranking',
      parser: null,
      chunkCount: 0,
      candidateCount: retrieved.candidateCount,
      selectedCount: selected.length,
      rerankingMode: this.reranking.mode,
      citationCount: 0,
      verificationStatus: null,
      durationMs: Date.now() - startedAt,
      errors: [],
    });

    const diagnostics = [...retrieved.diagnostics];
    if (removedDuplicates > 0) {
      diagnostics.push(`${removedDuplicates} duplicate candidate(s) removed before reranking.`);
    }
    if (this.reranking.mode === 'deterministic_fallback') {
      diagnostics.push(
        'Reranking uses the deterministic zero-cost scorer (no advanced reranker configured).'
      );
    }

    const topK = params.topK ?? 8;
    const retrievalResult: RetrievalResult = {
      query: params.query,
      understanding: retrieved.understanding,
      candidates: retrieved.scored,
      selected: selected.slice(0, topK),
      rerankingMode: this.reranking.mode,
      embeddingStatus: retrieved.embeddingStatus,
      candidateCount: retrieved.candidateCount,
      selectedCount: Math.min(topK, selected.length),
      diagnostics,
    };

    const titles = new Map<string, string>();
    for (const scored of retrievalResult.selected) {
      const record = this.store.get(params.ownerId, scored.chunk.documentId);
      if (record) titles.set(scored.chunk.documentId, record.document.title);
    }

    const { answer } = this.answerer.answer(params.query, retrievalResult, {
      budgetTokens: params.budgetTokens,
      maxChunks: topK,
      titlesByDocumentId: titles,
    });

    this.record({
      documentId: null,
      phase: 'citation_verification',
      parser: null,
      chunkCount: 0,
      candidateCount: retrieved.candidateCount,
      selectedCount: retrievalResult.selectedCount,
      rerankingMode: this.reranking.mode,
      citationCount: answer.citations.length,
      verificationStatus: answer.status,
      durationMs: Date.now() - startedAt,
      errors,
    });

    return {
      ok: true,
      answer,
      retrieval: retrievalResult,
      errors,
      durationMs: Date.now() - startedAt,
    };
  }

  /* ---------------------------------------------------------------------
   * Summarization
   * ------------------------------------------------------------------- */

  summarize(params: {
    ownerId: string;
    documentIds: string[];
    kind: SummaryKind;
  }): { ok: boolean; summary: SummaryResult | null; errors: string[] } {
    const errors: string[] = [];
    const chunks: DocumentChunk[] = [];
    const titles = new Map<string, string>();

    for (const documentId of params.documentIds) {
      const record = this.store.get(params.ownerId, documentId);
      if (!record) {
        errors.push(`Document ${documentId} is not available for this owner.`);
        continue;
      }
      titles.set(documentId, record.document.title);
      chunks.push(...record.chunks);
    }

    if (chunks.length === 0) {
      return {
        ok: false,
        summary: null,
        errors: errors.length > 0 ? errors : ['No authorized document chunks were available.'],
      };
    }

    chunks.sort((a, b) => a.order - b.order);
    const summary = this.summarizer.summarize(chunks, params.kind, titles);
    return { ok: true, summary, errors };
  }

  /* ---------------------------------------------------------------------
   * Deletion
   * ------------------------------------------------------------------- */

  async removeDocument(
    ownerId: string,
    documentId: string,
    options?: { memoryRevoker?: (memoryEntryId: string) => Promise<boolean> | boolean }
  ) {
    const record = this.store.get(ownerId, documentId);
    if (!record) {
      return {
        ok: false,
        documentId,
        chunksRevoked: 0,
        memoryEntriesRevoked: 0,
        auditRetained: false,
        error: 'Document not found for this owner.',
      };
    }

    const chunkCountBefore = record.chunks.length;
    const memoryIds = this.memoryEntryIds.get(documentId) ?? [];

    // Revoke mirrored knowledge-memory entries when a revoker is available.
    let memoryEntriesRevoked = 0;
    if (options?.memoryRevoker) {
      for (const entryId of memoryIds) {
        try {
          const revoked = await options.memoryRevoker(entryId);
          if (revoked) memoryEntriesRevoked += 1;
        } catch {
          // Bounded: a failing revoker must not resurrect retrievable chunks.
        }
      }
    }

    const result = this.store.remove(
      ownerId,
      documentId,
      () => this.index.removeDocument(ownerId, documentId),
      () => memoryEntriesRevoked
    );

    this.memoryEntryIds.delete(documentId);

    this.record({
      documentId,
      phase: 'removed',
      parser: record.document.parser,
      chunkCount: chunkCountBefore,
      candidateCount: 0,
      selectedCount: 0,
      rerankingMode: null,
      citationCount: 0,
      verificationStatus: 'removed',
      durationMs: 0,
      errors: [],
    });

    return result;
  }

  /** Chunks currently retrievable for an owner (test/diagnostic helper). */
  retrievableChunkCount(ownerId: string, documentId?: string): number {
    return this.index.countChunks(ownerId, documentId);
  }

  /** Citation list for a document (used by the HUD and tests). */
  documentCitations(ownerId: string, documentId: string): Citation[] {
    const record = this.store.get(ownerId, documentId);
    if (!record) return [];
    const titles = new Map([[documentId, record.document.title]]);
    return buildCitations(record.chunks.slice(0, 12), titles);
  }
}

export { DocumentIntelligenceEngine as JarvisDocumentEngine };

export * from './types';
export { DocumentSecurityGate, DEFAULT_SECURITY_LIMITS } from './security-gate';
export { ParserRegistry } from './parsers';
export { chunkDocument, DEFAULT_CHUNKING_OPTIONS, estimateTokens } from './chunking';
export { DocumentEmbeddingService } from './embeddings';
export { DocumentIndex, HybridRetriever } from './retrieval';
export { RerankingService, DeterministicReranker } from './reranking';
export { ContextAssembler, DEFAULT_CONTEXT_BUDGET_TOKENS } from './context-assembly';
export { GroundedAnswerer } from './grounding';
export { SummarizationEngine } from './summarization';
export { DocumentStore } from './document-store';
export { DocumentInjectionDefense } from './injection-defense';
export { understandQuery } from './query-understanding';
export { ClaimVerifier, ConflictDetector } from './verification';

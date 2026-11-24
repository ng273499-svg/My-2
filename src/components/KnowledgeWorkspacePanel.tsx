'use client';

import React, { useCallback, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  FileText,
  Layers,
  Loader2,
  Quote,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';

/**
 * JARVIS-X v1.2.0 — Knowledge / Documents Workspace
 *
 * Mobile-first grounded document intelligence HUD.
 *
 * Shows operational status only:
 *   filename · format · ingestion state · page count · parser · indexing state ·
 *   embedding mode · project · last updated · re-ingest / remove ·
 *   query interface · citations.
 *
 * Never renders private chain-of-thought, internal prompts, or model reasoning
 * traces. Document content is displayed strictly as quoted evidence.
 */

export type DocumentLifecycle =
  | 'INGESTING'
  | 'READY'
  | 'PARTIAL'
  | 'OCR_REQUIRED'
  | 'FAILED'
  | 'REMOVED';

export type KnowledgePhase =
  | 'idle'
  | 'reading_document'
  | 'parsing_pages'
  | 'structuring_content'
  | 'creating_chunks'
  | 'indexing_knowledge'
  | 'retrieving_evidence'
  | 'reranking'
  | 'verifying_citations'
  | 'grounded_answer_ready'
  | 'ocr_required'
  | 'extraction_failed';

export interface KnowledgeDocument {
  documentId: string;
  filename: string;
  title?: string;
  format?: string | null;
  lifecycle: DocumentLifecycle | string;
  pageCount?: number;
  chunkCount?: number;
  parser?: string | null;
  indexingStatus?: string;
  embeddingMode?: string;
  projectId?: string | null;
  ingestedAt?: string;
  updatedAt?: string;
  ocrRequired?: boolean;
  warnings?: string[];
}

export interface KnowledgeCitation {
  citationId: string;
  documentId: string;
  documentTitle: string;
  chunkId: string;
  page: number | null;
  pageRange: [number, number] | null;
  section: string | null;
  headingPath: string[];
  locationLabel: string;
}

export interface KnowledgeAnswer {
  text: string;
  status: 'SUPPORTED' | 'PARTIALLY_SUPPORTED' | 'NOT_SUPPORTED' | 'CONFLICTING_EVIDENCE';
  insufficientEvidence: boolean;
  warnings: string[];
}

export interface KnowledgeQueryResult {
  answer: KnowledgeAnswer;
  citations: KnowledgeCitation[];
  verification?: {
    status: string;
    summary: string;
    supportedCount: number;
    totalClaims: number;
    unsupportedClaimCount: number;
  };
  retrieval?: {
    intent: string;
    candidateCount: number;
    selectedCount: number;
    rerankingMode: string;
    embeddingMode: string;
    embeddingHonestNote: string;
    diagnostics: string[];
  };
}

const PHASE_LABELS: Record<KnowledgePhase, string> = {
  idle: 'Idle — no document operation running',
  reading_document: 'Reading document',
  parsing_pages: 'Parsing pages',
  structuring_content: 'Structuring content',
  creating_chunks: 'Creating chunks',
  indexing_knowledge: 'Indexing knowledge',
  retrieving_evidence: 'Retrieving evidence',
  reranking: 'Reranking',
  verifying_citations: 'Verifying citations',
  grounded_answer_ready: 'Grounded answer ready',
  ocr_required: 'OCR required',
  extraction_failed: 'Extraction failed',
};

const LIFECYCLE_STYLES: Record<string, { className: string; label: string }> = {
  READY: { className: 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200', label: 'Ready' },
  PARTIAL: { className: 'border-amber-400/40 bg-amber-500/10 text-amber-200', label: 'Partial' },
  OCR_REQUIRED: { className: 'border-orange-400/40 bg-orange-500/10 text-orange-200', label: 'OCR required' },
  INGESTING: { className: 'border-cyan-400/40 bg-cyan-500/10 text-cyan-200', label: 'Ingesting' },
  FAILED: { className: 'border-rose-400/40 bg-rose-500/10 text-rose-200', label: 'Failed' },
  REMOVED: { className: 'border-slate-500/40 bg-slate-600/10 text-slate-300', label: 'Removed' },
};

const GROUNDING_STYLES: Record<string, string> = {
  SUPPORTED: 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200',
  PARTIALLY_SUPPORTED: 'border-amber-400/40 bg-amber-500/10 text-amber-200',
  NOT_SUPPORTED: 'border-rose-400/40 bg-rose-500/10 text-rose-200',
  CONFLICTING_EVIDENCE: 'border-violet-400/40 bg-violet-500/10 text-violet-200',
};

const GROUNDING_LABELS: Record<string, string> = {
  SUPPORTED: 'Supported by documents',
  PARTIALLY_SUPPORTED: 'Partially supported',
  NOT_SUPPORTED: 'Not supported by documents',
  CONFLICTING_EVIDENCE: 'Conflicting evidence',
};

interface KnowledgeWorkspacePanelProps {
  documents?: KnowledgeDocument[];
  phase?: KnowledgePhase;
  embeddingMode?: string;
  embeddingHonestNote?: string;
  rerankingMode?: string;
  onUpload?: (file: File) => Promise<void> | void;
  onRemove?: (documentId: string) => Promise<void> | void;
  onReingest?: (documentId: string) => Promise<void> | void;
  onQuery?: (query: string) => Promise<KnowledgeQueryResult> | KnowledgeQueryResult;
}

export function KnowledgeWorkspacePanel({
  documents = [],
  phase = 'idle',
  embeddingMode = 'deterministic_fallback',
  embeddingHonestNote,
  rerankingMode = 'deterministic_fallback',
  onUpload,
  onRemove,
  onReingest,
  onQuery,
}: KnowledgeWorkspacePanelProps) {
  const [busy, setBusy] = useState(false);
  const [localPhase, setLocalPhase] = useState<KnowledgePhase>(phase);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<KnowledgeQueryResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const effectivePhase = localPhase === 'idle' ? phase : localPhase;

  const handleUpload = useCallback(
    async (file: File) => {
      if (!onUpload) return;
      setError(null);
      setBusy(true);
      setLocalPhase('reading_document');
      try {
        await onUpload(file);
        setLocalPhase('idle');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Document upload failed');
        setLocalPhase('extraction_failed');
      } finally {
        setBusy(false);
      }
    },
    [onUpload]
  );

  const handleQuery = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed || !onQuery) return;
    setError(null);
    setResult(null);
    setBusy(true);
    setLocalPhase('retrieving_evidence');
    try {
      const response = await onQuery(trimmed);
      setResult(response);
      setLocalPhase('grounded_answer_ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Document query failed');
      setLocalPhase('extraction_failed');
    } finally {
      setBusy(false);
    }
  }, [onQuery, query]);

  const handleRemove = useCallback(
    async (documentId: string) => {
      if (!onRemove) return;
      setError(null);
      setBusy(true);
      try {
        await onRemove(documentId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Document removal failed');
      } finally {
        setBusy(false);
      }
    },
    [onRemove]
  );

  const handleReingest = useCallback(
    async (documentId: string) => {
      if (!onReingest) return;
      setError(null);
      setBusy(true);
      setLocalPhase('reading_document');
      try {
        await onReingest(documentId);
        setLocalPhase('idle');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Re-ingestion failed');
      } finally {
        setBusy(false);
      }
    },
    [onReingest]
  );

  const busyIndicators: KnowledgePhase[] = [
    'reading_document',
    'parsing_pages',
    'structuring_content',
    'creating_chunks',
    'indexing_knowledge',
    'retrieving_evidence',
    'reranking',
    'verifying_citations',
  ];

  return (
    <section
      aria-label="Knowledge and documents workspace"
      className="flex flex-1 flex-col gap-3"
      data-testid="knowledge-workspace"
    >
      {/* ---- Operational status ---------------------------------------- */}
      <div className="glass-panel flex flex-col gap-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-cyan-300" />
            <h2 className="font-display text-sm font-semibold text-slate-100">
              Documents &amp; Knowledge
            </h2>
          </div>
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
              busyIndicators.includes(effectivePhase)
                ? 'border-cyan-400/40 bg-cyan-500/10 text-cyan-200'
                : effectivePhase === 'ocr_required' || effectivePhase === 'extraction_failed'
                  ? 'border-rose-400/40 bg-rose-500/10 text-rose-200'
                  : 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200'
            }`}
            data-testid="knowledge-phase"
          >
            {busyIndicators.includes(effectivePhase) && (
              <Loader2 className="h-3 w-3 animate-spin" />
            )}
            {PHASE_LABELS[effectivePhase]}
          </span>
        </div>

        <p className="text-[11px] leading-relaxed text-slate-400">
          Grounded answers only. JARVIS-X cites the exact page or section it read and
          states plainly when your documents do not contain the answer. Document text is
          always treated as untrusted data, never as instructions.
        </p>

        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-semibold ${
              embeddingMode === 'neural'
                ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200'
                : embeddingMode === 'deterministic_fallback'
                  ? 'border-amber-400/40 bg-amber-500/10 text-amber-200'
                  : 'border-slate-500/40 bg-slate-600/10 text-slate-300'
            }`}
            data-testid="embedding-mode"
          >
            <Layers className="h-3 w-3" />
            Embeddings: {embeddingMode.replace(/_/g, ' ')}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-slate-500/40 bg-slate-600/10 px-2 py-0.5 font-semibold text-slate-300">
            <Search className="h-3 w-3" />
            Reranker: {rerankingMode.replace(/_/g, ' ')}
          </span>
        </div>

        {embeddingMode === 'deterministic_fallback' && (
          <p className="rounded-lg border border-amber-400/30 bg-amber-500/5 p-2 text-[10px] leading-relaxed text-amber-200/90">
            {embeddingHonestNote ??
              'Semantic search is running on a zero-cost deterministic fallback, not a neural embedding model. Results rely heavily on keyword matching.'}
          </p>
        )}

        {error && (
          <p
            className="rounded-lg border border-rose-400/30 bg-rose-500/10 p-2 text-[11px] text-rose-200"
            data-testid="knowledge-error"
          >
            {error}
          </p>
        )}
      </div>

      {/* ---- Upload ------------------------------------------------------ */}
      <div className="glass-panel flex flex-col gap-2 p-3">
        <input
          ref={fileInputRef}
          type="file"
          className="sr-only"
          accept=".pdf,.txt,.md,.mdx,.docx,.csv,.tsv,.json,.html,.htm,.xml,.yaml,.yml,.toml,.ts,.tsx,.js,.jsx,.py,.sql,.sh,.css"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleUpload(file);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          disabled={busy || !onUpload}
          onClick={() => fileInputRef.current?.click()}
          className="flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-cyan-400/40 bg-cyan-500/15 px-3 font-display text-xs font-semibold text-cyan-100 transition disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          Ingest document (PDF · DOCX · MD · CSV · JSON · code)
        </button>
        <p className="text-[10px] text-slate-500">
          PDF and DOCX text extraction runs locally on the server. Scanned PDFs report
          OCR required — contents are never invented.
        </p>
      </div>

      {/* ---- Document list ---------------------------------------------- */}
      <div className="glass-panel flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-xs font-semibold text-slate-200">
            Indexed documents
          </h3>
          <span className="text-[10px] text-slate-500">{documents.length} total</span>
        </div>

        {documents.length === 0 ? (
          <p className="rounded-lg border border-slate-600/30 bg-slate-800/30 p-3 text-[11px] text-slate-400">
            No documents ingested yet. Upload a specification, report, or dataset to start
            grounded retrieval.
          </p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="knowledge-document-list">
            {documents.map((doc) => {
              const style = LIFECYCLE_STYLES[doc.lifecycle] ?? LIFECYCLE_STYLES.FAILED;
              return (
                <li
                  key={doc.documentId}
                  className="rounded-xl border border-slate-600/30 bg-slate-900/40 p-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-xs font-semibold text-slate-100">
                        <FileText className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
                        {doc.title || doc.filename}
                      </p>
                      <p className="mt-0.5 truncate text-[10px] text-slate-500">
                        {doc.filename}
                        {doc.projectId ? ' · project-scoped' : ' · personal'}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${style.className}`}
                    >
                      {style.label}
                    </span>
                  </div>

                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-slate-400">
                    <div className="flex justify-between">
                      <dt>Format</dt>
                      <dd className="text-slate-300">{(doc.format ?? 'unknown').toUpperCase()}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Pages</dt>
                      <dd className="text-slate-300">{doc.pageCount ?? 0}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Parser</dt>
                      <dd className="truncate text-slate-300">{doc.parser ?? 'n/a'}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Chunks</dt>
                      <dd className="text-slate-300">{doc.chunkCount ?? 0}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Indexing</dt>
                      <dd className="text-slate-300">{doc.indexingStatus ?? 'indexed'}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Embedding</dt>
                      <dd className="truncate text-slate-300">
                        {(doc.embeddingMode ?? embeddingMode).replace(/_/g, ' ')}
                      </dd>
                    </div>
                  </dl>

                  {doc.ocrRequired && (
                    <p className="mt-2 flex items-start gap-1 rounded-lg border border-orange-400/30 bg-orange-500/10 p-1.5 text-[10px] text-orange-200">
                      <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
                      OCR required — image-only pages were not read and are never fabricated.
                    </p>
                  )}

                  <div className="mt-2 flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={busy || !onReingest}
                      onClick={() => void handleReingest(doc.documentId)}
                      className="inline-flex min-h-[32px] flex-1 items-center justify-center gap-1 rounded-lg border border-slate-500/40 bg-slate-700/30 px-2 text-[10px] font-semibold text-slate-200 transition disabled:opacity-50"
                    >
                      <RefreshCw className="h-3 w-3" />
                      Re-ingest
                    </button>
                    <button
                      type="button"
                      disabled={busy || !onRemove}
                      onClick={() => void handleRemove(doc.documentId)}
                      className="inline-flex min-h-[32px] flex-1 items-center justify-center gap-1 rounded-lg border border-rose-400/40 bg-rose-500/10 px-2 text-[10px] font-semibold text-rose-200 transition disabled:opacity-50"
                    >
                      <Trash2 className="h-3 w-3" />
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ---- Query ------------------------------------------------------- */}
      <div className="glass-panel flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-cyan-300" />
          <h3 className="font-display text-xs font-semibold text-slate-200">
            Ask your documents
          </h3>
        </div>

        <div className="flex gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void handleQuery();
              }
            }}
            placeholder="What does the spec say about retention?"
            className="min-h-[44px] flex-1 rounded-xl border border-slate-600/40 bg-slate-900/60 px-3 text-xs text-slate-100 placeholder:text-slate-500 focus:border-cyan-400/60 focus:outline-none"
            data-testid="knowledge-query-input"
          />
          <button
            type="button"
            disabled={busy || !query.trim() || !onQuery}
            onClick={() => void handleQuery()}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-cyan-400/40 bg-cyan-500/15 px-3 text-cyan-100 transition disabled:opacity-50"
            aria-label="Run grounded document query"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
          </button>
        </div>

        {result && (
          <div className="flex flex-col gap-2" data-testid="knowledge-answer">
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                  GROUNDING_STYLES[result.answer.status] ?? GROUNDING_STYLES.NOT_SUPPORTED
                }`}
                data-testid="grounding-status"
              >
                {result.answer.status === 'SUPPORTED' ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : result.answer.status === 'CONFLICTING_EVIDENCE' ? (
                  <AlertTriangle className="h-3 w-3" />
                ) : (
                  <XCircle className="h-3 w-3" />
                )}
                {GROUNDING_LABELS[result.answer.status] ?? result.answer.status}
              </span>
              {result.retrieval && (
                <span className="rounded-full border border-slate-500/40 bg-slate-600/10 px-2 py-0.5 text-[10px] text-slate-300">
                  {result.retrieval.selectedCount}/{result.retrieval.candidateCount} passages ·{' '}
                  {result.retrieval.intent.replace(/_/g, ' ')}
                </span>
              )}
              {result.verification && (
                <span className="rounded-full border border-slate-500/40 bg-slate-600/10 px-2 py-0.5 text-[10px] text-slate-300">
                  {result.verification.supportedCount}/{result.verification.totalClaims} claims traced
                </span>
              )}
            </div>

            <div className="rounded-xl border border-slate-600/30 bg-slate-900/50 p-2.5 text-[11px] leading-relaxed whitespace-pre-wrap text-slate-200">
              {result.answer.text}
            </div>

            {result.citations.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="flex items-center gap-1 text-[10px] font-semibold text-slate-400">
                  <Quote className="h-3 w-3" />
                  Citations
                </p>
                <ul className="flex flex-col gap-1" data-testid="knowledge-citations">
                  {result.citations.map((citation) => (
                    <li
                      key={citation.citationId}
                      className="flex items-center justify-between gap-2 rounded-lg border border-slate-600/30 bg-slate-800/40 px-2 py-1 text-[10px]"
                    >
                      <span className="truncate text-slate-200">{citation.documentTitle}</span>
                      <span className="shrink-0 font-mono text-cyan-200">
                        {citation.locationLabel}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {result.answer.insufficientEvidence && (
              <p className="flex items-start gap-1 rounded-lg border border-rose-400/30 bg-rose-500/10 p-2 text-[10px] text-rose-200">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                Your documents do not contain enough evidence to answer this. JARVIS-X did not
                invent a fact to fill the gap.
              </p>
            )}

            {result.answer.warnings.length > 0 && (
              <ul className="flex flex-col gap-1">
                {result.answer.warnings.map((warning, index) => (
                  <li
                    key={`${index}-${warning.slice(0, 24)}`}
                    className="rounded-lg border border-amber-400/30 bg-amber-500/5 px-2 py-1 text-[10px] text-amber-200/90"
                  >
                    {warning}
                  </li>
                ))}
              </ul>
            )}

            {result.retrieval?.embeddingHonestNote && (
              <p className="text-[10px] italic text-slate-500">
                <Sparkles className="mr-1 inline h-3 w-3" />
                {result.retrieval.embeddingHonestNote}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Compass,
  ExternalLink,
  FileSearch,
  Globe,
  HelpCircle,
  Loader2,
  Play,
  Quote,
  Search,
  ShieldAlert,
  Square,
  TrendingUp,
  XCircle,
} from 'lucide-react';

/**
 * JARVIS-X v1.3.0 — Research Workspace
 *
 * Mobile-first HUD for evidence-grounded deep research.
 *
 * Shows operational status only:
 *   mode · progress · queries · sources discovered/used · freshness · conflicts ·
 *   confidence · citations · final report · cancel control.
 *
 * Never renders private chain-of-thought, internal prompts or model reasoning.
 * Web content is displayed strictly as quoted, cited evidence, and a NON-LIVE
 * provider is labelled as such so synthetic fixtures can never pass as real
 * web research.
 */

export type ResearchMode =
  | 'QUICK_RESEARCH'
  | 'DEEP_RESEARCH'
  | 'FACT_CHECK'
  | 'COMPARE'
  | 'LATEST'
  | 'SOURCE_DISCOVERY'
  | 'TECHNICAL_RESEARCH'
  | 'MARKET_RESEARCH'
  | 'ACADEMIC_DISCOVERY';

export interface ResearchCitation {
  citationId: string;
  sourceId: string;
  url: string;
  canonicalUrl: string;
  title: string;
  domain: string;
  retrievedAt: string;
  publishedAt: string | null;
  provenance?: 'WEB_SOURCE' | 'DOCUMENT_SOURCE';
}

export interface ResearchFindingView {
  text: string;
  claimId: string;
  state: string;
  citationIds: string[];
  confidence: number;
}

export interface ResearchSourceView {
  sourceId: string;
  title: string;
  domain: string;
  url: string;
  provenance?: string;
  sourceType: string;
  publishedAt: string | null;
  retrievedAt: string;
  quality: number | null;
  fetchStatus: string;
  duplicateOf: string | null;
  trustSignals: string[];
}

export interface ResearchProgressView {
  stage: string;
  at: string;
  detail: string;
}

export interface ResearchReportView {
  title: string;
  live: boolean;
  status: string;
  executiveSummary: string;
  verifiedFindings: ResearchFindingView[];
  qualifiedFindings: ResearchFindingView[];
  conflicts: ResearchFindingView[];
  unknowns: string[];
  citations: ResearchCitation[];
  confidence: { level: string; score: number; notes: string[] };
  factCheck: { verdict: string; rationale: string; supportingCount: number; contradictingCount: number } | null;
  contradictions: Array<{
    claim: string;
    sideA: { domain: string; statement: string; publishedAt: string | null };
    sideB: { domain: string; statement: string; publishedAt: string | null };
    possibleExplanation: string | null;
    resolved: boolean;
  }>;
  sourcesUsed: number;
  sourcesDiscovered: number;
  limitations: string[];
  generatedAt: string;
}

export interface ResearchResultView {
  taskId: string;
  status: string;
  mode: string;
  report: ResearchReportView | null;
  sources: ResearchSourceView[];
  metrics: {
    queryCount: number;
    sourcesDiscovered: number;
    sourcesFetched: number;
    evidenceUnits: number;
    followUpRounds: number;
    contradictions: number;
    citationCount: number;
    live: boolean;
    searchProviderStatus: string;
  };
  durationMs: number;
}

export interface ResearchProviderView {
  providerId: string;
  label: string;
  status: string;
  live: boolean;
  detail: string;
}

export interface ResearchWorkspacePanelProps {
  authenticated: boolean;
  provider: ResearchProviderView | null;
  onRun: (input: { query: string; mode: ResearchMode }) => Promise<ResearchResultView | null>;
  onCancel: (taskId: string) => Promise<boolean>;
}

const MODES: Array<{ id: ResearchMode; label: string; hint: string }> = [
  { id: 'QUICK_RESEARCH', label: 'Quick', hint: 'Short bounded lookup' },
  { id: 'DEEP_RESEARCH', label: 'Deep', hint: 'Multi-stage investigation' },
  { id: 'FACT_CHECK', label: 'Fact check', hint: 'Claim-centric evidence' },
  { id: 'COMPARE', label: 'Compare', hint: 'Balanced evidence per side' },
  { id: 'LATEST', label: 'Latest', hint: 'Freshness weighted heavily' },
  { id: 'SOURCE_DISCOVERY', label: 'Sources', hint: 'Find authoritative sources' },
  { id: 'TECHNICAL_RESEARCH', label: 'Technical', hint: 'Docs, specs, release notes' },
  { id: 'MARKET_RESEARCH', label: 'Market', hint: 'Claims vs independent evidence' },
  { id: 'ACADEMIC_DISCOVERY', label: 'Academic', hint: 'Papers and metadata' },
];

const STAGES = [
  'Understanding question',
  'Planning research',
  'Searching sources',
  'Evaluating sources',
  'Reading evidence',
  'Checking contradictions',
  'Following up',
  'Verifying claims',
  'Checking citations',
  'Research complete',
];

function confidenceTone(level: string): string {
  switch (level) {
    case 'HIGH':
      return 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10';
    case 'MEDIUM':
      return 'text-amber-300 border-amber-500/40 bg-amber-500/10';
    case 'LOW':
      return 'text-orange-300 border-orange-500/40 bg-orange-500/10';
    default:
      return 'text-slate-300 border-slate-600/50 bg-slate-700/30';
  }
}

function stateTone(state: string): string {
  switch (state) {
    case 'SUPPORTED':
      return 'text-emerald-300';
    case 'PARTIALLY_SUPPORTED':
      return 'text-amber-300';
    case 'CONFLICTING':
      return 'text-orange-300';
    case 'OUTDATED':
      return 'text-orange-300';
    case 'UNSUPPORTED':
      return 'text-rose-300';
    default:
      return 'text-slate-400';
  }
}

export function ResearchWorkspacePanel({
  authenticated,
  provider,
  onRun,
  onCancel,
}: ResearchWorkspacePanelProps) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<ResearchMode>('QUICK_RESEARCH');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ResearchResultView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeStage, setActiveStage] = useState<string | null>(null);
  const [expandedSource, setExpandedSource] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [running]);

  const run = useCallback(async () => {
    if (!authenticated || query.trim().length < 3 || running) return;
    setRunning(true);
    setError(null);
    setResult(null);
    setElapsed(0);
    // Stage indicator advances on a timer: the engine streams real progress
    // events over the API, and this mirrors the visible pipeline while waiting.
    let stageIndex = 0;
    setActiveStage(STAGES[0]);
    const stageTimer = setInterval(() => {
      stageIndex = Math.min(STAGES.length - 2, stageIndex + 1);
      setActiveStage(STAGES[stageIndex]);
    }, 1200);

    try {
      const outcome = await onRun({ query: query.trim(), mode });
      if (!outcome) {
        setError('Research could not be started. Check your session and try again.');
      } else {
        setResult(outcome);
        if (outcome.report?.live === false) {
          setError(null);
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Research failed.');
    } finally {
      clearInterval(stageTimer);
      setActiveStage(null);
      setRunning(false);
    }
  }, [authenticated, mode, onRun, query, running]);

  const cancel = useCallback(async () => {
    if (!result?.taskId) return;
    await onCancel(result.taskId);
  }, [onCancel, result?.taskId]);

  const report = result?.report ?? null;
  const liveLabel = provider?.live ? 'LIVE WEB' : 'NON-LIVE';

  return (
    <div className="space-y-3" data-testid="research-workspace">
      {/* ---- Provider honesty banner ---- */}
      <div
        className={`rounded-xl border p-3 ${
          provider?.live
            ? 'border-emerald-500/30 bg-emerald-500/5'
            : 'border-amber-500/30 bg-amber-500/5'
        }`}
        data-testid="research-provider-banner"
      >
        <div className="flex items-start gap-2">
          <Globe
            className={`mt-0.5 h-4 w-4 shrink-0 ${provider?.live ? 'text-emerald-300' : 'text-amber-300'}`}
          />
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-200">
              {liveLabel} · {provider?.status ?? 'UNCONFIGURED'}
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-slate-400">
              {provider?.live
                ? `Provider "${provider.providerId}" supplies real external results.`
                : 'No live search provider is configured. JARVIS reports the absence of web evidence instead of inventing sources.'}
            </p>
          </div>
        </div>
      </div>

      {/* ---- Query composer ---- */}
      <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-3">
        <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-400" htmlFor="research-query">
          Research question
        </label>
        <textarea
          id="research-query"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          rows={2}
          placeholder="e.g. What are the documented breaking changes in the latest release?"
          className="mt-1 w-full resize-none rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-500/60"
          data-testid="research-query-input"
        />

        <div className="mt-2 flex flex-wrap gap-1.5">
          {MODES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              title={entry.hint}
              onClick={() => setMode(entry.id)}
              className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
                mode === entry.id
                  ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-200'
                  : 'border-slate-700 bg-slate-800/40 text-slate-400 hover:text-slate-200'
              }`}
              data-testid={`research-mode-${entry.id}`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={run}
            disabled={!authenticated || running || query.trim().length < 3}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-cyan-600 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            data-testid="research-run"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {running ? `Researching ${elapsed}s` : 'Run research'}
          </button>
          {running && (
            <button
              type="button"
              onClick={cancel}
              className="flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm font-medium text-rose-200"
              data-testid="research-cancel"
            >
              <Square className="h-3.5 w-3.5" />
              Cancel
            </button>
          )}
        </div>

        {!authenticated && (
          <p className="mt-2 text-[11px] text-amber-300">
            An authenticated owner session is required. Guest sessions never receive research results.
          </p>
        )}
      </div>

      {/* ---- Progress ---- */}
      {running && activeStage && (
        <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-3" data-testid="research-progress">
          <div className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-300" />
            <p className="text-xs font-medium text-slate-200">{activeStage}</p>
          </div>
          <div className="mt-2 flex gap-1">
            {STAGES.slice(0, -1).map((stage) => (
              <div
                key={stage}
                className={`h-1 flex-1 rounded-full ${
                  STAGES.indexOf(stage) <= STAGES.indexOf(activeStage) ? 'bg-cyan-500' : 'bg-slate-700'
                }`}
              />
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3" data-testid="research-error">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <p className="text-[11px] leading-snug text-amber-100">{error}</p>
        </div>
      )}

      {/* ---- Metrics ---- */}
      {result && (
        <div className="grid grid-cols-3 gap-1.5" data-testid="research-metrics">
          {[
            { label: 'Queries', value: result.metrics.queryCount },
            { label: 'Found', value: result.metrics.sourcesDiscovered },
            { label: 'Read', value: result.metrics.sourcesFetched },
            { label: 'Evidence', value: result.metrics.evidenceUnits },
            { label: 'Conflicts', value: result.metrics.contradictions },
            { label: 'Citations', value: result.metrics.citationCount },
          ].map((metric) => (
            <div key={metric.label} className="rounded-lg border border-slate-700/50 bg-slate-900/50 px-2 py-1.5">
              <p className="text-[9px] uppercase tracking-wide text-slate-500">{metric.label}</p>
              <p className="text-sm font-semibold text-slate-100">{metric.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* ---- Status line ---- */}
      {result && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-slate-600/60 bg-slate-800/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-300">
            {result.status}
          </span>
          <span className="rounded-full border border-slate-600/60 bg-slate-800/60 px-2 py-0.5 text-[10px] text-slate-400">
            {result.mode.replace(/_/g, ' ').toLowerCase()}
          </span>
          {report && (
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${confidenceTone(report.confidence.level)}`}>
              {report.confidence.level} confidence
            </span>
          )}
          {report && (
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${
                report.live
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
              }`}
            >
              {report.live ? 'live' : 'non-live'}
            </span>
          )}
          <span className="text-[10px] text-slate-500">{Math.round(result.durationMs / 100) / 10}s</span>
        </div>
      )}

      {/* ---- Fact check verdict ---- */}
      {report?.factCheck && (
        <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-3" data-testid="research-factcheck">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Fact-check verdict</p>
          <p className="mt-1 text-sm font-semibold text-slate-100">{report.factCheck.verdict.replace(/_/g, ' ')}</p>
          <p className="mt-1 text-[11px] leading-snug text-slate-400">{report.factCheck.rationale}</p>
        </div>
      )}

      {/* ---- Conflicts ---- */}
      {report && report.contradictions.length > 0 && (
        <div className="rounded-xl border border-orange-500/30 bg-orange-500/5 p-3" data-testid="research-conflicts">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-orange-300" />
            <p className="text-[11px] font-semibold uppercase tracking-wide text-orange-200">
              {report.contradictions.length} contradiction(s)
            </p>
          </div>
          <div className="mt-2 space-y-2">
            {report.contradictions.map((contradiction, index) => (
              <div key={index} className="rounded-lg border border-orange-500/20 bg-slate-950/40 p-2">
                <p className="text-[11px] font-medium text-slate-200">{contradiction.claim}</p>
                <p className="mt-1 text-[11px] text-emerald-300">
                  {contradiction.sideA.domain}: {contradiction.sideA.statement.slice(0, 180)}
                </p>
                <p className="mt-1 text-[11px] text-rose-300">
                  {contradiction.sideB.domain}: {contradiction.sideB.statement.slice(0, 180)}
                </p>
                {contradiction.possibleExplanation && (
                  <p className="mt-1 text-[10px] italic text-slate-400">{contradiction.possibleExplanation}</p>
                )}
                {!contradiction.resolved && (
                  <p className="mt-1 text-[10px] font-medium text-orange-300">Remains unresolved.</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---- Findings ---- */}
      {report && (
        <div className="space-y-2" data-testid="research-report">
          <FindingGroup title="Verified findings" icon={<CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />} items={report.verifiedFindings} />
          <FindingGroup title="Qualified findings" icon={<HelpCircle className="h-3.5 w-3.5 text-amber-300" />} items={report.qualifiedFindings} />
          <FindingGroup title="Conflicting" icon={<AlertTriangle className="h-3.5 w-3.5 text-orange-300" />} items={report.conflicts} />

          {report.unknowns.length > 0 && (
            <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Unknown / insufficient evidence</p>
              <ul className="mt-1 space-y-1">
                {report.unknowns.map((unknown, index) => (
                  <li key={index} className="text-[11px] leading-snug text-slate-400">
                    · {unknown}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.confidence.notes.length > 0 && (
            <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Confidence notes</p>
              <ul className="mt-1 space-y-1">
                {report.confidence.notes.map((note, index) => (
                  <li key={index} className="text-[11px] leading-snug text-slate-400">
                    · {note}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.limitations.length > 0 && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3" data-testid="research-limitations">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-200">Limitations</p>
              <ul className="mt-1 space-y-1">
                {report.limitations.map((limitation, index) => (
                  <li key={index} className="text-[11px] leading-snug text-amber-100/80">
                    · {limitation}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* ---- Citations ---- */}
      {report && report.citations.length > 0 && (
        <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-3" data-testid="research-citations">
          <div className="flex items-center gap-2">
            <Quote className="h-3.5 w-3.5 text-cyan-300" />
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Citations ({report.citations.length})
            </p>
          </div>
          <ul className="mt-2 space-y-1.5">
            {report.citations.map((citation) => (
              <li key={citation.citationId} className="text-[11px] leading-snug">
                <span className="mr-1 rounded bg-slate-800 px-1 py-0.5 text-[9px] font-mono text-slate-400">
                  {citation.citationId.replace('cit-', '')}
                </span>
                <span className="text-slate-200">{citation.title}</span>
                <span className="ml-1 text-slate-500">
                  · {citation.domain}
                  {citation.publishedAt ? ` · ${citation.publishedAt.slice(0, 10)}` : ' · date unverified'}
                  {citation.provenance === 'DOCUMENT_SOURCE' ? ' · DOCUMENT_SOURCE' : ''}
                </span>
                {citation.provenance !== 'DOCUMENT_SOURCE' && (
                  <a
                    href={citation.canonicalUrl}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="ml-1 inline-flex items-center gap-0.5 text-cyan-400 hover:text-cyan-300"
                  >
                    <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ---- Sources (inspectable, no chain-of-thought) ---- */}
      {result && result.sources.length > 0 && (
        <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-3" data-testid="research-sources">
          <div className="flex items-center gap-2">
            <FileSearch className="h-3.5 w-3.5 text-slate-300" />
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Sources ({result.sources.length})
            </p>
          </div>
          <ul className="mt-2 space-y-1">
            {result.sources.slice(0, 20).map((source) => (
              <li key={source.sourceId} className="rounded-lg border border-slate-800 bg-slate-950/40">
                <button
                  type="button"
                  onClick={() => setExpandedSource(expandedSource === source.sourceId ? null : source.sourceId)}
                  className="flex w-full items-start justify-between gap-2 px-2 py-1.5 text-left"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[11px] text-slate-200">{source.title}</span>
                    <span className="block text-[10px] text-slate-500">
                      {source.domain} · {source.sourceType.replace(/_/g, ' ').toLowerCase()}
                      {source.duplicateOf ? ' · duplicate' : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] text-slate-500">
                    {source.quality !== null ? source.quality.toFixed(2) : '—'}
                  </span>
                </button>
                {expandedSource === source.sourceId && (
                  <div className="border-t border-slate-800 px-2 py-1.5 text-[10px] text-slate-400">
                    <p>Status: {source.fetchStatus}</p>
                    <p>Published: {source.publishedAt ?? 'unverified'}</p>
                    <p>Retrieved: {source.retrievedAt.slice(0, 19).replace('T', ' ')}</p>
                    <p>Provenance: {source.provenance ?? 'WEB_SOURCE'}</p>
                    <p className="mt-1">Signals: {source.trustSignals.join(', ') || 'none'}</p>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ---- Empty / intro ---- */}
      {!result && !running && (
        <div className="rounded-xl border border-slate-700/40 bg-slate-900/40 p-4 text-center">
          <Compass className="mx-auto h-6 w-6 text-slate-600" />
          <p className="mt-2 text-xs text-slate-400">
            Research runs through a bounded plan: discover → read → compare → verify → cite.
          </p>
          <p className="mt-1 text-[10px] text-slate-500">
            Nothing is reported without a real retrieved source behind it.
          </p>
        </div>
      )}
    </div>
  );
}

function FindingGroup({
  title,
  icon,
  items,
}: {
  title: string;
  icon: React.ReactNode;
  items: ResearchFindingView[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-3">
      <div className="flex items-center gap-2">
        {icon}
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</p>
      </div>
      <ul className="mt-2 space-y-1.5">
        {items.map((item, index) => (
          <li key={`${item.claimId}-${index}`} className="text-[11px] leading-snug text-slate-200">
            <span className={`mr-1 text-[9px] font-semibold uppercase ${stateTone(item.state)}`}>
              {item.state.replace(/_/g, ' ')}
            </span>
            {item.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default ResearchWorkspacePanel;

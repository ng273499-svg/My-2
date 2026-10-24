'use client';

import React, { useCallback, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Code2,
  FileCode2,
  FlaskConical,
  GitBranch,
  Hammer,
  Loader2,
  Shield,
  Terminal,
  XCircle,
} from 'lucide-react';

/**
 * JARVIS-X v1.1.0 — Engineering Workspace Panel
 *
 * Mobile-responsive operational view of the Coding & Software Engineering
 * Engine. Shows concise status only: project, languages, toolchains, files
 * changed, diff summaries, commands, tests, build, repair count and
 * verification status. Never exposes private chain-of-thought.
 */

export type EngineeringPhase =
  | 'idle'
  | 'analyzing_repository'
  | 'planning'
  | 'inspecting_dependencies'
  | 'editing_files'
  | 'running_tests'
  | 'build_failed'
  | 'diagnosing'
  | 'repairing'
  | 'regression_tests_passed'
  | 'verified';

export type EngineeringVerification =
  | 'VERIFIED'
  | 'PARTIALLY_VERIFIED'
  | 'UNVERIFIED'
  | 'FAILED'
  | 'NOT_VERIFIABLE';

export interface EngineeringStatus {
  project: string;
  languages: string[];
  toolchains: Array<{ name: string; status: string }>;
  filesChanged: string[];
  diffSummaries: string[];
  commands: Array<{ command: string; exitCode: number | null }>;
  tests: { passed: boolean; count?: number };
  build: { passed: boolean };
  repairCount: number;
  verification: EngineeringVerification;
  phase: EngineeringPhase;
}

const PHASE_LABELS: Record<EngineeringPhase, string> = {
  idle: 'Idle — no engineering task running',
  analyzing_repository: 'Analyzing repository',
  planning: 'Planning',
  inspecting_dependencies: 'Inspecting dependencies',
  editing_files: 'Editing files',
  running_tests: 'Running tests',
  build_failed: 'Build failed',
  diagnosing: 'Diagnosing',
  repairing: 'Repairing',
  regression_tests_passed: 'Regression tests passed',
  verified: 'Verified',
};

const MODES = [
  { id: 'analyze', label: 'Analyze', mutating: false },
  { id: 'review', label: 'Security review', mutating: false },
  { id: 'feature', label: 'Feature', mutating: true },
  { id: 'debug', label: 'Debug', mutating: true },
  { id: 'refactor', label: 'Refactor', mutating: true },
  { id: 'implement-api', label: 'API', mutating: true },
] as const;

function verificationTone(v: EngineeringVerification): string {
  switch (v) {
    case 'VERIFIED':
      return 'border-emerald-400/35 bg-emerald-500/15 text-emerald-200';
    case 'PARTIALLY_VERIFIED':
      return 'border-amber-400/35 bg-amber-500/15 text-amber-200';
    case 'FAILED':
      return 'border-rose-400/35 bg-rose-500/15 text-rose-200';
    default:
      return 'border-slate-400/30 bg-slate-500/15 text-slate-200';
  }
}

export function EngineeringWorkspacePanel({
  authenticated,
}: {
  authenticated: boolean;
}) {
  const [goal, setGoal] = useState('');
  const [mode, setMode] = useState<(typeof MODES)[number]['id']>('analyze');
  const [acknowledge, setAcknowledge] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<EngineeringStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedMode = MODES.find((m) => m.id === mode) ?? MODES[0];
  const requiresAck = selectedMode.mutating;

  const runTask = useCallback(async () => {
    if (!goal.trim() || running) return;
    setRunning(true);
    setError(null);
    setStatus((prev) => ({
      project: prev?.project ?? 'workspace',
      languages: prev?.languages ?? [],
      toolchains: prev?.toolchains ?? [],
      filesChanged: [],
      diffSummaries: [],
      commands: [],
      tests: { passed: false },
      build: { passed: false },
      repairCount: 0,
      verification: 'UNVERIFIED',
      phase: 'analyzing_repository',
    }));

    try {
      const res = await fetch('/api/jarvis/coding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal: goal.trim(),
          mode,
          acknowledgement: undefined,
          acknowledgeMutations: requiresAck ? acknowledge : undefined,
          verificationPreference: 'standard',
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        setError(typeof data.error === 'string' ? data.error : 'Coding task failed.');
        setStatus((prev) => (prev ? { ...prev, phase: 'idle' } : prev));
        return;
      }

      const profile = data.repositoryProfile;
      setStatus({
        project: profile?.primaryLanguage
          ? `${profile.primaryLanguage} workspace`
          : 'workspace',
        languages: (profile?.languages ?? []).map(
          (l: { name: string }) => l.name
        ),
        toolchains: [],
        filesChanged: data.changedFiles ?? [],
        diffSummaries: (data.changedFiles ?? []).slice(0, 5),
        commands: (data.commandsExecuted ?? []).map(
          (c: { command: string; exitCode: number | null }) => ({
            command: c.command,
            exitCode: c.exitCode,
          })
        ),
        tests: {
          passed: Boolean(data.testEvidence?.testPassed),
          count: data.testEvidence?.testCount,
        },
        build: { passed: Boolean(data.testEvidence?.buildPassed) },
        repairCount: data.repairAttempts ?? 0,
        verification: data.verificationStatus ?? 'UNVERIFIED',
        phase:
          data.verificationStatus === 'VERIFIED' ? 'verified' : 'build_failed',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error.');
    } finally {
      setRunning(false);
    }
  }, [goal, mode, running, requiresAck, acknowledge]);

  return (
    <section
      aria-label="Engineering Workspace"
      className="flex flex-col gap-4 rounded-2xl border border-cyan-400/20 bg-slate-950/60 p-4 backdrop-blur"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Code2 className="h-5 w-5 text-cyan-300" aria-hidden="true" />
          <h2 className="text-sm font-semibold tracking-wide text-cyan-100">
            Engineering Workspace
          </h2>
        </div>
        <span
          className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider ${verificationTone(
            status?.verification ?? 'UNVERIFIED'
          )}`}
        >
          {status?.verification ?? 'UNVERIFIED'}
        </span>
      </header>

      {!authenticated && (
        <p className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Engineering tasks require an authenticated owner session. Voice alone is
          never accepted as identity proof.
        </p>
      )}

      {/* Goal input */}
      <div className="flex flex-col gap-2">
        <label
          htmlFor="engineering-goal"
          className="text-[11px] font-medium uppercase tracking-wider text-slate-400"
        >
          Engineering goal
        </label>
        <textarea
          id="engineering-goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={3}
          placeholder="Analyze this repository's architecture…"
          className="w-full resize-none rounded-xl border border-slate-700/60 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-400/60 focus:outline-none"
        />
      </div>

      {/* Mode selector */}
      <div
        role="group"
        aria-label="Engineering mode"
        className="flex flex-wrap gap-2"
      >
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setMode(m.id)}
            aria-pressed={mode === m.id}
            className={`min-h-[44px] rounded-xl border px-3 text-xs font-medium transition ${
              mode === m.id
                ? 'border-cyan-400/60 bg-cyan-500/20 text-cyan-100'
                : 'border-slate-700/60 bg-slate-900/60 text-slate-300 hover:border-slate-500'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {requiresAck && (
        <label className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <input
            type="checkbox"
            checked={acknowledge}
            onChange={(e) => setAcknowledge(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-amber-400"
          />
          <span>
            I authorize this mutating coding mode. JARVIS-X will stay inside the
            server workspace and record every change for rollback.
          </span>
        </label>
      )}

      <button
        type="button"
        onClick={runTask}
        disabled={running || !goal.trim() || !authenticated || (requiresAck && !acknowledge)}
        className="flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-cyan-400/40 bg-cyan-500/20 px-4 text-sm font-semibold text-cyan-100 transition disabled:cursor-not-allowed disabled:opacity-40"
      >
        {running ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        )}
        {running ? 'Working…' : 'Run engineering task'}
      </button>

      {error && (
        <p className="flex items-start gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      {/* Status */}
      {status && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-xl border border-slate-700/60 bg-slate-900/60 px-3 py-2">
            {status.phase === 'verified' ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-300" aria-hidden="true" />
            ) : running ? (
              <Loader2 className="h-4 w-4 animate-spin text-cyan-300" aria-hidden="true" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-amber-300" aria-hidden="true" />
            )}
            <span className="text-xs text-slate-200" aria-live="polite">
              {PHASE_LABELS[status.phase]}
            </span>
          </div>

          <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <Metric label="Project" value={status.project} />
            <Metric
              label="Languages"
              value={status.languages.slice(0, 3).join(', ') || '—'}
            />
            <Metric label="Files changed" value={String(status.filesChanged.length)} />
            <Metric label="Repairs" value={String(status.repairCount)} />
          </dl>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <EvidenceRow
              icon={<FlaskConical className="h-4 w-4" aria-hidden="true" />}
              label="Tests"
              ok={status.tests.passed}
              detail={status.tests.count ? `${status.tests.count} passed` : undefined}
            />
            <EvidenceRow
              icon={<Hammer className="h-4 w-4" aria-hidden="true" />}
              label="Build"
              ok={status.build.passed}
            />
          </div>

          {status.filesChanged.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-400">
                <FileCode2 className="h-3.5 w-3.5" aria-hidden="true" /> Changed files
              </span>
              <ul className="flex flex-col gap-1">
                {status.filesChanged.slice(0, 8).map((f) => (
                  <li
                    key={f}
                    className="truncate rounded-lg border border-slate-700/50 bg-slate-900/50 px-2 py-1 font-mono text-[11px] text-slate-300"
                  >
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {status.commands.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-400">
                <Terminal className="h-3.5 w-3.5" aria-hidden="true" /> Commands
              </span>
              <ul className="flex flex-col gap-1">
                {status.commands.slice(0, 6).map((c, i) => (
                  <li
                    key={`${c.command}-${i}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-slate-700/50 bg-slate-900/50 px-2 py-1 font-mono text-[11px] text-slate-300"
                  >
                    <span className="truncate">{c.command}</span>
                    <span
                      className={
                        c.exitCode === 0 ? 'text-emerald-300' : 'text-rose-300'
                      }
                    >
                      {c.exitCode === null ? '—' : c.exitCode}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-900/50 px-2.5 py-2">
      <dt className="text-[10px] uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="truncate text-xs font-semibold text-slate-200">{value}</dd>
    </div>
  );
}

function EvidenceRow({
  icon,
  label,
  ok,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  ok: boolean;
  detail?: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-slate-700/50 bg-slate-900/50 px-2.5 py-2">
      <span className={ok ? 'text-emerald-300' : 'text-rose-300'}>{icon}</span>
      <span className="text-xs text-slate-300">{label}</span>
      <span
        className={`ml-auto text-[11px] font-semibold ${
          ok ? 'text-emerald-300' : 'text-rose-300'
        }`}
      >
        {ok ? 'PASS' : 'FAIL'}
        {detail ? ` · ${detail}` : ''}
      </span>
    </div>
  );
}

'use client';

import React from 'react';
import {
  Activity,
  Bot,
  CheckCircle2,
  CircleDot,
  Clock,
  GitBranch,
  PauseCircle,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import type {
  AgentActivityStep,
  AgentLifecycleStage,
  JarvisSystemSnapshot,
  RuntimeExecutionResult,
} from '@/core/types';

interface AgentActivityPanelProps {
  steps: AgentActivityStep[];
  runtimeResult?: RuntimeExecutionResult | null;
  isProcessing: boolean;
  specialists: JarvisSystemSnapshot['specialists'];
}

const STANDBY_PIPELINE_STAGES: Array<{ stage: AgentLifecycleStage; label: string }> = [
  { stage: 'understanding', label: 'Understanding' },
  { stage: 'context_loading', label: 'Loading context' },
  { stage: 'planning', label: 'Planning' },
  { stage: 'selecting', label: 'Selecting capability' },
  { stage: 'executing', label: 'Executing' },
  { stage: 'verifying', label: 'Verifying' },
  { stage: 'completed', label: 'Completed' },
];

export function AgentActivityPanel({
  steps,
  runtimeResult,
  isProcessing,
  specialists,
}: AgentActivityPanelProps) {
  const hasLiveSteps = steps.length > 0;

  const badgeLabel = isProcessing
    ? 'RUNNING'
    : runtimeResult?.finalState
      ? runtimeResult.finalState
      : hasLiveSteps
        ? 'TRACE READY'
        : 'IDLE';

  const badgeTone =
    runtimeResult?.finalState === 'FAILED'
      ? 'border-rose-400/35 bg-rose-500/15 text-rose-200'
      : runtimeResult?.finalState === 'WAITING_FOR_USER_APPROVAL'
        ? 'border-amber-400/35 bg-amber-500/15 text-amber-200'
        : runtimeResult?.finalState === 'CANCELLED'
          ? 'border-slate-500/40 bg-slate-800/80 text-slate-300'
          : 'border-cyan-400/20 bg-cyan-500/10 text-cyan-200';

  return (
    <div className="flex flex-col gap-4">
      {/* Real Runtime State Machine Activity */}
      <section
        aria-label="Agent Activity Pipeline"
        data-testid="agent-activity-panel"
        className="glass-panel p-4"
      >
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-cyan-300" />
            <h2 className="font-display text-sm font-semibold tracking-wide text-slate-100">
              Agent Activity Runtime
            </h2>
          </div>
          <span
            className={`rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase ${badgeTone}`}
          >
            {badgeLabel}
          </span>
        </div>

        {/* Live Task Metadata Strip when a task has executed */}
        {runtimeResult && (
          <div className="mb-3 rounded-xl border border-slate-800/90 bg-slate-950/65 p-2.5 font-mono text-[10px] text-slate-300">
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <span className="text-cyan-200">
                TASK: <strong>{runtimeResult.taskId.slice(0, 8)}</strong>
              </span>
              <span>
                TYPE: <strong>{runtimeResult.taskClassification.taskType}</strong>
              </span>
              <span>
                RISK: <strong>{runtimeResult.riskClassification.riskLevel}</strong>
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center justify-between gap-1.5 text-slate-400">
              <span>
                VERIFY:{' '}
                <strong
                  className={
                    runtimeResult.verification.verificationStatus === 'VERIFIED'
                      ? 'text-emerald-300'
                      : runtimeResult.verification.verificationStatus ===
                          'FAILED_VERIFICATION'
                        ? 'text-rose-300'
                        : 'text-amber-200'
                  }
                >
                  {runtimeResult.verification.verificationStatus}
                </strong>
              </span>
              <span>
                TRANSITIONS: <strong>{runtimeResult.stateHistory.length}</strong>
              </span>
            </div>
          </div>
        )}

        <p className="mb-3 text-xs text-slate-400">
          Real Core Runtime state telemetry (concise execution status only — hidden chain-of-thought is never exposed).
        </p>

        {hasLiveSteps ? (
          <ol className="relative space-y-2.5">
            {steps.map((recorded, idx) => {
              const state = recorded.state;
              return (
                <li
                  key={`${recorded.stage}-${idx}`}
                  className={`rounded-xl border px-3 py-2.5 transition ${
                    state === 'completed'
                      ? 'border-emerald-400/25 bg-emerald-950/15'
                      : state === 'awaiting_permission'
                        ? 'border-amber-400/35 bg-amber-950/20'
                        : state === 'blocked' || state === 'failed'
                          ? 'border-rose-400/35 bg-rose-950/20'
                          : state === 'cancelled'
                            ? 'border-slate-600/40 bg-slate-900/60'
                            : state === 'active'
                              ? 'border-cyan-400/45 bg-cyan-950/25'
                              : 'border-slate-800/80 bg-slate-900/40'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {state === 'completed' ? (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                      ) : state === 'awaiting_permission' ? (
                        <PauseCircle className="h-4 w-4 shrink-0 text-amber-300" />
                      ) : state === 'blocked' || state === 'failed' ? (
                        <ShieldAlert className="h-4 w-4 shrink-0 text-rose-400" />
                      ) : state === 'cancelled' ? (
                        <XCircle className="h-4 w-4 shrink-0 text-slate-400" />
                      ) : (
                        <CircleDot className="h-4 w-4 shrink-0 animate-pulse text-cyan-300" />
                      )}
                      <span className="font-display text-xs font-semibold text-slate-100">
                        {idx + 1}. {recorded.label}
                      </span>
                    </div>

                    {recorded.durationMs !== undefined && (
                      <span className="font-mono text-[10px] text-slate-400">
                        {recorded.durationMs}ms
                      </span>
                    )}
                  </div>

                  <p className="mt-1 pl-6 text-xs leading-relaxed text-slate-300 break-words">
                    {recorded.summary}
                  </p>

                  {recorded.moduleName && (
                    <div className="mt-1 pl-6 font-mono text-[10px] text-slate-500">
                      Module: {recorded.moduleName}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        ) : (
          <ol className="relative space-y-2">
            {STANDBY_PIPELINE_STAGES.map((stageItem, idx) => {
              const active = isProcessing && idx === 0;
              return (
                <li
                  key={stageItem.stage}
                  className={`rounded-xl border px-3 py-2 transition ${
                    active
                      ? 'border-cyan-400/45 bg-cyan-950/25'
                      : 'border-slate-800/80 bg-slate-900/40'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {active ? (
                      <CircleDot className="h-4 w-4 shrink-0 animate-pulse text-cyan-300" />
                    ) : (
                      <Clock className="h-3.5 w-3.5 shrink-0 text-slate-600" />
                    )}
                    <span className="font-display text-xs font-semibold text-slate-200">
                      {idx + 1}. {stageItem.label}
                    </span>
                  </div>
                  <p className="mt-1 pl-6 text-[11px] text-slate-500">
                    {active
                      ? 'Processing incoming request through Core Runtime...'
                      : 'Standby — populates with real runtime state on execution.'}
                  </p>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* Structured Task Plan Steps (shown when a plan exists) */}
      {runtimeResult && runtimeResult.plan.steps.length > 0 && (
        <section aria-label="Runtime Execution Plan" className="glass-panel p-4">
          <div className="mb-2.5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-cyan-300" />
              <h3 className="font-display text-sm font-semibold text-slate-100">
                Execution Plan Steps
              </h3>
            </div>
            <span className="font-mono text-[10px] text-cyan-200">
              {runtimeResult.plan.steps.length} STEP
              {runtimeResult.plan.steps.length === 1 ? '' : 'S'}
            </span>
          </div>

          <div className="space-y-2">
            {runtimeResult.plan.steps.map((step) => (
              <div
                key={step.stepId}
                className="glass-panel-subtle flex flex-col gap-1 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2 font-mono text-[10px]">
                  <span className="font-semibold text-cyan-200">
                    {step.stepId.toUpperCase()} · {step.requiredCapability}
                  </span>
                  <span className="uppercase text-slate-300">{step.status}</span>
                </div>
                <p className="text-xs text-slate-200 break-words">{step.objective}</p>
                {step.dependencies.length > 0 && (
                  <p className="font-mono text-[10px] text-slate-500">
                    Depends on: {step.dependencies.join(', ')}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Specialist Sub-Agent Contract Registry */}
      <section aria-label="Specialist Sub-Agents" className="glass-panel p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-indigo-300" />
            <h3 className="font-display text-sm font-semibold text-slate-100">
              Specialist Agent Contracts
            </h3>
          </div>
          <span className="font-mono text-[10px] text-slate-400">
            {specialists.length} REGISTERED
          </span>
        </div>

        <div className="space-y-2">
          {specialists.map((agent) => {
            const isLocal = agent.readiness === 'operational_local';
            return (
              <div
                key={agent.id}
                className="glass-panel-subtle flex flex-col gap-1 px-3 py-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-display text-xs font-semibold text-slate-100">
                    {agent.name}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                      isLocal
                        ? 'border border-emerald-400/25 bg-emerald-500/10 text-emerald-300'
                        : 'border border-amber-400/25 bg-amber-500/10 text-amber-200'
                    }`}
                  >
                    {isLocal ? 'LOCAL ACTIVE' : 'CONTRACT / NOT_AVAILABLE'}
                  </span>
                </div>
                <p className="text-[11px] leading-snug text-slate-400">
                  {agent.roleSummary}
                </p>
                {agent.missingDependencies.length > 0 && (
                  <p className="font-mono text-[10px] text-slate-500">
                    Unlinked: {agent.missingDependencies[0]}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

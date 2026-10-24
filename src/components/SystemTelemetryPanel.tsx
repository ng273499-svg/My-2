'use client';

import React, { useState } from 'react';
import {
  BellRing,
  Cpu,
  Database,
  PlugZap,
  Plus,
  Trash2,
} from 'lucide-react';
import type { JarvisSystemSnapshot } from '@/core/types';

interface SystemTelemetryPanelProps {
  snapshot: JarvisSystemSnapshot | null;
  onAddMemory: (content: string) => Promise<void>;
  onDeleteMemory: (id: string) => Promise<void>;
}

export function SystemTelemetryPanel({
  snapshot,
  onAddMemory,
  onDeleteMemory,
}: SystemTelemetryPanelProps) {
  const [newMemoryText, setNewMemoryText] = useState('');
  const [savingMem, setSavingMem] = useState(false);

  const handleSaveMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMemoryText.trim() || savingMem) return;
    setSavingMem(true);
    try {
      await onAddMemory(newMemoryText.trim());
      setNewMemoryText('');
    } finally {
      setSavingMem(false);
    }
  };

  const configuredProviders =
    snapshot?.modelSystem?.providerHealth.filter(
      (p) => p.configurationState === 'CONFIGURED'
    ).length ?? 1;
  const unconfiguredProviders =
    snapshot?.modelSystem?.providerHealth.filter(
      (p) => p.configurationState === 'UNCONFIGURED'
    ).length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Multi-Model Router Telemetry Card */}
      <section aria-label="Multi-Model Router Status" className="glass-panel p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-cyan-300" />
            <h3 className="font-display text-sm font-semibold text-slate-100">
              Multi-Model Router
            </h3>
          </div>
          <span className="rounded border border-cyan-400/25 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[10px] uppercase text-cyan-200">
            {snapshot?.modelSystem?.routingPolicy ?? 'AUTO_BALANCED'}
          </span>
        </div>
        <div className="space-y-1.5 font-mono text-[11px] text-slate-300">
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Active:</span>
            <span className="truncate text-cyan-100">
              {snapshot?.activeModel.displayName ?? 'Foundation Core v0.4'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Providers:</span>
            <span>
              <span className="text-emerald-300">{configuredProviders} CONFIGURED</span>
              {' · '}
              <span className="text-slate-400">{unconfiguredProviders} UNCONFIGURED</span>
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Route State:</span>
            <span
              className={
                snapshot?.modelSystem?.fallbackActive
                  ? 'text-amber-300'
                  : 'text-emerald-300'
              }
            >
              {snapshot?.modelSystem?.fallbackActive ? 'FALLBACK ACTIVE' : 'HEALTHY PRIMARY'}
            </span>
          </div>
        </div>
      </section>

      {/* Memory Status & Inspector */}
      <section aria-label="Memory Status and Store" className="glass-panel p-4">
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-indigo-300" />
            <h3 className="font-display text-sm font-semibold text-slate-100">
              Memory Manager
            </h3>
          </div>
          <span
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${
              snapshot?.memory.persistenceMode === 'supabase_cloud'
                ? 'border border-emerald-400/25 bg-emerald-500/10 text-emerald-300'
                : 'border border-amber-400/25 bg-amber-500/10 text-amber-200'
            }`}
          >
            {snapshot?.memory.persistenceMode === 'supabase_cloud'
              ? 'SUPABASE CLOUD'
              : 'EPHEMERAL RAM'}
          </span>
        </div>

        <p className="mb-2.5 font-mono text-[11px] text-slate-400">
          {snapshot?.memory.statusLabel ?? 'Initializing hierarchical memory engine...'}
        </p>

        {/* 7-Scope Compact Telemetry Strip */}
        {snapshot?.memory.countsByScope && (
          <div className="mb-3 grid grid-cols-4 gap-1 font-mono text-[9px] sm:grid-cols-7">
            {(
              [
                ['working', 'WRK'],
                ['episodic', 'EPI'],
                ['semantic', 'SEM'],
                ['project', 'PRJ'],
                ['knowledge', 'KNW'],
                ['procedural', 'PRC'],
                ['event', 'EVT'],
              ] as const
            ).map(([scopeKey, shortLabel]) => {
              const count = snapshot.memory.countsByScope?.[scopeKey] ?? 0;
              return (
                <div
                  key={scopeKey}
                  title={`${scopeKey} scope: ${count} item(s)`}
                  className={`flex flex-col items-center rounded border px-1 py-1 ${
                    count > 0
                      ? 'border-cyan-400/25 bg-cyan-500/10 text-cyan-200'
                      : 'border-slate-800/80 bg-slate-950/60 text-slate-500'
                  }`}
                >
                  <span>{shortLabel}</span>
                  <span className="font-semibold">{count}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Manual memory quick-entry */}
        <form onSubmit={handleSaveMemory} className="mb-3 flex gap-1.5">
          <input
            type="text"
            value={newMemoryText}
            onChange={(e) => setNewMemoryText(e.target.value)}
            aria-label="Add session memory fact"
            placeholder="Store fact in active memory..."
            className="min-h-[38px] flex-1 rounded-lg border border-slate-800 bg-slate-950/90 px-2.5 text-xs text-slate-100 placeholder-slate-500 focus:border-cyan-400/50 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!newMemoryText.trim() || savingMem}
            aria-label="Save memory entry"
            className="inline-flex min-h-[38px] min-w-[38px] items-center justify-center rounded-lg border border-cyan-400/30 bg-cyan-500/15 px-2.5 text-cyan-200 transition hover:bg-cyan-500/25 disabled:opacity-40"
          >
            <Plus className="h-4 w-4" />
          </button>
        </form>

        <div className="max-h-44 space-y-2 overflow-y-auto pr-1">
          {(snapshot?.recentMemories ?? []).map((mem) => (
            <div
              key={mem.id}
              className="glass-panel-subtle group flex items-start justify-between gap-2 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1">
                  <span className="font-mono text-[9px] uppercase tracking-wider text-cyan-300/90">
                    {mem.memoryScope ?? 'semantic'} · {mem.category}
                  </span>
                  {mem.provenance === 'untrusted_external' && (
                    <span className="rounded border border-amber-400/30 bg-amber-500/10 px-1 py-0.2 font-mono text-[8px] uppercase text-amber-200">
                      quarantined
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs leading-snug text-slate-300">
                  {mem.content}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onDeleteMemory(mem.id)}
                aria-label={`Delete memory ${mem.id}`}
                className="shrink-0 rounded p-1 text-slate-500 transition hover:bg-rose-500/15 hover:text-rose-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Connected Tools & Future-Ready Interfaces */}
      <section aria-label="Connected Tools and Capabilities" className="glass-panel p-4">
        <div className="mb-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <PlugZap className="h-4 w-4 text-cyan-300" />
            <h3 className="font-display text-sm font-semibold text-slate-100">
              Tools &amp; Capability Interfaces
            </h3>
          </div>
          <span className="font-mono text-[10px] text-slate-400">
            {snapshot?.capabilities.length ?? 15} INTERFACES
          </span>
        </div>

        <p className="mb-3 text-xs text-slate-400">
          Honest capability matrix: unconfigured external tools are explicitly marked rather than simulated.
        </p>

        <div className="max-h-60 space-y-1.5 overflow-y-auto pr-1">
          {(snapshot?.capabilities ?? []).map((cap) => {
            const isConnected = cap.state === 'connected_local';
            const isBrowser = cap.state === 'browser_dependent';
            return (
              <div
                key={cap.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-slate-800/80 bg-slate-900/50 px-2.5 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-slate-200">
                    {cap.name}
                  </div>
                  <div className="truncate font-mono text-[10px] text-slate-500">
                    {cap.permissionTier}
                  </div>
                </div>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase ${
                    isConnected
                      ? 'border border-emerald-400/25 bg-emerald-500/10 text-emerald-300'
                      : isBrowser
                        ? 'border border-cyan-400/25 bg-cyan-500/10 text-cyan-200'
                        : 'border border-slate-700 bg-slate-950 text-slate-400'
                  }`}
                >
                  {isConnected ? 'Active Local' : isBrowser ? 'Browser API' : 'Not Connected'}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      {/* Proactive Monitoring Advisories */}
      {snapshot?.proactiveAdvisories && snapshot.proactiveAdvisories.length > 0 && (
        <section aria-label="Proactive Monitoring Advisories" className="glass-panel p-4">
          <div className="mb-2.5 flex items-center gap-2">
            <BellRing className="h-4 w-4 text-amber-300" />
            <h3 className="font-display text-sm font-semibold text-slate-100">
              Proactive Monitor
            </h3>
          </div>
          <div className="space-y-2">
            {snapshot.proactiveAdvisories.map((adv) => (
              <div key={adv.id} className="glass-panel-subtle px-3 py-2">
                <div className="font-mono text-[10px] font-semibold uppercase text-cyan-200">
                  {adv.title}
                </div>
                <p className="mt-0.5 text-xs text-slate-400">{adv.summary}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

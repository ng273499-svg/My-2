'use client';

import React from 'react';
import {
  Cpu,
  Database,
  PlugZap,
  Settings,
  ShieldCheck,
  UserCheck,
  UserCircle2,
} from 'lucide-react';
import type { JarvisSystemSnapshot } from '@/core/types';
import type { BrowserOperatorSession } from '@/lib/supabase-browser';

interface TopStatusBarProps {
  snapshot: JarvisSystemSnapshot | null;
  operatorSession: BrowserOperatorSession | null;
  clientRlsSynced: boolean;
  onOpenAuth: () => void;
  onOpenSettings: (initialTab?: 'persona' | 'models' | 'supabase' | 'security') => void;
}

export function TopStatusBar({
  snapshot,
  operatorSession,
  clientRlsSynced,
  onOpenAuth,
  onOpenSettings,
}: TopStatusBarProps) {
  const connectedCount =
    snapshot?.capabilities.filter((c) => c.state === 'connected_local').length ?? 3;
  const standbyCount = (snapshot?.capabilities.length ?? 15) - connectedCount;

  const isCloudPersisted =
    snapshot?.supabase.persistenceMode === 'supabase_cloud' || clientRlsSynced;
  const isDegraded =
    snapshot?.supabase.persistenceMode === 'degraded_fallback' && !clientRlsSynced;

  return (
    <header className="sticky top-0 z-30 border-b border-cyan-400/[0.10] bg-[#050914]/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-2 px-3 py-2.5 sm:px-5">
        {/* Brand Identity */}
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            aria-hidden="true"
            className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-400/30 bg-cyan-500/10 shadow-[0_0_20px_rgba(34,211,238,0.18)]"
          >
            <span className="h-2.5 w-2.5 rounded-full bg-cyan-300 shadow-[0_0_10px_#67e8f9]" />
            <span className="absolute inset-1 rounded-lg border border-cyan-300/25" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate font-display text-base font-bold tracking-[0.14em] text-slate-100 sm:text-lg">
                JARVIS-X
              </h1>
              <span className="hidden rounded-md border border-cyan-400/20 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-cyan-300 sm:inline-block">
                v0.6 VOICE &amp; PERSONA
              </span>
            </div>
            <p className="truncate font-mono text-[10px] uppercase tracking-[0.16em] text-slate-400">
              Modular Personal AI Architecture
            </p>
          </div>
        </div>

        {/* Status Telemetry Pills */}
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          {/* System Status */}
          <div
            title="Core System Status"
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
              isDegraded
                ? 'border-amber-400/30 bg-amber-500/10 text-amber-200'
                : 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200'
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                isDegraded
                  ? 'bg-amber-400 shadow-[0_0_8px_#fbbf24]'
                  : 'bg-emerald-400 shadow-[0_0_8px_#34d399]'
              }`}
            />
            <span className="font-mono text-[11px] font-medium tracking-wider">
              {isDegraded ? 'FALLBACK' : 'ONLINE'}
            </span>
          </div>

          {/* Active Model & Routing Policy Indicator */}
          <button
            type="button"
            onClick={() => onOpenSettings('models')}
            title="Inspect Multi-Model Intelligence Router"
            className="hidden min-h-[36px] items-center gap-1.5 rounded-full border border-cyan-400/20 bg-slate-900/80 px-3 py-1 text-xs text-slate-200 transition hover:border-cyan-400/45 hover:bg-slate-900 md:inline-flex"
          >
            <Cpu className="h-3.5 w-3.5 text-cyan-300" />
            <span className="font-mono text-[11px] text-slate-300">
              {snapshot?.activeModel.displayName ?? 'Foundation Core v0.4'}
            </span>
            <span className="rounded border border-cyan-400/25 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[9px] uppercase text-cyan-200">
              {snapshot?.modelSystem?.routingPolicy ?? 'AUTO_BALANCED'}
            </span>
            {snapshot?.modelSystem?.fallbackActive && (
              <span className="rounded border border-amber-400/30 bg-amber-500/15 px-1.5 py-0.5 font-mono text-[9px] uppercase text-amber-200">
                FALLBACK
              </span>
            )}
          </button>

          {/* Memory & Supabase Persistence Status */}
          <button
            type="button"
            onClick={() => onOpenSettings('supabase')}
            title="Inspect Memory & Supabase Data Layer"
            className="hidden min-h-[36px] items-center gap-1.5 rounded-full border border-slate-700/80 bg-slate-900/75 px-3 py-1 text-xs text-slate-300 transition hover:border-cyan-400/35 lg:inline-flex"
          >
            <Database className="h-3.5 w-3.5 text-indigo-300" />
            <span className="font-mono text-[11px]">
              MEM: {snapshot?.memory.storedEntriesCount ?? 2}{' '}
              <span
                className={
                  isCloudPersisted
                    ? 'text-emerald-300'
                    : isDegraded
                      ? 'text-amber-300'
                      : 'text-slate-400'
                }
              >
                ({isCloudPersisted ? 'SUPABASE RLS' : isDegraded ? 'FALLBACK' : 'GUEST'})
              </span>
            </span>
          </button>

          {/* Connected Tools Indicator */}
          <button
            type="button"
            onClick={() => onOpenSettings('supabase')}
            title="Connected Tools & Future Capabilities"
            className="hidden min-h-[36px] items-center gap-1.5 rounded-full border border-slate-700/80 bg-slate-900/75 px-3 py-1 text-xs text-slate-300 transition hover:border-cyan-400/35 xl:inline-flex"
          >
            <PlugZap className="h-3.5 w-3.5 text-cyan-300" />
            <span className="font-mono text-[11px]">
              TOOLS: <span className="text-emerald-300">{connectedCount} READY</span> ·{' '}
              <span className="text-slate-400">{standbyCount} UNLINKED</span>
            </span>
          </button>

          {/* Security Policy Badge */}
          <button
            type="button"
            onClick={() => onOpenSettings('security')}
            title="3-Tier Permission & Audit Governance"
            className="hidden min-h-[36px] items-center gap-1 rounded-full border border-cyan-400/15 bg-slate-900/70 px-2.5 py-1 text-xs text-cyan-200 transition hover:border-cyan-400/40 xl:inline-flex"
          >
            <ShieldCheck className="h-3.5 w-3.5 text-cyan-300" />
            <span className="font-mono text-[10px] tracking-wider">RLS + 3-TIER</span>
          </button>

          {/* Operator Auth Button (44px accessible target) */}
          <button
            type="button"
            onClick={onOpenAuth}
            aria-label={
              operatorSession
                ? `Operator authenticated as ${operatorSession.displayName}`
                : 'Sign in to Supabase Operator Account'
            }
            className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border px-2.5 font-mono text-xs transition focus:outline-none focus:ring-2 focus:ring-cyan-400/50 ${
              operatorSession
                ? 'border-emerald-400/35 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25'
                : 'border-cyan-400/25 bg-slate-900/85 text-cyan-200 hover:border-cyan-300/50 hover:bg-cyan-500/15'
            }`}
          >
            {operatorSession ? (
              <>
                <UserCheck className="h-4 w-4 shrink-0 text-emerald-300" />
                <span className="hidden max-w-[100px] truncate sm:inline">
                  {operatorSession.displayName}
                </span>
              </>
            ) : (
              <>
                <UserCircle2 className="h-4 w-4 shrink-0 text-cyan-300" />
                <span className="hidden sm:inline">Sign In</span>
              </>
            )}
          </button>

          {/* Settings Trigger (44x44 accessible tap target) */}
          <button
            type="button"
            onClick={() => onOpenSettings('persona')}
            aria-label="Open JARVIS-X Settings and Architecture Controls"
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-cyan-400/25 bg-slate-900/80 text-cyan-200 transition hover:border-cyan-300/50 hover:bg-cyan-500/15 focus:outline-none focus:ring-2 focus:ring-cyan-400/50"
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </div>
    </header>
  );
}

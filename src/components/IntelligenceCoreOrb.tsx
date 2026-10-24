'use client';

import React from 'react';
import type { ResponseStyle } from '@/core/types';

export type CoreVisualState =
  | 'idle'
  | 'listening'
  | 'processing'
  | 'speaking'
  | 'awaiting_permission';

interface IntelligenceCoreOrbProps {
  visualState: CoreVisualState;
  activeStyle: ResponseStyle;
  activeStageLabel?: string;
  voiceProfileName?: string;
  compact?: boolean;
}

const STATE_PALETTE: Record<
  CoreVisualState,
  {
    label: string;
    primaryHex: string;
    secondaryHex: string;
    badgeClass: string;
    glowShadow: string;
  }
> = {
  idle: {
    label: 'CORE NOMINAL · STANDBY',
    primaryHex: '#38BDF8',
    secondaryHex: '#22D3EE',
    badgeClass: 'border-cyan-400/30 bg-cyan-500/10 text-cyan-200',
    glowShadow: 'radial-gradient(circle, rgba(56,189,248,0.28) 0%, rgba(14,165,233,0.06) 55%, transparent 75%)',
  },
  listening: {
    label: 'CLIENT AUDIO CAPTURE · LISTENING',
    primaryHex: '#2DD4BF',
    secondaryHex: '#38BDF8',
    badgeClass: 'border-teal-400/35 bg-teal-500/15 text-teal-200',
    glowShadow: 'radial-gradient(circle, rgba(45,212,191,0.34) 0%, rgba(56,189,248,0.08) 55%, transparent 75%)',
  },
  processing: {
    label: 'COGNITIVE PIPELINE · ACTIVE',
    primaryHex: '#818CF8',
    secondaryHex: '#38BDF8',
    badgeClass: 'border-indigo-400/35 bg-indigo-500/15 text-indigo-200',
    glowShadow: 'radial-gradient(circle, rgba(129,140,248,0.36) 0%, rgba(56,189,248,0.10) 55%, transparent 75%)',
  },
  speaking: {
    label: 'VOICE SYNTHESIS · SPEAKING',
    primaryHex: '#34D399',
    secondaryHex: '#22D3EE',
    badgeClass: 'border-emerald-400/35 bg-emerald-500/15 text-emerald-200',
    glowShadow: 'radial-gradient(circle, rgba(52,211,153,0.34) 0%, rgba(34,211,238,0.08) 55%, transparent 75%)',
  },
  awaiting_permission: {
    label: 'SECURITY GATE · OPERATOR REQUIRED',
    primaryHex: '#FBBF24',
    secondaryHex: '#FB7185',
    badgeClass: 'border-amber-400/40 bg-amber-500/15 text-amber-200',
    glowShadow: 'radial-gradient(circle, rgba(251,191,36,0.32) 0%, rgba(251,113,133,0.08) 55%, transparent 75%)',
  },
};

export function IntelligenceCoreOrb({
  visualState,
  activeStyle,
  activeStageLabel,
  voiceProfileName = 'Aria Persona Profile (Calm)',
  compact = false,
}: IntelligenceCoreOrbProps) {
  const palette = STATE_PALETTE[visualState];

  if (compact) {
    return (
      <div
        data-testid="jarvis-core-orb-compact"
        className="flex items-center justify-between gap-3 rounded-2xl border border-cyan-400/15 bg-slate-950/75 px-3.5 py-2.5 backdrop-blur-xl"
      >
        <div className="flex min-w-0 items-center gap-3">
          <div className="relative flex h-12 w-12 shrink-0 items-center justify-center">
            <div
              className="absolute inset-0 rounded-full"
              style={{ background: palette.glowShadow }}
            />
            <svg viewBox="0 0 120 120" className="h-12 w-12" aria-label="JARVIS-X Intelligence Core">
              <circle
                cx="60"
                cy="60"
                r="52"
                fill="none"
                stroke={palette.primaryHex}
                strokeOpacity="0.22"
                strokeWidth="1.5"
                strokeDasharray="6 6"
                className="animate-orbit-cw"
              />
              <circle
                cx="60"
                cy="60"
                r="38"
                fill="none"
                stroke={palette.secondaryHex}
                strokeOpacity="0.45"
                strokeWidth="2"
                strokeDasharray="34 14 12 14"
                className="animate-orbit-ccw"
              />
              <circle
                cx="60"
                cy="60"
                r="18"
                fill={palette.primaryHex}
                fillOpacity="0.24"
                stroke={palette.primaryHex}
                strokeWidth="2"
                className="animate-core-breathe"
              />
              <circle cx="60" cy="60" r="6" fill={palette.primaryHex} />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wider ${palette.badgeClass}`}
              >
                {activeStageLabel || palette.label}
              </span>
              <span className="rounded-md border border-slate-700/80 bg-slate-900/90 px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-300">
                Style: {activeStyle}
              </span>
            </div>
            <p className="mt-1 truncate font-mono text-[10px] text-slate-400">
              {voiceProfileName}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <section
      aria-label="JARVIS-X Central Intelligence Core"
      data-testid="jarvis-core-orb"
      className="glass-panel flex flex-col items-center overflow-hidden p-5"
    >
      <div className="flex w-full items-center justify-between text-[10px] font-mono uppercase tracking-[0.16em] text-slate-400">
        <span>INTELLIGENCE CORE // ORB-X1</span>
        <span className="text-cyan-300/90">HARMONIC LOCK</span>
      </div>

      {/* Central Original Geometric Intelligence Orb */}
      <div className="relative my-3 flex h-52 w-52 items-center justify-center sm:h-56 sm:w-56">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-full transition-all duration-700"
          style={{ background: palette.glowShadow }}
        />

        <svg
          viewBox="0 0 240 240"
          className="relative z-10 h-full w-full"
          role="img"
          aria-label={`JARVIS-X AI Core in ${visualState} state`}
        >
          <defs>
            <radialGradient id="jarvisNucleusGrad" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.95" />
              <stop offset="35%" stopColor={palette.primaryHex} stopOpacity="0.85" />
              <stop offset="75%" stopColor={palette.secondaryHex} stopOpacity="0.22" />
              <stop offset="100%" stopColor={palette.secondaryHex} stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Outer precision degree ring */}
          <circle
            cx="120"
            cy="120"
            r="108"
            fill="none"
            stroke={palette.primaryHex}
            strokeOpacity="0.16"
            strokeWidth="1"
          />

          {/* Clockwise outer segmented telemetry arc */}
          <g className="animate-orbit-cw">
            <circle
              cx="120"
              cy="120"
              r="98"
              fill="none"
              stroke={palette.primaryHex}
              strokeOpacity="0.38"
              strokeWidth="1.75"
              strokeDasharray="48 18 12 18 84 22"
              strokeLinecap="round"
            />
            <circle cx="120" cy="22" r="3" fill={palette.primaryHex} fillOpacity="0.85" />
            <circle cx="218" cy="120" r="2.5" fill={palette.secondaryHex} fillOpacity="0.7" />
          </g>

          {/* Counter-clockwise harmonic ring */}
          <g className="animate-orbit-ccw">
            <circle
              cx="120"
              cy="120"
              r="78"
              fill="none"
              stroke={palette.secondaryHex}
              strokeOpacity="0.52"
              strokeWidth="2.2"
              strokeDasharray="64 24 20 24"
              strokeLinecap="round"
            />
            <polygon
              points="120,34 124,42 116,42"
              fill={palette.secondaryHex}
              fillOpacity="0.75"
            />
          </g>

          {/* Inner geometric lattice */}
          <g className="animate-orbit-cw" style={{ animationDuration: '38s' }}>
            <polygon
              points="120,62 170,91 170,149 120,178 70,149 70,91"
              fill="none"
              stroke={palette.primaryHex}
              strokeOpacity="0.24"
              strokeWidth="1.2"
            />
          </g>

          {/* Breathing Core Halo & Nucleus */}
          <g className="animate-core-breathe" style={{ transformOrigin: '120px 120px' }}>
            <circle
              cx="120"
              cy="120"
              r="46"
              fill="url(#jarvisNucleusGrad)"
            />
            <circle
              cx="120"
              cy="120"
              r="28"
              fill="none"
              stroke="#E0F2FE"
              strokeOpacity="0.65"
              strokeWidth="1.4"
            />
            <circle cx="120" cy="120" r="9" fill="#F8FAFC" />
          </g>
        </svg>
      </div>

      {/* State & Conversational Style Telemetry */}
      <div className="flex w-full flex-col items-center gap-2 text-center">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-[11px] font-medium tracking-wider ${palette.badgeClass}`}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: palette.primaryHex }}
          />
          {activeStageLabel || palette.label}
        </span>

        <div className="mt-1 grid w-full grid-cols-2 gap-2 pt-1 text-left">
          <div className="glass-panel-subtle px-3 py-2">
            <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
              Response Style
            </div>
            <div className="mt-0.5 font-display text-xs font-semibold capitalize text-cyan-200">
              {activeStyle}
            </div>
          </div>
          <div className="glass-panel-subtle px-3 py-2">
            <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
              Persona Profile
            </div>
            <div className="mt-0.5 truncate font-display text-xs font-semibold text-slate-200">
              {voiceProfileName}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

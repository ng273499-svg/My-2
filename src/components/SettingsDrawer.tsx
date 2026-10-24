'use client';

import React, { useState } from 'react';
import {
  Cpu,
  Database,
  ShieldCheck,
  Sliders,
  X,
} from 'lucide-react';
import type {
  JarvisSystemSnapshot,
  PersonalityPreferences,
  ResponseStyle,
  RoutingPolicyMode,
} from '@/core/types';
import type { DiscoveredBrowserVoice } from '@/lib/browser-voice';

interface SettingsDrawerProps {
  open: boolean;
  initialTab: 'persona' | 'models' | 'supabase' | 'security';
  snapshot: JarvisSystemSnapshot | null;
  clientRlsSynced?: boolean;
  discoveredVoices?: DiscoveredBrowserVoice[];
  selectedBrowserVoice?: DiscoveredBrowserVoice | null;
  ttsSupported?: boolean;
  onClose: () => void;
  onUpdatePreferences: (patch: Partial<PersonalityPreferences>) => Promise<void>;
}

const RESPONSE_STYLES: ResponseStyle[] = [
  'neutral',
  'calm',
  'confidence',
  'curiosity',
  'excitement',
  'concern',
  'seriousness',
  'humor',
  'urgency',
];

export function SettingsDrawer({
  open,
  initialTab,
  snapshot,
  clientRlsSynced = false,
  discoveredVoices = [],
  selectedBrowserVoice = null,
  ttsSupported = false,
  onClose,
  onUpdatePreferences,
}: SettingsDrawerProps) {
  const [activeTab, setActiveTab] = useState<'persona' | 'models' | 'supabase' | 'security'>(
    initialTab
  );

  React.useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, open]);

  if (!open) return null;

  const prefs = snapshot?.preferences;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="JARVIS-X Settings and Architecture Drawer"
      className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm"
    >
      <div className="flex h-full w-full max-w-xl flex-col border-l border-cyan-400/20 bg-[#060B17] text-slate-100 shadow-2xl">
        {/* Drawer Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <div>
            <h2 className="font-display text-base font-semibold tracking-wide text-slate-100">
              JARVIS-X Control &amp; Architecture Settings
            </h2>
            <p className="font-mono text-[11px] text-slate-400">
              Privileged secrets stay server-only · FORCE RLS enforced
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Settings Drawer"
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-800 bg-slate-900/80 text-slate-300 hover:border-cyan-400/40 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tab Bar */}
        <div className="grid grid-cols-4 gap-1 border-b border-slate-800 bg-slate-950/80 px-3 py-2">
          {[
            { id: 'persona' as const, label: 'Persona', icon: Sliders },
            { id: 'models' as const, label: 'Models', icon: Cpu },
            { id: 'supabase' as const, label: 'Supabase', icon: Database },
            { id: 'security' as const, label: 'Security', icon: ShieldCheck },
          ].map((tab) => {
            const Icon = tab.icon;
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg px-2 font-mono text-xs transition ${
                  selected
                    ? 'border border-cyan-400/35 bg-cyan-500/15 text-cyan-200'
                    : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {activeTab === 'persona' && prefs && (
            <>
              <div>
                <h3 className="font-display text-sm font-semibold text-slate-100">
                  Baseline Conversational Delivery Style
                </h3>
                <p className="mt-1 text-xs text-slate-400">
                  JARVIS-X dynamically shifts style per message context, using this selection as its calm baseline. Styles are delivery framing — never claims of biological emotion.
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {RESPONSE_STYLES.map((style) => (
                    <button
                      key={style}
                      type="button"
                      onClick={() => onUpdatePreferences({ preferredResponseStyle: style })}
                      className={`min-h-[40px] rounded-xl border px-3 py-2 font-mono text-xs capitalize transition ${
                        prefs.preferredResponseStyle === style
                          ? 'border-cyan-400/50 bg-cyan-500/20 text-cyan-100'
                          : 'border-slate-800 bg-slate-900/60 text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      {style}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="glass-panel-subtle p-3.5">
                  <label
                    htmlFor="wit-select"
                    className="block font-mono text-[11px] uppercase tracking-wider text-slate-400"
                  >
                    Wit Calibration
                  </label>
                  <select
                    id="wit-select"
                    value={prefs.witLevel}
                    onChange={(e) =>
                      onUpdatePreferences({
                        witLevel: e.target.value as PersonalityPreferences['witLevel'],
                      })
                    }
                    className="mt-2 min-h-[40px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-xs text-slate-100"
                  >
                    <option value="minimal">Minimal — Strictly Tactical</option>
                    <option value="subtle">Subtle — Dry &amp; Intelligent (Default)</option>
                    <option value="moderate">Moderate — Warm &amp; Witty</option>
                  </select>
                </div>

                <div className="glass-panel-subtle p-3.5">
                  <label
                    htmlFor="concise-select"
                    className="block font-mono text-[11px] uppercase tracking-wider text-slate-400"
                  >
                    Response Conciseness
                  </label>
                  <select
                    id="concise-select"
                    value={prefs.conciseness}
                    onChange={(e) =>
                      onUpdatePreferences({
                        conciseness: e.target.value as PersonalityPreferences['conciseness'],
                      })
                    }
                    className="mt-2 min-h-[40px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-xs text-slate-100"
                  >
                    <option value="brief">Brief</option>
                    <option value="balanced">Balanced (Default)</option>
                    <option value="detailed">Detailed</option>
                  </select>
                </div>
              </div>

              <div className="glass-panel-subtle space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-display text-xs font-semibold text-slate-100">
                      JARVIS Persona &amp; Prosody Style Profile
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Aria &amp; Lyra define cadence/prosody profiles; actual audio uses a real device/browser voice.
                    </div>
                  </div>
                  <select
                    aria-label="Select Female Voice Persona Profile"
                    value={prefs.voiceProfileId}
                    onChange={(e) => onUpdatePreferences({ voiceProfileId: e.target.value })}
                    className="min-h-[40px] rounded-lg border border-slate-700 bg-slate-950 px-2.5 text-xs text-slate-100"
                  >
                    <option value="jarvis-x-aria-female-v1">Aria Persona (Calm Articulate)</option>
                    <option value="jarvis-x-lyra-female-v1">Lyra Persona (Crisp Tactical)</option>
                  </select>
                </div>

                <div className="border-t border-slate-800/80 pt-3">
                  <label
                    htmlFor="browser-tts-voice-select"
                    className="block font-display text-xs font-semibold text-slate-100"
                  >
                    Device / Browser Speech Output Voice (Zero-Cost TTS)
                  </label>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {ttsSupported
                      ? discoveredVoices.length > 0
                        ? `Active engine voice: ${selectedBrowserVoice ? `${selectedBrowserVoice.name} (${selectedBrowserVoice.lang})` : 'System Default'}`
                        : 'Browser SpeechSynthesis is available, waiting for system voices.'
                      : 'Browser SpeechSynthesis is unavailable on this device/browser.'}
                  </p>
                  <select
                    id="browser-tts-voice-select"
                    aria-label="Select Device Browser Speech Voice"
                    disabled={!ttsSupported || discoveredVoices.length === 0}
                    value={prefs.preferredBrowserVoiceUri ?? 'auto'}
                    onChange={(e) =>
                      onUpdatePreferences({
                        preferredBrowserVoiceUri:
                          e.target.value === 'auto' ? null : e.target.value,
                      })
                    }
                    className="mt-2 min-h-[40px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-xs text-slate-100 disabled:opacity-50"
                  >
                    <option value="auto">
                      Auto — Prefer Available Female-Presenting System Voice
                    </option>
                    {discoveredVoices.map((v) => (
                      <option key={v.voiceURI} value={v.voiceURI}>
                        {v.name} ({v.lang}){v.localService ? ' · Local' : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <label className="flex items-center justify-between gap-3 border-t border-slate-800/80 pt-3 text-xs text-slate-300">
                  <span>Mute Assistant Voice Playback</span>
                  <input
                    type="checkbox"
                    aria-label="Mute Assistant Voice Playback"
                    checked={Boolean(prefs.voiceMuted)}
                    onChange={(e) =>
                      onUpdatePreferences({ voiceMuted: e.target.checked })
                    }
                    className="h-4 w-4 accent-cyan-400"
                  />
                </label>

                <label className="flex items-center justify-between gap-3 border-t border-slate-800/80 pt-3 text-xs text-slate-300">
                  <span>Auto-Speak Assistant Replies (Zero-Cost Browser TTS)</span>
                  <input
                    type="checkbox"
                    checked={Boolean(prefs.voiceAutoSpeak)}
                    onChange={(e) =>
                      onUpdatePreferences({ voiceAutoSpeak: e.target.checked })
                    }
                    className="h-4 w-4 accent-cyan-400"
                  />
                </label>

                <label className="flex items-center justify-between gap-3 border-t border-slate-800/80 pt-3 text-xs text-slate-300">
                  <span>Enable Voice Barge-In Interruption</span>
                  <input
                    type="checkbox"
                    checked={Boolean(prefs.voiceBargeInEnabled)}
                    onChange={(e) =>
                      onUpdatePreferences({ voiceBargeInEnabled: e.target.checked })
                    }
                    className="h-4 w-4 accent-cyan-400"
                  />
                </label>

                <label className="flex items-center justify-between gap-3 border-t border-slate-800/80 pt-3 text-xs text-slate-300">
                  <span>Enable In-Session Proactive Assistance Advisories</span>
                  <input
                    type="checkbox"
                    checked={prefs.proactiveAssistanceEnabled}
                    onChange={(e) =>
                      onUpdatePreferences({ proactiveAssistanceEnabled: e.target.checked })
                    }
                    className="h-4 w-4 accent-cyan-400"
                  />
                </label>
              </div>
            </>
          )}

          {activeTab === 'models' && snapshot && (
            <div className="space-y-4">
              <div>
                <h3 className="font-display text-sm font-semibold text-slate-100">
                  Multi-Model Intelligence Router (`RuntimeModelRouter`)
                </h3>
                <p className="mt-1 text-xs text-slate-400">
                  Provider-agnostic routing with capability/modality matching, circuit breakers, and bounded fallback. Provider secrets stay strictly server-only.
                </p>
              </div>

              {/* Active Route & Fallback Summary */}
              <div className="glass-panel-subtle space-y-2.5 p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
                      Active Provider &amp; Model
                    </div>
                    <div className="font-display text-xs font-semibold text-cyan-100">
                      {snapshot.activeModel.displayName}{' '}
                      <span className="font-mono text-[10px] text-slate-400">
                        ({snapshot.modelSystem?.activeProviderId ?? snapshot.activeModel.providerId}/
                        {snapshot.modelSystem?.activeModelId ?? snapshot.activeModel.id})
                      </span>
                    </div>
                  </div>
                  <span
                    className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase ${
                      snapshot.modelSystem?.fallbackActive
                        ? 'border border-amber-400/35 bg-amber-500/15 text-amber-200'
                        : 'border border-emerald-400/30 bg-emerald-500/15 text-emerald-300'
                    }`}
                  >
                    {snapshot.modelSystem?.fallbackActive ? 'Fallback Active' : 'Primary Route'}
                  </span>
                </div>

                {/* Routing Policy Selector */}
                <div>
                  <label
                    htmlFor="routing-policy-select"
                    className="block font-mono text-[10px] uppercase tracking-wider text-slate-400"
                  >
                    Routing Policy Mode
                  </label>
                  <select
                    id="routing-policy-select"
                    aria-label="Select Model Routing Policy"
                    value={
                      snapshot.preferences.routingPolicy ??
                      snapshot.modelSystem?.routingPolicy ??
                      'AUTO_BALANCED'
                    }
                    onChange={(e) =>
                      onUpdatePreferences({
                        routingPolicy: e.target.value as RoutingPolicyMode,
                      })
                    }
                    className="mt-1.5 min-h-[40px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 font-mono text-xs text-slate-100"
                  >
                    <option value="AUTO_BALANCED">AUTO_BALANCED (Default)</option>
                    <option value="QUALITY_FIRST">QUALITY_FIRST — Highest Capability Tier</option>
                    <option value="SPEED_FIRST">SPEED_FIRST — Lowest Latency</option>
                    <option value="COST_AWARE">COST_AWARE — Zero/Lowest Cost Compatible</option>
                    <option value="MANUAL">MANUAL — Explicit Model Override</option>
                  </select>
                </div>

                {(snapshot.preferences.routingPolicy === 'MANUAL' ||
                  snapshot.modelSystem?.routingPolicy === 'MANUAL') && (
                  <div>
                    <label
                      htmlFor="manual-model-select"
                      className="block font-mono text-[10px] uppercase tracking-wider text-slate-400"
                    >
                      Manual Model Override
                    </label>
                    <select
                      id="manual-model-select"
                      aria-label="Select Manual Model Override"
                      value={snapshot.preferences.manualModelId ?? 'foundation-local-v1'}
                      onChange={(e) =>
                        onUpdatePreferences({ manualModelId: e.target.value })
                      }
                      className="mt-1.5 min-h-[40px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 font-mono text-xs text-slate-100"
                    >
                      {(snapshot.modelSystem?.catalog ?? []).map((m) => (
                        <option key={m.modelId} value={m.modelId}>
                          {m.displayName} [{m.configurationState}]
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {/* Provider Health & Circuit Breaker Matrix */}
              {snapshot.modelSystem?.providerHealth && (
                <div>
                  <h4 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                    Provider Health &amp; Circuit Breakers
                  </h4>
                  <div className="space-y-2">
                    {snapshot.modelSystem.providerHealth.map((ph) => (
                      <div
                        key={ph.providerId}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs"
                      >
                        <div className="min-w-0">
                          <div className="font-display font-medium text-slate-200">
                            {ph.providerName}
                          </div>
                          <div className="font-mono text-[10px] text-slate-400">
                            Circuit: {ph.circuitState} · Reliability:{' '}
                            {Math.round(ph.effectiveReliability * 100)}%
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 font-mono text-[10px]">
                          <span
                            className={`rounded px-1.5 py-0.5 ${
                              ph.configurationState === 'CONFIGURED'
                                ? 'border border-cyan-400/30 bg-cyan-500/10 text-cyan-200'
                                : 'border border-slate-700 bg-slate-950 text-slate-400'
                            }`}
                          >
                            {ph.configurationState}
                          </span>
                          <span
                            className={`rounded px-1.5 py-0.5 ${
                              ph.healthState === 'AVAILABLE'
                                ? 'border border-emerald-400/30 bg-emerald-500/15 text-emerald-300'
                                : ph.healthState === 'DEGRADED'
                                  ? 'border border-amber-400/30 bg-amber-500/15 text-amber-200'
                                  : 'border border-slate-700 bg-slate-950 text-slate-400'
                            }`}
                          >
                            {ph.healthState}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Registered Model Catalog */}
              <div>
                <h4 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                  Dynamic Model Registry ({snapshot.modelSystem?.catalog.length ?? snapshot.registeredModels.length})
                </h4>
                <div className="space-y-2.5">
                  {(snapshot.modelSystem?.catalog ?? []).map((model) => {
                    const isConfigured = model.configurationState === 'CONFIGURED';
                    return (
                      <div key={model.modelId} className="glass-panel-subtle p-3.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate font-display text-xs font-semibold text-slate-100">
                              {model.displayName}
                            </div>
                            <div className="font-mono text-[10px] text-slate-400">
                              {model.providerName} · ctx:{' '}
                              {typeof model.contextWindowTokens === 'number'
                                ? model.contextWindowTokens.toLocaleString()
                                : 'UNKNOWN'}{' '}
                              · cost: {model.costClass} · latency: {model.latencyClass}
                            </div>
                          </div>
                          <span
                            className={`shrink-0 rounded px-2 py-0.5 font-mono text-[10px] uppercase ${
                              isConfigured && model.healthStatus === 'AVAILABLE'
                                ? 'border border-emerald-400/30 bg-emerald-500/15 text-emerald-300'
                                : isConfigured
                                  ? 'border border-amber-400/30 bg-amber-500/15 text-amber-200'
                                  : 'border border-slate-700 bg-slate-950 text-slate-400'
                            }`}
                          >
                            {isConfigured ? model.healthStatus : 'UNCONFIGURED'}
                          </span>
                        </div>
                        <p className="mt-2 text-xs text-slate-400">{model.statusNote}</p>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {model.capabilities.map((cap) => (
                            <span
                              key={cap}
                              className="rounded border border-slate-800 bg-slate-950/90 px-1.5 py-0.5 font-mono text-[10px] text-cyan-200/80"
                            >
                              {cap}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="pt-2">
                <h4 className="mb-2 font-display text-xs font-semibold uppercase tracking-wider text-slate-300">
                  14 Modular Core Subsystems
                </h4>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {snapshot.modules.map((mod) => (
                    <div key={mod.id} className="glass-panel-subtle px-3 py-2">
                      <div className="flex items-center justify-between">
                        <span className="font-display text-xs font-medium text-slate-200">
                          {mod.name}
                        </span>
                        <span
                          className={`font-mono text-[9px] uppercase ${
                            mod.state === 'online' ? 'text-emerald-300' : 'text-amber-300'
                          }`}
                        >
                          {mod.state === 'online' ? 'ONLINE' : 'INTERFACE'}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-slate-400">{mod.summary}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'supabase' && snapshot && (
            <div className="space-y-4">
              <div className="glass-panel-subtle p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-display text-sm font-semibold text-slate-100">
                    Supabase Persistence &amp; Auth Layer
                  </span>
                  <span
                    className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase ${
                      snapshot.supabase.persistenceMode === 'supabase_cloud' || clientRlsSynced
                        ? 'border border-emerald-400/30 bg-emerald-500/15 text-emerald-300'
                        : snapshot.supabase.configured
                          ? 'border border-amber-400/30 bg-amber-500/15 text-amber-200'
                          : 'border border-slate-700 bg-slate-950 text-slate-400'
                    }`}
                  >
                    {snapshot.supabase.persistenceMode === 'supabase_cloud' || clientRlsSynced
                      ? 'Cloud RLS Active'
                      : snapshot.supabase.configured
                        ? 'Configured · Fallback Ready'
                        : 'Not Configured'}
                  </span>
                </div>

                <p className="mt-2 text-xs leading-relaxed text-slate-300">
                  {snapshot.supabase.statusDetail}
                </p>

                <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-[11px]">
                  <div className="rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-2">
                    <div className="text-[10px] text-slate-500">PROJECT REF</div>
                    <div className="truncate text-cyan-200">
                      {snapshot.supabase.projectRef || 'Unset'}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-2">
                    <div className="text-[10px] text-slate-500">VECTOR &amp; RLS</div>
                    <div className="text-emerald-300">
                      pgvector 0.8 + FORCE RLS
                    </div>
                  </div>
                </div>

                <div className="mt-3 space-y-1 rounded-lg border border-slate-800 bg-slate-950 p-2.5 font-mono text-[10px] text-cyan-200">
                  {(snapshot.supabase.migrationPaths ?? [snapshot.supabase.migrationPath]).map(
                    (path) => (
                      <div key={path} className="truncate">
                        ✓ {path}
                      </div>
                    )
                  )}
                </div>
              </div>

              {/* 7-Scope Hierarchical Memory Engine Diagnostics */}
              <div className="glass-panel-subtle p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-display text-xs font-semibold uppercase tracking-wider text-slate-200">
                    7-Scope Hierarchical Memory Engine
                  </span>
                  <span className="rounded border border-cyan-400/25 bg-cyan-500/10 px-2 py-0.5 font-mono text-[10px] text-cyan-200">
                    {snapshot.memory.isNeuralEmbeddingActive
                      ? 'OpenAI Neural 1536'
                      : 'Deterministic Hash 1536'}
                  </span>
                </div>
                <p className="mt-1.5 text-xs text-slate-400">
                  Active: {snapshot.memory.activeEntriesCount ?? snapshot.memory.storedEntriesCount} · Superseded:{' '}
                  {snapshot.memory.supersededEntriesCount ?? 0} · Expired Filtered:{' '}
                  {snapshot.memory.expiredEntriesCount ?? 0}
                </p>
                {snapshot.memory.countsByScope && (
                  <div className="mt-2.5 grid grid-cols-2 gap-1.5 font-mono text-[11px] sm:grid-cols-4">
                    {Object.entries(snapshot.memory.countsByScope).map(([scope, count]) => (
                      <div
                        key={scope}
                        className="flex items-center justify-between rounded border border-slate-800 bg-slate-950 px-2 py-1.5"
                      >
                        <span className="capitalize text-slate-400">{scope}</span>
                        <span className="text-cyan-200">{count}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <h4 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                  {snapshot.supabase.domainsPrepared.length} Active Schema &amp; RLS Domains
                </h4>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {snapshot.supabase.domainsPrepared.map((domain) => (
                    <div
                      key={domain}
                      className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 font-mono text-xs text-slate-200"
                    >
                      <span>{domain}</span>
                      <span className="text-[10px] text-emerald-300">FORCE RLS</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'security' && snapshot && (
            <div className="space-y-4">
              <div className="space-y-2">
                <h3 className="font-display text-sm font-semibold text-slate-100">
                  3-Tier Permission Governance &amp; Immutable Audit Trail
                </h3>
                <div className="glass-panel-subtle p-3 text-xs">
                  <div className="font-mono font-semibold text-emerald-300">
                    1. SAFE_READ
                  </div>
                  <p className="mt-0.5 text-slate-400">
                    Read-only diagnostics, memory queries, and dialogue synthesis. Auto-approved &amp; logged.
                  </p>
                </div>
                <div className="glass-panel-subtle p-3 text-xs">
                  <div className="font-mono font-semibold text-amber-300">
                    2. CONFIRMATION_REQUIRED
                  </div>
                  <p className="mt-0.5 text-slate-400">
                    Memory mutations, scheduled routines, and state writes. Pauses execution for explicit operator approval.
                  </p>
                </div>
                <div className="glass-panel-subtle p-3 text-xs">
                  <div className="font-mono font-semibold text-rose-300">
                    3. SENSITIVE_AUTH_REQUIRED
                  </div>
                  <p className="mt-0.5 text-slate-400">
                    Smart-home locks/devices, browser/computer actions, code execution, and destructive purges. Requires explicit step-up verification.
                  </p>
                </div>
              </div>

              <div>
                <h4 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                  Permission Records ({snapshot.permissionAudit.length})
                </h4>
                {snapshot.permissionAudit.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    No permission evaluations recorded in this session yet.
                  </p>
                ) : (
                  <div className="max-h-44 space-y-2 overflow-y-auto pr-1">
                    {snapshot.permissionAudit.map((rec) => (
                      <div key={rec.id} className="glass-panel-subtle px-3 py-2 text-xs">
                        <div className="flex items-center justify-between font-mono text-[11px]">
                          <span className="text-slate-200">{rec.actionCode}</span>
                          <span
                            className={
                              rec.decision === 'approved' || rec.decision === 'auto_allowed'
                                ? 'text-emerald-300'
                                : rec.decision === 'pending'
                                  ? 'text-amber-300'
                                  : 'text-rose-300'
                            }
                          >
                            {rec.decision}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[10px] text-slate-500">
                          Tier: {rec.tier} · Target: {rec.targetResource}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <h4 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                  Immutable Audit Logs ({snapshot.auditLogs?.length ?? 0})
                </h4>
                {(snapshot.auditLogs ?? []).length === 0 ? (
                  <p className="text-xs text-slate-500">
                    No audit log events recorded yet.
                  </p>
                ) : (
                  <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
                    {(snapshot.auditLogs ?? []).map((log) => (
                      <div key={log.id} className="glass-panel-subtle px-3 py-2 text-xs">
                        <div className="flex items-center justify-between font-mono text-[11px]">
                          <span className="text-cyan-200">{log.eventType}</span>
                          <span className="text-[10px] uppercase text-slate-400">
                            {log.entityType}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] text-slate-300">{log.summary}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

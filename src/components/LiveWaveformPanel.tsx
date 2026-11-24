'use client';

import React, { useEffect, useState } from 'react';
import {
  Hand,
  Square,
  Volume2,
  VolumeX,
  Waves,
} from 'lucide-react';
import type { ResponseStyle } from '@/core/types';
import type { VoiceSessionMachineState } from '@/core/voice';
import type { DiscoveredBrowserVoice } from '@/lib/browser-voice';

interface LiveWaveformPanelProps {
  voiceState?: VoiceSessionMachineState;
  isMicActive: boolean;
  isProcessing: boolean;
  isSpeaking?: boolean;
  isMuted?: boolean;
  autoSpeakEnabled?: boolean;
  personaProfileLabel?: string;
  activeStyle?: ResponseStyle;
  discoveredVoices?: DiscoveredBrowserVoice[];
  selectedBrowserVoice?: DiscoveredBrowserVoice | null;
  preferredBrowserVoiceUri?: string | null;
  ttsSupported?: boolean;
  sttSupported?: boolean;
  micLevels?: number[];
  compact?: boolean;
  onStopSpeaking?: () => void;
  onInterruptAndListen?: () => void;
  onToggleMute?: () => void;
  onSelectBrowserVoiceUri?: (voiceUri: string | null) => void;
}

const BAR_COUNT = 24;

export function LiveWaveformPanel({
  voiceState = 'IDLE',
  isMicActive,
  isProcessing,
  isSpeaking = false,
  isMuted = false,
  autoSpeakEnabled = false,
  personaProfileLabel = 'Aria Persona',
  activeStyle = 'calm',
  discoveredVoices = [],
  selectedBrowserVoice = null,
  preferredBrowserVoiceUri = null,
  ttsSupported = false,
  sttSupported = false,
  micLevels,
  compact = false,
  onStopSpeaking,
  onInterruptAndListen,
  onToggleMute,
  onSelectBrowserVoiceUri,
}: LiveWaveformPanelProps) {
  const [phase, setPhase] = useState(0);

  // Only animate during genuine active speech playback or live mic fallback when levels aren't provided.
  // Never display fake idle waveform oscillations when no actual voice activity exists.
  const hasRealVoiceActivity = isMicActive || isSpeaking;

  useEffect(() => {
    if (!hasRealVoiceActivity) {
      setPhase(0);
      return;
    }
    const interval = window.setInterval(() => {
      setPhase((p) => (p + 1) % 360);
    }, 85);
    return () => window.clearInterval(interval);
  }, [hasRealVoiceActivity]);

  const bars = Array.from({ length: BAR_COUNT }, (_, idx) => {
    if (isMicActive) {
      if (micLevels && micLevels.length > 0) {
        const level = micLevels[idx % micLevels.length] ?? 0;
        return Math.max(8, Math.min(96, Math.round(level * 100)));
      }
      // Minimal flat listening indicator when browser doesn't expose Web Audio AnalyserNode
      return 16;
    }
    if (isSpeaking && !isMuted) {
      const wave =
        Math.sin(idx * 0.65 + phase * 0.55) * 0.35 +
        Math.cos(idx * 0.3 - phase * 0.35) * 0.25 +
        0.5;
      return Math.max(16, Math.min(92, Math.round(18 + wave * 64)));
    }
    // Honest resting flat baseline (0 fake activity when idle/processing/unsupported/muted)
    return 8;
  });

  const resolvedStateBadge = (() => {
    if (voiceState === 'UNSUPPORTED' || (!sttSupported && !ttsSupported)) {
      return 'UNSUPPORTED';
    }
    if (voiceState === 'ERROR') return 'VOICE ERROR';
    if (voiceState === 'REQUESTING_MIC_PERMISSION') return 'REQUESTING MIC';
    if (isMicActive || voiceState === 'LISTENING') return 'LISTENING';
    if (isSpeaking || voiceState === 'SPEAKING') return 'SPEAKING';
    if (voiceState === 'INTERRUPTING') return 'INTERRUPTING';
    if (isProcessing || voiceState === 'PROCESSING') return 'PROCESSING';
    if (isMuted) return 'MUTED';
    return autoSpeakEnabled ? 'IDLE · AUTO-TTS' : 'IDLE';
  })();

  const activeEngineVoiceLabel = !ttsSupported
    ? 'Browser TTS Unsupported'
    : selectedBrowserVoice
      ? `${selectedBrowserVoice.name} (${selectedBrowserVoice.lang})`
      : 'System Default Voice';

  if (compact) {
    return (
      <div
        data-testid="mobile-voice-hud"
        className="rounded-xl border border-slate-800/90 bg-slate-950/75 px-3 py-2"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Waves className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
            <div
              aria-label="Audio telemetry waveform"
              data-active-voice={hasRealVoiceActivity ? 'true' : 'false'}
              className="flex h-5 w-24 items-center justify-between gap-[2px] sm:w-32"
            >
              {bars.slice(0, 16).map((h, idx) => (
                <span
                  key={idx}
                  style={{ height: `${h}%` }}
                  className={`w-1 rounded-full transition-all duration-100 ${
                    isMicActive
                      ? 'bg-teal-400'
                      : isSpeaking && !isMuted
                        ? 'bg-emerald-400'
                        : 'bg-slate-700/70'
                  }`}
                />
              ))}
            </div>
            <span
              role="status"
              aria-live="polite"
              className="truncate font-mono text-[10px] uppercase tracking-wider text-cyan-200"
            >
              {resolvedStateBadge}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {isSpeaking && onInterruptAndListen && sttSupported && (
              <button
                type="button"
                onClick={onInterruptAndListen}
                aria-label="Interrupt speech and listen"
                className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-amber-400/40 bg-amber-500/15 px-2.5 font-mono text-[10px] text-amber-100"
              >
                <Hand className="h-3.5 w-3.5" />
                <span>Interrupt</span>
              </button>
            )}
            {isSpeaking && onStopSpeaking && (
              <button
                type="button"
                onClick={onStopSpeaking}
                aria-label="Stop assistant voice playback"
                className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-rose-400/40 bg-rose-500/15 px-2.5 font-mono text-[10px] text-rose-100"
              >
                <Square className="h-3 w-3" />
                <span>Stop</span>
              </button>
            )}
            {onToggleMute && (
              <button
                type="button"
                onClick={onToggleMute}
                aria-label={isMuted ? 'Unmute assistant voice' : 'Mute assistant voice'}
                aria-pressed={isMuted}
                className={`inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border transition ${
                  isMuted
                    ? 'border-amber-400/40 bg-amber-500/15 text-amber-200'
                    : 'border-slate-700/90 bg-slate-900/90 text-slate-300'
                }`}
              >
                {isMuted ? (
                  <VolumeX className="h-4 w-4" />
                ) : (
                  <Volume2 className="h-4 w-4" />
                )}
              </button>
            )}
          </div>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/70 pt-1.5 font-mono text-[10px] text-slate-400">
          <span>
            Persona: <strong className="text-slate-200">{personaProfileLabel}</strong> · Style:{' '}
            <strong className="uppercase text-cyan-200">{activeStyle}</strong>
          </span>
          {onSelectBrowserVoiceUri && ttsSupported && discoveredVoices.length > 0 ? (
            <select
              aria-label="Select browser speech output voice"
              value={preferredBrowserVoiceUri ?? 'auto'}
              onChange={(e) =>
                onSelectBrowserVoiceUri(
                  e.target.value === 'auto' ? null : e.target.value
                )
              }
              className="min-h-[44px] max-w-[190px] truncate rounded-lg border border-slate-700 bg-slate-900 px-2 font-mono text-[10px] text-slate-200"
            >
              <option value="auto">Auto Voice ({selectedBrowserVoice?.name ?? 'Default'})</option>
              {discoveredVoices.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
          ) : (
            <span className="truncate text-slate-500">{activeEngineVoiceLabel}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <section
      aria-label="Live Audio and Voice Waveform Telemetry"
      className="glass-panel px-4 py-3.5"
    >
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Waves className="h-4 w-4 text-cyan-300" />
          <span
            role="status"
            aria-live="polite"
            className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-slate-200"
          >
            {resolvedStateBadge} · {personaProfileLabel}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {isSpeaking && onInterruptAndListen && sttSupported && (
            <button
              type="button"
              onClick={onInterruptAndListen}
              aria-label="Interrupt speech and listen"
              className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-amber-400/35 bg-amber-500/15 px-2.5 py-1 font-mono text-[10px] text-amber-100 hover:bg-amber-500/25"
            >
              <Hand className="h-3.5 w-3.5" />
              Interrupt
            </button>
          )}
          {isSpeaking && onStopSpeaking && (
            <button
              type="button"
              onClick={onStopSpeaking}
              aria-label="Stop assistant voice playback"
              className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-rose-400/35 bg-rose-500/15 px-2.5 py-1 font-mono text-[10px] text-rose-200 hover:bg-rose-500/25"
            >
              <Square className="h-3.5 w-3.5" />
              Stop Voice
            </button>
          )}
          {onToggleMute && (
            <button
              type="button"
              onClick={onToggleMute}
              aria-label={isMuted ? 'Unmute assistant voice' : 'Mute assistant voice'}
              aria-pressed={isMuted}
              title={isMuted ? 'Unmute Assistant Voice' : 'Mute Assistant Voice'}
              className={`inline-flex min-h-[44px] items-center gap-1 rounded-lg border px-2.5 py-1 font-mono text-[10px] transition ${
                isMuted
                  ? 'border-amber-400/40 bg-amber-500/15 text-amber-200'
                  : 'border-slate-700/80 bg-slate-900/90 text-cyan-200 hover:border-cyan-400/40'
              }`}
            >
              {isMuted ? (
                <>
                  <VolumeX className="h-3.5 w-3.5" />
                  Muted
                </>
              ) : (
                <>
                  <Volume2 className="h-3.5 w-3.5" />
                  Voice On
                </>
              )}
            </button>
          )}
        </div>
      </div>

      <div
        data-testid="desktop-voice-waveform"
        data-active-voice={hasRealVoiceActivity ? 'true' : 'false'}
        className="flex h-12 items-center justify-between gap-1 rounded-xl border border-slate-800/80 bg-slate-950/75 px-3 py-2"
      >
        {bars.map((heightPct, idx) => (
          <span
            key={idx}
            style={{ height: `${heightPct}%` }}
            className={`w-1.5 rounded-full transition-all duration-100 ${
              isMicActive
                ? 'bg-gradient-to-t from-teal-500/70 to-cyan-300 shadow-[0_0_8px_rgba(45,212,191,0.45)]'
                : isSpeaking && !isMuted
                  ? 'bg-gradient-to-t from-emerald-500/70 to-cyan-200 shadow-[0_0_8px_rgba(52,211,153,0.45)]'
                  : 'bg-slate-700/60'
            }`}
          />
        ))}
      </div>

      {onSelectBrowserVoiceUri && ttsSupported && discoveredVoices.length > 0 && (
        <div className="mt-2.5 flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400">
            System TTS Voice
          </span>
          <select
            aria-label="Select browser speech output voice"
            value={preferredBrowserVoiceUri ?? 'auto'}
            onChange={(e) =>
              onSelectBrowserVoiceUri(e.target.value === 'auto' ? null : e.target.value)
            }
            className="min-h-[44px] max-w-[195px] truncate rounded-lg border border-slate-700 bg-slate-950 px-2 font-mono text-[10px] text-slate-200"
          >
            <option value="auto">
              Auto ({selectedBrowserVoice?.name ?? 'Female-Preferred'})
            </option>
            {discoveredVoices.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
        </div>
      )}

      <p className="mt-2 font-mono text-[10px] leading-relaxed text-slate-400">
        {isMicActive
          ? 'Live microphone capture active (user-initiated; raw audio is never recorded or persisted).'
          : isSpeaking && !isMuted
            ? `Speaking via "${activeEngineVoiceLabel}" (${personaProfileLabel} · style=${activeStyle}). Tap Mic or Interrupt to barge in.`
            : !sttSupported && !ttsSupported
              ? 'Browser SpeechRecognition & SpeechSynthesis unavailable in this runtime — text console active.'
              : `Zero-cost Browser Voice (₹0 API cost) · Engine: ${activeEngineVoiceLabel}.`}
      </p>
    </section>
  );
}

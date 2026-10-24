'use client';

import React, { useState } from 'react';
import {
  AlertTriangle,
  Camera,
  FileText,
  Loader2,
  Mic,
  MicOff,
  Paperclip,
  SendHorizontal,
  Square,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type { VoiceErrorCode, VoiceSessionMachineState } from '@/core/voice';

export interface StagedVisionAttachment {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  base64Data?: string;
  source?: 'upload' | 'camera_preview';
}

export interface StagedDocumentAttachment {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  textContent: string;
  ingestToKnowledge: boolean;
}

interface MultimodalInputBarProps {
  inputText: string;
  onChangeText: (value: string) => void;
  onSubmit: () => void;
  isSending: boolean;
  stagedAttachment: StagedVisionAttachment | null;
  onClearAttachment: () => void;
  stagedDocument?: StagedDocumentAttachment | null;
  onStageDocument?: (doc: StagedDocumentAttachment | null) => void;
  onOpenVisionModal: () => void;
  isMicActive: boolean;
  voiceState?: VoiceSessionMachineState;
  sttSupported?: boolean;
  interimTranscript?: string;
  lastRecognizedTranscript?: string;
  voiceErrorCode?: VoiceErrorCode | null;
  voiceErrorMessage?: string | null;
  isSpeaking?: boolean;
  isVoiceMuted?: boolean;
  onToggleMic?: () => void | Promise<void>;
  onStopSpeaking?: () => void;
  onToggleMute?: () => void;
  onMicStateChange?: (active: boolean, levels?: number[]) => void;
  onBargeInInterrupt?: () => void;
}

export function MultimodalInputBar({
  inputText,
  onChangeText,
  onSubmit,
  isSending,
  stagedAttachment,
  onClearAttachment,
  stagedDocument = null,
  onStageDocument,
  onOpenVisionModal,
  isMicActive,
  voiceState = 'IDLE',
  sttSupported = true,
  interimTranscript = '',
  lastRecognizedTranscript = '',
  voiceErrorCode = null,
  voiceErrorMessage = null,
  isSpeaking = false,
  isVoiceMuted = false,
  onToggleMic,
  onStopSpeaking,
  onToggleMute,
  onMicStateChange,
  onBargeInInterrupt,
}: MultimodalInputBarProps) {
  const [localBanner, setLocalBanner] = useState<string | null>(null);

  const handleMicPress = async () => {
    setLocalBanner(null);
    if (onToggleMic) {
      await onToggleMic();
      return;
    }
    // Fallback for standalone component usage in isolated tests
    onBargeInInterrupt?.();
    onMicStateChange?.(!isMicActive);
  };

  const handleDocumentPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !onStageDocument) return;

    if (file.name.toLowerCase().endsWith('.pdf')) {
      setLocalBanner(
        'Binary PDF OCR is NOT_AVAILABLE. Attach Markdown (.md), CSV (.csv), JSON (.json), code, or plain text (.txt).'
      );
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const textContent = typeof reader.result === 'string' ? reader.result : '';
      if (!textContent.trim()) return;
      onStageDocument({
        fileName: file.name,
        mimeType: file.type || 'text/plain',
        sizeBytes: file.size,
        textContent: textContent.slice(0, 120_000),
        ingestToKnowledge: true,
      });
      if (!inputText.trim()) {
        onChangeText(`Analyze attached document ${file.name} and summarize key structure.`);
      }
    };
    reader.readAsText(file);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (inputText.trim() && !isSending) {
        onBargeInInterrupt?.();
        onSubmit();
      }
    }
  };

  const isRequestingMic = voiceState === 'REQUESTING_MIC_PERMISSION';
  const showListeningPreview =
    isMicActive ||
    isRequestingMic ||
    Boolean(interimTranscript) ||
    (voiceState === 'PROCESSING' && Boolean(lastRecognizedTranscript));

  const statusAlertMessage =
    localBanner ||
    (voiceState === 'UNSUPPORTED'
      ? 'Browser SpeechRecognition is unsupported on this device/browser. Full text interaction remains active.'
      : voiceState === 'ERROR' && voiceErrorMessage
        ? voiceErrorMessage
        : null);

  return (
    <div className="border-t border-cyan-400/[0.12] bg-slate-950/85 p-3 sm:p-4">
      {/* Live Transcript Preview & Listening Status Banner */}
      {showListeningPreview && (
        <div
          role="status"
          aria-live="polite"
          data-testid="voice-transcript-preview"
          className="mb-2.5 flex items-center justify-between gap-2 rounded-xl border border-teal-400/35 bg-teal-950/35 px-3 py-2 text-xs text-teal-100"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-teal-300">
              <span className="h-2 w-2 animate-pulse rounded-full bg-teal-400" />
              <span>
                {isRequestingMic
                  ? 'REQUESTING MICROPHONE PERMISSION...'
                  : isMicActive
                    ? 'MICROPHONE ACTIVE · LISTENING'
                    : 'PROCESSING VOICE TRANSCRIPT'}
              </span>
            </div>
            <p className="mt-1 truncate font-mono text-xs text-slate-100">
              {interimTranscript
                ? `“${interimTranscript}”`
                : lastRecognizedTranscript
                  ? `Recognized: “${lastRecognizedTranscript}”`
                  : 'Speak your directive clearly — tap Mic again to stop.'}
            </p>
          </div>
          {isMicActive && (
            <button
              type="button"
              onClick={handleMicPress}
              aria-label="Stop active microphone capture"
              className="inline-flex min-h-[36px] shrink-0 items-center gap-1 rounded-lg border border-teal-400/40 bg-slate-950/75 px-2.5 font-mono text-[10px] text-teal-200 hover:bg-slate-900"
            >
              <MicOff className="h-3.5 w-3.5" />
              Stop Mic
            </button>
          )}
        </div>
      )}

      {/* Accessible Error / Denied / Unsupported Notice */}
      {statusAlertMessage && (
        <div
          role="alert"
          data-testid="voice-status-alert"
          data-error-code={voiceErrorCode ?? undefined}
          className="mb-2.5 flex items-center justify-between gap-2 rounded-xl border border-amber-400/30 bg-amber-950/30 px-3 py-2 text-xs text-amber-100"
        >
          <span className="inline-flex items-center gap-2 font-mono text-[11px]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-300" />
            <span>{statusAlertMessage}</span>
          </span>
          {localBanner && (
            <button
              type="button"
              onClick={() => setLocalBanner(null)}
              aria-label="Dismiss voice notice"
              className="rounded p-1 text-slate-400 hover:text-slate-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

      {/* Staged Vision Frame Chip */}
      {stagedAttachment && (
        <div className="mb-2.5 mr-2 inline-flex items-center gap-2 rounded-xl border border-indigo-400/30 bg-indigo-950/40 px-3 py-1.5 text-xs text-indigo-200">
          <Paperclip className="h-3.5 w-3.5 text-indigo-300" />
          <span className="font-mono text-[11px]">
            {stagedAttachment.fileName}
            {stagedAttachment.width && stagedAttachment.height
              ? ` (${stagedAttachment.width}×${stagedAttachment.height}px)`
              : ' (Binary Frame Ready)'}
          </span>
          <button
            type="button"
            onClick={onClearAttachment}
            aria-label="Remove staged image"
            className="rounded p-0.5 text-indigo-300 hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Staged Structured Document Chip */}
      {stagedDocument && onStageDocument && (
        <div className="mb-2.5 inline-flex flex-wrap items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-950/35 px-3 py-1.5 text-xs text-emerald-100">
          <FileText className="h-3.5 w-3.5 text-emerald-300" />
          <span className="font-mono text-[11px]">
            {stagedDocument.fileName} ({Math.max(1, Math.round(stagedDocument.sizeBytes / 1024))} KB · Quarantined)
          </span>
          <label className="inline-flex cursor-pointer items-center gap-1 font-mono text-[10px] text-emerald-200">
            <input
              type="checkbox"
              checked={stagedDocument.ingestToKnowledge}
              onChange={(e) =>
                onStageDocument({
                  ...stagedDocument,
                  ingestToKnowledge: e.target.checked,
                })
              }
              className="h-3.5 w-3.5 accent-emerald-400"
            />
            <span>Ingest Knowledge</span>
          </label>
          <button
            type="button"
            onClick={() => onStageDocument(null)}
            aria-label="Remove staged document"
            className="rounded p-0.5 text-emerald-300 hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="flex items-end gap-2">
        {/* Microphone Control (44x44px accessible button, never auto-started) */}
        <button
          type="button"
          onClick={handleMicPress}
          disabled={isRequestingMic}
          aria-label={
            isMicActive
              ? 'Stop microphone input'
              : sttSupported
                ? 'Activate microphone input'
                : 'Activate microphone input (SpeechRecognition unsupported in this browser)'
          }
          aria-pressed={isMicActive}
          title={
            isMicActive
              ? 'Stop Microphone Capture'
              : isSpeaking
                ? 'Barge-In: Interrupt Assistant & Speak'
                : 'Start Voice Input (User-Initiated)'
          }
          className={`inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl border transition focus:outline-none focus:ring-2 focus:ring-cyan-400/50 ${
            isMicActive
              ? 'border-teal-400/70 bg-teal-500/25 text-teal-100 shadow-[0_0_16px_rgba(45,212,191,0.35)]'
              : !sttSupported
                ? 'border-slate-800 bg-slate-900/50 text-slate-500'
                : 'border-slate-700/90 bg-slate-900/90 text-slate-300 hover:border-cyan-400/40 hover:text-cyan-200'
          }`}
        >
          {isMicActive ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </button>

        {/* Stop Speaking Quick Action when Assistant is Speaking (44x44px) */}
        {isSpeaking && onStopSpeaking && (
          <button
            type="button"
            onClick={onStopSpeaking}
            aria-label="Stop spoken assistant output"
            title="Stop Assistant Voice Playback"
            className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl border border-rose-400/45 bg-rose-500/20 text-rose-100 transition hover:bg-rose-500/30"
          >
            <Square className="h-4 w-4" />
          </button>
        )}

        {/* Mute / Unmute Quick Toggle (44x44px) */}
        {onToggleMute && (
          <button
            type="button"
            onClick={onToggleMute}
            aria-label={
              isVoiceMuted ? 'Unmute assistant voice output' : 'Mute assistant voice output'
            }
            aria-pressed={isVoiceMuted}
            title={isVoiceMuted ? 'Unmute Assistant Voice' : 'Mute Assistant Voice'}
            className={`inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl border transition focus:outline-none focus:ring-2 focus:ring-cyan-400/50 ${
              isVoiceMuted
                ? 'border-amber-400/45 bg-amber-500/15 text-amber-200'
                : 'border-slate-700/90 bg-slate-900/90 text-slate-300 hover:border-cyan-400/40 hover:text-cyan-200'
            }`}
          >
            {isVoiceMuted ? (
              <VolumeX className="h-4 w-4" />
            ) : (
              <Volume2 className="h-4 w-4" />
            )}
          </button>
        )}

        {/* Camera / Vision Control (44x44px accessible button) */}
        <button
          type="button"
          onClick={onOpenVisionModal}
          aria-label="Open Camera and Vision Engine Inspector"
          title="Camera / Vision Engine Interface"
          className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl border border-slate-700/90 bg-slate-900/90 text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-200 focus:outline-none focus:ring-2 focus:ring-cyan-400/50"
        >
          <Camera className="h-4 w-4" />
        </button>

        {/* Document / File Intelligence Picker (44x44px accessible label) */}
        {onStageDocument && (
          <label
            aria-label="Attach structured document for File Intelligence"
            title="Attach Markdown, CSV, JSON, Code, or Text File"
            className="inline-flex min-h-[44px] min-w-[44px] shrink-0 cursor-pointer items-center justify-center rounded-xl border border-slate-700/90 bg-slate-900/90 text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-200"
          >
            <FileText className="h-4 w-4" />
            <input
              type="file"
              accept=".md,.mdx,.txt,.csv,.tsv,.json,.ts,.tsx,.js,.jsx,.py,.sql,.yaml,.yml,.log"
              onChange={handleDocumentPick}
              className="hidden"
            />
          </label>
        )}

        {/* Text Command Input */}
        <div className="relative flex-1">
          <textarea
            rows={1}
            value={inputText}
            onChange={(e) => onChangeText(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Command or message to JARVIS-X"
            placeholder="Transmit directive to JARVIS-X (type or tap Mic)..."
            className="max-h-32 min-h-[44px] w-full resize-none rounded-xl border border-slate-700/90 bg-slate-900/90 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-500 transition focus:border-cyan-400/60 focus:outline-none focus:ring-1 focus:ring-cyan-400/40"
          />
        </div>

        {/* Send Button (44x44px accessible button) */}
        <button
          type="button"
          disabled={!inputText.trim() || isSending}
          onClick={() => {
            onBargeInInterrupt?.();
            onSubmit();
          }}
          aria-label="Send message to JARVIS-X"
          className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-1.5 rounded-xl border border-cyan-400/50 bg-gradient-to-r from-cyan-500/25 to-sky-500/25 px-3.5 font-display text-sm font-medium text-cyan-100 shadow-[0_0_20px_rgba(34,211,238,0.16)] transition hover:border-cyan-300 hover:from-cyan-500/35 hover:to-sky-500/35 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isSending ? (
            <Loader2 className="h-4 w-4 animate-spin text-cyan-200" />
          ) : (
            <>
              <SendHorizontal className="h-4 w-4" />
              <span className="hidden sm:inline">Send</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}

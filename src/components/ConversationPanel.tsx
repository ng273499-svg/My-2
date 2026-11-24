'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  KeyRound,
  Lock,
  MessageSquarePlus,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Terminal,
  Volume2,
  VolumeX,
  XCircle,
} from 'lucide-react';
import type {
  ChatMessage,
  ConversationSummary,
  PermissionRequest,
  ResponseStyle,
} from '@/core/types';

interface ConversationPanelProps {
  conversations: ConversationSummary[];
  activeConversationId: string;
  onSelectConversation: (conversationId: string) => void;
  onCreateConversation: () => void;
  messages: ChatMessage[];
  isSending: boolean;
  resolvedPermissions: Record<string, 'approved' | 'denied'>;
  permissionError: Record<string, string>;
  onSelectQuickPrompt: (prompt: string) => void;
  onResolvePermission: (
    request: PermissionRequest,
    approve: boolean,
    stepUpPasscode?: string
  ) => Promise<void>;
  speakingMessageId?: string | null;
  onSpeakMessage?: (message: ChatMessage, style?: ResponseStyle) => void;
  onStopSpeaking?: () => void;
}

const ARCHITECTURAL_PROMPTS = [
  {
    label: 'System Diagnostics',
    prompt: 'Run a full status diagnostics check on JARVIS-X modules and capabilities.',
  },
  {
    label: 'Memory Gate (Tier 2)',
    prompt: 'Remember that our primary deployment stack uses Next.js, TypeScript, and Supabase RLS.',
  },
  {
    label: 'Research Specialist',
    prompt: 'Research recent architectural patterns for multimodal personal AI agents.',
  },
  {
    label: 'Security Gate (Tier 3)',
    prompt: 'Unlock the studio smart-home door lock immediately.',
  },
  {
    label: 'Voice Persona Check',
    prompt: 'Check Voice Engine status and Aria female voice prosody configuration.',
  },
];

function renderFormattedLine(line: string, key: number) {
  const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <span key={key}>
      {parts.map((part, idx) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return (
            <strong key={idx} className="font-semibold text-slate-100">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <code
              key={idx}
              className="rounded border border-cyan-400/20 bg-slate-900/90 px-1.5 py-0.5 font-mono text-[12px] text-cyan-200"
            >
              {part.slice(1, -1)}
            </code>
          );
        }
        return <React.Fragment key={idx}>{part}</React.Fragment>;
      })}
    </span>
  );
}

function FormattedContent({ content }: { content: string }) {
  const lines = content.split('\n');
  return (
    <div className="space-y-1.5 text-sm leading-relaxed text-slate-200">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return <div key={i} className="h-1.5" />;
        }
        if (trimmed.startsWith('- ')) {
          return (
            <div key={i} className="flex items-start gap-2 pl-1">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-400/80" />
              <div>{renderFormattedLine(trimmed.slice(2), i)}</div>
            </div>
          );
        }
        if (trimmed.startsWith('> ')) {
          return (
            <blockquote
              key={i}
              className="rounded-r-lg border-l-2 border-cyan-400/50 bg-slate-900/60 px-3 py-1.5 italic text-cyan-100"
            >
              {renderFormattedLine(trimmed.slice(2), i)}
            </blockquote>
          );
        }
        return <p key={i}>{renderFormattedLine(line, i)}</p>;
      })}
    </div>
  );
}

export function ConversationPanel({
  conversations,
  activeConversationId,
  onSelectConversation,
  onCreateConversation,
  messages,
  isSending,
  resolvedPermissions,
  permissionError,
  onSelectQuickPrompt,
  onResolvePermission,
  speakingMessageId = null,
  onSpeakMessage,
  onStopSpeaking,
}: ConversationPanelProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [passcodes, setPasscodes] = useState<Record<string, string>>({});
  const [busyPermId, setBusyPermId] = useState<string | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, isSending]);

  const handlePermissionAction = async (req: PermissionRequest, approve: boolean) => {
    setBusyPermId(req.id);
    try {
      await onResolvePermission(req, approve, passcodes[req.id]);
    } finally {
      setBusyPermId(null);
    }
  };

  return (
    <section
      aria-label="Conversation Panel"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      {/* Header + Conversation Selector */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 px-3.5 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="h-4 w-4 shrink-0 text-cyan-300" />
          <h2 className="truncate font-display text-sm font-semibold tracking-wide text-slate-100">
            Command &amp; Dialogue Stream
          </h2>
        </div>

        <div className="flex items-center gap-1.5">
          {conversations.length > 0 && (
            <select
              aria-label="Select active conversation"
              value={activeConversationId}
              onChange={(e) => onSelectConversation(e.target.value)}
              className="min-h-[36px] max-w-[165px] truncate rounded-lg border border-slate-700/90 bg-slate-900/90 px-2 font-mono text-[11px] text-slate-200 focus:border-cyan-400 focus:outline-none sm:max-w-[210px]"
            >
              {conversations.map((conv) => (
                <option key={conv.id} value={conv.id}>
                  {conv.title}
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            onClick={onCreateConversation}
            aria-label="Start new conversation session"
            title="Start New Conversation Session"
            className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-cyan-400/25 bg-cyan-500/10 px-2.5 font-mono text-[11px] text-cyan-200 transition hover:border-cyan-400/50 hover:bg-cyan-500/20"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">New</span>
          </button>
        </div>
      </div>

      {/* Scrollable Message Stream */}
      <div className="flex-1 space-y-4 overflow-y-auto px-3.5 py-4 sm:px-5">
        {messages.length === 0 ? (
          <div className="mx-auto my-4 max-w-xl rounded-2xl border border-cyan-400/15 bg-slate-900/45 p-5">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-cyan-400/25 bg-cyan-500/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-cyan-200">
              <Sparkles className="h-3 w-3" />
              JARVIS-X Foundation Ready
            </div>
            <h3 className="mt-3 font-display text-base font-semibold text-slate-100 sm:text-lg">
              Good day, Operator. All 14 modular subsystems are online.
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
              Supabase PostgreSQL 17 persistence, <code className="font-mono text-cyan-200">pgvector</code> HNSW indexing, and <code className="font-mono text-cyan-200">FORCE ROW LEVEL SECURITY</code> are provisioned across all 10 tables — with automatic graceful fallback if network connectivity is interrupted.
            </p>

            <div className="mt-4">
              <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-400">
                Test Architectural Pathways:
              </p>
              <div className="flex flex-wrap gap-2">
                {ARCHITECTURAL_PROMPTS.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => onSelectQuickPrompt(item.prompt)}
                    className="min-h-[38px] rounded-xl border border-cyan-400/20 bg-slate-950/75 px-3 py-1.5 text-left text-xs font-medium text-cyan-100 transition hover:border-cyan-400/45 hover:bg-cyan-500/10"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            const isUser = msg.role === 'user';
            const pendingPerm = msg.pendingPermission;
            const permStatus = pendingPerm ? resolvedPermissions[pendingPerm.id] : undefined;

            return (
              <article
                key={msg.id}
                className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`max-w-[92%] rounded-2xl px-4 py-3 sm:max-w-[85%] ${
                    isUser
                      ? 'border border-cyan-400/30 bg-cyan-500/[0.13] text-slate-100'
                      : 'border border-slate-800/90 bg-slate-900/75 text-slate-200 shadow-lg'
                  }`}
                >
                  {/* Header line */}
                  <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-slate-400">
                    <span className={isUser ? 'text-cyan-300' : 'text-indigo-300'}>
                      {isUser ? 'OPERATOR' : 'JARVIS-X'}
                    </span>
                    {!isUser && msg.responseStyle && (
                      <span className="rounded border border-cyan-400/20 bg-cyan-500/10 px-1.5 py-0.5 text-cyan-200">
                        STYLE: {msg.responseStyle}
                      </span>
                    )}
                    {!isUser && msg.specialistAgent && (
                      <span className="rounded border border-indigo-400/25 bg-indigo-500/10 px-1.5 py-0.5 text-indigo-200">
                        AGENT: {msg.specialistAgent}
                      </span>
                    )}
                    {!isUser && msg.verification && (
                      <span
                        className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 ${
                          msg.verification.outcome === 'verified'
                            ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-300'
                            : 'border-amber-400/30 bg-amber-500/10 text-amber-300'
                        }`}
                      >
                        <ShieldCheck className="h-3 w-3" />
                        {msg.verification.outcome}
                      </span>
                    )}
                    {!isUser && onSpeakMessage && (
                      <button
                        type="button"
                        onClick={() =>
                          speakingMessageId === msg.id
                            ? onStopSpeaking?.()
                            : onSpeakMessage(msg, msg.responseStyle)
                        }
                        aria-label={
                          speakingMessageId === msg.id
                            ? 'Stop spoken response'
                            : 'Speak response with female persona'
                        }
                        className={`ml-auto inline-flex items-center gap-1 rounded border px-1.5 py-0.5 transition ${
                          speakingMessageId === msg.id
                            ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200'
                            : 'border-slate-700/80 bg-slate-950/60 text-slate-300 hover:border-cyan-400/40 hover:text-cyan-200'
                        }`}
                      >
                        {speakingMessageId === msg.id ? (
                          <>
                            <VolumeX className="h-3 w-3" />
                            <span>Stop</span>
                          </>
                        ) : (
                          <>
                            <Volume2 className="h-3 w-3" />
                            <span>Speak</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  <FormattedContent content={msg.content} />

                  {/* Interactive Permission / Security Gate Card */}
                  {pendingPerm && (
                    <div
                      className={`mt-3 rounded-xl border p-3.5 ${
                        pendingPerm.tier === 'SENSITIVE_AUTH_REQUIRED'
                          ? 'border-rose-400/35 bg-rose-950/25'
                          : 'border-amber-400/35 bg-amber-950/20'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          {pendingPerm.tier === 'SENSITIVE_AUTH_REQUIRED' ? (
                            <Lock className="h-4 w-4 text-rose-300" />
                          ) : (
                            <ShieldAlert className="h-4 w-4 text-amber-300" />
                          )}
                          <span className="font-mono text-xs font-semibold uppercase tracking-wider text-slate-100">
                            {pendingPerm.actionTitle}
                          </span>
                        </div>
                        <span className="rounded bg-slate-950/80 px-2 py-0.5 font-mono text-[10px] text-amber-200">
                          {pendingPerm.tier}
                        </span>
                      </div>

                      <p className="mt-1.5 text-xs text-slate-300">
                        <span className="font-mono text-slate-400">Resource:</span>{' '}
                        {pendingPerm.targetResource}
                      </p>
                      <p className="mt-1 text-[11px] text-slate-400">
                        {pendingPerm.impactDescription}
                      </p>

                      {permStatus ? (
                        <div className="mt-3 flex items-center gap-2 font-mono text-xs">
                          {permStatus === 'approved' ? (
                            <span className="inline-flex items-center gap-1.5 text-emerald-300">
                              <CheckCircle2 className="h-4 w-4" />
                              Authorized &amp; logged to audit trail
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 text-slate-400">
                              <XCircle className="h-4 w-4" />
                              Declined by operator
                            </span>
                          )}
                        </div>
                      ) : (
                        <div className="mt-3 space-y-2.5">
                          {pendingPerm.requiresStepUpAuth && (
                            <div>
                              <label
                                htmlFor={`stepup-${pendingPerm.id}`}
                                className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-rose-200"
                              >
                                <KeyRound className="h-3 w-3" />
                                Step-Up Verification Phrase (Default: JARVIS-VERIFY)
                              </label>
                              <input
                                id={`stepup-${pendingPerm.id}`}
                                type="password"
                                placeholder="Enter verification phrase..."
                                value={passcodes[pendingPerm.id] ?? ''}
                                onChange={(e) =>
                                  setPasscodes((prev) => ({
                                    ...prev,
                                    [pendingPerm.id]: e.target.value,
                                  }))
                                }
                                className="min-h-[40px] w-full rounded-lg border border-rose-400/30 bg-slate-950/90 px-3 py-1.5 font-mono text-xs text-slate-100 placeholder-slate-500 focus:border-cyan-400 focus:outline-none"
                              />
                            </div>
                          )}

                          {permissionError[pendingPerm.id] && (
                            <p className="rounded-lg border border-rose-400/30 bg-rose-950/40 px-2.5 py-1.5 font-mono text-[11px] text-rose-200">
                              {permissionError[pendingPerm.id]}
                            </p>
                          )}

                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              disabled={busyPermId === pendingPerm.id}
                              onClick={() => handlePermissionAction(pendingPerm, true)}
                              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-emerald-400/40 bg-emerald-500/20 px-3.5 py-1.5 font-mono text-xs font-medium text-emerald-100 transition hover:bg-emerald-500/30 disabled:opacity-50"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              {pendingPerm.requiresStepUpAuth
                                ? 'Verify & Authorize'
                                : 'Approve Action'}
                            </button>
                            <button
                              type="button"
                              disabled={busyPermId === pendingPerm.id}
                              onClick={() => handlePermissionAction(pendingPerm, false)}
                              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/90 px-3.5 py-1.5 font-mono text-xs text-slate-300 transition hover:border-slate-500 disabled:opacity-50"
                            >
                              <XCircle className="h-3.5 w-3.5" />
                              Decline
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </article>
            );
          })
        )}

        {isSending && (
          <div className="flex items-center gap-2.5 px-2 py-1 font-mono text-xs text-cyan-300">
            <span className="h-2 w-2 animate-ping rounded-full bg-cyan-400" />
            JARVIS-X routing turn through 6-stage pipeline...
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Compact quick-test prompt strip when conversation is active */}
      {messages.length > 0 && (
        <div className="flex items-center gap-1.5 overflow-x-auto border-t border-slate-800/70 px-3.5 py-2">
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            Quick Test:
          </span>
          {ARCHITECTURAL_PROMPTS.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => onSelectQuickPrompt(item.prompt)}
              className="shrink-0 rounded-lg border border-slate-800 bg-slate-900/75 px-2.5 py-1 font-mono text-[11px] text-slate-300 transition hover:border-cyan-400/35 hover:text-cyan-200"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

'use client';

/**
 * JARVIS-X — Focused chat website.
 *
 * A clean, mobile-first surface for talking to JARVIS. It talks to the SAME
 * backend as the full HUD (`/api/jarvis/chat`), so there is no second runtime
 * and no duplicated orchestration.
 *
 * Honesty rules respected here:
 *   * the model/provider actually used is shown, not implied;
 *   * only safe operational metadata is surfaced (no reasoning traces);
 *   * nothing is optimistically rendered — the assistant bubble appears only
 *     after a real server response.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  BadgeCheck,
  CircleAlert,
  Menu,
  MessageSquarePlus,
  PanelLeftClose,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from 'lucide-react';

import type { ChatMessage, ConversationSummary } from '@/core/types/conversation';

/* ==========================================================================
 * Types
 * ======================================================================== */

interface RouteDecisionLike {
  selectedModel?: { displayName?: string; providerId?: string; id?: string };
  reason?: string;
}

interface ChatApiTurn {
  conversationId: string;
  assistantMessage: ChatMessage;
  userMessage: ChatMessage;
  routeDecision?: RouteDecisionLike;
  verification?: { outcome?: string; warnings?: string[] };
}

interface ChatApiResponse {
  ok: boolean;
  turn?: ChatApiTurn;
  error?: string;
}

interface ConversationsResponse {
  ok: boolean;
  conversations?: ConversationSummary[];
  messages?: ChatMessage[];
  error?: string;
}

export interface JarvisChatProps {
  initialMessages: ChatMessage[];
  initialConversations: ConversationSummary[];
  initialConversationId: string;
}

/* ==========================================================================
 * Lightweight, dependency-free markdown renderer
 * ======================================================================== */

function renderInline(text: string, keyPrefix: string) {
  // Split on **bold**, `code`, and *italic* — nothing else is interpreted.
  const nodes: React.ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];

    if (token.startsWith('**')) {
      nodes.push(
        <strong key={`${keyPrefix}-b-${index}`} className="font-semibold text-cyan-100">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith('`')) {
      nodes.push(
        <code
          key={`${keyPrefix}-c-${index}`}
          className="rounded bg-cyan-400/10 px-1.5 py-0.5 font-mono text-[0.85em] text-cyan-200"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else {
      nodes.push(
        <em key={`${keyPrefix}-i-${index}`} className="text-slate-300">
          {token.slice(1, -1)}
        </em>
      );
    }

    lastIndex = match.index + token.length;
    index += 1;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function FormattedMessage({ content }: { content: string }) {
  const blocks = useMemo(() => content.split('\n'), [content]);

  return (
    <div className="space-y-1.5 text-[15px] leading-relaxed text-slate-200">
      {blocks.map((line, i) => {
        const trimmed = line.trim();

        if (!trimmed) return <div key={`sp-${i}`} className="h-1.5" />;

        // Bullet list item
        if (/^[-*•]\s+/.test(trimmed)) {
          return (
            <div key={`li-${i}`} className="flex gap-2 pl-1">
              <span className="mt-[0.45em] h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-400/70" />
              <span>{renderInline(trimmed.replace(/^[-*•]\s+/, ''), `li-${i}`)}</span>
            </div>
          );
        }

        // Numbered list item
        const numbered = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
        if (numbered) {
          return (
            <div key={`ol-${i}`} className="flex gap-2 pl-1">
              <span className="min-w-[1.1rem] font-mono text-xs text-cyan-400/80">{numbered[1]}.</span>
              <span>{renderInline(numbered[2], `ol-${i}`)}</span>
            </div>
          );
        }

        // Heading
        if (/^#{1,6}\s+/.test(trimmed)) {
          return (
            <p key={`h-${i}`} className="pt-1 font-display text-sm font-semibold uppercase tracking-wide text-cyan-200">
              {trimmed.replace(/^#{1,6}\s+/, '')}
            </p>
          );
        }

        return <p key={`p-${i}`}>{renderInline(line, `p-${i}`)}</p>;
      })}
    </div>
  );
}

/* ==========================================================================
 * Small pieces
 * ======================================================================== */

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const diffMin = Math.round((Date.now() - then) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const hours = Math.round(diffMin / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const SUGGESTIONS = [
  'Mera naam kya hai aur tum mere baare mein kya jaante ho?',
  'Explain what you can actually do right now',
  'Aaj ke liye ek short productive plan banao',
  'Tum kaun se model par chal rahe ho?',
];

/* ==========================================================================
 * Main component
 * ======================================================================== */

export function JarvisChat({
  initialMessages,
  initialConversations,
  initialConversationId,
}: JarvisChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [conversations, setConversations] = useState<ConversationSummary[]>(initialConversations);
  const [conversationId, setConversationId] = useState<string>(initialConversationId);

  const [draft, setDraft] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastMeta, setLastMeta] = useState<{
    modelLabel: string;
    providerId: string;
    verified: boolean;
    warnings: number;
  } | null>(null);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isSending, scrollToBottom]);

  // Auto-grow the composer.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || isSending) return;

    setError(null);
    setDraft('');

    // Optimistic USER bubble only. The assistant bubble is never pre-rendered.
    const optimisticUser: ChatMessage = {
      id: `local-user-${Date.now()}`,
      conversationId,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUser]);
    setIsSending(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch('/api/jarvis/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Omit an empty id entirely: the server creates the conversation on the
        // first message, and an empty string would fail validation.
        body: JSON.stringify(
          conversationId ? { message: text, conversationId } : { message: text }
        ),
        signal: controller.signal,
      });

      const payload = (await response.json()) as ChatApiResponse;

      if (!response.ok || !payload.ok || !payload.turn) {
        throw new Error(payload.error || `Request failed (HTTP ${response.status}).`);
      }

      const turn = payload.turn;

      setMessages((prev) => {
        // Reconcile the optimistic bubble with the authoritative server copy.
        const withoutOptimistic = prev.filter((m) => m.id !== optimisticUser.id);
        return [...withoutOptimistic, turn.userMessage, turn.assistantMessage];
      });

      setConversationId(turn.conversationId);

      setLastMeta({
        modelLabel:
          turn.routeDecision?.selectedModel?.displayName ??
          turn.assistantMessage.modelId ??
          'Unknown model',
        providerId: turn.routeDecision?.selectedModel?.providerId ?? 'unknown',
        verified: turn.verification?.outcome === 'verified',
        warnings: turn.verification?.warnings?.length ?? 0,
      });

      // Refresh the conversation list so the title/sidebar stays truthful.
      void refreshConversations();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError('Request cancelled.');
      } else {
        setError(err instanceof Error ? err.message : 'Something went wrong.');
      }
      // Keep the user's words on screen so nothing is silently lost.
      setMessages((prev) => prev.filter((m) => m.id !== optimisticUser.id));
      setDraft(text);
    } finally {
      setIsSending(false);
      abortRef.current = null;
      textareaRef.current?.focus();
    }
  }, [draft, isSending, conversationId]);

  const refreshConversations = useCallback(async () => {
    try {
      const response = await fetch('/api/jarvis/conversations', { cache: 'no-store' });
      const payload = (await response.json()) as ConversationsResponse;
      if (payload.ok && payload.conversations) setConversations(payload.conversations);
    } catch {
      /* sidebar refresh is best-effort */
    }
  }, []);

  const openConversation = useCallback(async (id: string) => {
    if (id === conversationId) {
      setSidebarOpen(false);
      return;
    }
    setIsLoadingHistory(true);
    setError(null);
    try {
      const response = await fetch(`/api/jarvis/conversations?id=${encodeURIComponent(id)}`, {
        cache: 'no-store',
      });
      const payload = (await response.json()) as ConversationsResponse;
      if (!payload.ok) throw new Error(payload.error ?? 'Could not load that conversation.');
      setMessages(payload.messages ?? []);
      setConversationId(id);
      setSidebarOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load that conversation.');
    } finally {
      setIsLoadingHistory(false);
    }
  }, [conversationId]);

  const startNewChat = useCallback(() => {
    // A fresh conversation is created by the server on the first message.
    // We clear the local view and drop the conversation id.
    setMessages([]);
    setConversationId('');
    setDraft('');
    setError(null);
    setLastMeta(null);
    setSidebarOpen(false);
    textareaRef.current?.focus();
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void send();
      }
    },
    [send]
  );

  const isEmpty = messages.length === 0;

  return (
    <div className="jarvis-atmosphere relative flex h-[100dvh] w-full overflow-hidden text-slate-200">
      <div className="jarvis-grid-overlay pointer-events-none absolute inset-0 opacity-60" />

      {/* ---------------- Sidebar ---------------- */}
      <aside
        className={[
          'absolute inset-y-0 left-0 z-30 w-[280px] transform border-r border-cyan-400/10 bg-slate-950/95 backdrop-blur-xl transition-transform duration-300 ease-out md:relative md:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-cyan-400/10 px-4 py-4">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 animate-pulse rounded-full bg-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.8)]" />
              <span className="font-display text-sm font-semibold tracking-[0.18em] text-cyan-100">
                JARVIS-X
              </span>
            </div>
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-800/60 hover:text-slate-100 md:hidden"
              aria-label="Close sidebar"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>

          <div className="p-3">
            <button
              type="button"
              onClick={startNewChat}
              className="flex w-full items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-3 py-2.5 text-sm font-medium text-cyan-100 transition hover:border-cyan-400/40 hover:bg-cyan-400/10"
            >
              <MessageSquarePlus className="h-4 w-4" />
              New chat
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
            <p className="px-2 pb-2 pt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">
              Recent
            </p>
            {conversations.length === 0 && (
              <p className="px-2 py-3 text-xs text-slate-500">No conversations yet.</p>
            )}
            <ul className="space-y-1">
              {conversations.map((conversation) => (
                <li key={conversation.id}>
                  <button
                    type="button"
                    onClick={() => void openConversation(conversation.id)}
                    className={[
                      'w-full rounded-lg px-2.5 py-2 text-left transition',
                      conversation.id === conversationId
                        ? 'bg-cyan-400/10 text-cyan-100'
                        : 'text-slate-300 hover:bg-slate-800/60',
                    ].join(' ')}
                  >
                    <span className="line-clamp-1 text-[13px]">{conversation.title || 'Untitled'}</span>
                    <span className="mt-0.5 block font-mono text-[10px] text-slate-500">
                      {relativeTime(conversation.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="border-t border-cyan-400/10 px-4 py-3">
            <a
              href="/"
              className="text-[11px] text-slate-500 underline-offset-2 transition hover:text-cyan-300 hover:underline"
            >
              Open full HUD dashboard →
            </a>
          </div>
        </div>
      </aside>

      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close sidebar overlay"
          onClick={() => setSidebarOpen(false)}
          className="absolute inset-0 z-20 bg-black/60 backdrop-blur-sm md:hidden"
        />
      )}

      {/* ---------------- Main column ---------------- */}
      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex items-center gap-3 border-b border-cyan-400/10 bg-slate-950/50 px-4 py-3 backdrop-blur-xl">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="rounded-lg p-2 text-slate-300 transition hover:bg-slate-800/60 hover:text-slate-100 md:hidden"
            aria-label="Open sidebar"
          >
            <Menu className="h-5 w-5" />
          </button>

          <div className="flex min-w-0 items-center gap-2.5">
            <div className="relative flex h-8 w-8 items-center justify-center rounded-full border border-cyan-400/30 bg-cyan-400/10">
              <Sparkles className="h-4 w-4 text-cyan-300" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate font-display text-sm font-semibold tracking-wide text-slate-100">
                JARVIS-X
              </h1>
              <p className="truncate font-mono text-[10px] text-slate-500">
                {isSending ? 'thinking…' : lastMeta ? lastMeta.modelLabel : 'ready'}
              </p>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {lastMeta && (
              <span
                className={[
                  'hidden items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] sm:flex',
                  lastMeta.verified
                    ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300'
                    : 'border-amber-400/25 bg-amber-400/10 text-amber-300',
                ].join(' ')}
                title={`Provider: ${lastMeta.providerId}`}
              >
                {lastMeta.verified ? (
                  <BadgeCheck className="h-3 w-3" />
                ) : (
                  <CircleAlert className="h-3 w-3" />
                )}
                {lastMeta.verified ? 'verified' : 'unverified'}
              </span>
            )}
            <span
              className="flex items-center gap-1.5 rounded-full border border-slate-700/70 bg-slate-900/60 px-2.5 py-1 font-mono text-[10px] text-slate-400"
              title="Ephemeral guest session when Supabase is not configured"
            >
              <ShieldCheck className="h-3 w-3" />
              READ-ONLY
            </span>
          </div>
        </header>

        {/* Messages */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6">
          <div className="mx-auto w-full max-w-3xl">
            {isEmpty && (
              <div className="flex min-h-[46vh] flex-col items-center justify-center text-center">
                <div className="relative mb-6 flex h-16 w-16 items-center justify-center">
                  <span className="absolute inset-0 animate-ping rounded-full bg-cyan-400/10" />
                  <span className="absolute inset-0 rounded-full border border-cyan-400/25" />
                  <Sparkles className="relative h-7 w-7 text-cyan-300" />
                </div>
                <h2 className="font-display text-xl font-semibold text-slate-100">
                  Namaste. Main JARVIS hoon.
                </h2>
                <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-400">
                  Kuch bhi poochhiye — sawaal, planning, code, ya kisi cheez ka analysis. Aapko
                  sirf ek assistant se baat hoti hai, chahe peeche kitne bhi engines chalein.
                </p>

                <div className="mt-7 grid w-full max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => {
                        setDraft(suggestion);
                        textareaRef.current?.focus();
                      }}
                      className="glass-panel-subtle px-3.5 py-3 text-left text-[13px] leading-snug text-slate-300 transition hover:border-cyan-400/30 hover:text-cyan-100"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-6">
              {messages.map((message) => {
                const isUser = message.role === 'user';
                return (
                  <div
                    key={message.id}
                    className={['flex gap-3', isUser ? 'justify-end' : 'justify-start'].join(' ')}
                  >
                    {!isUser && (
                      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-cyan-400/25 bg-cyan-400/10">
                        <Sparkles className="h-4 w-4 text-cyan-300" />
                      </div>
                    )}

                    <div className={['min-w-0 max-w-[85%]', isUser ? 'items-end' : ''].join(' ')}>
                      <div
                        className={[
                          'rounded-2xl px-4 py-3',
                          isUser
                            ? 'rounded-br-md border border-cyan-400/20 bg-cyan-400/10 text-slate-100'
                            : 'glass-panel rounded-bl-md',
                        ].join(' ')}
                      >
                        {isUser ? (
                          <p className="whitespace-pre-wrap text-[15px] leading-relaxed">{message.content}</p>
                        ) : (
                          <FormattedMessage content={message.content} />
                        )}
                      </div>

                      {!isUser && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-1 font-mono text-[10px] text-slate-500">
                          {message.modelId && <span>{message.modelId}</span>}
                          {message.verification?.outcome && (
                            <span
                              className={
                                message.verification.outcome === 'verified'
                                  ? 'text-emerald-400/80'
                                  : 'text-amber-400/80'
                              }
                            >
                              {message.verification.outcome}
                            </span>
                          )}
                          {(message.verification?.warnings?.length ?? 0) > 0 && (
                            <span className="text-amber-400/80">
                              {message.verification!.warnings.length} warning
                              {message.verification!.warnings.length > 1 ? 's' : ''}
                            </span>
                          )}
                          {message.responseStyle && <span>style: {message.responseStyle}</span>}
                        </div>
                      )}
                    </div>

                    {isUser && (
                      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-700 bg-slate-800/80 font-mono text-[11px] text-slate-300">
                        You
                      </div>
                    )}
                  </div>
                );
              })}

              {isSending && (
                <div className="flex gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-cyan-400/25 bg-cyan-400/10">
                    <Sparkles className="h-4 w-4 animate-pulse text-cyan-300" />
                  </div>
                  <div className="glass-panel flex items-center gap-1.5 rounded-2xl rounded-bl-md px-4 py-3.5">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-400/80 [animation-delay:-0.3s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-400/80 [animation-delay:-0.15s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-400/80" />
                  </div>
                </div>
              )}
            </div>

            {error && (
              <div className="mt-4 flex items-start gap-2 rounded-xl border border-rose-500/25 bg-rose-500/10 px-3.5 py-3 text-[13px] text-rose-200">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium">Request failed</p>
                  <p className="mt-0.5 break-words text-rose-300/90">{error}</p>
                </div>
              </div>
            )}

            <div ref={bottomRef} className="h-2" />
          </div>
        </div>

        {/* Composer */}
        <div className="border-t border-cyan-400/10 bg-slate-950/60 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl">
          <div className="mx-auto w-full max-w-3xl">
            <div className="flex items-end gap-2 rounded-2xl border border-cyan-400/15 bg-slate-900/70 px-3 py-2.5 transition focus-within:border-cyan-400/40">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onKeyDown}
                rows={1}
                maxLength={4000}
                placeholder="Message JARVIS…"
                disabled={isLoadingHistory}
                className="max-h-[180px] min-h-[24px] flex-1 resize-none bg-transparent py-1 text-[15px] leading-relaxed text-slate-100 outline-none placeholder:text-slate-500 disabled:opacity-50"
                aria-label="Message JARVIS"
              />

              {isSending ? (
                <button
                  type="button"
                  onClick={stop}
                  className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-rose-400/30 bg-rose-500/15 text-rose-300 transition hover:bg-rose-500/25"
                  aria-label="Stop generating"
                >
                  <Square className="h-3.5 w-3.5" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={!draft.trim()}
                  className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-400/30 bg-cyan-400/15 text-cyan-200 transition enabled:hover:bg-cyan-400/25 disabled:cursor-not-allowed disabled:opacity-35"
                  aria-label="Send message"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
              )}
            </div>

            <p className="mt-2 text-center font-mono text-[10px] text-slate-500">
              Enter to send · Shift+Enter for a new line · JARVIS never claims a capability it
              doesn&apos;t have
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

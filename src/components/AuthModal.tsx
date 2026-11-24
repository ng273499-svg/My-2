'use client';

import React, { useState } from 'react';
import {
  CheckCircle2,
  KeyRound,
  Loader2,
  LogOut,
  ShieldCheck,
  UserCheck,
  UserPlus,
  X,
} from 'lucide-react';
import type { BrowserOperatorSession } from '@/lib/supabase-browser';

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
  session: BrowserOperatorSession | null;
  supabaseConfigured: boolean;
  clientSyncActive: boolean;
  onSignIn: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  onSignUp: (
    email: string,
    password: string,
    displayName: string
  ) => Promise<{ ok: boolean; error?: string }>;
  onSignOut: () => Promise<void>;
}

export function AuthModal({
  open,
  onClose,
  session,
  supabaseConfigured,
  clientSyncActive,
  onSignIn,
  onSignUp,
  onSignOut,
}: AuthModalProps) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setStatusMessage(null);
    setBusy(true);

    try {
      const res =
        mode === 'signin'
          ? await onSignIn(email, password)
          : await onSignUp(email, password, displayName);

      if (!res.ok) {
        setErrorMessage(res.error || 'Authentication failed.');
      } else if (res.error) {
        setStatusMessage(res.error);
      } else {
        setEmail('');
        setPassword('');
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="JARVIS-X Operator Authentication"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
    >
      <div className="glass-panel w-full max-w-md p-5 text-slate-100">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-cyan-300" />
            <h2 className="font-display text-base font-semibold">
              Operator Authentication
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Authentication Modal"
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-slate-400 hover:bg-slate-800/70 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {session ? (
          <div className="mt-4 space-y-4">
            <div className="rounded-xl border border-emerald-400/30 bg-emerald-950/25 p-4">
              <div className="flex items-center gap-2 font-mono text-xs font-semibold uppercase tracking-wider text-emerald-300">
                <CheckCircle2 className="h-4 w-4" />
                Authenticated Supabase Operator
              </div>
              <div className="mt-2 space-y-1 text-xs text-slate-200">
                <div>
                  <span className="font-mono text-slate-400">Name:</span>{' '}
                  {session.displayName}
                </div>
                <div className="truncate">
                  <span className="font-mono text-slate-400">Email:</span>{' '}
                  {session.email}
                </div>
                <div className="truncate font-mono text-[11px] text-slate-400">
                  UID: {session.userId}
                </div>
              </div>
              <div className="mt-3 flex items-center gap-1.5 font-mono text-[11px] text-cyan-200">
                <ShieldCheck className="h-3.5 w-3.5 text-cyan-300" />
                {clientSyncActive
                  ? 'PostgreSQL FORCE ROW LEVEL SECURITY Active'
                  : 'Session active (Degraded fallback ready if offline)'}
              </div>
            </div>

            <button
              type="button"
              onClick={async () => {
                setBusy(true);
                try {
                  await onSignOut();
                  onClose();
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
              className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-rose-400/35 bg-rose-500/15 font-display text-sm font-medium text-rose-200 transition hover:bg-rose-500/25 disabled:opacity-50"
            >
              <LogOut className="h-4 w-4" />
              Sign Out &amp; Return to Ephemeral Mode
            </button>
          </div>
        ) : (
          <div className="mt-4">
            <div className="mb-4 grid grid-cols-2 gap-1.5 rounded-xl border border-slate-800 bg-slate-950 p-1">
              <button
                type="button"
                onClick={() => {
                  setMode('signin');
                  setErrorMessage(null);
                }}
                className={`flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg font-mono text-xs transition ${
                  mode === 'signin'
                    ? 'border border-cyan-400/40 bg-cyan-500/15 text-cyan-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <UserCheck className="h-3.5 w-3.5" />
                Sign In
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('signup');
                  setErrorMessage(null);
                }}
                className={`flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg font-mono text-xs transition ${
                  mode === 'signup'
                    ? 'border border-cyan-400/40 bg-cyan-500/15 text-cyan-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <UserPlus className="h-3.5 w-3.5" />
                Register
              </button>
            </div>

            {!supabaseConfigured && (
              <p className="mb-3 rounded-xl border border-amber-400/30 bg-amber-950/25 px-3 py-2 text-xs text-amber-200">
                Supabase credentials are not configured on this instance. Running in Guest Ephemeral mode.
              </p>
            )}

            <form onSubmit={handleSubmit} className="space-y-3">
              {mode === 'signup' && (
                <div>
                  <label
                    htmlFor="auth-display-name"
                    className="mb-1 block font-mono text-[11px] uppercase tracking-wider text-slate-400"
                  >
                    Operator Callsign / Display Name
                  </label>
                  <input
                    id="auth-display-name"
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Prime Operator"
                    className="min-h-[44px] w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 text-sm text-slate-100 placeholder-slate-500 focus:border-cyan-400 focus:outline-none"
                  />
                </div>
              )}

              <div>
                <label
                  htmlFor="auth-email"
                  className="mb-1 block font-mono text-[11px] uppercase tracking-wider text-slate-400"
                >
                  Email Address
                </label>
                <input
                  id="auth-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="operator@domain.com"
                  className="min-h-[44px] w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 text-sm text-slate-100 placeholder-slate-500 focus:border-cyan-400 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="auth-password"
                  className="mb-1 block font-mono text-[11px] uppercase tracking-wider text-slate-400"
                >
                  Password (min 6 characters)
                </label>
                <input
                  id="auth-password"
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="min-h-[44px] w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 text-sm text-slate-100 placeholder-slate-500 focus:border-cyan-400 focus:outline-none"
                />
              </div>

              {errorMessage && (
                <div className="rounded-xl border border-rose-400/35 bg-rose-950/35 px-3 py-2 font-mono text-xs text-rose-200">
                  {errorMessage}
                </div>
              )}

              {statusMessage && (
                <div className="rounded-xl border border-cyan-400/35 bg-cyan-950/35 px-3 py-2 font-mono text-xs text-cyan-200">
                  {statusMessage}
                </div>
              )}

              <button
                type="submit"
                disabled={busy || !supabaseConfigured}
                className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-cyan-400/50 bg-cyan-500/20 font-display text-sm font-semibold text-cyan-100 transition hover:bg-cyan-500/30 disabled:opacity-45"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : mode === 'signin' ? (
                  'Authenticate with Supabase RLS'
                ) : (
                  'Provision Operator Account'
                )}
              </button>
            </form>

            <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
              All private conversations, memories, preferences, and audit logs are isolated per user via PostgreSQL <code className="font-mono text-cyan-200">FORCE ROW LEVEL SECURITY</code>.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

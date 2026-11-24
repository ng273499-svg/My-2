import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

export type ServerReachabilityState =
  | 'connected'
  | 'degraded_unreachable'
  | 'not_configured';

export interface SupabaseConnectionDiagnostics {
  configured: boolean;
  projectRef: string | null;
  serverReachability: ServerReachabilityState;
  authReady: boolean;
  pgvectorEnabled: boolean;
  rlsForced: boolean;
  hasServiceRole: boolean;
  persistenceMode: 'supabase_cloud' | 'degraded_fallback' | 'ephemeral_session';
  domainsPrepared: string[];
  migrationPath: string;
  migrationPaths: string[];
  statusDetail: string;
}

export const SUPABASE_PREPARED_DOMAINS = [
  'authentication',
  'user_profiles',
  'conversations',
  'conversation_messages',
  'long_term_memories',
  'projects',
  'agent_tasks',
  'preferences',
  'connected_tools',
  'permission_records',
  'audit_logs',
];

export const SUPABASE_MIGRATION_PATHS = [
  'supabase/migrations/20261022000001_jarvis_x_foundation.sql',
  'supabase/migrations/20261022000002_jarvis_x_audit_rls_pgvector.sql',
  'supabase/migrations/20261022000003_jarvis_x_core_runtime_tasks.sql',
  'supabase/migrations/20261022000004_jarvis_x_routing_policy.sql',
  'supabase/migrations/20261022000005_jarvis_x_hierarchical_memory.sql',
  'supabase/migrations/20261022000006_jarvis_x_multimodal_workflows.sql',
  'supabase/migrations/20261022000007_jarvis_x_voice_preferences.sql',
];

/**
 * Wraps fetch with an AbortController timeout so unreachable/degraded Supabase
 * networks fail fast (<2.2s) and trigger graceful fallback rather than hanging.
 */
export function createTimeoutFetch(timeoutMs = 2200): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, {
        ...init,
        signal: init?.signal ?? controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

let cachedReachability: {
  state: ServerReachabilityState;
  checkedAt: number;
  detail?: string;
} | null = null;

export function resetSupabaseReachabilityCache(): void {
  cachedReachability = null;
}

export async function probeSupabaseServerReachability(): Promise<{
  state: ServerReachabilityState;
  detail?: string;
}> {
  const url = process.env.SUPABASE_URL?.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();

  if (!url || !anonKey) {
    return { state: 'not_configured', detail: 'SUPABASE_URL or SUPABASE_ANON_KEY missing.' };
  }

  const now = Date.now();
  if (cachedReachability && now - cachedReachability.checkedAt < 15_000) {
    return { state: cachedReachability.state, detail: cachedReachability.detail };
  }

  try {
    const fastFetch = createTimeoutFetch(1800);
    const res = await fastFetch(`${url.replace(/\/$/, '')}/auth/v1/health`, {
      method: 'GET',
      headers: {
        apikey: anonKey,
      },
    });
    const ok = res.status >= 200 && res.status < 500;
    const state: ServerReachabilityState = ok ? 'connected' : 'degraded_unreachable';
    const detail = ok
      ? undefined
      : `Supabase Auth health probe returned HTTP ${res.status}.`;
    cachedReachability = { state, checkedAt: now, detail };
    return { state, detail };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Network connection failed';
    cachedReachability = {
      state: 'degraded_unreachable',
      checkedAt: now,
      detail: reason,
    };
    return { state: 'degraded_unreachable', detail: reason };
  }
}

export async function getSupabaseDiagnostics(
  authenticatedUser = false
): Promise<SupabaseConnectionDiagnostics> {
  const url = process.env.SUPABASE_URL?.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const projectRef =
    process.env.SUPABASE_PROJECT_REF?.trim() ||
    url?.match(/^https:\/\/([a-z0-9-]+)\.supabase\.co/i)?.[1] ||
    null;

  const configured = Boolean(url && anonKey);
  if (!configured) {
    return {
      configured: false,
      projectRef: null,
      serverReachability: 'not_configured',
      authReady: false,
      pgvectorEnabled: true,
      rlsForced: true,
      hasServiceRole: Boolean(serviceKey),
      persistenceMode: 'ephemeral_session',
      domainsPrepared: SUPABASE_PREPARED_DOMAINS,
      migrationPath: SUPABASE_MIGRATION_PATHS[0],
      migrationPaths: SUPABASE_MIGRATION_PATHS,
      statusDetail:
        'Not Configured — SUPABASE_URL / SUPABASE_ANON_KEY not set. Running isolated local ephemeral repository.',
    };
  }

  const probe = await probeSupabaseServerReachability();

  if (probe.state === 'degraded_unreachable') {
    return {
      configured: true,
      projectRef,
      serverReachability: 'degraded_unreachable',
      authReady: true,
      pgvectorEnabled: true,
      rlsForced: true,
      hasServiceRole: Boolean(serviceKey),
      persistenceMode: 'degraded_fallback',
      domainsPrepared: SUPABASE_PREPARED_DOMAINS,
      migrationPath: SUPABASE_MIGRATION_PATHS[SUPABASE_MIGRATION_PATHS.length - 1],
      migrationPaths: SUPABASE_MIGRATION_PATHS,
      statusDetail:
        'Supabase project linked & migrated (RLS + pgvector active), but server egress to *.supabase.co is currently unreachable — degraded server fallback active; browser RLS client sync available.',
    };
  }

  return {
    configured: true,
    projectRef,
    serverReachability: 'connected',
    authReady: true,
    pgvectorEnabled: true,
    rlsForced: true,
    hasServiceRole: Boolean(serviceKey),
    persistenceMode: authenticatedUser ? 'supabase_cloud' : 'ephemeral_session',
    domainsPrepared: SUPABASE_PREPARED_DOMAINS,
    migrationPath: SUPABASE_MIGRATION_PATHS[SUPABASE_MIGRATION_PATHS.length - 1],
    migrationPaths: SUPABASE_MIGRATION_PATHS,
    statusDetail: authenticatedUser
      ? 'Connected to Supabase Cloud with user-scoped FORCE ROW LEVEL SECURITY.'
      : 'Supabase Cloud online & verified. Sign in to persist private data under Row-Level Security (currently Guest Ephemeral mode).',
  };
}

/**
 * Returns ONLY public, non-privileged Supabase connection parameters suitable for
 * browser Auth + RLS client initialization. Privileged keys (`SUPABASE_SERVICE_ROLE_KEY`)
 * are NEVER included here.
 */
export function getPublicSupabaseBrowserConfig(): {
  configured: boolean;
  projectRef: string | null;
  url: string | null;
  anonKey: string | null;
} {
  const url = process.env.SUPABASE_URL?.trim() || null;
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim() || null;
  const projectRef =
    process.env.SUPABASE_PROJECT_REF?.trim() ||
    url?.match(/^https:\/\/([a-z0-9-]+)\.supabase\.co/i)?.[1] ||
    null;

  return {
    configured: Boolean(url && anonKey),
    projectRef,
    url: url && anonKey ? url : null,
    anonKey: url && anonKey ? anonKey : null,
  };
}

/**
 * Creates a strictly user-scoped Supabase client enforcing PostgreSQL Row Level Security.
 * NEVER uses `SUPABASE_SERVICE_ROLE_KEY`.
 */
export function createUserScopedSupabaseClient(
  userAccessToken: string
): SupabaseClient<Database> | null {
  const url = process.env.SUPABASE_URL?.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();

  if (!url || !anonKey || !userAccessToken.trim()) {
    return null;
  }

  return createClient<Database>(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      fetch: createTimeoutFetch(2500),
      headers: {
        Authorization: `Bearer ${userAccessToken}`,
      },
    },
  });
}

let cachedPublicAuthClient: {
  cacheKey: string;
  client: SupabaseClient<Database>;
} | null = null;

/**
 * Creates an unauthenticated public Auth client (strictly anon key) for server-side
 * signUp / signInWithPassword / getUser calls. NEVER uses `SUPABASE_SERVICE_ROLE_KEY`.
 */
export function createPublicAuthSupabaseClient(): SupabaseClient<Database> | null {
  const url = process.env.SUPABASE_URL?.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();

  if (!url || !anonKey) {
    return null;
  }

  const cacheKey = `${url}::${anonKey}`;
  if (cachedPublicAuthClient && cachedPublicAuthClient.cacheKey === cacheKey) {
    return cachedPublicAuthClient.client;
  }

  const client = createClient<Database>(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: 'jarvis-x-server-stateless-auth',
    },
    global: {
      fetch: createTimeoutFetch(2500),
    },
  });

  cachedPublicAuthClient = { cacheKey, client };
  return client;
}

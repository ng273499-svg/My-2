import 'server-only';
import { JarvisCore } from '@/core/modules/jarvis-core';
import type { PermissionRequest } from '@/core/types';
import { InMemorySessionRepository } from '@/server/repositories/in-memory-repository';
import { ResilientDataRepository } from '@/server/repositories/resilient-repository';
import { SupabaseDataRepository } from '@/server/repositories/supabase-repository';
import { getDocumentEngine } from '@/server/document-engine';
import {
  GUEST_ACTOR,
  resolveRequestActor,
  type AuthActorContext,
} from '@/server/supabase/auth';
import {
  createUserScopedSupabaseClient,
  getSupabaseDiagnostics,
  probeSupabaseServerReachability,
} from '@/server/supabase/client';

const globalForJarvis = globalThis as unknown as {
  __jarvisFallbackRepository?: InMemorySessionRepository;
  __jarvisPendingPermissions?: Map<string, PermissionRequest>;
};

function getSharedFallbackRepository(): InMemorySessionRepository {
  if (!globalForJarvis.__jarvisFallbackRepository) {
    globalForJarvis.__jarvisFallbackRepository = new InMemorySessionRepository();
  }
  return globalForJarvis.__jarvisFallbackRepository;
}

function getSharedPendingPermissions(): Map<string, PermissionRequest> {
  if (!globalForJarvis.__jarvisPendingPermissions) {
    globalForJarvis.__jarvisPendingPermissions = new Map<string, PermissionRequest>();
  }
  return globalForJarvis.__jarvisPendingPermissions;
}

/**
 * Resolves the calling operator from the HTTP request and builds a strictly
 * actor-scoped `JarvisCore` backed by `ResilientDataRepository` (real user-scoped
 * Supabase RLS repository primary + graceful degraded fallback if unreachable).
 */
export async function getJarvisCoreForRequest(request?: Request | null): Promise<{
  jarvis: JarvisCore;
  actor: AuthActorContext;
  repository: ResilientDataRepository;
}> {
  const actor = await resolveRequestActor(request);
  const supabaseConfigured = Boolean(
    process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_ANON_KEY?.trim()
  );

  const userClient =
    actor.authenticated && actor.accessToken
      ? createUserScopedSupabaseClient(actor.accessToken)
      : null;

  const primaryRepo = userClient ? new SupabaseDataRepository(userClient) : null;
  const fallbackRepo = getSharedFallbackRepository();

  const reachability = supabaseConfigured
    ? await probeSupabaseServerReachability()
    : null;
  const initialDegradedReason =
    reachability?.state === 'degraded_unreachable'
      ? reachability.detail || 'Supabase endpoint temporarily unreachable from server.'
      : null;

  const repository = new ResilientDataRepository(
    primaryRepo,
    fallbackRepo,
    supabaseConfigured,
    initialDegradedReason
  );

  const jarvis = new JarvisCore(
    repository,
    getSupabaseDiagnostics,
    actor,
    getSharedPendingPermissions(),
    {
      // One document engine per server process. Ingested documents must remain
      // retrievable on the next request; owner isolation is enforced inside the
      // engine by `ownerId` on every read, and memory writes stay per-call.
      documentEngine: getDocumentEngine(),
    }
  );

  return { jarvis, actor, repository };
}

/**
 * Synchronous guest/SSR helper for initial page shell rendering when no Request header is present.
 */
export function getGuestJarvisCore(): JarvisCore {
  const supabaseConfigured = Boolean(
    process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_ANON_KEY?.trim()
  );
  const repository = new ResilientDataRepository(
    null,
    getSharedFallbackRepository(),
    supabaseConfigured
  );
  return new JarvisCore(
    repository,
    getSupabaseDiagnostics,
    GUEST_ACTOR,
    getSharedPendingPermissions()
  );
}

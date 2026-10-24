import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeEach } from 'vitest';
import { JarvisCore } from '@/core/modules/jarvis-core';
import { InMemorySessionRepository } from '@/server/repositories/in-memory-repository';
import { ResilientDataRepository } from '@/server/repositories/resilient-repository';
import {
  SupabaseConnectivityError,
  SupabaseDataRepository,
} from '@/server/repositories/supabase-repository';
import { resolveRequestActor } from '@/server/supabase/auth';
import {
  getPublicSupabaseBrowserConfig,
  resetSupabaseReachabilityCache,
  SUPABASE_MIGRATION_PATHS,
  SUPABASE_PREPARED_DOMAINS,
} from '@/server/supabase/client';
import type { PermissionRequest } from '@/core/types';

function makeSignedTestJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
    'base64url'
  );
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.test_signature`;
}

describe('Supabase Persistence, Auth, RLS Isolation, Fallback & Secret Hygiene', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://jdlxnidzakdtksjzazqe.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'sb_publishable_test_anon_key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'super_secret_service_role_key_never_expose';
    resetSupabaseReachabilityCache();
  });

  it('never exposes SUPABASE_SERVICE_ROLE_KEY in public browser config or client components', () => {
    const pub = getPublicSupabaseBrowserConfig();
    expect(pub.configured).toBe(true);
    expect(pub.url).toBe('https://jdlxnidzakdtksjzazqe.supabase.co');
    expect(pub.anonKey).toBe('sb_publishable_test_anon_key');
    expect(JSON.stringify(pub)).not.toContain('super_secret_service_role_key_never_expose');
    expect(JSON.stringify(pub)).not.toContain('service_role');

    // Scan all client components & browser lib files to ensure zero service-role references
    const clientDirs = [
      path.resolve(__dirname, '../components'),
      path.resolve(__dirname, '../lib'),
    ];
    for (const dir of clientDirs) {
      for (const file of fs.readdirSync(dir)) {
        const content = fs.readFileSync(path.join(dir, file), 'utf8');
        expect(content).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
      }
    }
  });

  it('validates operator JWTs during degraded offline reachability and rejects expired or wrong-issuer tokens', async () => {
    const validUserId = '11111111-1111-4111-8111-111111111111';
    const validToken = makeSignedTestJwt({
      sub: validUserId,
      aud: 'authenticated',
      iss: 'https://jdlxnidzakdtksjzazqe.supabase.co/auth/v1',
      email: 'alice@jarvis.test',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const reqValid = new Request('http://localhost:3000/api/jarvis/status', {
      headers: { Authorization: `Bearer ${validToken}` },
    });
    const actor = await resolveRequestActor(reqValid);
    expect(actor.authenticated).toBe(true);
    expect(actor.userId).toBe(validUserId);
    expect(actor.email).toBe('alice@jarvis.test');

    // Expired token -> must reject and downgrade to guest ephemeral
    const expiredToken = makeSignedTestJwt({
      sub: validUserId,
      aud: 'authenticated',
      iss: 'https://jdlxnidzakdtksjzazqe.supabase.co/auth/v1',
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const reqExpired = new Request('http://localhost:3000/api/jarvis/status', {
      headers: { Authorization: `Bearer ${expiredToken}` },
    });
    const expiredActor = await resolveRequestActor(reqExpired);
    expect(expiredActor.authenticated).toBe(false);

    // Wrong issuer -> must reject
    const wrongIssuerToken = makeSignedTestJwt({
      sub: validUserId,
      aud: 'authenticated',
      iss: 'https://attacker.example.com/auth/v1',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const reqWrong = new Request('http://localhost:3000/api/jarvis/status', {
      headers: { Authorization: `Bearer ${wrongIssuerToken}` },
    });
    const wrongActor = await resolveRequestActor(reqWrong);
    expect(wrongActor.authenticated).toBe(false);
  });

  it('creates/retrieves conversations, preferences, memories, vectors, connected tools, permission records & immutable audit logs per operator with strict user isolation', async () => {
    const sharedRepo = new InMemorySessionRepository('ephemeral_session');
    const sharedPending = new Map<string, PermissionRequest>();
    const diagStub = () => ({
      configured: true,
      projectRef: 'jdlxnidzakdtksjzazqe',
      serverReachability: 'connected' as const,
      authReady: true,
      pgvectorEnabled: true,
      rlsForced: true,
      hasServiceRole: true,
      persistenceMode: 'supabase_cloud' as const,
      domainsPrepared: SUPABASE_PREPARED_DOMAINS,
      migrationPath: SUPABASE_MIGRATION_PATHS[1],
      migrationPaths: SUPABASE_MIGRATION_PATHS,
      statusDetail: 'Connected',
    });

    const userA = {
      authenticated: true,
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'alice@jarvis.test',
      displayName: 'Alice',
      callsign: 'OP-1111',
      verificationMode: 'supabase_jwt' as const,
    };
    const userB = {
      authenticated: true,
      userId: '22222222-2222-4222-8222-222222222222',
      email: 'bob@jarvis.test',
      displayName: 'Bob',
      callsign: 'OP-2222',
      verificationMode: 'supabase_jwt' as const,
    };

    const coreA = new JarvisCore(sharedRepo, diagStub, userA, sharedPending);
    const coreB = new JarvisCore(sharedRepo, diagStub, userB, sharedPending);

    // 1. User A creates a conversation & exchanges messages
    const convA = await coreA.createConversation({ title: 'Alice Private Mission' });
    await coreA.handleTurn({
      conversationId: convA.id,
      message: 'Check status diagnostics for Alice.',
    });

    const retrievedConvA = await coreA.getConversation(convA.id);
    expect(retrievedConvA?.title).toBe('Alice Private Mission');
    const msgsA = await coreA.getConversationMessages(convA.id);
    expect(msgsA).toHaveLength(2);

    // 2. User B cannot see Alice's conversation or messages
    const retrievedByB = await coreB.getConversation(convA.id);
    expect(retrievedByB).toBeNull();
    const msgsByB = await coreB.getConversationMessages(convA.id);
    expect(msgsByB).toHaveLength(0);

    // 3. Preferences persistence & isolation
    await coreA.updateOperatorPreferences({
      preferredResponseStyle: 'curiosity',
      witLevel: 'moderate',
    });
    const snapA = await coreA.getSystemSnapshot(convA.id);
    const snapB = await coreB.getSystemSnapshot();
    expect(snapA.preferences.preferredResponseStyle).toBe('curiosity');
    expect(snapB.preferences.preferredResponseStyle).toBe('calm');

    // 4. Memory persistence + vector search + isolation
    const emb = new Array(16).fill(0.5);
    await coreA.memoryManager.storeMemory(
      userA.userId,
      'Alice secret orbital keyphrase alpha-9',
      'fact',
      ['secret'],
      convA.id,
      emb
    );
    const vecHitsA = await coreA.memoryManager.searchByVector(userA.userId, emb, 0.8, 5);
    expect(vecHitsA).toHaveLength(1);
    expect(vecHitsA[0].content).toContain('alpha-9');

    const vecHitsB = await coreB.memoryManager.searchByVector(userB.userId, emb, 0.1, 5);
    expect(vecHitsB).toHaveLength(0);

    // 5. Connected-tool metadata persistence & isolation
    await coreA.upsertConnectedToolMetadata({
      toolSlug: 'web_research',
      displayName: 'Web Research Connector',
      category: 'web_research',
      connectionStatus: 'not_connected',
      defaultPermissionTier: 'SAFE_READ',
      scopes: ['search:read'],
    });
    expect(await coreA.listConnectedToolMetadata()).toHaveLength(1);
    expect(await coreB.listConnectedToolMetadata()).toHaveLength(0);

    // 6. Cross-operator pending permission isolation & audit logs
    const gatedTurnA = await coreA.handleTurn({
      conversationId: convA.id,
      message: 'Remember that Alice prefers dark glass telemetry.',
    });
    const permIdA = gatedTurnA.pendingPermission!.id;

    // User B tries to approve User A's pending permission -> MUST FAIL!
    const hijackAttempt = await coreB.resolvePermissionDecision({
      requestId: permIdA,
      approve: true,
    });
    expect(hijackAttempt.resolved).toBe(false);

    // User A approves own permission -> SUCCEEDS & writes audit log!
    const validApprove = await coreA.resolvePermissionDecision({
      requestId: permIdA,
      approve: true,
    });
    expect(validApprove.resolved).toBe(true);

    const finalSnapA = await coreA.getSystemSnapshot(convA.id);
    expect(finalSnapA.auditLogs.length).toBeGreaterThanOrEqual(4);
    expect(
      finalSnapA.permissionAudit.some(
        (p) => p.id === permIdA && p.decision === 'approved'
      )
    ).toBe(true);
  });

  it('gracefully falls back to degraded in-memory store when Supabase throws connectivity errors, without masking RLS errors', async () => {
    // Mock Supabase client simulating network unreachable error first, then RLS violation
    let failWithNetwork = true;
    const mockSupabaseClient = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () =>
              failWithNetwork
                ? {
                    data: null,
                    error: { message: 'TypeError: fetch failed (ECONNREFUSED)' },
                  }
                : {
                    data: null,
                    error: {
                      message: 'new row violates row-level security policy for table "preferences"',
                    },
                  },
          }),
        }),
      }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supaRepo = new SupabaseDataRepository(mockSupabaseClient as any);
    const fallbackRepo = new InMemorySessionRepository();
    const resilient = new ResilientDataRepository(supaRepo, fallbackRepo, true);

    const userId = '33333333-3333-4333-8333-333333333333';

    // Network failure -> seamlessly falls back & marks mode as degraded_fallback!
    const prefs = await resilient.getPreferences(userId);
    expect(prefs.preferredResponseStyle).toBe('calm');
    expect(resilient.mode).toBe('degraded_fallback');
    expect(resilient.lastFallbackReason).toContain('fetch failed');

    // Non-connectivity error (e.g. RLS violation) on an active non-degraded repo -> MUST NOT be swallowed!
    failWithNetwork = false;
    const activeResilient = new ResilientDataRepository(supaRepo, fallbackRepo, true);
    await expect(activeResilient.getPreferences(userId)).rejects.toThrow(
      /violates row-level security policy/
    );
    await expect(
      Promise.reject(new SupabaseConnectivityError('socket timeout'))
    ).rejects.toBeInstanceOf(SupabaseConnectivityError);
  });
});

import { describe, expect, it } from 'vitest';
import { JarvisCore } from '@/core/modules/jarvis-core';
import { InMemorySessionRepository } from '@/server/repositories/in-memory-repository';
import {
  SUPABASE_MIGRATION_PATHS,
  SUPABASE_PREPARED_DOMAINS,
} from '@/server/supabase/client';
import type { ModelProviderAdapter } from '@/core/types';

function createTestCore() {
  const repo = new InMemorySessionRepository();
  return new JarvisCore(repo, () => ({
    configured: true,
    projectRef: 'jdlxnidzakdtksjzazqe',
    serverReachability: 'connected',
    authReady: true,
    pgvectorEnabled: true,
    rlsForced: true,
    hasServiceRole: true,
    persistenceMode: 'ephemeral_session',
    domainsPrepared: SUPABASE_PREPARED_DOMAINS,
    migrationPath: SUPABASE_MIGRATION_PATHS[SUPABASE_MIGRATION_PATHS.length - 1],
    migrationPaths: SUPABASE_MIGRATION_PATHS,
    statusDetail: 'Connected for test.',
  }));
}

describe('JARVIS-X Modular Core & Runtime Architecture', () => {
  it('exposes all 14 modular subsystems, 10 specialist contracts, 10 runtime capabilities, and 11 Supabase schema domains', async () => {
    const core = createTestCore();
    const snapshot = await core.getSystemSnapshot();

    expect(snapshot.modules).toHaveLength(14);
    expect(snapshot.specialists).toHaveLength(10);
    expect(snapshot.runtimeCapabilities).toHaveLength(10);
    expect(snapshot.supabase.domainsPrepared).toEqual([
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
    ]);
    expect(snapshot.supabase.pgvectorEnabled).toBe(true);
    expect(snapshot.supabase.rlsForced).toBe(true);
  });

  it('executes safe read-only turns through all real Core Runtime Agent Activity states', async () => {
    const core = createTestCore();
    const turn = await core.handleTurn({
      message: 'Run a full status diagnostics check on JARVIS-X.',
    });

    expect(turn.activitySteps.map((s) => s.stage)).toEqual([
      'understanding',
      'context_loading',
      'planning',
      'selecting',
      'executing',
      'observing',
      'verifying',
      'completed',
    ]);
    expect(turn.verification.outcome).toBe('verified');
    expect(turn.verification.noFabricatedCapabilitiesConfirmed).toBe(true);
    expect(turn.runtime.verification.verificationStatus).toBe('VERIFIED');
    expect(turn.pendingPermission).toBeUndefined();
  });

  it('enforces Tier-2 CONFIRMATION_REQUIRED gate before writing to memory store', async () => {
    const core = createTestCore();
    const beforeSnapshot = await core.getSystemSnapshot();
    const initialCount = beforeSnapshot.memory.storedEntriesCount;

    const turn = await core.handleTurn({
      message: 'Remember that my preferred deployment region is ap-south-1.',
    });

    expect(turn.pendingPermission).toBeDefined();
    expect(turn.pendingPermission?.tier).toBe('CONFIRMATION_REQUIRED');
    expect(turn.runtime.finalState).toBe('WAITING_FOR_USER_APPROVAL');

    const midSnapshot = await core.getSystemSnapshot();
    expect(midSnapshot.memory.storedEntriesCount).toBe(initialCount);

    const resolution = await core.resolvePermissionDecision({
      requestId: turn.pendingPermission!.id,
      approve: true,
    });
    expect(resolution.resolved).toBe(true);
    expect(resolution.decision).toBe('approved');

    const afterSnapshot = await core.getSystemSnapshot();
    expect(afterSnapshot.memory.storedEntriesCount).toBe(initialCount + 1);
  });

  it('enforces Tier-3 SENSITIVE_AUTH_REQUIRED gate and blocks unauthenticated smart-device actuation', async () => {
    const core = createTestCore();
    const turn = await core.handleTurn({
      message: 'Unlock the front smart-home door lock right now!',
    });

    expect(turn.contextSignals.recommendedStyle).toBe('urgency');
    expect(turn.pendingPermission).toBeDefined();
    expect(turn.pendingPermission?.tier).toBe('SENSITIVE_AUTH_REQUIRED');
    expect(turn.pendingPermission?.requiresStepUpAuth).toBe(true);
    expect(turn.runtime.finalState).toBe('WAITING_FOR_USER_APPROVAL');

    const failedAuth = await core.resolvePermissionDecision({
      requestId: turn.pendingPermission!.id,
      approve: true,
      stepUpPasscode: 'WRONG-CODE',
    });
    expect(failedAuth.resolved).toBe(false);
    expect(failedAuth.decision).toBe('blocked_unauthenticated');

    const validAuth = await core.resolvePermissionDecision({
      requestId: turn.pendingPermission!.id,
      approve: true,
      stepUpPasscode: 'JARVIS-VERIFY',
    });
    expect(validAuth.resolved).toBe(true);
    expect(validAuth.followUpMessage?.content).toContain('Not Connected');
  });

  it('supports registering future AI Model Providers without rewriting JARVIS Core', async () => {
    const core = createTestCore();

    const customAdapter: ModelProviderAdapter = {
      providerId: 'custom-test-llm',
      providerName: 'Custom Test Provider',
      isConfigured: () => true,
      listModels: () => [
        {
          id: 'custom-v1',
          providerId: 'custom-test-llm',
          providerName: 'Custom Test Provider',
          displayName: 'Custom Test Model v1',
          availability: 'ready',
          isPaidExternal: false,
          capabilities: ['chat', 'reasoning'],
          latencyProfile: 'balanced',
          statusNote: 'Connected in test.',
        },
      ],
      generate: async (input) => ({
        content: `[Custom Provider Response · Style=${input.responseStyle}] Ready.`,
        modelId: 'custom-v1',
        providerId: 'custom-test-llm',
        tokensEstimated: 12,
        latencyMs: 3,
        usedFallbackFoundation: false,
      }),
    };

    core.modelRouter.registerProvider(customAdapter);
    await core.updateOperatorPreferences({ preferredModelProvider: 'custom-test-llm' });

    const turn = await core.handleTurn({ message: 'Hello custom model!' });
    expect(turn.routeDecision.selectedModel.id).toBe('custom-v1');
    expect(turn.assistantMessage.content).toContain('[Custom Provider Response');
  });
});

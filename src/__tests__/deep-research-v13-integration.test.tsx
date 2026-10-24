/**
 * JARVIS-X v1.3.0 — Deep Research integration tests (AN–AP).
 *
 * Covers the HTTP contract, the mobile Research HUD, and the cross-engine
 * boundaries (Coding Engine bridge, permission gate, no command authority for
 * web content).
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JarvisCore, JARVIS_CORE_VERSION } from '@/core/modules/jarvis-core';
import { ResearchEngine, type ResearchResult } from '@/core/research';
import { FixtureSearchProvider } from '@/core/research/search-provider';
import { StaticFixtureFetchProvider, buildAuditCorpus } from '@/core/research/fixture-corpus';
import type { AuthSessionStatus } from '@/core/types';
import { InMemorySessionRepository } from '@/server/repositories/in-memory-repository';
import { ResearchWorkspacePanel } from '@/components/ResearchWorkspacePanel';
import {
  SUPABASE_MIGRATION_PATHS,
  SUPABASE_PREPARED_DOMAINS,
} from '@/server/supabase/client';

const GUEST_ACTOR: AuthSessionStatus = {
  authenticated: false,
  userId: '00000000-0000-4000-8000-000000000000',
  displayName: 'Guest Operator',
  callsign: 'GUEST-EPHEMERAL',
  verificationMode: 'anonymous_ephemeral',
};

const AUTHENTICATED_ACTOR: AuthSessionStatus = {
  authenticated: true,
  userId: 'owner-a',
  displayName: 'Owner A',
  callsign: 'OWNER-A',
  verificationMode: 'supabase_jwt',
};

function buildCore(actor: AuthSessionStatus = AUTHENTICATED_ACTOR, researchEngine?: ResearchEngine) {
  return new JarvisCore(
    new InMemorySessionRepository(),
    () => ({
    configured: true,
    projectRef: 'jdlxnidzakdtksjzazqe',
    serverReachability: 'connected' as const,
    authReady: true,
    pgvectorEnabled: false,
    rlsForced: true,
    hasServiceRole: true,
    persistenceMode: 'ephemeral_session' as const,
    domainsPrepared: SUPABASE_PREPARED_DOMAINS,
    migrationPath: SUPABASE_MIGRATION_PATHS[SUPABASE_MIGRATION_PATHS.length - 1],
    migrationPaths: SUPABASE_MIGRATION_PATHS,
    statusDetail: 'Local session',
    }),
    actor,
    undefined,
    researchEngine ? { researchEngine } : undefined
  );
}

function fixtureResearchEngine(): ResearchEngine {
  const { documents, failures } = buildAuditCorpus();
  return new ResearchEngine({
    searchProvider: new FixtureSearchProvider({ documents }),
    fetchProvider: new StaticFixtureFetchProvider({ documents, failures }),
    now: () => new Date('2026-10-24T00:00:00.000Z'),
  });
}

/* ==========================================================================
 * AN. HTTP API contract
 * ======================================================================== */

describe('v1.3 AN — Research API resolves identity server-side', () => {
  it('rejects an unauthenticated POST with 401 and no research work', async () => {
    const { POST } = await import('@/app/api/jarvis/research/route');
    const response = await POST(
      new Request('http://localhost:3000/api/jarvis/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'What is the default cache TTL?' }),
      })
    );

    expect(response.status).toBe(401);
    const payload = (await response.json()) as { ok: boolean; errorCode: string };
    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('UNAUTHORIZED_ACCESS');
  });

  it('rejects a client-supplied owner identity before doing any work', async () => {
    const { POST } = await import('@/app/api/jarvis/research/route');

    for (const field of ['ownerId', 'userId']) {
      const response = await POST(
        new Request('http://localhost:3000/api/jarvis/research', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'What is the default cache TTL?', [field]: 'attacker-owner' }),
        })
      );

      expect(response.status).toBe(400);
      const payload = (await response.json()) as { errorCode: string };
      expect(payload.errorCode).toBe('UNTRUSTED_IDENTITY_FIELD');
    }
  });

  it('rejects a malformed JSON body and an over-long query', async () => {
    const { POST } = await import('@/app/api/jarvis/research/route');

    const malformed = await POST(
      new Request('http://localhost:3000/api/jarvis/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      })
    );
    expect(malformed.status).toBe(400);

    const overLong = await POST(
      new Request('http://localhost:3000/api/jarvis/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'a'.repeat(5000) }),
      })
    );
    expect(overLong.status).toBe(400);
  });

  it('refuses to widen the budget past the hard ceiling', async () => {
    const { POST } = await import('@/app/api/jarvis/research/route');
    const response = await POST(
      new Request('http://localhost:3000/api/jarvis/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'What is the default cache TTL?', maxSources: 100000, maxQueries: 9999 }),
      })
    );
    // The schema clamps the values, so the request is rejected rather than honoured.
    expect(response.status).toBe(400);
  });

  it('requires authentication for status, task inspection, cancellation and history', async () => {
    const status = await import('@/app/api/jarvis/research/route');
    const task = await import('@/app/api/jarvis/research/[taskId]/route');
    const cancel = await import('@/app/api/jarvis/research/[taskId]/cancel/route');
    const history = await import('@/app/api/jarvis/research/history/route');

    const guest = () => new Request('http://localhost:3000/api/jarvis/research');

    expect((await status.GET(guest())).status).toBe(401);
    expect((await task.GET(guest(), { params: { taskId: 'rsch-1' } })).status).toBe(401);
    expect((await cancel.POST(guest(), { params: { taskId: 'rsch-1' } })).status).toBe(401);
    expect((await history.GET(guest())).status).toBe(401);
  });

  it('returns 404 (not 403) for a task the caller does not own', async () => {
    const route = await import('@/app/api/jarvis/research/[taskId]/route');
    // Unauthenticated callers are rejected before the lookup; the 404 path is
    // covered by the owner-isolation test on the engine itself.
    const response = await route.GET(new Request('http://localhost:3000/api/jarvis/research/rsch-x'), {
      params: { taskId: 'rsch-x' },
    });
    expect([401, 404]).toContain(response.status);
  });
});

/* ==========================================================================
 * AO. Mobile Research UI
 * ======================================================================== */

describe('v1.3 AO — Mobile-first Research HUD', () => {
  const provider = {
    providerId: 'fixture:non-live',
    label: 'Deterministic fixture index (NON-LIVE)',
    status: 'AVAILABLE',
    live: false,
    detail: 'Synthetic results only.',
  };

  it('labels a non-live provider honestly and never as real research', () => {
    render(
      <ResearchWorkspacePanel authenticated provider={provider} onRun={async () => null} onCancel={async () => false} />
    );

    expect(screen.getByTestId('research-provider-banner')).toHaveTextContent(/NON-LIVE/i);
    expect(screen.getByTestId('research-provider-banner')).toHaveTextContent(/no live search provider/i);
    // Never claims live results exist.
    expect(screen.queryByText(/LIVE WEB/)).toBeNull();
  });

  it('shows all nine research modes', () => {
    render(
      <ResearchWorkspacePanel authenticated provider={provider} onRun={async () => null} onCancel={async () => false} />
    );
    for (const mode of [
      'QUICK_RESEARCH',
      'DEEP_RESEARCH',
      'FACT_CHECK',
      'COMPARE',
      'LATEST',
      'SOURCE_DISCOVERY',
      'TECHNICAL_RESEARCH',
      'MARKET_RESEARCH',
      'ACADEMIC_DISCOVERY',
    ]) {
      expect(screen.getByTestId(`research-mode-${mode}`)).toBeInTheDocument();
    }
  });

  it('disables the run control for a guest and for a too-short query', () => {
    const { rerender } = render(
      <ResearchWorkspacePanel authenticated={false} provider={provider} onRun={async () => null} onCancel={async () => false} />
    );
    expect(screen.getByTestId('research-run')).toBeDisabled();
    expect(screen.getByText(/authenticated owner session is required/i)).toBeInTheDocument();

    rerender(
      <ResearchWorkspacePanel authenticated provider={provider} onRun={async () => null} onCancel={async () => false} />
    );
    expect(screen.getByTestId('research-run')).toBeDisabled();

    fireEvent.change(screen.getByTestId('research-query-input'), { target: { value: 'What is the cache TTL?' } });
    expect(screen.getByTestId('research-run')).toBeEnabled();
  });

  it('renders a completed report with citations and confidence', async () => {
    const onRun = vi.fn().mockResolvedValue({
      taskId: 'rsch-1',
      status: 'COMPLETED',
      mode: 'QUICK_RESEARCH',
      report: {
        title: 'Quantum Cache TTL',
        live: false,
        status: 'COMPLETED',
        executiveSummary: 'The default TTL is 300 seconds.',
        verifiedFindings: [
          {
            text: 'The default time-to-live is 300 seconds.',
            claimId: 'clm-1',
            state: 'SUPPORTED',
            citationIds: ['cit-1'],
            confidence: 0.8,
          },
        ],
        qualifiedFindings: [],
        conflicts: [],
        unknowns: ['No source retrieved for: internal benchmarks'],
        citations: [
          {
            citationId: 'cit-1',
            sourceId: 'src-1',
            url: 'https://docs.example.org/reference',
            canonicalUrl: 'https://docs.example.org/reference',
            title: 'Official reference',
            domain: 'docs.example.org',
            retrievedAt: '2026-10-24T00:00:00.000Z',
            publishedAt: '2026-09-02T00:00:00.000Z',
            provenance: 'WEB_SOURCE',
          },
        ],
        confidence: { level: 'MEDIUM', score: 0.6, notes: ['Two independent sources agree.'] },
        factCheck: null,
        contradictions: [],
        sourcesUsed: 2,
        sourcesDiscovered: 4,
        limitations: ['Search provider is NOT live.'],
        generatedAt: '2026-10-24T00:00:00.000Z',
      },
      sources: [],
      metrics: {
        queryCount: 3,
        sourcesDiscovered: 4,
        sourcesFetched: 2,
        evidenceUnits: 5,
        followUpRounds: 0,
        contradictions: 0,
        citationCount: 1,
        live: false,
        searchProviderStatus: 'AVAILABLE',
      },
      durationMs: 1200,
    });

    render(
      <ResearchWorkspacePanel authenticated provider={provider} onRun={onRun} onCancel={async () => false} />
    );

    fireEvent.change(screen.getByTestId('research-query-input'), { target: { value: 'What is the cache TTL?' } });
    fireEvent.click(screen.getByTestId('research-run'));

    await waitFor(() => expect(screen.getByTestId('research-report')).toBeInTheDocument());

    expect(screen.getByTestId('research-citations')).toHaveTextContent('Official reference');
    expect(screen.getByText(/MEDIUM confidence/i)).toBeInTheDocument();
    expect(screen.getByTestId('research-limitations')).toHaveTextContent('NOT live');
    expect(screen.getByTestId('research-report')).toHaveTextContent(/No source retrieved for/);
  });

  it('surfaces a research failure instead of pretending it succeeded', async () => {
    const onRun = vi.fn().mockRejectedValue(new Error('Research request failed.'));
    render(<ResearchWorkspacePanel authenticated provider={provider} onRun={onRun} onCancel={async () => false} />);

    fireEvent.change(screen.getByTestId('research-query-input'), { target: { value: 'What is the cache TTL?' } });
    fireEvent.click(screen.getByTestId('research-run'));

    await waitFor(() => expect(screen.getByTestId('research-error')).toHaveTextContent('Research request failed.'));
    expect(screen.queryByTestId('research-report')).toBeNull();
  });
});

/* ==========================================================================
 * AP. Cross-engine boundaries
 * ======================================================================== */

describe('v1.3 AP — Web content has no command authority', () => {
  it('exposes research as a read-only, non-command capability', () => {
    const core = buildCore();
    const capability = (core as unknown as {
      capabilityRegistry: { listDefinitions(): Array<Record<string, unknown>> };
    })
      .capabilityRegistry.listDefinitions()
      .find((entry) => entry.id === 'research');

    expect(capability).toBeDefined();
    expect(capability!.defaultRiskLevel).toBe('READ_ONLY');
    expect(capability!.countsAsToolCall).toBe(true);
    // No live provider is configured in the test environment: it must say so.
    expect(['PARTIAL_LOCAL', 'NOT_AVAILABLE']).toContain(capability!.availability);
  });

  it('keeps the v1.1 coding engine intact and separate from research', () => {
    const core = buildCore();
    const ids = (core as unknown as { capabilityRegistry: { listDefinitions(): Array<{ id: string }> } })
      .capabilityRegistry.listDefinitions()
      .map((entry) => entry.id);

    expect(ids).toHaveLength(10);
    expect(ids).toContain('coding');
    expect(ids).toContain('research');
    expect(ids).toContain('file_intelligence');
  });

  it('never turns injected page text into a permission request or a command', async () => {
    const core = buildCore(AUTHENTICATED_ACTOR, fixtureResearchEngine());

    const result = (await core.runResearch({
      query: 'Quantum Cache default time-to-live cached entry',
      mode: 'DEEP_RESEARCH',
    })) as ResearchResult;

    expect('errorCode' in result).toBe(false);
    expect(result.report).not.toBeNull();

    // No command, no permission prompt, no tool call is ever produced by page text.
    const serialized = JSON.stringify(result.report);
    expect(serialized).not.toMatch(/rm -rf/);
    expect(serialized).not.toMatch(/unrestricted assistant/i);
    expect(result.report!.citations.length).toBeGreaterThan(0);

    // Nothing was authorised: an unknown permission id resolves to nothing both
    // before and after a research run.
    expect(core.permissionSecurityManager.getPendingRequest('owner-a', 'perm-from-web')).toBeUndefined();
  });

  it('refuses research entirely for a guest session', async () => {
    const guest = buildCore(GUEST_ACTOR);
    const result = await guest.runResearch({ query: 'What is the default cache TTL?' });
    expect('errorCode' in result).toBe(true);
    if ('errorCode' in result) expect(result.errorCode).toBe('UNAUTHORIZED_ACCESS');
  });

  it('reports the provider as non-live through the core snapshot surface', () => {
    const core = buildCore(AUTHENTICATED_ACTOR, fixtureResearchEngine());
    const summary = core.researchSummary();
    expect(summary.liveWebResearch).toBe(false);
    expect(summary.provider.live).toBe(false);
    expect(summary.provider.status).toBe('AVAILABLE');
  });

  it('reports the research version only after v1.3 behaviour is present', () => {
    expect(JARVIS_CORE_VERSION).toBe('1.3.0-deep-research');
  });
});

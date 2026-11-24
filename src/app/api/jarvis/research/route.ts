import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getJarvisCoreForRequest } from '@/server/runtime';
import { RESEARCH_MODES } from '@/core/research/types';

/**
 * JARVIS-X v1.3.0 — Deep Research API
 *
 * POST /api/jarvis/research
 *
 * The owner is ALWAYS resolved from the authenticated session. A client-supplied
 * ownerId/userId is rejected by the schema, never trusted.
 *
 * Research is read-only and bounded: the mode's budget is clamped to a hard
 * ceiling inside the engine, so no payload can widen it into an open crawl.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ResearchSchema = z.object({
  query: z.string().min(3, 'Query is too short').max(2000),
  mode: z.enum(RESEARCH_MODES as [string, ...string[]]).optional(),
  projectId: z.string().uuid().nullable().optional(),
  selectedDocumentIds: z.array(z.string().min(1).max(120)).max(20).optional(),
  freshness: z.enum(['any', 'recent', 'latest']).optional(),
  maxSources: z.number().int().min(1).max(40).optional(),
  maxQueries: z.number().int().min(1).max(12).optional(),
  /** Explicitly rejected — identity is server-resolved. */
  ownerId: z.undefined().optional(),
  userId: z.undefined().optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, errorCode: 'INVALID_INPUT', error: 'Request body must be valid JSON.' },
      { status: 400 }
    );
  }

  const parsed = ResearchSchema.safeParse(body);
  if (!parsed.success) {
    const forgedIdentity = parsed.error.issues.some(
      (issue) => issue.path[0] === 'ownerId' || issue.path[0] === 'userId'
    );
    return NextResponse.json(
      {
        ok: false,
        errorCode: forgedIdentity ? 'UNTRUSTED_IDENTITY_FIELD' : 'INVALID_INPUT',
        error: forgedIdentity
          ? 'Owner identity is resolved server-side from the authenticated session and must not be supplied by the client.'
          : parsed.error.issues[0]?.message ?? 'Invalid research request.',
      },
      { status: 400 }
    );
  }

  try {
    const { jarvis, actor } = await getJarvisCoreForRequest(request);

    if (!actor.authenticated) {
      return NextResponse.json(
        {
          ok: false,
          errorCode: 'UNAUTHORIZED_ACCESS',
          error:
            'Deep research requires an authenticated owner session. Guest/voice-only sessions never receive research results.',
        },
        { status: 401 }
      );
    }

    const result = await jarvis.runResearch({
      query: parsed.data.query,
      mode: parsed.data.mode as never,
      projectId: parsed.data.projectId ?? null,
      documentIds: parsed.data.selectedDocumentIds ?? [],
      freshness: parsed.data.freshness,
      maxSources: parsed.data.maxSources,
      maxQueries: parsed.data.maxQueries,
    });

    if ('ok' in result && result.ok === false && 'errorCode' in result) {
      return NextResponse.json(result, { status: 401 });
    }

    const research = result as Exclude<typeof result, { ok: false }>;

    return NextResponse.json({
      ok: research.ok,
      taskId: research.taskId,
      query: research.query,
      mode: research.mode,
      status: research.status,
      intent: {
        kind: research.intent.kind,
        confidence: research.intent.confidence,
        rationale: research.intent.rationale,
      },
      plan: {
        planId: research.plan.planId,
        subQuestions: research.plan.objective.subQuestions,
        searchQueries: research.plan.objective.searchQueries,
        freshnessRequirement: research.plan.objective.freshnessRequirement,
        budget: research.plan.budget,
      },
      report: research.report
        ? {
            title: research.report.title,
            live: research.report.live,
            status: research.report.status,
            executiveSummary: research.report.executiveSummary,
            verifiedFindings: research.report.verifiedFindings,
            qualifiedFindings: research.report.qualifiedFindings,
            conflicts: research.report.conflicts,
            unknowns: research.report.unknowns,
            citations: research.report.citations,
            confidence: research.report.confidence,
            factCheck: research.report.factCheck,
            contradictions: research.report.contradictions,
            sourcesUsed: research.report.sourcesUsed,
            sourcesDiscovered: research.report.sourcesDiscovered,
            providerStatus: research.report.providerStatus,
            limitations: research.report.limitations,
            progress: research.report.progress,
            generatedAt: research.report.generatedAt,
          }
        : null,
      sources: research.sources.map((source) => ({
        sourceId: source.sourceId,
        title: source.title,
        domain: source.domain,
        url: source.canonicalUrl,
        provenance: source.provenance,
        sourceType: source.sourceType,
        publishedAt: source.publishedAt,
        retrievedAt: source.retrievedAt,
        quality: source.quality?.overall ?? null,
        fetchStatus: source.fetchStatus,
        duplicateOf: source.duplicateOf,
        independenceGroup: source.independenceGroup,
        // Signals only — never page text in the source list.
        trustSignals: source.trustSignals,
      })),
      metrics: research.metrics,
      errors: research.errors,
      durationMs: research.durationMs,
      cancelledAtStage: research.cancelledAtStage,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Research failed';
    return NextResponse.json(
      { ok: false, errorCode: 'RESEARCH_FAILED', error: message },
      { status: 500 }
    );
  }
}

/** Optional discovery endpoint: GET returns the honest provider status. */
export async function GET(request: Request) {
  try {
    const { jarvis, actor } = await getJarvisCoreForRequest(request);

    if (!actor.authenticated) {
      return NextResponse.json(
        { ok: false, errorCode: 'UNAUTHORIZED_ACCESS', error: 'Authentication required.' },
        { status: 401 }
      );
    }

    return NextResponse.json({
      ok: true,
      modes: RESEARCH_MODES,
      provider: jarvis.researchProviderStatus(),
      liveWebResearch: jarvis.researchProviderStatus().live,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read research status';
    return NextResponse.json({ ok: false, errorCode: 'INTERNAL_ERROR', error: message }, { status: 500 });
  }
}

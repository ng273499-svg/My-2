import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getJarvisCoreForRequest } from '@/server/runtime';

/**
 * JARVIS-X v1.2.0 — Grounded Document Query API
 *
 * POST /api/jarvis/files/query
 *
 * Full pipeline: hybrid retrieval → reranking → context assembly → grounded
 * answering → claim verification → citations.
 *
 * Scope is always owner-resolved. `projectId` / `documentIds` can only NARROW
 * the owner's own corpus — they can never widen it.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const QuerySchema = z.object({
  query: z.string().min(1, 'Query cannot be empty').max(2000),
  projectId: z.string().uuid().nullable().optional(),
  documentIds: z.array(z.string().min(1).max(120)).max(25).optional(),
  includeAllProjects: z.boolean().optional(),
  topK: z.number().int().min(1).max(20).optional(),
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

  const parsed = QuerySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        errorCode: 'INVALID_INPUT',
        error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
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
            'Document queries require an authenticated owner session. Guest/voice-only sessions never receive document evidence.',
        },
        { status: 401 }
      );
    }

    const result = await jarvis.queryDocuments({
      query: parsed.data.query,
      projectId: parsed.data.projectId ?? null,
      documentIds: parsed.data.documentIds,
      includeAllProjects: parsed.data.includeAllProjects ?? false,
      topK: parsed.data.topK,
    });

    if ('errorCode' in result) {
      return NextResponse.json(result, { status: 401 });
    }

    if (!result.ok || !result.answer) {
      return NextResponse.json(
        { ok: false, errorCode: 'QUERY_FAILED', error: result.errors[0] ?? 'Query failed.' },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      answer: {
        text: result.answer.answer,
        status: result.answer.status,
        insufficientEvidence: result.answer.insufficientEvidence,
        warnings: result.answer.warnings,
      },
      citations: result.answer.citations,
      conflicts: result.answer.conflicts,
      // Concise verification metadata only — never private chain-of-thought.
      verification: {
        status: result.answer.verification.status,
        summary: result.answer.verification.summary,
        supportedCount: result.answer.verification.supportedCount,
        totalClaims: result.answer.verification.totalClaims,
        unsupportedClaimCount: result.answer.verification.unsupportedClaims.length,
      },
      retrieval: result.retrieval
        ? {
            intent: result.retrieval.understanding.intent,
            intentRationale: result.retrieval.understanding.rationale,
            candidateCount: result.retrieval.candidateCount,
            selectedCount: result.retrieval.selectedCount,
            rerankingMode: result.retrieval.rerankingMode,
            embeddingMode: result.retrieval.embeddingStatus.mode,
            embeddingHonestNote: result.retrieval.embeddingStatus.honestNote,
            diagnostics: result.retrieval.diagnostics,
            evidence: result.retrieval.selected.map((s) => ({
              chunkId: s.chunk.chunkId,
              documentId: s.chunk.documentId,
              section: s.chunk.section,
              page: s.chunk.page,
              pageRange: s.chunk.pageRange,
              hybridScore: Number(s.hybridScore.toFixed(4)),
              rerankScore: s.rerankScore !== undefined ? Number(s.rerankScore.toFixed(4)) : null,
              vectorScore: Number(s.vectorScore.toFixed(4)),
              keywordScore: Number(s.keywordScore.toFixed(4)),
            })),
          }
        : null,
      durationMs: result.durationMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Document query failed';
    return NextResponse.json({ ok: false, errorCode: 'QUERY_FAILED', error: message }, { status: 500 });
  }
}

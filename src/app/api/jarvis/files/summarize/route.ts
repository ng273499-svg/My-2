import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getJarvisCoreForRequest } from '@/server/runtime';

/**
 * JARVIS-X v1.2.0 — Bounded Document Summarization API
 *
 * POST /api/jarvis/files/summarize
 *
 * quick · detailed · section · key_points · action_items · technical · compare
 *
 * Large documents use a bounded hierarchical (map → reduce) strategy with a
 * fixed maximum number of stages. The beginning of a document is never simply
 * truncated. Every summary is returned with citations back to real chunks.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SummarizeSchema = z.object({
  documentIds: z.array(z.string().min(1).max(120)).min(1).max(20),
  kind: z.enum(['quick', 'detailed', 'section', 'key_points', 'action_items', 'technical', 'compare']),
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

  const parsed = SummarizeSchema.safeParse(body);
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
          error: 'Document summarization requires an authenticated owner session.',
        },
        { status: 401 }
      );
    }

    const outcome = await jarvis.summarizeDocuments(parsed.data);
    if ('errorCode' in outcome) {
      return NextResponse.json(outcome, { status: 400 });
    }

    if (!outcome.ok || !outcome.summary) {
      return NextResponse.json(
        {
          ok: false,
          errorCode: 'SUMMARIZE_FAILED',
          error: outcome.errors[0] ?? 'Summarization failed.',
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      kind: outcome.summary.kind,
      summary: outcome.summary.summary,
      citations: outcome.summary.citations,
      citationsCount: outcome.summary.citations.length,
      stages: outcome.summary.stages,
      bounded: outcome.summary.bounded,
      truncated: outcome.summary.truncated,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Summarization failed';
    return NextResponse.json(
      { ok: false, errorCode: 'SUMMARIZE_FAILED', error: message },
      { status: 500 }
    );
  }
}

import { NextResponse } from 'next/server';
import { getJarvisCoreForRequest } from '@/server/runtime';

/**
 * JARVIS-X v1.3.0 — Research history.
 *
 * GET /api/jarvis/research/history?limit=20
 *
 * Returns only the authenticated owner's own tasks. Metadata and progress are
 * included; raw page text never is.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const { jarvis, actor } = await getJarvisCoreForRequest(request);

    if (!actor.authenticated) {
      return NextResponse.json(
        { ok: false, errorCode: 'UNAUTHORIZED_ACCESS', error: 'Authentication required.' },
        { status: 401 }
      );
    }

    const url = new URL(request.url);
    const rawLimit = Number(url.searchParams.get('limit') ?? '20');
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, Math.trunc(rawLimit))) : 20;

    const history = jarvis.listResearchHistory(limit);
    if (!Array.isArray(history)) {
      return NextResponse.json(history, { status: 403 });
    }

    return NextResponse.json({
      ok: true,
      provider: jarvis.researchProviderStatus(),
      liveWebResearch: jarvis.researchProviderStatus().live,
      tasks: history.map((task) => ({
        taskId: task.taskId,
        query: task.query,
        mode: task.mode,
        status: task.status,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        cancelled: task.cancelled,
        metrics: task.metrics,
        progress: task.progress,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read research history';
    return NextResponse.json({ ok: false, errorCode: 'INTERNAL_ERROR', error: message }, { status: 500 });
  }
}

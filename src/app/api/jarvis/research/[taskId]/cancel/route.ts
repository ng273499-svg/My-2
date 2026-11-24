import { NextResponse } from 'next/server';
import { getJarvisCoreForRequest } from '@/server/runtime';

/**
 * JARVIS-X v1.3.0 — Research cancellation.
 *
 * POST /api/jarvis/research/:taskId/cancel
 *
 * Cancels only the caller's own task. Safety partial evidence already retrieved
 * is preserved in the task record; the status is reported as CANCELLED.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: { taskId: string } }) {
  try {
    const { jarvis, actor } = await getJarvisCoreForRequest(request);

    if (!actor.authenticated) {
      return NextResponse.json(
        { ok: false, errorCode: 'UNAUTHORIZED_ACCESS', error: 'Authentication required.' },
        { status: 401 }
      );
    }

    const taskId = context.params.taskId;
    if (!taskId || taskId.length > 120) {
      return NextResponse.json(
        { ok: false, errorCode: 'INVALID_INPUT', error: 'Invalid task identifier.' },
        { status: 400 }
      );
    }

    const result = jarvis.cancelResearchTask(taskId);
    if (!result || !('cancelled' in result)) {
      return NextResponse.json(result, { status: 401 });
    }

    return NextResponse.json({
      ok: true,
      taskId,
      cancelled: result.cancelled,
      detail: result.cancelled
        ? 'Cancellation requested. Future searches, fetches and follow-up rounds will stop.'
        : 'Task was not running (already completed, cancelled, or not found for this owner).',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to cancel research task';
    return NextResponse.json({ ok: false, errorCode: 'INTERNAL_ERROR', error: message }, { status: 500 });
  }
}

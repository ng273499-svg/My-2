import { NextResponse } from 'next/server';
import { getJarvisCoreForRequest } from '@/server/runtime';
import type { ResearchMetrics, ResearchProgressEvent, ResearchReport } from '@/core/research/types';

/**
 * Shape returned by the core for an authenticated caller. The core also has an
 * error envelope for unauthenticated callers, which this route rejects before
 * reaching the task lookup.
 */
interface ResearchTaskView {
  taskId: string;
  query: string;
  mode: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  cancelled: boolean;
  progress: ResearchProgressEvent[];
  metrics: ResearchMetrics | null;
  result: { report: ResearchReport | null; errors: string[] } | null;
}

/**
 * JARVIS-X v1.3.0 — Research task inspection.
 *
 * GET /api/jarvis/research/:taskId
 *
 * A task is only visible to the owner that created it. Requesting another
 * owner's task returns 404 (not 403) so task existence is not leaked.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: { taskId: string } }) {
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

    const task = jarvis.getResearchTask(taskId) as ResearchTaskView | null;

    if (!task) {
      return NextResponse.json(
        { ok: false, errorCode: 'TASK_NOT_FOUND', error: 'No such research task for this owner.' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      ok: true,
      taskId: task.taskId,
      query: task.query,
      mode: task.mode,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      cancelled: task.cancelled,
      progress: task.progress,
      metrics: task.metrics,
      report: task.result?.report ?? null,
      errors: task.result?.errors ?? [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read research task';
    return NextResponse.json({ ok: false, errorCode: 'INTERNAL_ERROR', error: message }, { status: 500 });
  }
}

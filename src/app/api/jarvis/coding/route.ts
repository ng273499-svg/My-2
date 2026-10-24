import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getJarvisCoreForRequest } from '@/server/runtime';

/**
 * JARVIS-X v1.1.0 — Secure server-side Coding Task API
 *
 * POST /api/jarvis/coding
 *
 * The client supplies a GOAL and a MODE only. It never supplies a filesystem
 * path: the server always binds the task to its own authorized workspace root.
 * Mutating modes additionally require an explicit operator acknowledgement and
 * an authenticated owner session.
 */

const CodingTaskSchema = z.object({
  goal: z.string().min(1, 'Goal cannot be empty').max(4000),
  conversationId: z.string().min(1).max(80).optional(),
  projectId: z.string().uuid().nullable().optional(),
  mode: z.enum(['analyze', 'review', 'feature', 'debug', 'refactor', 'implement-api']),
  verificationPreference: z.enum(['strict', 'standard', 'minimal']).optional(),
  maxRepairIterations: z.number().int().min(0).max(10).optional(),
  acknowledgeMutations: z.boolean().optional(),
  // Deliberately rejected if supplied — the workspace is server-bound.
  authorizedWorkspace: z.undefined().optional(),
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

  const parsed = CodingTaskSchema.safeParse(body);
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
    const { jarvis } = await getJarvisCoreForRequest(request);
    const outcome = await jarvis.runCodingTask(parsed.data);

    if (!outcome.ok) {
      const status =
        outcome.errorCode === 'UNAUTHORIZED_ACCESS'
          ? 401
          : outcome.errorCode === 'CONFIRMATION_REQUIRED'
            ? 409
            : 400;
      return NextResponse.json(
        { ok: false, errorCode: outcome.errorCode, error: outcome.error },
        { status }
      );
    }

    const r = outcome.result;
    return NextResponse.json({
      ok: true,
      taskId: r.taskId,
      status: r.status,
      mode: r.mode,
      planSummary: r.planSummary,
      filesInspected: r.filesInspected,
      changedFiles: r.changedFiles,
      commandsExecuted: r.commandsExecuted.map((c) => ({
        command: c.command,
        exitCode: c.exitCode,
        redactedSecrets: c.redactedSecrets,
        riskLevel: c.riskLevel,
        durationMs: c.durationMs,
        timedOut: c.timedOut,
      })),
      testEvidence: r.testEvidence,
      repairAttempts: r.repairAttempts,
      verificationStatus: r.verificationStatus,
      warnings: r.warnings,
      errors: r.errors,
      secretRedactions: r.secretRedactions,
      repositoryProfile: r.repositoryProfile
        ? {
            languages: r.repositoryProfile.languages,
            primaryLanguage: r.repositoryProfile.primaryLanguage,
            frameworks: r.repositoryProfile.frameworks.map((f) => f.name),
            entryPoints: r.repositoryProfile.entryPoints.slice(0, 10),
            apisRoutes: r.repositoryProfile.apisRoutes.slice(0, 10),
            tests: r.repositoryProfile.tests.length,
            databaseMigrations: r.repositoryProfile.databaseMigrations.length,
            ignoredDirectories: r.repositoryProfile.ignoredDirectories,
            gitMetadata: r.repositoryProfile.gitMetadata
              ? {
                  currentBranch: r.repositoryProfile.gitMetadata.currentBranch,
                  statusSummary: r.repositoryProfile.gitMetadata.statusSummary,
                }
              : undefined,
          }
        : undefined,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        errorCode: 'CODING_TASK_FAILED',
        error: error instanceof Error ? error.message : 'Unexpected coding task failure.',
      },
      { status: 500 }
    );
  }
}

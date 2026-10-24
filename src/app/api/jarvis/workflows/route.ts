import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getJarvisCoreForRequest } from '@/server/runtime';

export const dynamic = 'force-dynamic';

const CreateWorkflowSchema = z.object({
  action: z.literal('create'),
  title: z.string().min(2).max(120),
  description: z.string().max(500).default(''),
  directivePrompt: z.string().min(4).max(2000),
  projectId: z.string().uuid().nullable().optional(),
  triggerKind: z
    .enum(['manual', 'session_start', 'interval_advisory', 'event_watch'])
    .default('manual'),
  scheduleHint: z.string().max(120).nullable().optional(),
  intervalMinutes: z.number().int().min(5).max(10_080).optional(),
  riskLevel: z
    .enum(['READ_ONLY', 'LOW_RISK', 'CONFIRMATION_REQUIRED', 'SENSITIVE'])
    .default('READ_ONLY'),
  enabled: z.boolean().default(true),
});

const RunWorkflowSchema = z.object({
  action: z.literal('run'),
  workflowId: z.string().uuid(),
  conversationId: z.string().max(80).optional(),
});

const ToggleWorkflowSchema = z.object({
  action: z.literal('toggle'),
  workflowId: z.string().uuid(),
  enabled: z.boolean(),
});

const DeleteWorkflowSchema = z.object({
  action: z.literal('delete'),
  workflowId: z.string().uuid(),
});

const WorkflowPostSchema = z.discriminatedUnion('action', [
  CreateWorkflowSchema,
  RunWorkflowSchema,
  ToggleWorkflowSchema,
  DeleteWorkflowSchema,
]);

export async function GET(request: Request) {
  try {
    const { actor, jarvis, repository } = await getJarvisCoreForRequest(request);
    const workflows = await repository.listProactiveWorkflows(actor.userId);
    const dueWorkflows = jarvis.proactiveMonitoringEngine.listDueWorkflows(workflows);
    return NextResponse.json({
      ok: true,
      workflows,
      dueWorkflowIds: dueWorkflows.map((w) => w.id),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to list proactive workflows';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = WorkflowPostSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: parsed.error.issues.map((i) => i.message).join('; '),
        },
        { status: 400 }
      );
    }

    const { actor, jarvis, repository } = await getJarvisCoreForRequest(request);
    const data = parsed.data;

    if (data.action === 'create') {
      const created = await repository.createProactiveWorkflow(actor.userId, {
        projectId: data.projectId ?? null,
        title: data.title,
        description: data.description,
        directivePrompt: data.directivePrompt,
        triggerKind: data.triggerKind,
        scheduleHint: data.scheduleHint ?? null,
        riskLevel: data.riskLevel,
        enabled: data.enabled,
        metadata: data.intervalMinutes
          ? { intervalMinutes: data.intervalMinutes }
          : {},
      });
      return NextResponse.json({ ok: true, workflow: created });
    }

    if (data.action === 'toggle') {
      const updated = await repository.updateProactiveWorkflow(
        actor.userId,
        data.workflowId,
        { enabled: data.enabled }
      );
      if (!updated) {
        return NextResponse.json(
          { ok: false, error: 'Workflow not found.' },
          { status: 404 }
        );
      }
      return NextResponse.json({ ok: true, workflow: updated });
    }

    if (data.action === 'delete') {
      const deleted = await repository.deleteProactiveWorkflow(
        actor.userId,
        data.workflowId
      );
      return NextResponse.json({ ok: true, deleted });
    }

    // Governed Execution (`data.action === 'run'`): always runs through JarvisCoreRuntime + RiskClassifier + PermissionManager
    const workflows = await repository.listProactiveWorkflows(actor.userId);
    const target = workflows.find((w) => w.id === data.workflowId);
    if (!target) {
      return NextResponse.json(
        { ok: false, error: 'Workflow not found for current operator.' },
        { status: 404 }
      );
    }

    const execution = await jarvis.executeRuntimeTask({
      conversationId: data.conversationId,
      projectId: target.projectId,
      modality: 'text',
      message: target.directivePrompt,
    });

    const updated = await repository.updateProactiveWorkflow(actor.userId, target.id, {
      runCount: target.runCount + 1,
      lastRunAt: new Date().toISOString(),
      metadata: {
        ...target.metadata,
        lastFinalState: execution.result.finalState,
        lastTaskId: execution.result.taskId,
      },
    });

    return NextResponse.json({
      ok: true,
      workflow: updated ?? target,
      runtime: execution.result,
      activitySteps: execution.activitySteps,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Workflow operation failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

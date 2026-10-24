import { NextResponse } from 'next/server';
import { z } from 'zod';
import { PREPARED_MEMORY_SCOPES } from '@/core/runtime';
import { getJarvisCoreForRequest } from '@/server/runtime';

export const dynamic = 'force-dynamic';

const RuntimePostSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('execute'),
    conversationId: z.string().max(80).optional(),
    projectId: z.string().uuid().nullable().optional(),
    modality: z.enum(['text', 'voice_transcript', 'vision_multimodal']).optional(),
    voiceMeta: z
      .object({
        transcriptConfidence: z.number().min(0).max(1).optional(),
        languageCode: z.string().max(24).optional(),
        durationMs: z.number().nonnegative().optional(),
        bargeInTriggered: z.boolean().optional(),
      })
      .optional(),
    message: z.string().min(1).max(4000),
    routingPolicyOverride: z
      .enum([
        'AUTO_BALANCED',
        'QUALITY_FIRST',
        'SPEED_FIRST',
        'COST_AWARE',
        'MANUAL',
      ])
      .optional(),
    manualModelIdOverride: z.string().min(1).max(120).nullable().optional(),
    visionAttachment: z
      .object({
        fileName: z.string().max(160),
        mimeType: z.string().max(80),
        sizeBytes: z.number().nonnegative(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        base64Data: z.string().max(5_600_000).optional(),
        source: z.enum(['upload', 'camera_preview']).optional(),
      })
      .optional(),
    documentAttachment: z
      .object({
        fileName: z.string().max(160),
        mimeType: z.string().max(120),
        sizeBytes: z.number().nonnegative(),
        textContent: z.string().max(120_000),
        ingestToKnowledge: z.boolean().optional(),
      })
      .optional(),
    limits: z
      .object({
        maxSteps: z.number().int().min(1).max(20).optional(),
        maxRetriesPerStep: z.number().int().min(0).max(5).optional(),
        executionTimeoutMs: z.number().int().min(50).max(60000).optional(),
        maxToolCalls: z.number().int().min(0).max(16).optional(),
        maxModelFallbacks: z.number().int().min(0).max(4).optional(),
      })
      .optional(),
  }),
  z.object({
    action: z.literal('cancel'),
    taskId: z.string().uuid(),
  }),
]);

export async function GET(request: Request) {
  try {
    const { jarvis, actor } = await getJarvisCoreForRequest(request);
    const providerHealth = jarvis.runtimeModelRouter.listProviderHealth();
    const modelCatalog = jarvis.runtimeModelRouter.listRegisteredModels();
    const modelTelemetry = jarvis.runtimeModelRouter.getTelemetryHistory(20);
    const snapshot = await jarvis.getSystemSnapshot();

    return NextResponse.json({
      ok: true,
      actor,
      capabilities: jarvis.capabilityRegistry.listDefinitions(),
      specialistContracts: jarvis.specialistRegistry.listContracts(),
      providerHealth,
      modelCatalog,
      modelTelemetry,
      memoryScopes: PREPARED_MEMORY_SCOPES,
      recentTasks: snapshot.recentTasks ?? [],
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to inspect Core Runtime';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = RuntimePostSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: parsed.error.issues.map((i) => i.message).join('; '),
        },
        { status: 400 }
      );
    }

    const { jarvis, actor } = await getJarvisCoreForRequest(request);

    if (parsed.data.action === 'cancel') {
      const cancelled = jarvis.runtime.cancelTask(actor.userId, parsed.data.taskId);
      return NextResponse.json({
        ok: true,
        cancelled,
        taskId: parsed.data.taskId,
      });
    }

    const output = await jarvis.executeRuntimeTask({
      conversationId: parsed.data.conversationId,
      projectId: parsed.data.projectId,
      modality: parsed.data.modality,
      voiceInput: parsed.data.voiceMeta,
      voiceMeta: parsed.data.voiceMeta,
      message: parsed.data.message,
      routingPolicyOverride: parsed.data.routingPolicyOverride,
      manualModelIdOverride: parsed.data.manualModelIdOverride,
      visionAttachment: parsed.data.visionAttachment,
      documentAttachment: parsed.data.documentAttachment,
      limits: parsed.data.limits,
    });

    return NextResponse.json({
      ok: true,
      runtime: output.result,
      activitySteps: output.activitySteps,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Core Runtime execution error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

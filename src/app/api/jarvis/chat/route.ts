import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getJarvisCoreForRequest } from '@/server/runtime';

const TurnRequestSchema = z.object({
  conversationId: z.string().min(1).max(80).optional(),
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
  message: z.string().min(1, 'Message cannot be empty').max(4000),
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
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = TurnRequestSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: parsed.error.issues.map((i) => i.message).join('; '),
        },
        { status: 400 }
      );
    }

    const { jarvis } = await getJarvisCoreForRequest(request);
    const turn = await jarvis.handleTurn(parsed.data);
    const snapshot = await jarvis.getSystemSnapshot(turn.conversationId);

    return NextResponse.json({
      ok: true,
      turn,
      snapshot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected turn failure';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getJarvisCoreForRequest } from '@/server/runtime';

const PreferencesPatchSchema = z.object({
  preferredResponseStyle: z
    .enum([
      'neutral',
      'calm',
      'excitement',
      'concern',
      'curiosity',
      'confidence',
      'seriousness',
      'humor',
      'urgency',
    ])
    .optional(),
  voiceProfileId: z.string().min(1).max(80).optional(),
  preferredBrowserVoiceUri: z.string().min(1).max(240).nullable().optional(),
  voiceMuted: z.boolean().optional(),
  voiceAutoSpeak: z.boolean().optional(),
  voiceBargeInEnabled: z.boolean().optional(),
  witLevel: z.enum(['minimal', 'subtle', 'moderate']).optional(),
  conciseness: z.enum(['brief', 'balanced', 'detailed']).optional(),
  preferredModelProvider: z.string().min(1).max(80).optional(),
  routingPolicy: z
    .enum([
      'AUTO_BALANCED',
      'QUALITY_FIRST',
      'SPEED_FIRST',
      'COST_AWARE',
      'MANUAL',
    ])
    .optional(),
  manualModelId: z.string().min(1).max(120).nullable().optional(),
  proactiveAssistanceEnabled: z.boolean().optional(),
  crossDeviceSyncEnabled: z.boolean().optional(),
});

export async function GET(request: Request) {
  try {
    const { jarvis } = await getJarvisCoreForRequest(request);
    const snapshot = await jarvis.getSystemSnapshot();
    return NextResponse.json({
      ok: true,
      preferences: snapshot.preferences,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Preferences read failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const parsed = PreferencesPatchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: 'Invalid preferences update payload.' },
        { status: 400 }
      );
    }

    const { jarvis } = await getJarvisCoreForRequest(request);
    const preferences = await jarvis.updateOperatorPreferences(parsed.data);
    const snapshot = await jarvis.getSystemSnapshot();

    return NextResponse.json({
      ok: true,
      preferences,
      snapshot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Preferences update failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

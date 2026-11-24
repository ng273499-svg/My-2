import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getJarvisCoreForRequest } from '@/server/runtime';

export const dynamic = 'force-dynamic';

const ResponseStyleEnum = z.enum([
  'neutral',
  'calm',
  'excitement',
  'concern',
  'curiosity',
  'confidence',
  'seriousness',
  'humor',
  'urgency',
]);

const VoicePostSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('prepare_speech'),
    text: z.string().min(1).max(4000),
    style: ResponseStyleEnum.optional(),
    voiceProfileId: z.string().max(80).optional(),
  }),
  z.object({
    action: z.literal('barge_in'),
    event: z.enum(['start_listening', 'start_speaking', 'interrupt', 'reset']),
    turnId: z.string().max(80).optional(),
  }),
]);

export async function GET(request: Request) {
  try {
    const { jarvis } = await getJarvisCoreForRequest(request);
    const snapshot = await jarvis.getSystemSnapshot();
    const diagnostics = jarvis.voiceEngine.getDiagnostics(
      snapshot.preferences.voiceProfileId
    );
    return NextResponse.json({
      ok: true,
      diagnostics,
      autoSpeakEnabled: snapshot.preferences.voiceAutoSpeak,
      bargeInEnabled: snapshot.preferences.voiceBargeInEnabled,
      voiceMuted: Boolean(snapshot.preferences.voiceMuted),
      preferredBrowserVoiceUri: snapshot.preferences.preferredBrowserVoiceUri ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Voice diagnostics failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = VoicePostSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: 'Invalid voice request payload.' },
        { status: 400 }
      );
    }

    const { jarvis } = await getJarvisCoreForRequest(request);
    const snapshot = await jarvis.getSystemSnapshot();

    if (parsed.data.action === 'barge_in') {
      const ev = parsed.data.event;
      if (ev === 'start_listening') jarvis.voiceEngine.startListening();
      else if (ev === 'start_speaking')
        jarvis.voiceEngine.startSpeaking(parsed.data.turnId);
      else if (ev === 'interrupt') jarvis.voiceEngine.triggerBargeInInterrupt();
      else jarvis.voiceEngine.resetBargeInState();

      return NextResponse.json({
        ok: true,
        diagnostics: jarvis.voiceEngine.getDiagnostics(
          snapshot.preferences.voiceProfileId
        ),
      });
    }

    const synthesis = await jarvis.voiceEngine.synthesizeSpeechIfConfigured(
      parsed.data.text,
      parsed.data.style ?? snapshot.preferences.preferredResponseStyle,
      parsed.data.voiceProfileId ?? snapshot.preferences.voiceProfileId
    );

    return NextResponse.json({
      ok: true,
      synthesis,
      diagnostics: jarvis.voiceEngine.getDiagnostics(
        snapshot.preferences.voiceProfileId
      ),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Voice processing failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getJarvisCoreForRequest } from '@/server/runtime';

export const dynamic = 'force-dynamic';

const UpsertToolSchema = z.object({
  toolSlug: z.string().min(2).max(64),
  displayName: z.string().min(2).max(80),
  category: z.enum([
    'internal',
    'web_research',
    'file_analysis',
    'computer_use',
    'code_execution',
    'external_api',
    'smart_device',
    'notifications',
    'sync',
  ]),
  connectionStatus: z.enum(['connected', 'not_connected', 'degraded', 'revoked']),
  defaultPermissionTier: z.enum([
    'SAFE_READ',
    'CONFIRMATION_REQUIRED',
    'SENSITIVE_AUTH_REQUIRED',
  ]),
  scopes: z.array(z.string().max(64)).default([]),
});

export async function GET(request: Request) {
  try {
    const { jarvis } = await getJarvisCoreForRequest(request);
    const tools = await jarvis.listConnectedToolMetadata();
    return NextResponse.json({ ok: true, tools });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to list connected tool metadata';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = UpsertToolSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: 'Invalid connected tool metadata payload.' },
        { status: 400 }
      );
    }

    const { jarvis } = await getJarvisCoreForRequest(request);
    const tool = await jarvis.upsertConnectedToolMetadata(parsed.data);
    return NextResponse.json({ ok: true, tool });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to save connected tool metadata';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

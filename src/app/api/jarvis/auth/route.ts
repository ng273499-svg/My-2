import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  createPublicAuthSupabaseClient,
  probeSupabaseServerReachability,
} from '@/server/supabase/client';
import { resolveRequestActor } from '@/server/supabase/auth';

export const dynamic = 'force-dynamic';

const AuthActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('signup'),
    email: z.string().email(),
    password: z.string().min(6).max(128),
    displayName: z.string().min(1).max(60).optional(),
  }),
  z.object({
    action: z.literal('signin'),
    email: z.string().email(),
    password: z.string().min(6).max(128),
  }),
]);

export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  const reachability = await probeSupabaseServerReachability();
  return NextResponse.json({
    ok: true,
    actor,
    serverReachability: reachability.state,
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = AuthActionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: parsed.error.issues.map((i) => i.message).join('; '),
        },
        { status: 400 }
      );
    }

    const client = createPublicAuthSupabaseClient();
    if (!client) {
      return NextResponse.json(
        {
          ok: false,
          code: 'SUPABASE_NOT_CONFIGURED',
          error: 'Supabase Auth is not configured on the server.',
        },
        { status: 503 }
      );
    }

    const reachability = await probeSupabaseServerReachability();
    if (reachability.state === 'degraded_unreachable') {
      return NextResponse.json(
        {
          ok: false,
          code: 'SERVER_EGRESS_UNREACHABLE',
          error:
            'Server egress to Supabase Auth is currently unreachable; use direct browser Supabase Auth.',
        },
        { status: 503 }
      );
    }

    if (parsed.data.action === 'signup') {
      const { data, error } = await client.auth.signUp({
        email: parsed.data.email,
        password: parsed.data.password,
        options: {
          data: {
            display_name: parsed.data.displayName || parsed.data.email.split('@')[0],
          },
        },
      });

      if (error) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
      }

      return NextResponse.json({
        ok: true,
        user: data.user
          ? { id: data.user.id, email: data.user.email }
          : null,
        session: data.session
          ? {
              accessToken: data.session.access_token,
              expiresAt: data.session.expires_at,
            }
          : null,
      });
    }

    const { data, error } = await client.auth.signInWithPassword({
      email: parsed.data.email,
      password: parsed.data.password,
    });

    if (error || !data.session) {
      return NextResponse.json(
        { ok: false, error: error?.message || 'Invalid credentials.' },
        { status: 401 }
      );
    }

    return NextResponse.json({
      ok: true,
      user: { id: data.user.id, email: data.user.email },
      session: {
        accessToken: data.session.access_token,
        expiresAt: data.session.expires_at,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected authentication failure';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

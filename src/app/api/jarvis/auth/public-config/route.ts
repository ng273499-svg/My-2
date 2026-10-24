import { NextResponse } from 'next/server';
import { getPublicSupabaseBrowserConfig, probeSupabaseServerReachability } from '@/server/supabase/client';

export const dynamic = 'force-dynamic';

/**
 * Returns ONLY public, non-privileged Supabase connection parameters (`url` and
 * publishable `anonKey`) for browser Supabase Auth + RLS initialization.
 * Privileged credentials (`SUPABASE_SERVICE_ROLE_KEY`, secrets) are NEVER included.
 */
export async function GET() {
  const pub = getPublicSupabaseBrowserConfig();
  const reachability = await probeSupabaseServerReachability();

  return NextResponse.json({
    ok: true,
    configured: pub.configured,
    projectRef: pub.projectRef,
    url: pub.url,
    anonKey: pub.anonKey,
    serverReachability: reachability.state,
  });
}

import 'server-only';
import { DEFAULT_GUEST_USER_ID, isValidUuid } from '@/core/utils/uuid';
import type { AuthSessionStatus } from '@/core/types';
import {
  createPublicAuthSupabaseClient,
  probeSupabaseServerReachability,
} from './client';

export interface AuthActorContext extends AuthSessionStatus {
  accessToken?: string;
}

export const GUEST_ACTOR: AuthActorContext = {
  authenticated: false,
  userId: DEFAULT_GUEST_USER_ID,
  displayName: 'Guest Operator',
  callsign: 'GUEST-EPHEMERAL',
  verificationMode: 'anonymous_ephemeral',
};

function decodeJwtPayloadUnsafe(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export function extractBearerToken(request?: Request | null): string | null {
  if (!request) return null;
  const authHeader = request.headers.get('authorization') || request.headers.get('Authorization');
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token.length > 20) return token;
  }
  return null;
}

/**
 * Resolves the calling operator's identity.
 * 1. When no Bearer token is provided -> returns isolated Guest Ephemeral actor.
 * 2. When Supabase Auth is reachable -> verifies JWT cryptographically via GoTrue (`auth.getUser`).
 * 3. When Supabase Auth is temporarily unreachable from server network -> validates issuer,
 *    audience, expiry, and UUID subject solely to preserve per-user isolation in degraded fallback.
 */
export async function resolveRequestActor(request?: Request | null): Promise<AuthActorContext> {
  const token = extractBearerToken(request);
  if (!token) {
    return { ...GUEST_ACTOR };
  }

  const supabaseUrl = process.env.SUPABASE_URL?.trim()?.replace(/\/$/, '');
  const authClient = createPublicAuthSupabaseClient();

  if (authClient) {
    const reachability = await probeSupabaseServerReachability();
    if (reachability.state === 'connected') {
      const { data, error } = await authClient.auth.getUser(token);
      if (error || !data?.user) {
        return { ...GUEST_ACTOR };
      }

      const email = data.user.email ?? undefined;
      const metaName =
        (data.user.user_metadata?.display_name as string | undefined) ||
        (data.user.user_metadata?.full_name as string | undefined) ||
        email?.split('@')[0] ||
        'Operator';

      return {
        authenticated: true,
        userId: data.user.id,
        email,
        displayName: metaName,
        callsign: `OP-${data.user.id.slice(0, 4).toUpperCase()}`,
        verificationMode: 'supabase_jwt',
        accessToken: token,
      };
    }
  }

  // Degraded server-network fallback claim validation (rejects expired, wrong-issuer, or non-UUID tokens)
  const payload = decodeJwtPayloadUnsafe(token);
  if (!payload) {
    return { ...GUEST_ACTOR };
  }

  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  const aud = typeof payload.aud === 'string' ? payload.aud : '';
  const iss = typeof payload.iss === 'string' ? payload.iss : '';
  const exp = typeof payload.exp === 'number' ? payload.exp : 0;
  const nowSec = Math.floor(Date.now() / 1000);

  const expectedIssuer = supabaseUrl ? `${supabaseUrl}/auth/v1` : '';
  const issuerMatches = expectedIssuer ? iss === expectedIssuer : iss.includes('/auth/v1');

  if (!isValidUuid(sub) || aud !== 'authenticated' || !issuerMatches || exp <= nowSec) {
    return { ...GUEST_ACTOR };
  }

  const email = typeof payload.email === 'string' ? payload.email : undefined;
  const userMeta =
    typeof payload.user_metadata === 'object' && payload.user_metadata !== null
      ? (payload.user_metadata as Record<string, unknown>)
      : {};
  const displayName =
    (typeof userMeta.display_name === 'string' && userMeta.display_name) ||
    email?.split('@')[0] ||
    'Operator';

  return {
    authenticated: true,
    userId: sub.toLowerCase(),
    email,
    displayName,
    callsign: `OP-${sub.slice(0, 4).toUpperCase()}`,
    verificationMode: 'degraded_offline_jwt',
    accessToken: token,
  };
}

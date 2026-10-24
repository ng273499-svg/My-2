import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * The site entry point opens JARVIS directly.
 *
 * The full command HUD is preserved and reachable at /dashboard — nothing was
 * removed, the landing route simply points at the conversation surface.
 */
export default function RootPage() {
  redirect('/chat');
}

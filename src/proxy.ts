import type { NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/proxy'

/**
 * Runs before every matched request: refreshes the Supabase session cookie and
 * gates /account and /dashboard.
 *
 * Named `proxy`, not `middleware` — Next 16 renamed the file convention. The
 * guards here are a first line of defence for redirects only; the real boundary
 * is RLS in the database, plus the explicit checks in each layout.
 */
export async function proxy(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  /*
   * Only the routes that actually need a session.
   *
   * The Supabase SSR guide suggests matching everything so the auth cookie
   * refreshes on any navigation — but that costs a round-trip to Supabase on
   * every request, and most of this site is a public marketing page an
   * anonymous visitor is reading. Matching everything made each of those pages
   * wait on an auth check that could not change what it rendered.
   *
   * The token still refreshes whenever someone touches an authenticated area,
   * which is the only place a stale one would matter.
   */
  matcher: [
    '/account/:path*',
    '/dashboard/:path*',
    '/login',
    '/signup',
    '/auth/:path*',
  ],
}

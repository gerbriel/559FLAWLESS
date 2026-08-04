import 'server-only'

import type { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * DB-backed fixed-window rate limiting — see migration 057 for why the counter
 * lives in Postgres (serverless: in-memory counters die with the instance and
 * lie across concurrent ones).
 *
 * FAIL OPEN, always. Any error here — the function not yet migrated, the
 * database briefly away — returns "allowed" and logs. A broken limiter must
 * never be the reason a client cannot book; the threat it answers is bulk
 * abuse, not a determined attacker, and a guard that can take bookings down
 * is a worse liability than the abuse.
 *
 * Applied ONLY to routes a stranger can reach. Staff routes are behind auth
 * and RLS already, and the studio hammering its own till must never be
 * throttled by its own guard.
 */

/**
 * Per-route budgets, named here so the reasoning stays next to the number.
 *
 *   book          a family books four visits in a sitting; a bot books four
 *                 hundred. 10 per 10 minutes per address.
 *   newsletter    nobody subscribes five times an hour for honest reasons.
 *   inviteAccept  the token space (32 random bytes, hashed) is the real
 *                 defence; this stops online guessing from one address from
 *                 being free.
 *   availability  read-only but priced per call — it fans out per provider.
 *                 Generous: a person browsing dates taps it constantly.
 */
export const RATE_BUDGETS = {
  book: { limit: 10, windowSeconds: 600 },
  newsletter: { limit: 5, windowSeconds: 3600 },
  inviteAccept: { limit: 10, windowSeconds: 3600 },
  availability: { limit: 120, windowSeconds: 60 },
} as const

/**
 * The caller's address, as a bucket key.
 *
 * Vercel sets x-forwarded-for with the client as the FIRST hop. The value is
 * attacker-influenced in general, but on Vercel the platform prepends the
 * real connecting address; still, it is treated as a key and nothing more —
 * never logged raw, never stored beyond the day the bucket lives (057's
 * cleanup). This studio has treated an IP leaving the building as an incident
 * before; keys are truncated and scoped, not archived.
 */
export function limitKey(request: NextRequest, scope: string): string {
  const forwarded = request.headers.get('x-forwarded-for')
  const ip =
    forwarded?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    'unknown'
  // Length-cap defensively: the header is client-influenced and the DB key is
  // capped at 128 chars anyway (057) — garbage just becomes a garbage bucket.
  return `${scope}:${ip.slice(0, 64)}`
}

export async function checkRateLimit(
  request: NextRequest,
  scope: keyof typeof RATE_BUDGETS
): Promise<{ allowed: boolean }> {
  const budget = RATE_BUDGETS[scope]
  try {
    // The admin client rather than anon: this runs inside route handlers that
    // may not have (or want) a user session, and the function's EXECUTE grant
    // is not the boundary here — the function itself is the boundary, and the
    // service key is already resident in these routes.
    const admin = createAdminClient()
    const { data, error } = await admin.rpc('check_rate_limit', {
      p_key: limitKey(request, scope),
      p_limit: budget.limit,
      p_window_seconds: budget.windowSeconds,
    })

    if (error) {
      // Includes "function does not exist" — the deploy-before-migrate window.
      console.error('rate limit check failed open', scope, error.message)
      return { allowed: true }
    }
    return { allowed: data !== false }
  } catch (err) {
    console.error('rate limit check failed open', scope, err)
    return { allowed: true }
  }
}

/** The standard refusal, with Retry-After so well-behaved clients back off. */
export function rateLimitedResponse(scope: keyof typeof RATE_BUDGETS): Response {
  return Response.json(
    { error: 'rate_limited' },
    {
      status: 429,
      headers: { 'Retry-After': String(RATE_BUDGETS[scope].windowSeconds) },
    }
  )
}

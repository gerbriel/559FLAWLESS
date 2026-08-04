import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'

/**
 * The durable half of every console.error that matters.
 *
 * Vercel Hobby keeps runtime logs for about an hour, so a console.error is a
 * message to whoever happens to be watching the dashboard at that minute —
 * usually nobody. This writes the same fact into `app_errors` (migration 058),
 * where it survives thirty days and a manager can read it on Settings when a
 * client phones about a failure from yesterday.
 *
 * NEVER THROWS, by construction. The error path must not have an error path:
 * a booking that failed AND could not be recorded should still return its 500
 * cleanly, not die twice. Fire-and-forget is acceptable at every call site —
 * `void logError(...)` — because the console.error happens synchronously
 * first, so the short-lived log always has the line even if the insert loses
 * a race with the function shutting down.
 *
 * Context discipline: ids and small facts only. An appointment id, a provider
 * id, a route name, a guest email where the failure IS about that booking.
 * Never request bodies, never tokens, never stack traces beyond the message.
 */
export async function logError(
  scope: string,
  err: unknown,
  context: Record<string, string | number | boolean | null> = {},
  digest?: string
): Promise<void> {
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err)

  // The immediate copy, for whoever is watching right now.
  console.error(`[${scope}]`, message, context)

  try {
    const admin = createAdminClient()
    const { error } = await admin.rpc('log_app_error', {
      p_scope: scope,
      p_message: message,
      p_context: context,
      p_digest: digest ?? null,
    })
    if (error) {
      // The one place a failure is allowed to stay ephemeral: recording that
      // recording failed. Includes "function does not exist" — the window
      // between this deploy and the studio running 058 — which degrades to
      // console-only logging, exactly what the app had before.
      console.error('[log-error] durable write failed', error.message)
    }
  } catch (recordErr) {
    console.error('[log-error] durable write failed', recordErr)
  }
}

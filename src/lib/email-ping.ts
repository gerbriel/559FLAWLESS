/**
 * Nudge the email mirror from the browser, after an action that rang a bell.
 *
 * The mirror itself lives server-side (072); this only asks it to sweep now
 * rather than at the daily cron. Fire-and-forget by contract: a failed ping
 * costs nothing — the notification is already in the bell, and the sweeper
 * catches it later.
 */
export function pingEmailDispatch(): void {
  try {
    void fetch('/api/notifications/email-dispatch', { method: 'POST' }).catch(() => {})
  } catch {
    // Nothing — see above.
  }
}

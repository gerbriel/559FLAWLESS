'use client'

import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getAnalyticsConsent, sessionId } from '@/components/shared/ClientAnalytics'

const STITCH_FLAG_PREFIX = 'fl_stitched_'

/**
 * The stitch trigger. Mounted in the account layout — only signed-in clients
 * ever reach it — it hands the anonymous browser session id to
 * claim_browsing_session (migration 060) so the pre-sign-in trail and the
 * account become one record. Renders null, holds no state, fires at most
 * once per browser session.
 *
 * Consent gates this too, even though the stitch concerns the viewer's own
 * account: with consent off no trail was collected, so there is nothing to
 * claim, and calling anyway would record the one fact the visitor asked us
 * not to keep.
 */
export function SessionStitch() {
  useEffect(() => {
    async function claim() {
      try {
        if (!getAnalyticsConsent()) return
        const sid = sessionId()
        if (!sid) return

        const flag = STITCH_FLAG_PREFIX + sid
        if (localStorage.getItem(flag)) return

        // Session ids rotate per tab session, so flags for old ids are dead
        // weight — sweep them rather than accrete one key per visit forever.
        // A concurrently open sibling tab has a different live id; deleting
        // its flag costs at most one redundant claim call, which the definer
        // function shrugs off.
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i)
          if (key && key.startsWith(STITCH_FLAG_PREFIX) && key !== flag) {
            localStorage.removeItem(key)
          }
        }

        const supabase = createClient()
        // Locally typed seam, same reasoning as CartSnapshotSync: migration
        // 060's function may not be in the Database Functions map yet.
        const rpc = supabase.rpc.bind(supabase) as unknown as (
          fn: 'claim_browsing_session',
          args: { p_session: string }
        ) => PromiseLike<{ error: { message: string } | null }>
        const { error } = await rpc('claim_browsing_session', { p_session: sid })
        if (error) {
          // Leave the flag unset so the next full page load retries.
          console.error('claim_browsing_session failed:', error.message)
          return
        }
        localStorage.setItem(flag, '1')
      } catch (err) {
        console.error('claim_browsing_session failed:', err)
      }
    }

    void claim().catch((err) => console.error('claim_browsing_session failed:', err))
  }, [])

  return null
}

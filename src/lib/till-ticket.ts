/**
 * The staff side of a till ticket (090): who may touch one, and what the
 * till is shown while it waits.
 *
 * A ticket is a till sale waiting for a card payment taken through Stripe,
 * either a phone link (Checkout) or Tap to Pay in the Stripe app. The webhook
 * is what settles it; these helpers only read it and let staff act on it.
 */

import 'server-only'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isFrontDesk } from '@/types/database'

/** How far back a card payment counts as a candidate for a ticket. */
export const CARD_MATCH_WINDOW_MINUTES = 120

/**
 * How long past its time a Stripe app ticket is kept awaiting before the
 * ticket route lets it go. A Tap to Pay charge made just before the end is
 * still on its way as a webhook; letting the ticket go the moment the clock
 * runs out would cancel a sale whose money is landing.
 */
export const STRIPE_APP_GRACE_MINUTES = 5

type Gate =
  | { ok: true; supabase: Awaited<ReturnType<typeof createClient>>; userId: string }
  | { ok: false; response: NextResponse }

/** Signed in, not suspended, front desk or above. */
export async function frontDeskOnly(): Promise<Gate> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
  }
  const { data: me } = await supabase
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()
  if (!me || me.suspended_at || !isFrontDesk(me.role)) {
    return { ok: false, response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) }
  }
  return { ok: true, supabase, userId: user.id }
}

/** The ticket id from the path, or null when it is not one. */
export function ticketIdFrom(raw: string): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

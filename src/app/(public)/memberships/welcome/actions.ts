'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export type BookingIntent = 'now' | 'later'

/**
 * A new member's answer to "book now, or when you are ready" (084).
 *
 * Written as the signed-in member with the ordinary server client; RLS limits
 * the row to their own. The answer is a note for the studio, not a gate: if
 * the write fails (the migration not applied yet, a blip) the member still
 * goes where they asked to go.
 */
export async function recordBookingIntent(intent: BookingIntent): Promise<never> {
  // A server action is a public endpoint; the argument is not trusted.
  if (intent !== 'now' && intent !== 'later') redirect('/memberships/welcome')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/memberships/welcome')

  const { error } = await supabase
    .from('membership_booking_intents')
    // decided_at is left to the database (084 stamps it on insert and on
    // every overwrite), so the time on the row is the server's, not ours.
    .upsert({ client_id: user.id, intent }, { onConflict: 'client_id' })
  if (error) console.error('[membership welcome] could not record booking intent', error.message)

  redirect(intent === 'now' ? '/book?membership=1' : '/memberships?later=1')
}

import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { formatMoney } from '@/lib/utils'
import { isStaff, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * Staff asking the client to settle what a visit still owes.
 *
 * Writes one in-app notification with the live balance and a link to the
 * appointment page, where the pay button is. The balance is derived here from
 * the payments ledger — the number in the notice is the number the page will
 * show. Guarded against repeats: an unread nudge for the same visit stands in
 * the way of another, so a double-click never doubles the ask.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: me } = await supabase
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()
  if (me?.suspended_at || !isStaff((me?.role ?? 'client') as UserRole)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const admin = createAdminClient()

  const { data: appointment } = await admin
    .from('appointments')
    .select('id, client_id, status, total_cents, starts_at')
    .eq('id', id)
    .maybeSingle()

  if (!appointment) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (!appointment.client_id) {
    return NextResponse.json(
      { error: 'no_account', message: 'This booking has no account to notify — reach them by phone or email.' },
      { status: 409 }
    )
  }
  if (['cancelled', 'no_show'].includes(appointment.status)) {
    return NextResponse.json({ error: 'not_billed' }, { status: 409 })
  }

  const { data: payments } = await admin
    .from('payments')
    .select('amount_cents')
    .eq('appointment_id', id)
    .eq('status', 'succeeded')
  const taken = (payments ?? []).reduce((n, p) => n + p.amount_cents, 0)
  const balance = Math.max(appointment.total_cents - taken, 0)

  if (balance <= 0) {
    return NextResponse.json(
      { error: 'nothing_owed', message: 'This visit is fully settled — nothing to ask for.' },
      { status: 409 }
    )
  }

  // One unread ask at a time, same shape as the cart nudge's guard.
  const link = `/account/appointments/${id}`
  const { data: alreadyAsked } = await admin
    .from('notifications')
    .select('id')
    .eq('user_id', appointment.client_id)
    .eq('link', link)
    .eq('type', 'system')
    .is('read_at', null)
    .ilike('title', '%balance%')
    .limit(1)
  if (alreadyAsked && alreadyAsked.length > 0) {
    return NextResponse.json(
      { error: 'already_asked', message: 'They already have an unread balance notice.' },
      { status: 409 }
    )
  }

  const { error } = await admin.from('notifications').insert({
    user_id: appointment.client_id,
    type: 'system',
    title: `Balance due — ${formatMoney(balance)}`,
    body: 'You can pay the remaining balance on your appointment online, or at the studio — whichever suits.',
    link,
    appointment_id: id,
  })

  if (error) {
    return NextResponse.json({ error: 'failed', message: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, balance_cents: balance })
}

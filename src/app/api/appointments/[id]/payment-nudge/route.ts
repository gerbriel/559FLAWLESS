import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { formatMoney } from '@/lib/utils'
import { isStaff, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

const Body = z.object({ kind: z.enum(['deposit', 'balance']).default('balance') })

/** A repeat of the same ask is allowed once this much time has passed. */
const RESEND_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * Staff asking the client to pay — the deposit, or what the visit still owes.
 *
 * Writes one in-app notification with the live figure and a link to the
 * appointment page, where the pay button is. The amounts are derived here —
 * the number in the notice is the number the page will show. Repeats are
 * paced, not forbidden: an unpaid client can be asked again, but not twice in
 * the same day — a double-click never doubles the ask, and a genuine
 * follow-up tomorrow goes through.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }
  const { kind } = parsed.data

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
    .select('id, client_id, status, total_cents, deposit_cents, deposit_status, starts_at')
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

  let asking: number
  let title: string
  let body: string

  if (kind === 'deposit') {
    if (appointment.deposit_cents <= 0 || appointment.deposit_status === 'paid') {
      return NextResponse.json(
        { error: 'nothing_owed', message: 'No deposit is outstanding on this booking.' },
        { status: 409 }
      )
    }
    asking = appointment.deposit_cents
    title = `Deposit due — ${formatMoney(asking)}`
    body =
      'Your booking has a deposit outstanding. You can pay it from your appointment page — it comes off your total on the day.'
  } else {
    const { data: payments } = await admin
      .from('payments')
      .select('amount_cents')
      .eq('appointment_id', id)
      .eq('status', 'succeeded')
    const taken = (payments ?? []).reduce((n, p) => n + p.amount_cents, 0)
    asking = Math.max(appointment.total_cents - taken, 0)

    if (asking <= 0) {
      return NextResponse.json(
        { error: 'nothing_owed', message: 'This visit is fully settled — nothing to ask for.' },
        { status: 409 }
      )
    }
    title = `Balance due — ${formatMoney(asking)}`
    body =
      'You can pay the remaining balance on your appointment online, or at the studio — whichever suits.'
  }

  // Paced, not forbidden: a fresh unread ask blocks a repeat for a day.
  const link = `/account/appointments/${id}`
  const marker = kind === 'deposit' ? '%deposit%' : '%balance%'
  const { data: alreadyAsked } = await admin
    .from('notifications')
    .select('id, created_at')
    .eq('user_id', appointment.client_id)
    .eq('link', link)
    .eq('type', 'system')
    .is('read_at', null)
    .ilike('title', marker)
    .order('created_at', { ascending: false })
    .limit(1)
  const last = alreadyAsked?.[0]
  if (last && Date.now() - new Date(last.created_at).getTime() < RESEND_AFTER_MS) {
    return NextResponse.json(
      {
        error: 'already_asked',
        message: 'They were asked within the last day. It can be sent again tomorrow.',
      },
      { status: 409 }
    )
  }

  const { error } = await admin.from('notifications').insert({
    user_id: appointment.client_id,
    type: 'system',
    title,
    body,
    link,
    appointment_id: id,
  })

  if (error) {
    return NextResponse.json({ error: 'failed', message: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, balance_cents: asking })
}

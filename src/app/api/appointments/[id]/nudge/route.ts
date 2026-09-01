import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { formatMoney } from '@/lib/utils'
import { isStaff, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

const Body = z.object({ kind: z.enum(['deposit', 'balance', 'forms']).default('balance') })

/** A repeat of the same ask is allowed once this much time has passed. */
const RESEND_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * Staff nudging the client — the deposit, the remaining balance, or the
 * consent forms their visit still needs.
 *
 * Writes one in-app notification with the live figure (or the live form
 * list) and a link to the page where the thing is done. Everything is derived
 * here at send time — the notice always carries today's truth. Repeats are
 * paced, not forbidden: an unmoved client can be asked again, but not twice
 * in the same day — a double-click never doubles the ask, and a genuine
 * follow-up tomorrow goes through. The forms pacing counts 070's automatic
 * approval notice too, so approval day never gets a manual echo.
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

  let asking = 0
  let title: string
  let body: string
  let link = `/account/appointments/${id}`
  let type: 'system' | 'consent_needed' = 'system'

  if (kind === 'forms') {
    // The same reckoning as 070's approval nudge, at staff request. The two
    // read the same tables the same way and must move together.
    const { data: lineRows } = await admin
      .from('appointment_services')
      .select('service_id, services(category_id)')
      .eq('appointment_id', id)
      .not('service_id', 'is', null)
    const sids = [...new Set((lineRows ?? []).map((l) => l.service_id).filter((x): x is number => x !== null))]
    const cids = [
      ...new Set(
        (lineRows ?? [])
          .map((l) => (l.services as unknown as { category_id: number } | null)?.category_id)
          .filter((x): x is number => x != null)
      ),
    ]

    const { data: forms } = await admin
      .from('consent_forms')
      .select('id, slug, title, service_ids, category_ids, revalidate_after_days')
      .eq('is_active', true)

    const applicable = (forms ?? []).filter(
      (f) =>
        (f.service_ids ?? []).some((sid: number) => sids.includes(sid)) ||
        (f.category_ids ?? []).some((cid: number) => cids.includes(cid))
    )

    let outstanding: string[] = []
    if (applicable.length > 0) {
      const { data: sigs } = await admin
        .from('consent_signatures')
        .select('signed_at, expires_at, consent_forms(slug, revalidate_after_days)')
        .eq('client_id', appointment.client_id)
      const liveSlugs = new Set(
        (sigs ?? [])
          .filter((sig) => {
            const form = sig.consent_forms as unknown as {
              slug: string
              revalidate_after_days: number
            } | null
            if (!form) return false
            const until = sig.expires_at
              ? new Date(sig.expires_at).getTime()
              : new Date(sig.signed_at).getTime() + form.revalidate_after_days * 86_400_000
            return until > Date.now()
          })
          .map((sig) => (sig.consent_forms as unknown as { slug: string }).slug)
      )
      outstanding = [...new Set(applicable.filter((f) => !liveSlugs.has(f.slug)).map((f) => f.title))].sort()
    }

    if (outstanding.length === 0) {
      return NextResponse.json(
        { error: 'nothing_outstanding', message: 'Every form this visit needs is already signed.' },
        { status: 409 }
      )
    }

    asking = outstanding.length
    type = 'consent_needed'
    link = '/account/forms'
    title = 'Forms to sign before your visit'
    body = `Your visit needs: ${outstanding.join(', ')}. Signing takes a minute and saves time on the day.`
  } else if (kind === 'deposit') {
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

  // Paced, not forbidden: a fresh unread ask blocks a repeat for a day. The
  // forms marker also catches 070's automatic approval notice, so approval
  // day never gets a manual echo of the same list.
  const marker = kind === 'deposit' ? '%deposit%' : kind === 'balance' ? '%balance%' : '%form%'
  const { data: alreadyAsked } = await admin
    .from('notifications')
    .select('id, created_at')
    .eq('user_id', appointment.client_id)
    .eq('type', type)
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
    type,
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

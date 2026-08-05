import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isFrontDesk, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

const Body = z.object({ clientId: z.string().uuid() })

/**
 * "Still thinking it over?" — one gentle reminder about a bag left waiting.
 *
 * Sent by a person, on purpose, from the client's record — never by a
 * scheduler. The refusals below are the feature: a nudge that can be sent
 * twice, or to somebody who opted out of marketing, stops being gentle.
 *
 * The type is 'system' because the notification enum has no marketing kind and
 * a migration for one word is not worth it; what makes this marketing is the
 * opt-in check here, applied the way 038 applies it — re-read at the moment of
 * sending, never trusted from earlier.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Role and suspension re-read from the database, not trusted from a session.
  const { data: me } = await supabase
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()

  if (!me || me.suspended_at || !isFrontDesk(me.role as UserRole)) {
    return NextResponse.json(
      { error: 'forbidden', message: 'Sending reminders is front desk and up.' },
      { status: 403 }
    )
  }

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }
  const clientId = parsed.data.clientId

  // Past this point the admin client is authorised: the caller is verified
  // front-desk staff, and the reads below cross tables a staff session cannot
  // see together (notifications belong to the client).
  const admin = createAdminClient()

  const { data: target } = await admin
    .from('profiles')
    .select('id, role, marketing_opt_in, first_name')
    .eq('id', clientId)
    .maybeSingle()

  if (!target || target.role !== 'client') {
    return NextResponse.json(
      { error: 'unknown_client', message: 'No such client.' },
      { status: 404 }
    )
  }

  // 038's principle: consent is read at the moment of sending. A reminder
  // about an unbought product is marketing, whatever the enum calls it.
  if (!target.marketing_opt_in) {
    return NextResponse.json(
      {
        error: 'marketing_opt_out',
        message: 'This client has opted out of marketing, so no reminder can be sent.',
      },
      { status: 409 }
    )
  }

  const { data: bag } = await admin
    .from('cart_snapshots')
    .select('lines, updated_at')
    .eq('client_id', clientId)
    .maybeSingle()

  const lines = (bag?.lines ?? []) as { productId: number; qty: number }[]
  if (lines.length === 0) {
    return NextResponse.json(
      { error: 'empty_bag', message: 'Their bag is empty — nothing to remind them about.' },
      { status: 409 }
    )
  }

  // One bag, one nudge. An unread reminder still sitting in their bell means
  // the message has been sent and not yet seen; a second is a drip campaign.
  const { data: pending } = await admin
    .from('notifications')
    .select('id')
    .eq('user_id', clientId)
    .eq('link', '/cart')
    .is('read_at', null)
    .limit(1)

  if (pending && pending.length > 0) {
    return NextResponse.json(
      {
        error: 'already_nudged',
        message: 'They already have an unread reminder about this bag. One is enough.',
      },
      { status: 409 }
    )
  }

  // Name what is actually waiting — a reminder that says nothing specific
  // reads as spam. Ids and quantities are all the snapshot holds, so the
  // names come from the catalogue at send time.
  const { data: products } = await admin
    .from('products')
    .select('id, name')
    .in(
      'id',
      lines.map((l) => l.productId)
    )

  const names = lines
    .map((l) => products?.find((p) => p.id === l.productId)?.name)
    .filter((n): n is string => !!n)

  const body =
    names.length === 0
      ? 'Your bag is still waiting whenever you are ready.'
      : names.length === 1
        ? `The ${names[0]} is still in your bag whenever you are ready.`
        : `Your bag still has the ${names[0]} and ${names.length - 1} more waiting whenever you are ready.`

  const { error: insertError } = await admin.from('notifications').insert({
    user_id: clientId,
    type: 'system',
    title: 'Still thinking it over?',
    body,
    link: '/cart',
  })

  if (insertError) {
    return NextResponse.json(
      { error: 'send_failed', message: 'The reminder could not be sent. Try again.' },
      { status: 500 }
    )
  }

  return NextResponse.json({ ok: true })
}

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { recordPosVisit } from '@/lib/pos-visit'
import { queueNotificationEmails } from '@/lib/notification-email'
import { isFrontDesk, isManager, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

const SaleSchema = z
  .object({
    clientId: z.string().uuid().nullish(),
    guestName: z.string().trim().max(120).nullish(),
    serviceIds: z.array(z.number().int().positive()).min(1).max(6),
    paymentMethod: z.enum(['cash', 'card', 'apple_pay', 'zelle', 'paypal', 'venmo', 'cashapp', 'other']),
    notes: z.string().trim().max(500).nullish(),
    /** Manager-only, verified server-side. Integer cents off the visit. */
    discountCents: z.number().int().min(0).max(1_000_000).default(0),
  })
  .refine((v) => v.clientId || v.guestName, {
    message: 'Name the customer, even if only as a walk-in.',
  })

/**
 * Ring up a SERVICE at the till, on its own.
 *
 * The visit itself (a completed appointment priced by priceService, the
 * membership applied, back-bar drawn down, the payment in the ledger) is
 * written by recordPosVisit in src/lib/pos-visit.ts, which /api/pos/sale also
 * uses when services and products are rung up together.
 *
 * The manual discount is manager-only, verified here: a request from anyone
 * else simply loses the field. It lands in `promo_discount_cents`, the same
 * column every visit-level deal uses, so the total derivation needs nothing.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: staff } = await supabase
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()
  if (!staff || staff.suspended_at || !isFrontDesk(staff.role as UserRole)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const parsed = SaleSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', message: parsed.error.issues[0]?.message ?? 'Check the sale.' },
      { status: 400 }
    )
  }
  const { clientId, guestName, serviceIds, paymentMethod, notes } = parsed.data
  const discount = isManager(staff.role as UserRole) ? parsed.data.discountCents : 0

  const admin = createAdminClient()

  // The whole visit, payment row included: see src/lib/pos-visit.ts.
  const outcome = await recordPosVisit(admin, {
    staffId: user.id,
    clientId: clientId ?? null,
    guestName: guestName ?? null,
    serviceIds,
    paymentMethod,
    notes: notes ?? null,
    discountCents: discount,
    recordPayment: true,
  })
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error, message: outcome.message }, { status: outcome.status })
  }
  const { visit } = outcome

  queueNotificationEmails()

  return NextResponse.json(
    {
      ok: true,
      appointment_id: visit.appointmentId,
      subtotal_cents: visit.subtotalCents,
      discount_cents: visit.discountCents,
      membership_cents: visit.membershipCents,
      membership_name: visit.membershipName,
      total_cents: visit.totalCents,
    },
    { status: 201 }
  )
}

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isFrontDesk } from '@/types/database'

export const dynamic = 'force-dynamic'

const SaleSchema = z
  .object({
    clientId: z.string().uuid().nullish(),
    guestName: z.string().trim().max(120).nullish(),
    items: z
      .array(
        z.object({
          productId: z.number().int().positive(),
          qty: z.number().int().positive().max(999),
        })
      )
      .min(1)
      .max(50),
    paymentMethod: z.enum(['cash', 'card', 'other']),
    appointmentId: z.string().uuid().nullish(),
    notes: z.string().trim().max(500).nullish(),
  })
  .refine((v) => v.clientId || v.guestName, {
    message: 'Name the customer, even if only as a walk-in.',
  })

/** Fresno County's combined rate, unless the studio has set its own. */
const DEFAULT_TAX_RATE = 0.0835

/**
 * Ring up an in-person sale.
 *
 * Prices and stock are read from the database here rather than trusted from the
 * browser — the till is a staff tool, but "staff" includes whoever is standing
 * at an unlocked iPad, and a mispriced receipt is a real loss.
 *
 * The order is written as a cart and then moved to `paid`, because the
 * status-change trigger is what decrements stock. Writing it as paid outright
 * would sell the product without ever taking it off the shelf.
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

  if (!staff || staff.suspended_at || !isFrontDesk(staff.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const parsed = SaleSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'Check the sale and try again.',
      },
      { status: 400 }
    )
  }

  const { clientId, guestName, items, paymentMethod, appointmentId, notes } = parsed.data
  const admin = createAdminClient()

  // Merge duplicate lines so two scans of the same product are one line of two,
  // and so the stock check below sees the true quantity.
  const wanted = new Map<number, number>()
  for (const it of items) {
    wanted.set(it.productId, (wanted.get(it.productId) ?? 0) + it.qty)
  }

  const { data: products, error: productError } = await admin
    .from('products')
    .select('id, name, sku, price_cents, stock_qty, is_active, is_retail, external_url')
    .in('id', [...wanted.keys()])

  if (productError || !products) {
    return NextResponse.json(
      { error: 'lookup_failed', message: 'Could not read the products.' },
      { status: 500 }
    )
  }

  const lines: {
    product_id: number
    name_snapshot: string
    sku_snapshot: string | null
    unit_price_cents: number
    qty: number
  }[] = []

  for (const [productId, qty] of wanted) {
    const p = products.find((row) => row.id === productId)
    if (!p) {
      return NextResponse.json(
        { error: 'unknown_product', message: 'One of those products no longer exists.' },
        { status: 400 }
      )
    }
    if (!p.is_active || !p.is_retail) {
      return NextResponse.json(
        { error: 'not_for_sale', message: `${p.name} is not sold to clients.` },
        { status: 400 }
      )
    }
    if (Number(p.stock_qty) < qty) {
      return NextResponse.json(
        {
          error: 'out_of_stock',
          message: `Only ${Number(p.stock_qty)} of ${p.name} on the shelf.`,
          productId,
          available: Number(p.stock_qty),
          // The studio's Rhonda Allison storefront can ship it instead.
          externalUrl: p.external_url,
        },
        { status: 409 }
      )
    }

    lines.push({
      product_id: p.id,
      name_snapshot: p.name,
      sku_snapshot: p.sku,
      unit_price_cents: p.price_cents,
      qty,
    })
  }

  const subtotal = lines.reduce((sum, l) => sum + l.unit_price_cents * l.qty, 0)

  const { data: rateSetting } = await admin
    .from('site_settings')
    .select('text_value')
    .eq('key', 'sales_tax_rate')
    .eq('is_active', true)
    .maybeSingle()

  const parsedRate = Number(rateSetting?.text_value)
  const taxRate =
    Number.isFinite(parsedRate) && parsedRate >= 0 && parsedRate < 1 ? parsedRate : DEFAULT_TAX_RATE
  const tax = Math.round(subtotal * taxRate)

  const { data: order, error: orderError } = await admin
    .from('orders')
    .insert({
      client_id: clientId ?? null,
      guest_name: clientId ? null : (guestName ?? 'Walk-in'),
      status: 'cart',
      channel: 'in_store',
      fulfillment: 'pickup',
      payment_method: paymentMethod,
      sold_by: user.id,
      appointment_id: appointmentId ?? null,
      staff_notes: notes ?? null,
      tax_cents: tax,
    })
    .select('id')
    .single()

  if (orderError || !order) {
    console.error('pos order insert failed', orderError)
    return NextResponse.json(
      { error: 'sale_failed', message: 'Could not start that sale.' },
      { status: 500 }
    )
  }

  const { error: itemsError } = await admin
    .from('order_items')
    .insert(lines.map((l) => ({ ...l, order_id: order.id })))

  if (itemsError) {
    // Nothing has been paid or decremented yet, so removing the shell is clean.
    await admin.from('orders').delete().eq('id', order.id)
    console.error('pos items insert failed', itemsError)
    return NextResponse.json(
      { error: 'sale_failed', message: 'Could not add those items.' },
      { status: 500 }
    )
  }

  // The item trigger has recomputed subtotal and total from the lines; it reads
  // tax_cents off the order, which was set at insert. Moving to `paid` assigns
  // the order number and decrements stock.
  const { data: paid, error: payError } = await admin
    .from('orders')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', order.id)
    .select('id, order_number, subtotal_cents, tax_cents, total_cents')
    .single()

  if (payError || !paid) {
    console.error('pos mark-paid failed', payError)
    return NextResponse.json(
      { error: 'sale_failed', message: 'The sale was not completed. Nothing was charged.' },
      { status: 500 }
    )
  }

  return NextResponse.json({ ok: true, order: paid }, { status: 201 })
}

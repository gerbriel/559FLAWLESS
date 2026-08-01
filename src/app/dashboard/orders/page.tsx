import Link from 'next/link'
import { AlertTriangle, Package, Scissors, Store, Globe } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { OrderStatusControl } from '@/components/shared/OrderStatusControl'
import { formatMoney } from '@/lib/utils'
import { formatDateTimeInTimeZone } from '@/lib/time'
import type { OrderStatus, AppointmentStatus } from '@/types/database'

export const dynamic = 'force-dynamic'

const STUDIO_TZ = 'America/Los_Angeles'

interface Props {
  searchParams: Promise<{ view?: string }>
}

const VIEWS = [
  { key: 'owed', label: 'Owed' },
  { key: 'services', label: 'Services' },
  { key: 'products', label: 'Products' },
  { key: 'fulfil', label: 'To ship' },
] as const

/** Online orders still waiting to be packed or handed over. */
const OPEN_STATUSES: OrderStatus[] = ['paid', 'fulfilling', 'ready_for_pickup']

/** How an appointment's status reads as an outcome. */
const OUTCOME: Record<AppointmentStatus, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'accent' }> = {
  pending: { label: 'Awaiting confirmation', tone: 'warning' },
  confirmed: { label: 'Booked', tone: 'neutral' },
  checked_in: { label: 'In the room', tone: 'accent' },
  completed: { label: 'Showed up', tone: 'success' },
  no_show: { label: 'No-show', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}

/**
 * Everything the studio has sold, and what is still owed on it.
 *
 * Two things are being sold — time and products — and they behave differently
 * enough that one flat list would be a mess: a facial is booked, then either
 * happens or does not, and is usually part-paid up front; a bottle of serum is
 * simply handed over. So they get their own views, joined by a shared "Owed"
 * one, which is the question actually asked at the end of a day.
 *
 * Balances are computed from `payments` rather than read off a flag. The
 * payments are the evidence, and a stored balance drifts the moment anything is
 * refunded.
 */
export default async function DashboardOrdersPage({ searchParams }: Props) {
  const { view } = await searchParams
  const active = VIEWS.some((v) => v.key === view) ? view! : 'owed'

  const supabase = await createClient()

  const [{ data: orders }, { data: appointments }, { data: payments }] = await Promise.all([
    supabase
      .from('orders')
      .select(
        'id, order_number, status, channel, payment_method, fulfillment, total_cents, created_at, paid_at, guest_name, guest_email, client_id, profiles!orders_client_id_fkey(first_name, last_name), order_items(id, name_snapshot, qty)'
      )
      .neq('status', 'cart')
      .order('created_at', { ascending: false })
      .limit(200),
    supabase
      .from('appointments')
      .select(
        'id, starts_at, status, source, total_cents, deposit_cents, deposit_status, client_id, guest_first_name, guest_last_name, profiles!appointments_client_id_fkey(first_name, last_name), appointment_services(name_snapshot, sort_order)'
      )
      .order('starts_at', { ascending: false })
      .limit(200),
    supabase
      .from('payments')
      .select('amount_cents, order_id, appointment_id, status')
      .eq('status', 'succeeded')
      .limit(2000),
  ])

  // Roll payments up once, rather than a query per row.
  const paidByOrder = new Map<number, number>()
  const paidByAppointment = new Map<string, number>()
  for (const p of payments ?? []) {
    if (p.order_id) paidByOrder.set(p.order_id, (paidByOrder.get(p.order_id) ?? 0) + p.amount_cents)
    if (p.appointment_id) {
      paidByAppointment.set(
        p.appointment_id,
        (paidByAppointment.get(p.appointment_id) ?? 0) + p.amount_cents
      )
    }
  }

  const nameOf = (
    profile: { first_name: string | null; last_name: string | null } | null,
    fallback: string
  ) => {
    const n = profile ? `${profile.first_name ?? ''} ${profile.last_name ?? ''}`.trim() : ''
    return n || fallback
  }

  const orderRows = (orders ?? []).map((o) => {
    const taken = paidByOrder.get(o.id) ?? 0
    const billable = o.status !== 'cancelled' && o.status !== 'refunded'
    return {
      ...o,
      who: nameOf(
        o.profiles as { first_name: string | null; last_name: string | null } | null,
        o.guest_name ?? o.guest_email ?? 'Guest'
      ),
      items: (o.order_items ?? []) as { id: number; name_snapshot: string; qty: number }[],
      balance: billable ? Math.max(o.total_cents - taken, 0) : 0,
    }
  })

  const appointmentRows = (appointments ?? []).map((a) => {
    const taken = paidByAppointment.get(a.id) ?? 0
    // A treatment that did not happen is not billed. A forfeited deposit has
    // already been taken and stays taken.
    const billable = a.status !== 'cancelled' && a.status !== 'no_show'
    return {
      ...a,
      who: nameOf(
        a.profiles as { first_name: string | null; last_name: string | null } | null,
        `${a.guest_first_name ?? ''} ${a.guest_last_name ?? ''}`.trim() || 'Guest'
      ),
      services: ((a.appointment_services ?? []) as { name_snapshot: string; sort_order: number }[])
        .sort((x, y) => x.sort_order - y.sort_order)
        .map((s) => s.name_snapshot)
        .join(' + '),
      taken,
      balance: billable ? Math.max(a.total_cents - taken, 0) : 0,
      billable,
    }
  })

  const owedAppointments = appointmentRows.filter((a) => a.balance > 0)
  const owedOrders = orderRows.filter((o) => o.balance > 0)
  const totalOwed =
    owedAppointments.reduce((s, a) => s + a.balance, 0) +
    owedOrders.reduce((s, o) => s + o.balance, 0)

  const toShip = orderRows.filter(
    (o) => o.channel !== 'in_store' && OPEN_STATUSES.includes(o.status as OrderStatus)
  )

  // Money actually taken, which is what "sold" means at the end of a day.
  const takenFromServices = appointmentRows.reduce(
    (s, a) => s + (paidByAppointment.get(a.id) ?? 0),
    0
  )
  const takenFromProducts = orderRows.reduce((s, o) => s + (paidByOrder.get(o.id) ?? 0), 0)

  const showed = appointmentRows.filter((a) => a.status === 'completed').length
  const noShows = appointmentRows.filter((a) => a.status === 'no_show').length

  return (
    <div>
      <h1 className="display text-3xl">Orders</h1>
      <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
        Everything sold — time and product — and what is still outstanding on it.
      </p>

      <dl className="mt-8 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Taken · services" value={formatMoney(takenFromServices)} />
        <Stat label="Taken · products" value={formatMoney(takenFromProducts)} />
        <Stat label="Outstanding" value={formatMoney(totalOwed)} tone={totalOwed > 0 ? 'warn' : undefined} />
        <Stat label="Showed / no-show" value={`${showed} / ${noShows}`} />
      </dl>

      <nav className="mt-10 flex flex-wrap gap-x-7 gap-y-2" aria-label="View">
        {VIEWS.map((v) => {
          const count =
            v.key === 'owed'
              ? owedAppointments.length + owedOrders.length
              : v.key === 'fulfil'
                ? toShip.length
                : 0
          return (
            <Link
              key={v.key}
              href={`/dashboard/orders?view=${v.key}`}
              className={`label-caps pb-1 ${
                active === v.key
                  ? 'border-b border-[var(--color-foreground)]'
                  : 'text-[var(--color-muted)]'
              }`}
            >
              {v.label}
              {count > 0 && <span className="ml-1.5 text-[var(--color-accent)]">{count}</span>}
            </Link>
          )
        })}
      </nav>

      {/* ── Owed ─────────────────────────────────────────── */}
      {active === 'owed' && (
        <div className="mt-8">
          {owedAppointments.length + owedOrders.length === 0 ? (
            <Empty>Nothing outstanding. Everything sold has been paid for.</Empty>
          ) : (
            <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
              {owedAppointments.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4">
                  <Scissors
                    className="h-4 w-4 shrink-0 text-[var(--color-muted)]"
                    strokeWidth={1.5}
                  />
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/dashboard/appointments/${a.id}`}
                      className="hover:text-[var(--color-accent)]"
                    >
                      {a.who}
                    </Link>
                    <p className="mt-0.5 truncate text-sm text-[var(--color-muted)]">
                      {a.services} · {formatDateTimeInTimeZone(new Date(a.starts_at), STUDIO_TZ)}
                    </p>
                  </div>
                  <Badge tone={OUTCOME[a.status as AppointmentStatus].tone}>
                    {OUTCOME[a.status as AppointmentStatus].label}
                  </Badge>
                  {a.taken > 0 && (
                    <span className="text-xs tabular-nums text-[var(--color-muted)]">
                      {formatMoney(a.taken)} of {formatMoney(a.total_cents)}
                    </span>
                  )}
                  <span className="w-24 text-right tabular-nums text-amber-700 dark:text-amber-400">
                    {formatMoney(a.balance)}
                  </span>
                </li>
              ))}

              {owedOrders.map((o) => (
                <li key={`o${o.id}`} className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4">
                  <Package
                    className="h-4 w-4 shrink-0 text-[var(--color-muted)]"
                    strokeWidth={1.5}
                  />
                  <div className="min-w-0 flex-1">
                    <p>{o.who}</p>
                    <p className="mt-0.5 truncate text-sm text-[var(--color-muted)]">
                      {o.order_number} · {o.items.map((i) => `${i.name_snapshot} ×${i.qty}`).join(', ')}
                    </p>
                  </div>
                  <span className="w-24 text-right tabular-nums text-amber-700 dark:text-amber-400">
                    {formatMoney(o.balance)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ── Services ─────────────────────────────────────── */}
      {active === 'services' && (
        <div className="mt-8">
          {appointmentRows.length === 0 ? (
            <Empty>No appointments yet.</Empty>
          ) : (
            <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
              {appointmentRows.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4">
                  <span className="label-caps w-36 shrink-0 text-[var(--color-muted)]">
                    {formatDateTimeInTimeZone(new Date(a.starts_at), STUDIO_TZ)}
                  </span>

                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/dashboard/appointments/${a.id}`}
                      className="hover:text-[var(--color-accent)]"
                    >
                      {a.who}
                    </Link>
                    <p className="mt-0.5 truncate text-sm text-[var(--color-muted)]">
                      {a.services}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={OUTCOME[a.status as AppointmentStatus].tone}>
                      {OUTCOME[a.status as AppointmentStatus].label}
                    </Badge>
                    {a.deposit_cents > 0 && (
                      <Badge tone={a.deposit_status === 'paid' ? 'success' : 'warning'}>
                        Deposit {a.deposit_status}
                      </Badge>
                    )}
                    {a.billable && a.balance === 0 && a.total_cents > 0 && (
                      <Badge tone="success">Paid in full</Badge>
                    )}
                  </div>

                  <span className="w-24 text-right tabular-nums">
                    {formatMoney(a.total_cents)}
                    {a.balance > 0 && (
                      <span className="block text-xs text-amber-700 dark:text-amber-400">
                        {formatMoney(a.balance)} due
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ── Products ─────────────────────────────────────── */}
      {active === 'products' && (
        <div className="mt-8">
          {orderRows.length === 0 ? (
            <Empty>Nothing sold yet.</Empty>
          ) : (
            <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
              {orderRows.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4">
                  <span className="label-caps w-32 shrink-0 text-[var(--color-muted)]">
                    {o.order_number ?? `#${o.id}`}
                  </span>

                  <div className="min-w-0 flex-1">
                    <p>{o.who}</p>
                    <p className="mt-0.5 truncate text-sm text-[var(--color-muted)]">
                      {o.items.map((i) => `${i.name_snapshot} ×${i.qty}`).join(', ')}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={o.channel === 'in_store' ? 'accent' : 'neutral'}>
                      {o.channel === 'in_store' ? (
                        <>
                          <Store className="h-3 w-3" strokeWidth={2} />
                          In studio
                        </>
                      ) : (
                        <>
                          <Globe className="h-3 w-3" strokeWidth={2} />
                          Online
                        </>
                      )}
                    </Badge>
                    {o.payment_method && (
                      <span className="text-xs text-[var(--color-muted)]">
                        {o.payment_method}
                      </span>
                    )}
                    <Badge
                      tone={
                        o.status === 'completed'
                          ? 'success'
                          : o.status === 'cancelled' || o.status === 'refunded'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {o.status.replace('_', ' ')}
                    </Badge>
                  </div>

                  <span className="w-24 text-right tabular-nums">{formatMoney(o.total_cents)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ── To ship ──────────────────────────────────────── */}
      {active === 'fulfil' && (
        <div className="mt-8">
          {toShip.length === 0 ? (
            <Empty>Nothing waiting. In-studio sales are handed over as they are rung up.</Empty>
          ) : (
            <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
              {toShip.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-x-6 gap-y-3 py-4">
                  <span className="label-caps w-32 shrink-0 text-[var(--color-muted)]">
                    {o.order_number ?? `#${o.id}`}
                  </span>

                  <div className="min-w-0 flex-1">
                    <p>{o.who}</p>
                    <p className="mt-0.5 truncate text-sm text-[var(--color-muted)]">
                      {o.items.map((i) => `${i.name_snapshot} ×${i.qty}`).join(', ')}
                    </p>
                  </div>

                  <Badge tone="neutral">
                    {o.fulfillment === 'pickup' ? 'Pickup' : 'Ship'}
                  </Badge>

                  <OrderStatusControl
                    orderId={o.id}
                    status={o.status as OrderStatus}
                    fulfillment={o.fulfillment}
                  />

                  <span className="w-20 text-right tabular-nums">
                    {formatMoney(o.total_cents)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'warn'
}) {
  return (
    <div className="bg-[var(--color-background)] p-5">
      <dt className="label-caps text-[var(--color-muted)]">{label}</dt>
      <dd
        className={`mt-2 text-2xl tabular-nums ${
          tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : ''
        }`}
      >
        {tone === 'warn' && (
          <AlertTriangle className="mr-1.5 inline h-4 w-4" strokeWidth={2} />
        )}
        {value}
      </dd>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
      {children}
    </p>
  )
}

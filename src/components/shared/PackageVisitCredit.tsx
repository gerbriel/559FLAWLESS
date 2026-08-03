import { Check, Ticket } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { formatMoney } from '@/lib/utils'
import { requestNow } from '@/lib/time'
import { PackageRedeemButton } from '@/components/shared/PackageRedeem'

/**
 * Checkout, for a client who already paid for this treatment.
 *
 * Sits beside `TakePayment` on the appointment screen and answers the question
 * that comes first: is any of this already covered? A session spent here writes
 * a `payments` row of kind and method `package`, which is what drops the
 * balance `TakePayment` shows — there is no discount field in this schema and
 * an amount owed is the sum of the ledger, so a credit IS the mechanism.
 *
 * Renders nothing at all unless this visit includes a service one of the
 * client's live packages pays for. An appointment page carrying an empty
 * "Packages: none" panel forever is worse than silence.
 *
 * A guest booking has no `client_id` and therefore no balance — packages are
 * held by an account, which is also why the till refuses to sell one to a
 * walk-in.
 */
export async function PackageVisitCredit({
  appointmentId,
  clientId,
  now = requestNow(),
}: {
  appointmentId: string
  clientId: string | null
  now?: number
}) {
  if (!clientId) return null

  const supabase = await createClient()

  const [{ data: visit }, { data: lines }, { data: held }, { data: spent }, { data: payments }] =
    await Promise.all([
      supabase
        .from('appointments')
        .select('id, status, total_cents')
        .eq('id', appointmentId)
        .maybeSingle(),
      supabase
        .from('appointment_services')
        .select('id, service_id, name_snapshot, price_cents')
        .eq('appointment_id', appointmentId),
      supabase
        .from('client_packages')
        .select(
          'id, sessions_total, sessions_remaining, expires_at, service_packages(id, name, service_id)'
        )
        .eq('client_id', clientId)
        .order('purchased_at'),
      supabase
        .from('package_redemptions')
        .select('client_package_id')
        .eq('appointment_id', appointmentId),
      supabase
        .from('payments')
        .select('amount_cents')
        .eq('appointment_id', appointmentId)
        .eq('status', 'succeeded'),
    ])

  const serviceLines = lines ?? []
  if (!visit || serviceLines.length === 0) return null
  // A treatment that did not happen is not billed, so there is nothing here to
  // cover — the same line `TakePayment` draws.
  if (visit.status === 'cancelled' || visit.status === 'no_show') return null

  // Owed = the appointment's own total less what the ledger says was taken.
  // `appointments.total_cents` is maintained by a trigger and is the authority;
  // re-summing the lines here would be a second answer free to drift from it.
  const takenCents = (payments ?? []).reduce((sum, p) => sum + p.amount_cents, 0)
  const outstandingCents = Math.max(visit.total_cents - takenCents, 0)

  const alreadySpent = new Set((spent ?? []).map((r) => r.client_package_id))

  const applicable = (held ?? [])
    .map((row) => {
      const definition = row.service_packages as unknown as {
        id: number
        name: string
        service_id: number | null
      } | null

      // Open packages cover a service, not an add-on — an add-on row carries
      // `addon_id` and a null `service_id`.
      const covered =
        definition?.service_id == null
          ? serviceLines.filter((l) => l.service_id !== null)
          : serviceLines.filter((l) => l.service_id === definition.service_id)
      if (covered.length === 0) return null

      // The dearest covered line, the same reading `redeemSession` takes.
      const best = covered.reduce((top, l) => (l.price_cents > top.price_cents ? l : top))
      const used = alreadySpent.has(row.id)
      const expired = row.expires_at ? new Date(row.expires_at).getTime() <= now : false

      // A package with nothing left, and nothing spent here, is history.
      if (!used && (expired || row.sessions_remaining <= 0)) return null

      return {
        id: row.id,
        name: definition?.name ?? 'Package',
        lineName: best.name_snapshot,
        coversCents: Math.min(best.price_cents, outstandingCents),
        sessionsRemaining: row.sessions_remaining,
        sessionsTotal: row.sessions_total,
        used,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  if (applicable.length === 0) return null

  return (
    <div
      data-ui="panel"
      className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
    >
      <h3 className="label-caps mb-5 flex items-center gap-2 text-[var(--color-accent)]">
        <Ticket className="h-3.5 w-3.5" strokeWidth={2} />
        Prepaid
      </h3>

      <ul className="space-y-4">
        {applicable.map((p) => (
          <li key={p.id}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="text-sm">{p.name}</span>
              <span className="shrink-0 text-sm tabular-nums text-[var(--color-muted)]">
                {p.sessionsRemaining} of {p.sessionsTotal} left
              </span>
            </div>

            <p className="mt-1 text-xs text-[var(--color-muted)]">
              Covers {p.lineName}
              {p.used ? '' : ` · ${formatMoney(p.coversCents)} off this visit`}
            </p>

            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {p.used && (
                <Badge tone="success" size="sm">
                  <Check className="h-3 w-3" strokeWidth={2.5} />
                  Session used
                </Badge>
              )}
              <PackageRedeemButton
                clientPackageId={p.id}
                appointmentId={appointmentId}
                coversCents={p.coversCents}
                redeemed={p.used}
                disabled={!p.used && p.coversCents <= 0}
              />
            </div>

            {!p.used && p.coversCents <= 0 && (
              <p className="mt-2 text-xs text-[var(--color-muted)]">
                This visit is already settled, so a session would be spent for nothing.
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AlertTriangle } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { AppointmentStatusControl } from '@/components/shared/AppointmentStatusControl'
import { ClientNoteForm } from '@/components/shared/ClientNoteForm'
import { TakePayment, type PaymentRecord } from '@/components/shared/TakePayment'
import { PackageVisitCredit } from '@/components/shared/PackageVisitCredit'
import { PhotoReminderPrompt } from '@/components/shared/PhotoReminderPrompt'
import { PairUpsell, type PairUpsellOption } from '@/components/shared/PairUpsell'
import { formatMoney, formatDuration } from '@/lib/utils'
import { bestPairDiscount, pairDiscountCents, type PairDiscountRule } from '@/lib/pair-discounts'
import { formatDateTimeInTimeZone, dateKeyInTimeZone, requestNow } from '@/lib/time'
import type { AppointmentStatus } from '@/types/database'
import type { AppointmentPhotoPrompt } from '@/types/clientprofile'

export const dynamic = 'force-dynamic'

const STUDIO_TZ = 'America/Los_Angeles'

interface Props {
  params: Promise<{ id: string }>
}

export default async function StaffAppointmentPage({ params }: Props) {
  const { id } = await params
  const supabase = await createClient()

  const { data: appointment } = await supabase
    .from('appointments')
    .select(
      'id, starts_at, ends_at, status, source, provider_id, subtotal_cents, total_cents, membership_covered_cents, membership_discount_cents, deposit_cents, deposit_status, client_notes, staff_notes, client_id, guest_first_name, guest_last_name, guest_email, guest_phone, age_attested_at, profiles!appointments_client_id_fkey(first_name, last_name, email, phone), appointment_services(id, service_id, name_snapshot, price_cents, duration_minutes, full_price_cents, added_by, sort_order)'
    )
    .eq('id', id)
    .maybeSingle()

  if (!appointment) notFound()

  const client = appointment.profiles as {
    first_name: string | null
    last_name: string | null
    email: string | null
    phone: string | null
  } | null

  const name = client
    ? `${client.first_name ?? ''} ${client.last_name ?? ''}`.trim()
    : `${appointment.guest_first_name ?? ''} ${appointment.guest_last_name ?? ''}`.trim()

  const lines = ((appointment.appointment_services ?? []) as {
    id: number
    service_id: number | null
    name_snapshot: string
    price_cents: number
    duration_minutes: number
    full_price_cents: number | null
    added_by: string | null
    sort_order: number
  }[]).sort((a, b) => a.sort_order - b.sort_order)

  // Every payment against this appointment — the Stripe deposit and anything
  // taken at the counter. The balance is the arithmetic, not a stored flag.
  const { data: payments } = await supabase
    .from('payments')
    .select('id, amount_cents, method, kind, note, created_at, status')
    .eq('appointment_id', id)
    .eq('status', 'succeeded')
    .order('created_at')

  const takenCents = (payments ?? []).reduce((sum, p) => sum + p.amount_cents, 0)
  // A treatment that did not happen is not billed; a forfeited deposit has
  // already been taken and stays taken.
  const notBilled = appointment.status === 'cancelled' || appointment.status === 'no_show'
  const balanceCents = notBilled ? 0 : Math.max(appointment.total_cents - takenCents, 0)

  // Latest intake flags, if this booking is tied to an account.
  const { data: intake } = appointment.client_id
    ? await supabase
        .from('intake_submissions')
        .select('flags, reviewed_at, submitted_at')
        .eq('client_id', appointment.client_id)
        .order('submitted_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null }

  // The in-chair upsell (067): what could join TODAY's visit at the pair
  // price. Offered only on the day, on a visit that is still billable — the
  // same rules `addPairedService` enforces, said ahead of the click.
  const visitServiceIds = lines
    .map((l) => l.service_id)
    .filter((id): id is number => id !== null)
  const upsellDay =
    ['confirmed', 'checked_in', 'completed'].includes(appointment.status) &&
    dateKeyInTimeZone(new Date(appointment.starts_at), STUDIO_TZ) ===
      dateKeyInTimeZone(new Date(requestNow()), STUDIO_TZ)

  let upsellOptions: PairUpsellOption[] = []
  if (upsellDay && visitServiceIds.length > 0) {
    const { data: rules } = await supabase
      .from('service_pair_discounts')
      .select('id, trigger_service_id, discounted_service_id, percent_off, label')
      .eq('is_active', true)
      .in('trigger_service_id', visitServiceIds)

    const candidateIds = [
      ...new Set(
        ((rules ?? []) as PairDiscountRule[])
          .map((r) => r.discounted_service_id)
          .filter((id) => !visitServiceIds.includes(id))
      ),
    ]

    if (candidateIds.length > 0) {
      const [{ data: candidateServices }, { data: providerLinks }] = await Promise.all([
        supabase
          .from('services')
          .select(
            'id, name, price_cents, duration_minutes, is_active, requires_age_verification, min_age'
          )
          .in('id', candidateIds)
          .eq('is_active', true),
        supabase
          .from('provider_services')
          .select('service_id, price_cents, is_active')
          .eq('provider_id', appointment.provider_id)
          .in('service_id', candidateIds),
      ])

      const linkFor = new Map(
        (providerLinks ?? []).filter((l) => l.is_active).map((l) => [l.service_id, l])
      )
      upsellOptions = (candidateServices ?? []).flatMap((svc) => {
        const link = linkFor.get(svc.id)
        if (!link) return []
        const rule = bestPairDiscount((rules ?? []) as PairDiscountRule[], visitServiceIds, svc.id)
        if (!rule) return []
        const fullCents = link.price_cents ?? svc.price_cents
        const off = pairDiscountCents(fullCents, rule.percent_off)
        if (off === 0) return []
        return [
          {
            serviceId: svc.id,
            name: svc.name,
            fullCents,
            priceCents: fullCents - off,
            needsAge: svc.requires_age_verification && !appointment.age_attested_at,
            minAge: svc.min_age,
          },
        ]
      })
    }
  }

  // Is a before/after photograph due on this visit? `photo_due` is null unless
  // a documented service is booked AND the client's consent covers it — the
  // gate is in `client_photo_consent_ok` (039), never in the component.
  const { data: photoPrompt } = await supabase
    .from('appointment_photo_prompts')
    .select(
      'appointment_id, client_id, provider_id, location_id, starts_at, status, photo_documented, intimate, documented_services, followup_days, before_count, after_count, progress_count, consent_ok, photo_due'
    )
    .eq('appointment_id', id)
    .maybeSingle()

  return (
    <div className="max-w-3xl">
      <Link href="/dashboard/calendar" className="label-caps text-[var(--color-muted)]">
        ← Calendar
      </Link>

      <div className="mt-8 flex flex-wrap items-start justify-between gap-6">
        <div>
          <h1 className="display text-3xl">{name || 'Guest'}</h1>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            {client?.email ?? appointment.guest_email}
            {(client?.phone ?? appointment.guest_phone) &&
              ` · ${client?.phone ?? appointment.guest_phone}`}
          </p>
          {appointment.client_id && (
            <Link
              href={`/dashboard/clients/${appointment.client_id}`}
              className="label-caps mt-3 inline-block border-b border-[var(--color-foreground)] pb-0.5"
            >
              Full client record
            </Link>
          )}
        </div>

        <AppointmentStatusControl
          appointmentId={appointment.id}
          status={appointment.status as AppointmentStatus}
        />
      </div>

      {(intake?.flags.length ?? 0) > 0 && !intake?.reviewed_at && (
        <div className="mt-8 border-l-2 border-amber-600 bg-amber-50 p-5 dark:bg-transparent">
          <p className="label-caps mb-3 flex items-center gap-2 text-amber-800 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2} />
            Unreviewed intake flags
          </p>
          <p className="text-sm text-[var(--color-muted)]">{intake!.flags.join(', ')}</p>
        </div>
      )}

      {photoPrompt && (
        <div className="mt-8">
          <PhotoReminderPrompt prompt={photoPrompt as unknown as AppointmentPhotoPrompt} />
        </div>
      )}

      <div className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <p className="display text-xl">
          {formatDateTimeInTimeZone(new Date(appointment.starts_at), STUDIO_TZ)}
        </p>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          {formatDuration(lines.reduce((n, l) => n + l.duration_minutes, 0))} ·{' '}
          {appointment.source.replace('_', ' ')} booking
        </p>

        <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {lines.map((l) => (
            <li key={l.id} className="flex justify-between gap-6 py-3 text-sm">
              <span>
                {l.name_snapshot}
                {/* A pair-deal line says so, and whether it was added in the
                    chair — the split the redemptions report counts. */}
                {l.full_price_cents !== null && (
                  <span className="ml-2 text-xs text-[var(--color-muted)]">
                    pair deal{l.added_by ? ', added in the chair' : ''}
                  </span>
                )}
              </span>
              <span className="tabular-nums text-[var(--color-muted)]">
                {l.full_price_cents !== null && l.full_price_cents !== l.price_cents && (
                  <>
                    <s>{formatMoney(l.full_price_cents)}</s>{' '}
                  </>
                )}
                {formatMoney(l.price_cents)}
              </span>
            </li>
          ))}
        </ul>

        {/* The lines are list price and stay that way — they are a snapshot of
            what was booked. A membership comes off underneath them, which is
            why the total below is smaller than they add up to. Saying nothing
            here would make the receipt look wrong. */}
        {(appointment.membership_covered_cents > 0 ||
          appointment.membership_discount_cents > 0) && (
          <ul className="divide-y divide-[var(--color-border)] border-b border-[var(--color-border)] text-sm">
            {appointment.membership_covered_cents > 0 && (
              <li className="flex justify-between gap-6 py-3">
                <span className="text-[var(--color-muted)]">
                  Included with their membership
                </span>
                <span className="tabular-nums text-[var(--color-muted)]">
                  &minus;{formatMoney(appointment.membership_covered_cents)}
                </span>
              </li>
            )}
            {appointment.membership_discount_cents > 0 && (
              <li className="flex justify-between gap-6 py-3">
                <span className="text-[var(--color-muted)]">Member discount</span>
                <span className="tabular-nums text-[var(--color-muted)]">
                  &minus;{formatMoney(appointment.membership_discount_cents)}
                </span>
              </li>
            )}
          </ul>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {appointment.deposit_cents > 0 && (
              <Badge tone={appointment.deposit_status === 'paid' ? 'success' : 'warning'}>
                Deposit {formatMoney(appointment.deposit_cents)} · {appointment.deposit_status}
              </Badge>
            )}
            {appointment.age_attested_at && <Badge tone="neutral">18+ confirmed</Badge>}
          </div>
          <span className="tabular-nums">{formatMoney(appointment.total_cents)}</span>
        </div>
      </div>

      {/* The upsell sits above coverage and balance for the same reason those
          two are ordered: adding a line raises the total that everything
          below it reads. Renders nothing unless something pairs with today. */}
      {upsellOptions.length > 0 && (
        <div className="mt-8">
          <PairUpsell appointmentId={appointment.id} options={upsellOptions} />
        </div>
      )}

      {/* "Is any of this already covered?" comes before "what do they owe".
          Spending a session writes a `payments` row, which is what drops the
          balance TakePayment renders below — so this has to sit above it.
          Renders nothing unless a live package of theirs pays for a line on
          this visit, and nothing at all for a provider, whose read of
          `client_packages` is empty by policy (008). */}
      <div className="mt-8 empty:mt-0">
        <PackageVisitCredit
          appointmentId={appointment.id}
          clientId={appointment.client_id}
        />
      </div>

      <div className="mt-8">
        <TakePayment
          appointmentId={appointment.id}
          totalCents={appointment.total_cents}
          balanceCents={balanceCents}
          payments={(payments ?? []) as PaymentRecord[]}
          settled={notBilled}
        />
      </div>

      {appointment.client_notes && (
        <div className="mt-8">
          <h2 className="label-caps mb-2 text-[var(--color-accent)]">Client wrote</h2>
          <p className="text-sm text-[var(--color-muted)]">{appointment.client_notes}</p>
        </div>
      )}

      {appointment.client_id && (
        <div className="mt-10">
          <h2 className="label-caps mb-4 text-[var(--color-accent)]">Treatment note</h2>
          <ClientNoteForm clientId={appointment.client_id} appointmentId={appointment.id} />
        </div>
      )}
    </div>
  )
}
